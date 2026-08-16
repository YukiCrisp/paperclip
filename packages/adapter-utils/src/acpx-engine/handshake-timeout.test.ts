import { describe, expect, it, vi } from "vitest";
import {
  ACPX_HANDSHAKE_TIMEOUT_ERROR_CODE,
  AcpxHandshakeTimeoutError,
  DEFAULT_ACPX_HANDSHAKE_TIMEOUT_MS,
  acpxHandshakeTimeoutMs,
  formatAcpxHandshakeTimeoutErrorMessage,
  formatAcpxHandshakeTimeoutStartLogLine,
  isAcpxHandshakeTimeoutError,
  withAcpxHandshakeTimeout,
} from "./handshake-timeout.js";

describe("acpxHandshakeTimeoutMs", () => {
  it("defaults to the handshake window when the shared knob is at its default", () => {
    expect(acpxHandshakeTimeoutMs(45 * 60 * 1000)).toBe(DEFAULT_ACPX_HANDSHAKE_TIMEOUT_MS);
  });

  // An operator who bounds a silent turn at 2 minutes is not asking to sit
  // through 3 minutes of session bring-up first.
  it("never exceeds the event-inactivity window it is derived from", () => {
    expect(acpxHandshakeTimeoutMs(120_000)).toBe(120_000);
  });

  it("is disabled together with the event-inactivity watchdog", () => {
    expect(acpxHandshakeTimeoutMs(0)).toBe(0);
  });

  it("honors the test-only override, still capped by the shared knob", () => {
    expect(acpxHandshakeTimeoutMs(45 * 60 * 1000, 5_000)).toBe(5_000);
    expect(acpxHandshakeTimeoutMs(1_000, 5_000)).toBe(1_000);
  });
});

describe("start-of-run log line", () => {
  it("names the phases it covers and the knob that controls it", () => {
    const line = formatAcpxHandshakeTimeoutStartLogLine(180_000);
    expect(line).toContain("3m 0s (180000ms)");
    expect(line).toContain("spawn + initialize + session/new");
    expect(line).toContain("outputInactivityTimeoutMs");
  });

  it("says so when the watchdog is off", () => {
    expect(formatAcpxHandshakeTimeoutStartLogLine(0)).toContain("DISABLED");
  });
});

describe("withAcpxHandshakeTimeout", () => {
  it("passes a handshake that lands inside the window straight through", async () => {
    await expect(
      withAcpxHandshakeTimeout({ timeoutMs: 10_000, start: async () => "handle" }),
    ).resolves.toBe("handle");
  });

  it("propagates the underlying failure unchanged rather than masking it", async () => {
    const boom = new Error("spawn ENOENT");
    await expect(
      withAcpxHandshakeTimeout({
        timeoutMs: 10_000,
        start: () => Promise.reject(boom),
      }),
    ).rejects.toBe(boom);
  });

  it("rejects with the watchdog error once the window elapses", async () => {
    vi.useFakeTimers();
    try {
      const pending = withAcpxHandshakeTimeout({
        timeoutMs: 5_000,
        start: () => new Promise<string>(() => {}),
      });
      const assertion = expect(pending).rejects.toBeInstanceOf(AcpxHandshakeTimeoutError);
      await vi.advanceTimersByTimeAsync(5_000);
      await assertion;
    } finally {
      vi.useRealTimers();
    }
  });

  // The abandoned attempt keeps running inside acpx, which takes no signal. If
  // it eventually succeeds, the session it produced has to be closed or the
  // stalled run leaks a live child into a server that outlives it.
  it("closes a handshake that lands after the watchdog gave up", async () => {
    vi.useFakeTimers();
    try {
      let land!: (value: string) => void;
      const onLateSettle = vi.fn();
      const pending = withAcpxHandshakeTimeout({
        timeoutMs: 5_000,
        start: () =>
          new Promise<string>((resolve) => {
            land = resolve;
          }),
        onLateSettle,
      });
      const assertion = expect(pending).rejects.toBeInstanceOf(AcpxHandshakeTimeoutError);
      await vi.advanceTimersByTimeAsync(5_000);
      await assertion;

      expect(onLateSettle).not.toHaveBeenCalled();
      land("late-handle");
      await vi.advanceTimersByTimeAsync(0);
      expect(onLateSettle).toHaveBeenCalledWith("late-handle");
    } finally {
      vi.useRealTimers();
    }
  });

  // A late rejection has nobody left to hand it to — the run already failed on
  // the watchdog error — and an unhandled rejection would take the process down.
  it("swallows a late rejection instead of crashing the process", async () => {
    vi.useFakeTimers();
    try {
      let fail!: (err: Error) => void;
      const pending = withAcpxHandshakeTimeout({
        timeoutMs: 5_000,
        start: () =>
          new Promise<string>((_resolve, reject) => {
            fail = reject;
          }),
        onLateSettle: () => {
          throw new Error("must not be called");
        },
      });
      const assertion = expect(pending).rejects.toBeInstanceOf(AcpxHandshakeTimeoutError);
      await vi.advanceTimersByTimeAsync(5_000);
      await assertion;

      fail(new Error("late spawn failure"));
      await vi.advanceTimersByTimeAsync(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("is a no-op wrapper when the watchdog is disabled", async () => {
    vi.useFakeTimers();
    try {
      const settled = vi.fn();
      const pending = withAcpxHandshakeTimeout({
        timeoutMs: 0,
        start: () => new Promise<string>(() => {}),
      }).then(settled);
      // Far past every window in this file; a disabled watchdog arms no timer.
      await vi.advanceTimersByTimeAsync(60 * 60 * 1000);
      expect(settled).not.toHaveBeenCalled();
      void pending;
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("error identity", () => {
  it("is recognised by class, not by message", () => {
    const err = new AcpxHandshakeTimeoutError(180_000);
    expect(isAcpxHandshakeTimeoutError(err)).toBe(true);
    expect(isAcpxHandshakeTimeoutError(new Error(err.message))).toBe(false);
    expect(err.timeoutMs).toBe(180_000);
    expect(err.message).toBe(formatAcpxHandshakeTimeoutErrorMessage(180_000));
  });

  it("keeps the error code distinct from the generic ensure_session bucket", () => {
    expect(ACPX_HANDSHAKE_TIMEOUT_ERROR_CODE).toBe("acpx_handshake_timeout");
    expect(ACPX_HANDSHAKE_TIMEOUT_ERROR_CODE).not.toBe("acpx_session_init_failed");
  });
});
