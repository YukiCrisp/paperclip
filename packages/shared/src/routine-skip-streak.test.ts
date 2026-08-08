import { describe, expect, it } from "vitest";
import { ROUTINE_SKIP_TOUCHED_STATES } from "./constants.js";
import {
  isAlertingRoutineSkipReason,
  isRoutineSkipTouchedState,
  resolveRoutineSkipStreak,
} from "./routine-skip-streak.js";

describe("resolveRoutineSkipStreak", () => {
  it("reports no streak for a routine that is dispatching", () => {
    expect(
      resolveRoutineSkipStreak({
        consecutiveSkipCount: 0,
        consecutiveSkipReason: null,
        consecutiveSkipSince: null,
      }),
    ).toEqual({ count: 0, reason: null, since: null, threshold: 2, alerting: false });
  });

  it("holds a single skip below the alert threshold", () => {
    const streak = resolveRoutineSkipStreak({
      consecutiveSkipCount: 1,
      consecutiveSkipReason: "live_execution_issue_active",
      consecutiveSkipSince: new Date("2026-08-05T00:00:00.000Z"),
    });
    expect(streak.count).toBe(1);
    expect(streak.alerting).toBe(false);
    expect(streak.since).toEqual(new Date("2026-08-05T00:00:00.000Z"));
  });

  it("alerts from the second consecutive skip against a live execution issue", () => {
    const streak = resolveRoutineSkipStreak({
      consecutiveSkipCount: 2,
      consecutiveSkipReason: "live_execution_issue_active",
      consecutiveSkipSince: new Date("2026-08-05T00:00:00.000Z"),
    });
    expect(streak.alerting).toBe(true);
    expect(streak.threshold).toBe(2);
  });

  it("stays quiet for suppressions whose cause is already visible", () => {
    for (const reason of ["paused", "no_external_activity", "worktree_execution_cutoff"]) {
      expect(
        resolveRoutineSkipStreak({
          consecutiveSkipCount: 12,
          consecutiveSkipReason: reason,
          consecutiveSkipSince: new Date("2026-08-05T00:00:00.000Z"),
        }).alerting,
      ).toBe(false);
    }
  });

  it("does not alert on a counted skip that recorded no reason", () => {
    expect(
      resolveRoutineSkipStreak({
        consecutiveSkipCount: 9,
        consecutiveSkipReason: null,
        consecutiveSkipSince: new Date("2026-08-05T00:00:00.000Z"),
      }).alerting,
    ).toBe(false);
  });

  it("accepts serialized timestamps and drops the streak start once the count is cleared", () => {
    expect(
      resolveRoutineSkipStreak({
        consecutiveSkipCount: 3,
        consecutiveSkipReason: "live_execution_issue_active",
        consecutiveSkipSince: "2026-08-05T00:00:00.000Z",
      }).since,
    ).toEqual(new Date("2026-08-05T00:00:00.000Z"));

    expect(
      resolveRoutineSkipStreak({
        consecutiveSkipCount: 0,
        consecutiveSkipReason: "live_execution_issue_active",
        consecutiveSkipSince: "2026-08-05T00:00:00.000Z",
      }),
    ).toEqual({ count: 0, reason: null, since: null, threshold: 2, alerting: false });
  });
});

describe("isRoutineSkipTouchedState", () => {
  it("counts every skip label the dispatcher writes today", () => {
    expect(isRoutineSkipTouchedState("skipped", null)).toBe(true);
    expect(isRoutineSkipTouchedState("skipped_paused", null)).toBe(true);
    expect(isRoutineSkipTouchedState("skipped_no_activity", null)).toBe(true);
    expect(isRoutineSkipTouchedState("skipped_worktree_execution_cutoff", null)).toBe(true);
  });

  it("pins the label list, which no behavioural assertion can do", () => {
    // Dropping a label from the list is invisible through the helper: every entry except
    // "skipped" also matches the skipped_ fallback, so the helper keeps returning true and
    // the suite stays green. Comparing the constant is the only thing that turns a deletion
    // red — and it deliberately fails on an addition too, so a new skip label has to arrive
    // with a decision about whether it belongs here.
    expect([...ROUTINE_SKIP_TOUCHED_STATES]).toEqual([
      "skipped",
      "skipped_paused",
      "skipped_no_activity",
      "skipped_worktree_execution_cutoff",
    ]);
  });

  it("clears the streak on outcomes that did real work", () => {
    expect(isRoutineSkipTouchedState("issue_created", null)).toBe(false);
    expect(isRoutineSkipTouchedState("coalesced", null)).toBe(false);
    expect(isRoutineSkipTouchedState("completed", null)).toBe(false);
    expect(isRoutineSkipTouchedState("failed", null)).toBe(false);
  });

  it("counts a skip whose label this list has never heard of", () => {
    // The regression this guards: keying the streak solely off a "skipped" prefix meant a
    // future skip label named anything else would quietly reset the count to zero, which is
    // the silent stall the streak exists to catch. A structured reason is enough on its own.
    expect(isRoutineSkipTouchedState("suppressed_by_quota", "live_execution_issue_active")).toBe(true);
    expect(isRoutineSkipTouchedState("deferred", "paused")).toBe(true);
  });

  it("counts a known skip label even when the reason went unrecorded", () => {
    expect(isRoutineSkipTouchedState("skipped", null)).toBe(true);
    expect(isRoutineSkipTouchedState("skipped", undefined)).toBe(true);
  });

  it("falls back to the skipped_ prefix for a new label that recorded no reason", () => {
    // The third signal, and the one that covers the likelier mistake. Naming a skip path
    // outside the convention is visible in review; adding skipped_foo and forgetting to
    // write its skipReason is not. Without this fallback that omission would silently reset
    // the count to zero — the same silent stall, arrived at from the other direction.
    expect(isRoutineSkipTouchedState("skipped_quota_exhausted", null)).toBe(true);
    expect(isRoutineSkipTouchedState("skipped_quota_exhausted", undefined)).toBe(true);
  });

  it("does not count a label that trips none of the three signals", () => {
    expect(isRoutineSkipTouchedState("suppressed_by_quota", null)).toBe(false);
  });
});

describe("isAlertingRoutineSkipReason", () => {
  it("only treats a live execution issue as an unexplained stall", () => {
    expect(isAlertingRoutineSkipReason("live_execution_issue_active")).toBe(true);
    expect(isAlertingRoutineSkipReason("paused")).toBe(false);
    expect(isAlertingRoutineSkipReason(null)).toBe(false);
  });
});
