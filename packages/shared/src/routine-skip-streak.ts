import {
  ROUTINE_SKIP_STREAK_ALERT_REASONS,
  ROUTINE_SKIP_STREAK_ALERT_THRESHOLD,
  ROUTINE_SKIP_TOUCHED_STATES,
  type RoutineRunSkipReason,
} from "./constants.js";

export interface RoutineSkipStreakState {
  consecutiveSkipCount: number | null;
  consecutiveSkipReason: string | null;
  consecutiveSkipSince: Date | string | null;
}

export interface RoutineSkipStreak {
  /** Skipped runs since the last one that dispatched, coalesced, or failed. */
  count: number;
  /** Reason recorded by the most recent skip in the streak. */
  reason: RoutineRunSkipReason | string | null;
  /** When the current streak started; null when the routine is not skipping. */
  since: Date | null;
  /** Count at which an alerting reason turns the streak into an alert. */
  threshold: number;
  alerting: boolean;
}

export function isAlertingRoutineSkipReason(reason: string | null | undefined): boolean {
  if (!reason) return false;
  return (ROUTINE_SKIP_STREAK_ALERT_REASONS as readonly string[]).includes(reason);
}

/**
 * Whether a dispatch outcome should extend the skip streak rather than clear it.
 *
 * Either signal alone is enough, and that is deliberate. A tick that recorded a structured
 * skip reason counts even if its label is one this list has never heard of, and a labelled
 * skip counts even if the reason went unrecorded. Both halves fail toward "keep counting",
 * because the failure this streak exists to catch is a routine going quiet — a detector
 * that quietly resets to zero would reproduce it.
 */
export function isRoutineSkipTouchedState(
  status: string,
  skipReason: string | null | undefined,
): boolean {
  if (skipReason) return true;
  return (ROUTINE_SKIP_TOUCHED_STATES as readonly string[]).includes(status);
}

function toDate(value: Date | string | null | undefined): Date | null {
  if (!value) return null;
  const parsed = value instanceof Date ? value : new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

/**
 * Turns the raw skip-streak columns on a routine into the alert verdict clients read, so
 * the UI, the API, and the cadence watchdog all apply one threshold instead of three.
 */
export function resolveRoutineSkipStreak(state: RoutineSkipStreakState): RoutineSkipStreak {
  const rawCount = state.consecutiveSkipCount ?? 0;
  const count = Number.isFinite(rawCount) && rawCount > 0 ? Math.floor(rawCount) : 0;
  const reason = count > 0 ? state.consecutiveSkipReason ?? null : null;
  return {
    count,
    reason,
    since: count > 0 ? toDate(state.consecutiveSkipSince) : null,
    threshold: ROUTINE_SKIP_STREAK_ALERT_THRESHOLD,
    alerting: count >= ROUTINE_SKIP_STREAK_ALERT_THRESHOLD && isAlertingRoutineSkipReason(reason),
  };
}
