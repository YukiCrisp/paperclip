/**
 * ENGA-2912: one attempt budget per stuck issue, shared by every automatic
 * retry mechanism.
 *
 * Two independent mechanisms re-run a failed issue without any new external
 * input, and each already has a cap:
 *
 * - The bounded transient retry in `heartbeat.ts` (`transient_failure`), whose
 *   attempt counter rides on `heartbeat_runs.scheduled_retry_attempt` and is
 *   propagated run-to-run along the retry chain.
 * - The continuation reconciler in `recovery/service.ts`
 *   (`issue_continuation_needed`), which escalates the issue to `blocked` once
 *   `classifyContinuationFailure().maxAttempts` consecutive attempts have
 *   failed.
 *
 * Neither cap held, because each mechanism reset the other's counter. A
 * continuation run is a brand-new run with `scheduled_retry_attempt = 0`, so
 * it handed the transient retry a full fresh budget; and the continuation
 * streak was counted by walking recent runs newest-first and breaking on the
 * first row whose `retryReason` was not `issue_continuation_needed` — which
 * every interleaved transient retry is. The two budgets zeroed each other on
 * every hand-off, so the retry chain was unbounded in practice.
 *
 * Measured on ENGA-2906 (2026-08-05, 15 runs, ~10h): `scheduled_retry_attempt`
 * climbed 1→2→3→4, a continuation run dropped it back to 0, and the cycle
 * repeated three times. The continuation streak never got past 1.
 *
 * The fix is to count the streak the way the failure actually behaves: a run
 * of consecutive unsuccessful attempts on one issue, produced by *any*
 * automatic retry mechanism, against the same failure policy. Both mechanisms
 * read that one number, so a stuck issue is escalated after the designed number
 * of attempts instead of retrying forever.
 */

/**
 * How many recent runs to sample when measuring a streak. The streak stops at
 * the first non-matching run, so this only has to be deeper than any cap that
 * reads it.
 */
export const AUTOMATIC_RETRY_STREAK_RUN_SAMPLE_LIMIT = 10;

/** Terminal run statuses that mean the attempt did not succeed. */
export const UNSUCCESSFUL_HEARTBEAT_RUN_TERMINAL_STATUSES = [
  "interrupted",
  "failed",
  "cancelled",
  "timed_out",
] as const;

export type UnsuccessfulHeartbeatRunTerminalStatus =
  (typeof UNSUCCESSFUL_HEARTBEAT_RUN_TERMINAL_STATUSES)[number];

export function isUnsuccessfulTerminalRunStatus(status: string | null | undefined): boolean {
  return UNSUCCESSFUL_HEARTBEAT_RUN_TERMINAL_STATUSES.includes(
    status as UnsuccessfulHeartbeatRunTerminalStatus,
  );
}

/**
 * `contextSnapshot.retryReason` values that mark a run as "the platform decided
 * to re-run this issue by itself after the previous attempt failed".
 *
 * Membership is what makes a run count against the shared budget, so the set is
 * deliberately restricted to failure-driven retries. Continuations that follow a
 * run which did *not* fail carry their own separate budget and are not part of
 * this streak: `max_turns_continuation` resumes a turn that ran out of turns
 * rather than one that died, and `missing_issue_comment` re-runs one that
 * finished without posting its comment.
 *
 * Membership also decides where a streak *stops*, which is the sharper edge: a
 * failure-driven reason that is missing from this set does not merely go
 * uncounted, it breaks the streak at that run and so restores the budget its
 * predecessors had already spent. Keep this in step with the `retryReason`
 * values written into a run's contextSnapshot by `heartbeat.ts` and
 * `recovery/service.ts`.
 */
export const AUTOMATIC_RETRY_REASONS: ReadonlySet<string> = new Set([
  // Bounded transient retry (heartbeat.ts).
  "transient_failure",
  // Stranded-issue reconcilers (recovery/service.ts).
  "issue_continuation_needed",
  "assignment_recovery",
  "execution_review_participant_recovery",
  "interaction_continuation_infra_retry",
  // Provider usage-limit wait (recovery/service.ts). It follows a run that failed
  // with `provider_quota`, which `classifyContinuationFailure` puts in the same
  // `transient_infra` bucket as the acpx codes — so a quota-wait run that comes
  // back and dies in the same outage carries the streak's policy key and only its
  // `retryReason` would end the streak. Leaving it out reproduced both halves of
  // this bug on that path: the streak broke here, and the fresh run's
  // `scheduledRetryAttempt = 1` handed the transient ladder a near-full budget.
  "provider_quota_recovery",
  // Process-loss retry (heartbeat.ts). Bounded separately by
  // `process_loss_retry_count`, but it re-runs the same issue for the same
  // reason, so it belongs to the same episode.
  "process_lost",
]);

export function isAutomaticRetryReason(reason: string | null | undefined): boolean {
  return reason != null && AUTOMATIC_RETRY_REASONS.has(reason);
}

export interface AutomaticRetryStreakRun {
  id: string;
  status: string;
  finishedAt: Date | null;
  /** `contextSnapshot.retryReason`, or null when no automatic retry produced this run. */
  retryReason: string | null;
  /**
   * Stable identity of the retry policy the run's failure classifies into.
   * Callers build it from `classifyContinuationFailure`, so two runs share a key
   * exactly when the same budget and backoff apply to them — which is what makes
   * `acpx_event_inactivity` and `acpx_session_init_failed` count as one outage
   * instead of two unrelated single strikes.
   */
  retryPolicyKey: string;
}

export interface AutomaticRetryStreakSummary {
  consecutive: number;
  latestFinishedAt: Date | null;
  /** Policy the streak is measured against; null when the streak is empty. */
  policyKey: string | null;
}

/**
 * Count the run of consecutive automatic-retry failures at the head of
 * `runs` (which must be ordered newest first).
 *
 * The streak stops at the first run that is not an automatic retry failure
 * against the same policy: a success, a run nobody retried into (the original
 * attempt), a run still in flight, or a failure of a different kind. Any of
 * those means the next attempt is not simply the same attempt again.
 */
export function summarizeAutomaticRetryFailureStreak(
  runs: readonly AutomaticRetryStreakRun[],
): AutomaticRetryStreakSummary {
  let consecutive = 0;
  let latestFinishedAt: Date | null = null;
  let policyKey: string | null = null;

  for (const run of runs) {
    if (!isAutomaticRetryReason(run.retryReason)) break;
    if (!isUnsuccessfulTerminalRunStatus(run.status)) break;
    if (policyKey === null) {
      policyKey = run.retryPolicyKey;
    } else if (run.retryPolicyKey !== policyKey) {
      break;
    }

    consecutive += 1;
    if (latestFinishedAt === null) latestFinishedAt = run.finishedAt ?? null;
  }

  return { consecutive, latestFinishedAt, policyKey };
}
