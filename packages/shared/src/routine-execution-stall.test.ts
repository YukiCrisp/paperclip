import { describe, expect, it } from "vitest";
import { ROUTINE_EXECUTION_STALL_SUPPRESSED_RUN_STATUSES } from "./constants.js";
import { resolveRoutineExecutionStall } from "./routine-execution-stall.js";

const SINCE = new Date("2026-08-05T00:00:00.000Z");

describe("resolveRoutineExecutionStall", () => {
  it("stays quiet for an execution issue that has swallowed nothing", () => {
    expect(
      resolveRoutineExecutionStall({ suppressedRunCount: 0, since: SINCE, lastSuppressedAt: null }),
    ).toEqual({
      suppressedRunCount: 0,
      since: SINCE,
      lastSuppressedAt: null,
      threshold: 2,
      alerting: false,
    });
  });

  it("holds one swallowed fire below the threshold", () => {
    const stall = resolveRoutineExecutionStall({
      suppressedRunCount: 1,
      since: SINCE,
      lastSuppressedAt: new Date("2026-08-05T01:00:00.000Z"),
    });
    expect(stall.suppressedRunCount).toBe(1);
    expect(stall.alerting).toBe(false);
  });

  it("alerts from the second fire folded into the same execution issue", () => {
    const stall = resolveRoutineExecutionStall({
      suppressedRunCount: 2,
      since: SINCE,
      lastSuppressedAt: new Date("2026-08-05T02:00:00.000Z"),
    });
    expect(stall.alerting).toBe(true);
    expect(stall.threshold).toBe(2);
  });

  it("raises the alert on the count alone, with no reason to explain it away", () => {
    // The difference from the skip streak, and the reason this is a separate signal. There,
    // an alerting reason is required, and a coalesce records none — it is not a skip at all,
    // so it never reaches that check. Here the count *is* the evidence: N fires found the
    // same execution issue live, under whichever concurrency policy the routine happens to
    // run. Requiring a reason as well would reproduce the blind spot this exists to close.
    expect(
      resolveRoutineExecutionStall({ suppressedRunCount: 5, since: SINCE }).alerting,
    ).toBe(true);
  });

  it("does not let a long-open execution issue alert on age alone", () => {
    // `since` is on the object for an operator reading wall-time, not for the verdict. A
    // stuck issue on a paused routine ages without costing a fire, and reporting that as a
    // stall would train an operator to ignore the signal.
    const stall = resolveRoutineExecutionStall({
      suppressedRunCount: 0,
      since: new Date("2020-01-01T00:00:00.000Z"),
    });
    expect(stall.since).toEqual(new Date("2020-01-01T00:00:00.000Z"));
    expect(stall.alerting).toBe(false);
  });

  it("accepts serialized timestamps and normalises a missing or unparseable count", () => {
    const stall = resolveRoutineExecutionStall({
      suppressedRunCount: null,
      since: "2026-08-05T00:00:00.000Z",
      lastSuppressedAt: "2026-08-05T03:00:00.000Z",
    });
    expect(stall.since).toEqual(SINCE);
    expect(stall.lastSuppressedAt).toEqual(new Date("2026-08-05T03:00:00.000Z"));
    expect(stall.suppressedRunCount).toBe(0);

    expect(resolveRoutineExecutionStall({ suppressedRunCount: -3, since: null }).suppressedRunCount).toBe(0);
    expect(resolveRoutineExecutionStall({ suppressedRunCount: 2.7, since: null }).suppressedRunCount).toBe(2);
    expect(resolveRoutineExecutionStall({ suppressedRunCount: 1, since: "not a date" }).since).toBeNull();
  });
});

describe("ROUTINE_EXECUTION_STALL_SUPPRESSED_RUN_STATUSES", () => {
  it("pins both policies' labels, which no behavioural assertion can do", () => {
    // The bug this guards is a deletion, not an addition. Drop "coalesced" and every
    // skip_if_active test still passes — the count keeps working for the policy that was
    // already covered by the skip streak, and the policy that had no coverage at all goes
    // silent again. Comparing the constant is the only thing that turns that deletion red.
    expect([...ROUTINE_EXECUTION_STALL_SUPPRESSED_RUN_STATUSES]).toEqual(["skipped", "coalesced"]);
  });
});
