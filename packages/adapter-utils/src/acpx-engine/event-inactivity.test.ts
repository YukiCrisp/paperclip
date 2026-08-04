import { describe, expect, it } from "vitest";
import {
  ACPX_EVENT_INACTIVITY_ERROR_CODE,
  DEFAULT_ACPX_EVENT_INACTIVITY_TIMEOUT_MS,
  DEFAULT_ACPX_FIRST_EVENT_TIMEOUT_MS,
  MAX_ACPX_EVENT_INACTIVITY_CANCEL_GRACE_MS,
  acpxEventInactivityCancelGraceMs,
  acpxEventInactivityTimeoutMs,
  acpxFirstEventTimeoutMs,
  formatAcpxEventInactivityErrorMessage,
  formatAcpxEventInactivityStartLogLine,
  formatAcpxFirstEventTimeoutErrorMessage,
  resolveAcpxEventInactivityTimeout,
} from "./event-inactivity.js";
import { settleTurnResultWithinGrace } from "./execute.js";

describe("resolveAcpxEventInactivityTimeout", () => {
  it("defaults when the knob is unset", () => {
    expect(resolveAcpxEventInactivityTimeout(undefined)).toEqual({
      mode: "default",
      timeoutMs: DEFAULT_ACPX_EVENT_INACTIVITY_TIMEOUT_MS,
    });
  });

  it("treats an explicit null as the disable escape hatch", () => {
    expect(resolveAcpxEventInactivityTimeout(null)).toEqual({
      mode: "disabled",
      reason: "explicit_null",
    });
  });

  it("honors a positive configured value", () => {
    expect(resolveAcpxEventInactivityTimeout(90_000)).toEqual({
      mode: "configured",
      timeoutMs: 90_000,
    });
  });

  // The adapter-config UI persists 0 for untouched numeric fields, so 0 cannot
  // mean "disabled" — that would silently un-arm the watchdog for every agent
  // that has ever opened the config form. Same reasoning as `timeoutSec`.
  it("falls back to the default for non-positive values rather than disabling", () => {
    expect(resolveAcpxEventInactivityTimeout(0)).toEqual({
      mode: "default",
      timeoutMs: DEFAULT_ACPX_EVENT_INACTIVITY_TIMEOUT_MS,
      reason: "non_positive",
    });
    expect(resolveAcpxEventInactivityTimeout(-1)).toEqual({
      mode: "default",
      timeoutMs: DEFAULT_ACPX_EVENT_INACTIVITY_TIMEOUT_MS,
      reason: "non_positive",
    });
  });

  it("ignores non-numeric junk", () => {
    expect(resolveAcpxEventInactivityTimeout("600000")).toEqual({
      mode: "default",
      timeoutMs: DEFAULT_ACPX_EVENT_INACTIVITY_TIMEOUT_MS,
    });
    expect(resolveAcpxEventInactivityTimeout(Number.NaN)).toEqual({
      mode: "default",
      timeoutMs: DEFAULT_ACPX_EVENT_INACTIVITY_TIMEOUT_MS,
    });
  });

  it("reports 0 ms only when disabled", () => {
    expect(acpxEventInactivityTimeoutMs(resolveAcpxEventInactivityTimeout(null))).toBe(0);
    expect(acpxEventInactivityTimeoutMs(resolveAcpxEventInactivityTimeout(0))).toBe(
      DEFAULT_ACPX_EVENT_INACTIVITY_TIMEOUT_MS,
    );
  });
});

describe("acpxFirstEventTimeoutMs", () => {
  it("uses the short first-event default under the full window", () => {
    expect(acpxFirstEventTimeoutMs(DEFAULT_ACPX_EVENT_INACTIVITY_TIMEOUT_MS)).toBe(
      DEFAULT_ACPX_FIRST_EVENT_TIMEOUT_MS,
    );
    expect(DEFAULT_ACPX_FIRST_EVENT_TIMEOUT_MS).toBeLessThan(
      DEFAULT_ACPX_EVENT_INACTIVITY_TIMEOUT_MS,
    );
  });

  // An operator who asks for a 2-minute bound on the whole turn is not asking
  // to wait 10 minutes for the first event. There is one knob, and it caps both.
  it("never exceeds a tighter configured window", () => {
    expect(acpxFirstEventTimeoutMs(120_000)).toBe(120_000);
    expect(acpxFirstEventTimeoutMs(DEFAULT_ACPX_FIRST_EVENT_TIMEOUT_MS + 1)).toBe(
      DEFAULT_ACPX_FIRST_EVENT_TIMEOUT_MS,
    );
  });

  // `outputInactivityTimeoutMs = null` has to switch off both windows, not just
  // the long one — otherwise the documented escape hatch would silently leave a
  // 10-minute bound armed.
  it("is off whenever the watchdog itself is off", () => {
    expect(acpxFirstEventTimeoutMs(acpxEventInactivityTimeoutMs({ mode: "disabled", reason: "explicit_null" }))).toBe(0);
    expect(acpxFirstEventTimeoutMs(0)).toBe(0);
  });
});

