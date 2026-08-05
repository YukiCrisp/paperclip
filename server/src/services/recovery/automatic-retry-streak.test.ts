import { describe, expect, it } from "vitest";
import {
  isAutomaticRetryReason,
  summarizeAutomaticRetryFailureStreak,
  type AutomaticRetryStreakRun,
} from "./automatic-retry-streak.js";
import { continuationRetryPolicyKeyForErrorCode } from "./service.js";

/**
 * The ENGA-2906 run history from 2026-08-05, newest first, exactly as the live
 * instance recorded it (`GET /api/heartbeat-runs/{id}`). Two capped mechanisms
 * alternate: the bounded transient retry (`transient_failure`) and the
 * continuation reconciler (`issue_continuation_needed`).
 */
const ENGA_2906_RUNS: Array<{ id: string; errorCode: string; retryReason: string | null }> = [
  { id: "08a91721", errorCode: "acpx_session_init_failed", retryReason: "transient_failure" },
  { id: "17163cfe", errorCode: "acpx_event_inactivity", retryReason: "issue_continuation_needed" },
  { id: "f9370a37", errorCode: "acpx_turn_failed", retryReason: "transient_failure" },
  { id: "b7e145e1", errorCode: "acpx_event_inactivity", retryReason: "issue_continuation_needed" },
  { id: "499fc2a7", errorCode: "acpx_event_inactivity", retryReason: "transient_failure" },
  { id: "4ef430e4", errorCode: "acpx_event_inactivity", retryReason: "transient_failure" },
  { id: "87a27379", errorCode: "acpx_event_inactivity", retryReason: "issue_continuation_needed" },
  { id: "9241ca68", errorCode: "acpx_session_init_failed", retryReason: "transient_failure" },
  { id: "5ca0fff7", errorCode: "acpx_event_inactivity", retryReason: "issue_continuation_needed" },
  { id: "8553de36", errorCode: "acpx_session_init_failed", retryReason: "transient_failure" },
  // The original attempt: an ordinary assignment wake, not a retry.
  { id: "7cae667e", errorCode: "acpx_event_inactivity", retryReason: null },
];

function sample(
  runs: ReadonlyArray<{ id: string; errorCode: string | null; retryReason: string | null; status?: string }>,
): AutomaticRetryStreakRun[] {
  return runs.map((run, index) => ({
    id: run.id,
    status: run.status ?? "failed",
    finishedAt: new Date(Date.UTC(2026, 7, 5, 13 - index)),
    retryReason: run.retryReason,
    retryPolicyKey: continuationRetryPolicyKeyForErrorCode(run.errorCode),
  }));
}

/**
 * The pre-fix counter, reproduced from `summarizeRecentContinuationRetries`:
 * only continuations count, and the error code has to match exactly.
 */
function legacyContinuationStreak(
  runs: ReadonlyArray<{ errorCode: string | null; retryReason: string | null }>,
  errorCodeToMatch: string | null,
) {
  let consecutive = 0;
  for (const run of runs) {
    if (run.retryReason !== "issue_continuation_needed") break;
    if (run.errorCode !== errorCodeToMatch) break;
    consecutive += 1;
  }
  return consecutive;
}

