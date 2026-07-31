import { describe, expect, it } from "vitest";
import {
  ACPX_EVENT_INACTIVITY_ERROR_CODE,
  DEFAULT_ACPX_EVENT_INACTIVITY_TIMEOUT_MS,
  MAX_ACPX_EVENT_INACTIVITY_CANCEL_GRACE_MS,
  acpxEventInactivityCancelGraceMs,
  acpxEventInactivityTimeoutMs,
  formatAcpxEventInactivityErrorMessage,
  formatAcpxEventInactivityStartLogLine,
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
        "set adapterConfig.outputInactivityTimeoutMs to override, or null to disable.",
    );
  });

  it("says DISABLED loudly when the watchdog is off", () => {
    expect(formatAcpxEventInactivityStartLogLine(resolveAcpxEventInactivityTimeout(null))).toContain(
      "DISABLED",
    );
  });

  it("formats the fire message with a human duration", () => {
    expect(formatAcpxEventInactivityErrorMessage(90_000)).toBe(
      "watchdog: no ACP events for 1m 30s; the turn was cancelled as unresponsive.",
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
