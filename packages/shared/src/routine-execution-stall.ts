import { ROUTINE_EXECUTION_STALL_ALERT_THRESHOLD } from "./constants.js";

export interface RoutineExecutionStallState {
  /** Fires that were skipped or coalesced because this execution issue was still live. */
  suppressedRunCount: number | null;
  /** When the live execution issue was created. */
  since: Date | string | null;
  /** Trigger time of the most recent fire that folded into it. */
  lastSuppressedAt?: Date | string | null;
}

export interface RoutineExecutionStall {
  suppressedRunCount: number;
  since: Date | null;
  lastSuppressedAt: Date | null;
  /** suppressedRunCount at which the live execution issue counts as stalled. */
  threshold: number;
  alerting: boolean;
}

function toDate(value: Date | string | null | undefined): Date | null {
  if (!value) return null;
  const parsed = value instanceof Date ? value : new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

/**
 * Turns "how many fires this one live execution issue has eaten" into the alert verdict.
 *
 * This is deliberately not the skip streak. The streak lives on the routine and asks whether
 * the routine did work; this asks whether one execution issue is still holding the door shut,
 * which is the condition both concurrency policies share. `skip_if_active` records the answer
 * as a skip and extends the streak, `coalesce_if_active` records it as a coalesce and *clears*
 * the streak — same stuck issue, opposite streak reading. Anchoring on the issue rather than
 * on the run label makes the two policies report the same failure, and leaves the meaning of
 * `consecutiveSkipCount` ("fires that did no work") untouched for the watchdog that reads it.
 *
 * Counting fires rather than elapsed time is what makes one threshold portable across
 * cadences: two fires lost is two periods lost whether the routine is hourly or weekly. The
 * clock is still on the object as `since` for an operator who wants the wall-time, but it is
 * not what raises the alert — a stuck issue on a paused routine ages without eating anything,
 * and that is correctly quiet.
 */
export function resolveRoutineExecutionStall(state: RoutineExecutionStallState): RoutineExecutionStall {
  const rawCount = state.suppressedRunCount ?? 0;
  const suppressedRunCount = Number.isFinite(rawCount) && rawCount > 0 ? Math.floor(rawCount) : 0;
  return {
    suppressedRunCount,
    since: toDate(state.since),
    lastSuppressedAt: toDate(state.lastSuppressedAt),
    threshold: ROUTINE_EXECUTION_STALL_ALERT_THRESHOLD,
    alerting: suppressedRunCount >= ROUTINE_EXECUTION_STALL_ALERT_THRESHOLD,
  };
}