describe("acpxEventInactivityCancelGraceMs", () => {
  it("caps the cancel grace at a minute for the default window", () => {
    expect(acpxEventInactivityCancelGraceMs(DEFAULT_ACPX_EVENT_INACTIVITY_TIMEOUT_MS)).toBe(
      MAX_ACPX_EVENT_INACTIVITY_CANCEL_GRACE_MS,
    );
  });

  // An operator who tightens the window is asking for a tighter bound on the
  // whole turn; spending longer on the cancel ack than on the agent itself
  // would defeat that.
  it("never waits longer for the cancel ack than the silence that triggered it", () => {
    expect(acpxEventInactivityCancelGraceMs(5_000)).toBe(5_000);
    expect(acpxEventInactivityCancelGraceMs(0)).toBe(1);
  });
});

describe("acpx event-inactivity log lines", () => {
  it("names the override knob on the default line", () => {
    expect(formatAcpxEventInactivityStartLogLine(resolveAcpxEventInactivityTimeout(undefined))).toBe(
      "ACP event inactivity watchdog: 45m 0s (2700000ms) (default); " +
        "set adapterConfig.outputInactivityTimeoutMs to override, or null to disable." +
        " Until the first event of the turn: 10m 0s (600000ms).",
    );
  });

  // The tighter bound is the one most likely to be blamed for a surprising
  // kill, so it is stated up front rather than left to be inferred.
  it("states the first-event window on the configured line too", () => {
    expect(
      formatAcpxEventInactivityStartLogLine(resolveAcpxEventInactivityTimeout(120_000)),
    ).toBe(
      "ACP event inactivity watchdog: 2m 0s (120000ms), configured via adapterConfig.outputInactivityTimeoutMs." +
        " Until the first event of the turn: 2m 0s (120000ms).",
    );
  });

  it("says DISABLED loudly when the watchdog is off", () => {
    const line = formatAcpxEventInactivityStartLogLine(resolveAcpxEventInactivityTimeout(null));
    expect(line).toContain("DISABLED");
    // Nothing is armed, so advertising a first-event window would be a lie.
    expect(line).not.toContain("first event");
  });

  it("formats the fire message with a human duration", () => {
    expect(formatAcpxEventInactivityErrorMessage(90_000)).toBe(
      "watchdog: no ACP events for 1m 30s; the turn was cancelled as unresponsive.",
    );
  });

  // Same code, different sentence: the retry behaviour is identical, but the
  // two silences point at completely different causes and the run error is the
  // only place that distinction survives.
  it("distinguishes the pre-first-event kill in its wording", () => {
    expect(formatAcpxFirstEventTimeoutErrorMessage(DEFAULT_ACPX_FIRST_EVENT_TIMEOUT_MS)).toBe(
      "watchdog: no ACP events at all in the 10m 0s since the session was established; " +
        "the turn was cancelled as unresponsive.",
    );
    expect(formatAcpxFirstEventTimeoutErrorMessage(600_000)).not.toBe(
      formatAcpxEventInactivityErrorMessage(600_000),
    );
  });

  // The server classifies this code without a message gate, so the message must
  // not be mistakable for the connectivity strings the acpx phase buckets gate on.
  it("keeps its own error code distinct from the generic acpx phase buckets", () => {
    expect(ACPX_EVENT_INACTIVITY_ERROR_CODE).toBe("acpx_event_inactivity");
    expect(ACPX_EVENT_INACTIVITY_ERROR_CODE).not.toBe("acpx_turn_failed");
  });
});

describe("settleTurnResultWithinGrace", () => {
  it("returns the real terminal when the turn settles inside the grace window", async () => {
    const settled = await settleTurnResultWithinGrace(
      Promise.resolve({ status: "completed", stopReason: "end_turn" } as const),
      5_000,
      "watchdog",
    );
    expect(settled).toEqual({ status: "completed", stopReason: "end_turn" });
  });

  // The whole point: a child wedged enough to trip the watchdog may also never
  // acknowledge the in-band cancel, and `await turn.result` would then hang
  // exactly like the event loop the watchdog just escaped.
  it("synthesizes a cancelled terminal when the turn never settles", async () => {
    const settled = await settleTurnResultWithinGrace(new Promise(() => {}), 20, "watchdog");
    expect(settled).toEqual({ status: "cancelled", stopReason: "watchdog" });
  });
});
