import { describe, expect, it } from "vitest";
import { extractQuotaRetryNotBefore, isProviderQuotaText } from "./quota-text.js";

// The exact string an exhausted Claude seat puts on the ACP runtime error object.
const SESSION_LIMIT_ERROR =
  "Internal error: You've hit your session limit · resets 2pm (Asia/Tokyo)";

describe("isProviderQuotaText", () => {
  it("recognises the session-limit wording", () => {
    expect(isProviderQuotaText(SESSION_LIMIT_ERROR)).toBe(true);
  });

  it.each([
    "Claude usage limit reached",
    "You are out of extra usage",
    "ServiceQuotaExceededException",
  ])("recognises other exhausted-quota wordings: %s", (text) => {
    expect(isProviderQuotaText(text)).toBe(true);
  });

  it.each([
    "",
    "Unable to connect to API (ConnectionRefused)",
    "Workspace storage capacity limit reached.",
    "The turn failed while editing a file.",
  ])("does not fire on unrelated failure text: %s", (text) => {
    expect(isProviderQuotaText(text)).toBe(false);
  });

  it("returns false for null and undefined", () => {
    expect(isProviderQuotaText(null)).toBe(false);
    expect(isProviderQuotaText(undefined)).toBe(false);
  });
});

describe("extractQuotaRetryNotBefore", () => {
  it("resolves 'resets 2pm (Asia/Tokyo)' to the next 14:00 in that zone", () => {
    // 03:24Z is 12:24 the same day in Asia/Tokyo, so the reset is still ahead:
    // 14:00 JST === 05:00Z on the same date.
    const now = new Date("2026-08-16T03:24:00.000Z");
    expect(extractQuotaRetryNotBefore(SESSION_LIMIT_ERROR, now)?.toISOString()).toBe(
      "2026-08-16T05:00:00.000Z",
    );
  });

  it("rolls to the following day when the reset clock has already passed", () => {
    // 07:00Z is 16:00 JST — past 14:00 — so the next 14:00 JST is tomorrow.
    const now = new Date("2026-08-16T07:00:00.000Z");
    expect(extractQuotaRetryNotBefore(SESSION_LIMIT_ERROR, now)?.toISOString()).toBe(
      "2026-08-17T05:00:00.000Z",
    );
  });

  it("returns null when the quota text carries no reset clock", () => {
    expect(
      extractQuotaRetryNotBefore("You've hit your session limit", new Date()),
    ).toBeNull();
  });

  it("returns null for text that is not about quota at all", () => {
    expect(
      extractQuotaRetryNotBefore("Deploy resets 2pm (Asia/Tokyo)", new Date()),
    ).toBeNull();
  });
});
