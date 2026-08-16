/**
 * Watchdog for the ACP session handshake.
 *
 * `runtime.ensureSession(...)` covers three phases, and only the last one is
 * bounded by the ACP runtime itself:
 *
 *   1. **spawn** — `waitForSpawn` resolves on the child's `spawn` event and
 *      rejects on `error`. No timer. A child that neither spawns nor errors
 *      waits forever.
 *   2. **initialize** — the ACP `initialize` request. The runtime wraps this in
 *      a timeout for the Gemini command shape only; on every other agent,
 *      including `claude-agent-acp`, it is a bare `await`.
 *   3. **session/new** — bounded at 60s for the Claude command shape
 *      (`ACPX_CLAUDE_ACP_SESSION_CREATE_TIMEOUT_MS` overrides it), and
 *      unbounded for everything else.
 *
 * So on the lane Paperclip actually runs, a handshake can consume unlimited
 * wall-clock before the one bounded phase even starts. Measured over the 1312
 * handshakes recorded as `run.startup.step` events:
 *
 *   - 1162 runs that went on to succeed: median 2.4s, p90 3.5s, **worst 15.8s**.
 *   - 21 runs above that: 279.7s to 1065.5s (17.8 minutes). Every one of them
 *     failed. 20 died with the runtime's own `session/new` timeout, which puts
 *     219.7s–1005.5s of each in the unbounded phases above; the 21st reached a
 *     turn after a 13-minute handshake and then failed anyway.
 *   - **Nothing at all between 15.8s and 279.7s.**
 *
 * A run that spends 17 minutes here does no work and then fails, so the whole
 * cost is dead air. Bounding it turns that into a fast, retryable failure.
 */

/**
 * Default bound on the whole handshake.
 *
 * Sits inside the empty measured gap: 11.4x the worst handshake any successful
 * run has ever taken (15.8s), and comfortably below the fastest pathological
 * one (279.7s), so on the observed population it kills every stall and zero
 * healthy sessions.
 *
 * Deliberately above the runtime's own 60s `session/new` bound rather than
 * under it. A stall that is genuinely in `session/new` should keep surfacing
 * through the runtime's own error, which names that phase and carries the
 * known-cause remediation text; this watchdog is for the phases underneath it,
 * which report nothing at all.
 */
export const DEFAULT_ACPX_HANDSHAKE_TIMEOUT_MS = 3 * 60 * 1000;

/**
 * Dedicated error code, deliberately NOT the generic `acpx_session_init_failed`
 * phase bucket. That bucket is the adapter's fallback for any `ensure_session`
 * error, so treating it as an upstream stall needs a message gate; a watchdog
 * kill is Paperclip-authored and means exactly one thing, so it classifies on
 * the code alone. Being retryable is what makes a false positive survivable —
 * a handshake cut short loses no work, because no work had started.
 */
export const ACPX_HANDSHAKE_TIMEOUT_ERROR_CODE = "acpx_handshake_timeout";

/** Thrown when the watchdog fires; identified by class, never by message. */
export class AcpxHandshakeTimeoutError extends Error {
  readonly timeoutMs: number;

  constructor(timeoutMs: number) {
    super(formatAcpxHandshakeTimeoutErrorMessage(timeoutMs));
    this.name = "AcpxHandshakeTimeoutError";
    this.timeoutMs = timeoutMs;
  }
}

export function isAcpxHandshakeTimeoutError(err: unknown): err is AcpxHandshakeTimeoutError {
  return err instanceof AcpxHandshakeTimeoutError;
}

/**
 * Effective handshake window in ms, or 0 when the watchdog is off.
 *
 * There is deliberately no new operator knob, for the same reason the
 * pre-first-event window has none: the bound is derived from
 * `adapterConfig.outputInactivityTimeoutMs`, which the operator has already
 * tuned. It is never longer than that window (asking for a 2-minute bound on a
 * silent turn is not asking to wait 3 minutes for the session to come up), and
 * setting the knob to `null` disables this watchdog along with the others. One
 * escape hatch, not three.
 */
export function acpxHandshakeTimeoutMs(
  eventInactivityMs: number,
  handshakeMs: number = DEFAULT_ACPX_HANDSHAKE_TIMEOUT_MS,
): number {
  if (eventInactivityMs <= 0) return 0;
  return Math.min(handshakeMs, eventInactivityMs);
}

function formatDuration(ms: number): string {
  const totalSeconds = Math.max(0, Math.round(ms / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}m ${seconds}s`;
}

/**
 * Start-of-run log line, alongside the wall-clock and event-inactivity lines so
 * every bound on the run is visible before anything goes wrong.
 */
export function formatAcpxHandshakeTimeoutStartLogLine(timeoutMs: number): string {
  if (timeoutMs <= 0) {
    return (
      "ACP handshake watchdog: DISABLED via adapterConfig.outputInactivityTimeoutMs=null. " +
      "Session spawn and initialize have no bound of their own."
    );
  }
  return (
    `ACP handshake watchdog: ${formatDuration(timeoutMs)} (${timeoutMs}ms) for spawn + initialize + session/new; ` +
    "derived from adapterConfig.outputInactivityTimeoutMs, which also caps and disables it."
  );
}

/** Error message surfaced on the run when the watchdog fires. */
export function formatAcpxHandshakeTimeoutErrorMessage(timeoutMs: number): string {
  return (
    `watchdog: the ACP session handshake produced nothing for ${formatDuration(timeoutMs)}; ` +
    "the run was abandoned before any work started."
  );
}

/**
 * Race `start()` against the watchdog window.
 *
 * Nothing here can cancel the handshake — `ensureSession` takes no signal — so
 * the abandoned attempt keeps running inside the ACP runtime. `onLateSettle`
 * exists for exactly that: if the handshake lands after we have given up, the
 * caller closes the session it produced, otherwise a stalled run would leak a
 * live child process and a persisted session record into a server that outlives
 * it. A late *rejection* is swallowed, since the caller has already failed the
 * run on the watchdog error and an unhandled rejection would take the process
 * down with it.
 *
 * `timeoutMs <= 0` returns the underlying promise untouched — no timer, no
 * wrapper, no behaviour change at all.
 */
export async function withAcpxHandshakeTimeout<T>(input: {
  timeoutMs: number;
  start: () => Promise<T>;
  onLateSettle?: (value: T) => void;
}): Promise<T> {
  const pending = input.start();
  if (input.timeoutMs <= 0) return await pending;

  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      pending,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new AcpxHandshakeTimeoutError(input.timeoutMs)),
          input.timeoutMs,
        );
      }),
    ]);
  } catch (err) {
    if (isAcpxHandshakeTimeoutError(err)) {
      void pending.then(
        (value) => {
          try {
            input.onLateSettle?.(value);
          } catch {
            // Cleanup must not resurface as an unhandled rejection.
          }
        },
        () => {},
      );
    }
    throw err;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
