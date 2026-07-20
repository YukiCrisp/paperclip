import { describe, expect, it } from "vitest";
import {
  ROUTINE_TRIGGER_JITTER_WINDOW_SEC,
  nextCronTickInTimeZone,
  nextScheduledRunAt,
  triggerSplayOffsetSeconds,
} from "../services/routines.ts";

describe("triggerSplayOffsetSeconds", () => {
  it("is deterministic for the same trigger id and window", () => {
    const a = triggerSplayOffsetSeconds("11111111-2222-3333-4444-555555555555", 900);
    const b = triggerSplayOffsetSeconds("11111111-2222-3333-4444-555555555555", 900);
    expect(a).toBe(b);
  });

  it("stays within [0, window)", () => {
    for (const id of [
      "aaaaaaaa-0000-0000-0000-000000000001",
      "bbbbbbbb-0000-0000-0000-000000000002",
      "cccccccc-0000-0000-0000-000000000003",
      "dddddddd-0000-0000-0000-000000000004",
    ]) {
      const offset = triggerSplayOffsetSeconds(id, 900);
      expect(offset).toBeGreaterThanOrEqual(0);
      expect(offset).toBeLessThan(900);
      expect(Number.isInteger(offset)).toBe(true);
    }
  });

  it("spreads distinct trigger ids across the window (not all identical)", () => {
    const offsets = new Set(
      Array.from({ length: 20 }, (_, i) =>
        triggerSplayOffsetSeconds(`00000000-0000-0000-0000-0000000000${String(i).padStart(2, "0")}`, 900),
      ),
    );
    // With 20 ids over a 900s window a good hash should yield many distinct values.
    expect(offsets.size).toBeGreaterThan(10);
  });

  it("returns 0 when jitter is disabled (window <= 0)", () => {
    expect(triggerSplayOffsetSeconds("11111111-2222-3333-4444-555555555555", 0)).toBe(0);
    expect(triggerSplayOffsetSeconds("11111111-2222-3333-4444-555555555555", -5)).toBe(0);
  });
});

describe("nextScheduledRunAt", () => {
  const CRON_3H = "0 */3 * * *"; // the CEO pulse / watchdog collision cron
  const TZ = "UTC";
  const after = new Date("2026-07-19T00:30:00.000Z");

  it("adds the trigger's deterministic splay to the clean cron tick", () => {
    const triggerId = "11111111-2222-3333-4444-555555555555";
    const base = nextCronTickInTimeZone(CRON_3H, TZ, after)!;
    const offset = triggerSplayOffsetSeconds(triggerId, ROUTINE_TRIGGER_JITTER_WINDOW_SEC);
    const splayed = nextScheduledRunAt({ cronExpression: CRON_3H, timeZone: TZ, after, triggerId })!;
    expect(splayed.getTime()).toBe(base.getTime() + offset * 1000);
  });

  it("gives two triggers on the same cron slot different fire instants", () => {
    const a = nextScheduledRunAt({ cronExpression: CRON_3H, timeZone: TZ, after, triggerId: "aaaa1111-0000-0000-0000-000000000001" })!;
    const b = nextScheduledRunAt({ cronExpression: CRON_3H, timeZone: TZ, after, triggerId: "bbbb2222-0000-0000-0000-000000000002" })!;
    expect(a.getTime()).not.toBe(b.getTime());
    // both land in the same :00 minute's slot region, before the following tick
    const base = nextCronTickInTimeZone(CRON_3H, TZ, after)!;
    const following = nextCronTickInTimeZone(CRON_3H, TZ, base)!;
    for (const d of [a, b]) {
      expect(d.getTime()).toBeGreaterThanOrEqual(base.getTime());
      expect(d.getTime()).toBeLessThan(following.getTime());
    }
  });

  it("never splays into or past the following tick even for a per-minute cron", () => {
    const everyMinute = "* * * * *";
    const base = nextCronTickInTimeZone(everyMinute, TZ, after)!;
    const following = nextCronTickInTimeZone(everyMinute, TZ, base)!;
    for (const id of ["ffff0000-0000-0000-0000-000000000001", "ffff0000-0000-0000-0000-000000000009"]) {
      const d = nextScheduledRunAt({ cronExpression: everyMinute, timeZone: TZ, after, triggerId: id })!;
      expect(d.getTime()).toBeGreaterThanOrEqual(base.getTime());
      expect(d.getTime()).toBeLessThan(following.getTime());
    }
  });

  it("returns the clean tick unchanged when jitter is opted out (window 0)", () => {
    const triggerId = "11111111-2222-3333-4444-555555555555";
    const base = nextCronTickInTimeZone(CRON_3H, TZ, after)!;
    const splayed = nextScheduledRunAt({ cronExpression: CRON_3H, timeZone: TZ, after, triggerId, jitterWindowSec: 0 })!;
    expect(splayed.getTime()).toBe(base.getTime());
  });

  it("re-splaying from a previously splayed instant yields the next slot's stable splayed instant", () => {
    // Simulates the claim loop: nextRunAt is stored splayed, then recomputed from itself.
    const triggerId = "11111111-2222-3333-4444-555555555555";
    const first = nextScheduledRunAt({ cronExpression: CRON_3H, timeZone: TZ, after, triggerId })!;
    const second = nextScheduledRunAt({ cronExpression: CRON_3H, timeZone: TZ, after: first, triggerId })!;
    const cleanSecond = nextCronTickInTimeZone(CRON_3H, TZ, nextCronTickInTimeZone(CRON_3H, TZ, after)!)!;
    const offset = triggerSplayOffsetSeconds(triggerId, ROUTINE_TRIGGER_JITTER_WINDOW_SEC);
    // second fire is exactly one clean slot later, same sub-minute offset
    expect(second.getTime()).toBe(cleanSecond.getTime() + offset * 1000);
    expect(second.getTime() - first.getTime()).toBe(3 * 60 * 60 * 1000);
  });
});
