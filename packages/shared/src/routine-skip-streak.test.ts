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
    for (const status of ROUTINE_SKIP_TOUCHED_STATES) {
      expect(isRoutineSkipTouchedState(status, null)).toBe(true);
    }
  });

  it("clears the streak on outcomes that did real work", () => {
    expect(isRoutineSkipTouchedState("issue_created", null)).toBe(false);
    expect(isRoutineSkipTouchedState("coalesced", null)).toBe(false);
    expect(isRoutineSkipTouchedState("completed", null)).toBe(false);
    expect(isRoutineSkipTouchedState("failed", null)).toBe(false);
  });

  it("counts a skip whose label this list has never heard of", () => {
    // The regression this guards: keying the streak off a "skipped" prefix meant a future
    // skip label named anything else would quietly reset the count to zero, which is the
    // silent stall the streak exists to catch. A structured reason is enough on its own.
    expect(isRoutineSkipTouchedState("suppressed_by_quota", "live_execution_issue_active")).toBe(true);
    expect(isRoutineSkipTouchedState("deferred", "paused")).toBe(true);
  });

  it("counts a known skip label even when the reason went unrecorded", () => {
    expect(isRoutineSkipTouchedState("skipped", null)).toBe(true);
    expect(isRoutineSkipTouchedState("skipped", undefined)).toBe(true);
  });

  it("does not count an unknown label that recorded no reason", () => {
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