describe("automatic retry failure streak", () => {
  it("counts the ENGA-2906 storm as one streak past the 3-attempt cap", () => {
    const { consecutive, policyKey } = summarizeAutomaticRetryFailureStreak(sample(ENGA_2906_RUNS));

    // Every retry after the original assignment attempt, and nothing before it.
    expect(consecutive).toBe(ENGA_2906_RUNS.length - 1);
    expect(policyKey).toBe(continuationRetryPolicyKeyForErrorCode("acpx_event_inactivity"));
  });

  it("is the regression the old counter could not see", () => {
    // The pre-fix counter was called with the latest run's error code, so on
    // this history it never got past a single strike — which is why an issue
    // with a 3-attempt budget produced 15 runs over 10 hours.
    expect(legacyContinuationStreak(ENGA_2906_RUNS, "acpx_session_init_failed")).toBe(0);
    expect(
      legacyContinuationStreak(ENGA_2906_RUNS.slice(1), "acpx_event_inactivity"),
    ).toBe(1);
  });

  it("does not let a mechanism hand-off reset the count", () => {
    // Three transient retries with a continuation wedged in the middle is still
    // four spent attempts, not "one since the last hand-off".
    const runs = sample([
      { id: "d", errorCode: "acpx_event_inactivity", retryReason: "transient_failure" },
      { id: "c", errorCode: "acpx_event_inactivity", retryReason: "issue_continuation_needed" },
      { id: "b", errorCode: "acpx_turn_failed", retryReason: "transient_failure" },
      { id: "a", errorCode: "acpx_session_init_failed", retryReason: "transient_failure" },
    ]);
    expect(summarizeAutomaticRetryFailureStreak(runs).consecutive).toBe(4);
  });

  it("stops at the original attempt", () => {
    const runs = sample([
      { id: "b", errorCode: "acpx_event_inactivity", retryReason: "transient_failure" },
      { id: "a", errorCode: "acpx_event_inactivity", retryReason: null },
    ]);
    expect(summarizeAutomaticRetryFailureStreak(runs).consecutive).toBe(1);
  });

  it("stops at a success, so a recovered issue starts from a full budget", () => {
    const runs = sample([
      { id: "c", errorCode: "acpx_event_inactivity", retryReason: "transient_failure" },
      { id: "b", errorCode: null, retryReason: "transient_failure", status: "succeeded" },
      { id: "a", errorCode: "acpx_event_inactivity", retryReason: "transient_failure" },
    ]);
    expect(summarizeAutomaticRetryFailureStreak(runs).consecutive).toBe(1);
  });

  it("stops at a run that is still in flight", () => {
    const runs = sample([
      { id: "b", errorCode: null, retryReason: "transient_failure", status: "running" },
      { id: "a", errorCode: "acpx_event_inactivity", retryReason: "transient_failure" },
    ]);
    expect(summarizeAutomaticRetryFailureStreak(runs).consecutive).toBe(0);
  });

  it("does not merge failures that carry different retry budgets", () => {
    // `skills_source_unavailable` has its own swap-window budget and
    // `agent_not_invokable` is not retryable at all; neither is the same
    // episode as a generic transient outage.
    const runs = sample([
      { id: "b", errorCode: "acpx_event_inactivity", retryReason: "transient_failure" },
      { id: "a", errorCode: "skills_source_unavailable", retryReason: "transient_failure" },
    ]);
    expect(summarizeAutomaticRetryFailureStreak(runs).consecutive).toBe(1);
  });

  it("reports the newest finish time so the caller can back off from it", () => {
    const runs = sample(ENGA_2906_RUNS);
    expect(summarizeAutomaticRetryFailureStreak(runs).latestFinishedAt).toEqual(runs[0].finishedAt);
  });

  it("returns an empty streak for an issue with no runs", () => {
    expect(summarizeAutomaticRetryFailureStreak([])).toEqual({
      consecutive: 0,
      latestFinishedAt: null,
      policyKey: null,
    });
  });
});

describe("automatic retry reasons", () => {
  it("covers both mechanisms that re-ran ENGA-2906", () => {
    expect(isAutomaticRetryReason("transient_failure")).toBe(true);
    expect(isAutomaticRetryReason("issue_continuation_needed")).toBe(true);
  });

  it("excludes wakes that carry new input or resume a run that did not fail", () => {
    for (const reason of [null, "issue_assigned", "issue_commented", "max_turns_continuation"]) {
      expect(isAutomaticRetryReason(reason)).toBe(false);
    }
  });
});

describe("continuation retry policy keys", () => {
  it("treats the acpx phase codes as one outage", () => {
    const inactivity = continuationRetryPolicyKeyForErrorCode("acpx_event_inactivity");
    expect(continuationRetryPolicyKeyForErrorCode("acpx_session_init_failed")).toBe(inactivity);
    expect(continuationRetryPolicyKeyForErrorCode("acpx_turn_failed")).toBe(inactivity);
    expect(continuationRetryPolicyKeyForErrorCode("adapter_failed")).toBe(inactivity);
  });

  it("keeps policies with different budgets apart", () => {
    const transient = continuationRetryPolicyKeyForErrorCode("acpx_event_inactivity");
    expect(continuationRetryPolicyKeyForErrorCode("skills_source_unavailable")).not.toBe(transient);
    expect(continuationRetryPolicyKeyForErrorCode("agent_not_invokable")).not.toBe(transient);
    expect(continuationRetryPolicyKeyForErrorCode(null)).not.toBe(transient);
  });
});
