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
 * Any one of the three signals is enough, and that is deliberate. The failure this streak
 * exists to catch is a routine going quiet, so a detector that resets to zero on an outcome
 * it did not recognise would reproduce that failure rather than report it. Every branch
 * therefore fails toward "keep counting":
 *
 * 1. A structured `skipReason` counts on its own, even under a label this list has never
 *    heard of. This is the signal the dispatcher is supposed to write on every skip.
 * 2. A known label counts even when the reason went unrecorded.
 * 3. A `skipped_` prefix counts as a last resort. The prefix is no longer the foundation of
 *    the check — it sits behind the explicit list and the structured reason — but it stays
 *    because the two failures are not equally likely. Naming a new skip path outside the
 *    convention is visible in review; writing `skipped_foo` and forgetting the `skipReason`
 *    is not. Dropping the prefix would trade a loud failure for a silent one.
 *
 * Only a skip path that trips none of the three can fall out of the count.
 */
export function isRoutineSkipTouchedState(
  status: string,
  skipReason: string | null | undefined,
): boolean {
  if (skipReason) return true;
  if ((ROUTINE_SKIP_TOUCHED_STATES as readonly string[]).includes(status)) return true;
  return status.startsWith("skipped_");
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
