/**
 * Provider-quota text classification, shared by every adapter.
 *
 * These patterns and the reset-clock parser started out inside the Claude CLI
 * parser, but nothing in them is Claude-specific: they read the user-facing
 * quota strings a coding CLI surfaces verbatim from its provider ("you've hit
 * your session limit · resets 2pm (Asia/Tokyo)"). The acpx engine needs the
 * same reading to tag its failures as `provider_quota`, so the logic lives here
 * and the Claude parser wraps it with its own haystack building.
 *
 * Callers must feed these functions runtime/provider error text only. Agent
 * output is never a safe input: an agent that merely writes "session limit" in
 * its reply would otherwise be misread as an exhausted quota and park its own
 * issue until the imagined reset time.
 */

const PROVIDER_QUOTA_RE =
  /(?:you(?:'|’)ve\s+hit\s+your\s+session\s+limit|session\s+limit\s+(?:reached|exceeded)|out\s+of\s+extra\s+usage|extra\s+usage\b|claude\s+usage\s+limit\s+reached|5[-\s]?hour\s+limit\s+reached|weekly\s+limit\s+reached|usage\s+limit\s+reached|usage\s+cap\s+reached|servicequotaexceededexception)/i;

const QUOTA_RESET_RE =
  /(?:you(?:'|’)ve\s+hit\s+your\s+session\s+limit|session\s+limit\s+(?:reached|exceeded)|out\s+of\s+extra\s+usage|extra\s+usage|usage\s+limit\s+reached|usage\s+cap\s+reached|5[-\s]?hour\s+limit\s+reached|weekly\s+limit\s+reached|claude\s+usage\s+limit\s+reached)[\s\S]{0,120}?\bresets?\s+(?:at\s+)?([^\n()]+?)(?:\s*\(([^)]+)\))?(?:[.!]|\n|$)/i;

function readTimeZoneParts(date: Date, timeZone: string) {
  const values = new Map(
    new Intl.DateTimeFormat("en-US", {
      timeZone,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
    }).formatToParts(date).map((part) => [part.type, part.value]),
  );
  return {
    year: Number.parseInt(values.get("year") ?? "", 10),
    month: Number.parseInt(values.get("month") ?? "", 10),
    day: Number.parseInt(values.get("day") ?? "", 10),
    hour: Number.parseInt(values.get("hour") ?? "", 10),
    minute: Number.parseInt(values.get("minute") ?? "", 10),
  };
}

function normalizeResetTimeZone(timeZoneHint: string | null | undefined): string | null {
  const normalized = timeZoneHint?.trim();
  if (!normalized) return null;
  if (/^(?:utc|gmt)$/i.test(normalized)) return "UTC";

  try {
    new Intl.DateTimeFormat("en-US", { timeZone: normalized }).format(new Date(0));
    return normalized;
  } catch {
    return null;
  }
}

function dateFromTimeZoneWallClock(input: {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  timeZone: string;
}): Date | null {
  let candidate = new Date(Date.UTC(input.year, input.month - 1, input.day, input.hour, input.minute, 0, 0));
  const targetUtc = Date.UTC(input.year, input.month - 1, input.day, input.hour, input.minute, 0, 0);

  for (let attempt = 0; attempt < 4; attempt += 1) {
    const actual = readTimeZoneParts(candidate, input.timeZone);
    const actualUtc = Date.UTC(actual.year, actual.month - 1, actual.day, actual.hour, actual.minute, 0, 0);
    const offsetMs = targetUtc - actualUtc;
    if (offsetMs === 0) break;
    candidate = new Date(candidate.getTime() + offsetMs);
  }

  const verified = readTimeZoneParts(candidate, input.timeZone);
  if (
    verified.year !== input.year ||
    verified.month !== input.month ||
    verified.day !== input.day ||
    verified.hour !== input.hour ||
    verified.minute !== input.minute
  ) {
    return null;
  }

  return candidate;
}

function nextClockTimeInTimeZone(input: {
  now: Date;
  hour: number;
  minute: number;
  timeZoneHint: string;
}): Date | null {
  const timeZone = normalizeResetTimeZone(input.timeZoneHint);
  if (!timeZone) return null;

  const nowParts = readTimeZoneParts(input.now, timeZone);
  let retryAt = dateFromTimeZoneWallClock({
    year: nowParts.year,
    month: nowParts.month,
    day: nowParts.day,
    hour: input.hour,
    minute: input.minute,
    timeZone,
  });
  if (!retryAt) return null;

  if (retryAt.getTime() <= input.now.getTime()) {
    const nextDay = new Date(Date.UTC(nowParts.year, nowParts.month - 1, nowParts.day + 1, 0, 0, 0, 0));
    retryAt = dateFromTimeZoneWallClock({
      year: nextDay.getUTCFullYear(),
      month: nextDay.getUTCMonth() + 1,
      day: nextDay.getUTCDate(),
      hour: input.hour,
      minute: input.minute,
      timeZone,
    });
  }

  return retryAt;
}

function parseQuotaResetClockTime(clockText: string, now: Date, timeZoneHint?: string | null): Date | null {
  const normalized = clockText.trim().replace(/\s+/g, " ");
  const match = normalized.match(/^(\d{1,2})(?::(\d{2}))?\s*([ap])\.?\s*m\.?/i);
  if (!match) return null;

  const hour12 = Number.parseInt(match[1] ?? "", 10);
  const minute = Number.parseInt(match[2] ?? "0", 10);
  if (!Number.isInteger(hour12) || hour12 < 1 || hour12 > 12) return null;
  if (!Number.isInteger(minute) || minute < 0 || minute > 59) return null;

  let hour24 = hour12 % 12;
  if ((match[3] ?? "").toLowerCase() === "p") hour24 += 12;

  if (timeZoneHint) {
    const explicitRetryAt = nextClockTimeInTimeZone({
      now,
      hour: hour24,
      minute,
      timeZoneHint,
    });
    if (explicitRetryAt) return explicitRetryAt;
  }

  const retryAt = new Date(now);
  retryAt.setHours(hour24, minute, 0, 0);
  if (retryAt.getTime() <= now.getTime()) {
    retryAt.setDate(retryAt.getDate() + 1);
  }
  return retryAt;
}

/** True when `text` is provider/runtime error text announcing an exhausted quota. */
export function isProviderQuotaText(text: string | null | undefined): boolean {
  if (!text) return false;
  return PROVIDER_QUOTA_RE.test(text);
}

/**
 * Read the moment a quota message says the limit clears. Returns `null` when the
 * text carries no reset clock, which leaves the caller free to fall back to its
 * own backoff instead of guessing a wrong resume time.
 */
export function extractQuotaRetryNotBefore(
  text: string | null | undefined,
  now = new Date(),
): Date | null {
  if (!text) return null;
  const match = text.match(QUOTA_RESET_RE);
  if (!match) return null;
  return parseQuotaResetClockTime(match[1] ?? "", now, match[2]);
}
