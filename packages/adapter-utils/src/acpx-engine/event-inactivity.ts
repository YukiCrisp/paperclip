/**
 * Event-silence watchdog for ACPX turns.
 *
 * An ACPX turn is consumed as `for await (const event of turn.events)`. Nothing
 * bounds that loop on local/SSH targets: the shared execution-target resolver
 * returns `{timeoutSec: 0, source: "unlimited"}` there, so the adapter
 * wall-clock guard is never armed and a wedged agent child can hold the run for
 * hours. Measured in production: turns that ended in
 * "Unable to connect to API (ConnectionRefused)" ran 50-130 minutes, with the
 * session established in ~4 seconds and then **zero** events and zero child
 * stderr until the very last message. The agent child retries the upstream API
 * internally and silently, so there is no early connectivity signal to fail
 * fast on -- the only observable is that the event stream goes quiet.
 *
 * Hence a watchdog on event silence rather than on connectivity. It is
 * deliberately conservative: ACPX emits an event for every text delta, thought
 * delta, tool call, tool-call update, and status/usage update, so a turn that
 * is making any progress at all resets the timer continuously. Silence for the
 * full window means the child is producing nothing observable.
 */

/**
 * Conservative default. Well above any plausible legitimate ACP silence (the
 * quietest normal shape is a single long-running tool call, which still brackets
 * itself with `tool_call` events), and below the platform-level 1h suspicion /
 * 4h critical silent-run thresholds so the adapter bounds its own run before
 * the platform net has to.
 */
export const DEFAULT_ACPX_EVENT_INACTIVITY_TIMEOUT_MS = 45 * 60 * 1000;

/**
 * Tighter window for the stretch between "session established" and the *first*
 * event of the turn.
 *
 * The 45-minute default above is sized for silence *inside* a turn, where a
 * single long-running tool call can legitimately go quiet for a long time.
 * Before the first event there is no such shape: measured over 408 production
 * runs, session-established -> first-event is a median of 1.5s, p90 3.3s, p99
 * 9.9s, and every one of the three runs that exceeded 19s was inside a known
 * upstream-API outage. A turn that has said literally nothing since the session
 * came up is not working slowly, it is not working.
 *
 * Waiting 45 minutes on that shape is what turned one upstream outage into 22
 * runs x 45 minutes of dead air. 10 minutes is ~32x the worst healthy
 * observation, so it is still far outside anything normal -- deliberately
 * generous, because the cost of being wrong is one extra retry (the watchdog
 * error code is on the transient ladder), while the cost of the old behaviour
 * was 16.5 hours of spin.
 */
export const DEFAULT_ACPX_FIRST_EVENT_TIMEOUT_MS = 10 * 60 * 1000;

/**
 * Ceiling on how long to wait for `turn.result` after the watchdog has aborted
 * the turn.
 *
 * Abort is delivered as an in-band ACP `session/cancel`; a child that is wedged
 * badly enough may never acknowledge it, in which case `await turn.result`
 * would hang exactly like the loop we just escaped. After the grace window the
 * engine synthesizes a `cancelled` terminal itself and proceeds to teardown.
 */
export const MAX_ACPX_EVENT_INACTIVITY_CANCEL_GRACE_MS = 60 * 1000;

/**
 * Grace actually granted for the cancel acknowledgement: the ceiling above, but
 * never longer than the silence that triggered the watchdog. An operator who
 * tightens `outputInactivityTimeoutMs` is asking for a tighter bound on the
 * whole turn, and it would be incoherent to then spend more time waiting for
 * the cancel than we were willing to spend waiting for the agent.
 */
export function acpxEventInactivityCancelGraceMs(timeoutMs: number): number {
  return Math.max(1, Math.min(MAX_ACPX_EVENT_INACTIVITY_CANCEL_GRACE_MS, timeoutMs));
}

/**
 * Dedicated error code, deliberately NOT the generic `acpx_turn_failed` phase
 * bucket. A watchdog kill is a Paperclip-authored, unambiguous signal, so it can
 * be mapped to the transient retry ladder on the code alone -- unlike
 * `acpx_turn_failed`, which is the adapter's fallback for any turn error and
 * therefore needs a message gate before it can be treated as transient. Being
 * retryable is what makes a false positive survivable: a legitimately slow turn
 * that gets cut loses its progress but the issue is re-attempted rather than
 * escalated.
 */
export const ACPX_EVENT_INACTIVITY_ERROR_CODE = "acpx_event_inactivity";

export type AcpxEventInactivityResolution =
  | { mode: "default"; timeoutMs: number }
  | { mode: "default"; timeoutMs: number; reason: "non_positive" }
  | { mode: "configured"; timeoutMs: number }
  | { mode: "disabled"; reason: "explicit_null" };

/**
 * Resolve the watchdog window from raw adapter config
 * (`adapterConfig.outputInactivityTimeoutMs`).
 *
 * The knob is shared with the non-ACPX claude-local/codex-local monitors and
 * carries the same meaning on this lane -- "fail the run when the agent has
 * produced no output for this long" -- so an operator who has already tuned it
 * does not have to learn a second name.
 *
 * - `null`               -> disabled (explicit escape hatch).
 * - missing/`undefined`  -> default.
 * - number > 0           -> configured value.
 * - number <= 0          -> default, with a `non_positive` note for logging.
 */
export function resolveAcpxEventInactivityTimeout(rawValue: unknown): AcpxEventInactivityResolution {
  if (rawValue === null) return { mode: "disabled", reason: "explicit_null" };
  if (typeof rawValue === "number" && Number.isFinite(rawValue)) {
    if (rawValue > 0) return { mode: "configured", timeoutMs: rawValue };
    return {
      mode: "default",
      timeoutMs: DEFAULT_ACPX_EVENT_INACTIVITY_TIMEOUT_MS,
      reason: "non_positive",
    };
  }
  return { mode: "default", timeoutMs: DEFAULT_ACPX_EVENT_INACTIVITY_TIMEOUT_MS };
}

/** Effective window in ms, or 0 when the watchdog is off. */
export function acpxEventInactivityTimeoutMs(resolution: AcpxEventInactivityResolution): number {
  return resolution.mode === "disabled" ? 0 : resolution.timeoutMs;
}

/**
 * Effective pre-first-event window in ms, or 0 when the watchdog is off.
 *
 * There is deliberately no separate knob. The first-event window is derived
 * from the one the operator already tuned: it is never longer than that window
 * (someone who asks for a 2-minute bound on the whole turn is not asking to
 * wait 10 minutes for the first event), and `outputInactivityTimeoutMs = null`
 * disables both together. One escape hatch, not two.
 */
export function acpxFirstEventTimeoutMs(
  eventInactivityMs: number,
  firstEventMs: number = DEFAULT_ACPX_FIRST_EVENT_TIMEOUT_MS,
): number {
  if (eventInactivityMs <= 0) return 0;
  return Math.min(firstEventMs, eventInactivityMs);
}

function formatDuration(ms: number): string {
  const totalSeconds = Math.max(0, Math.round(ms / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}m ${seconds}s`;
}

/**
 * Start-of-run log line, mirroring the adapter wall-clock timeout line so both
 * bounds on a turn are visible in the run log before anything goes wrong.
 */
export function formatAcpxEventInactivityStartLogLine(
  resolution: AcpxEventInactivityResolution,
  firstEventOverrideMs?: number,
): string {
  if (resolution.mode === "disabled") {
    return (
      "ACP event inactivity watchdog: DISABLED via adapterConfig.outputInactivityTimeoutMs=null. " +
      "A silent turn will only be bounded by the platform-level silent-run safety net."
    );
  }
  const window = `${formatDuration(resolution.timeoutMs)} (${resolution.timeoutMs}ms)`;
  const firstEventMs = acpxFirstEventTimeoutMs(resolution.timeoutMs, firstEventOverrideMs);
  const firstEvent =
    ` Until the first event of the turn: ${formatDuration(firstEventMs)} (${firstEventMs}ms).`;
  if (resolution.mode === "configured") {
    return (
      `ACP event inactivity watchdog: ${window}, configured via adapterConfig.outputInactivityTimeoutMs.` +
      firstEvent
    );
  }
  if ("reason" in resolution && resolution.reason === "non_positive") {
    return (
      `ACP event inactivity watchdog: ${window} (default). ` +
      "Ignoring non-positive adapterConfig.outputInactivityTimeoutMs; set it to null to disable." +
      firstEvent
    );
  }
  return (
    `ACP event inactivity watchdog: ${window} (default); ` +
    "set adapterConfig.outputInactivityTimeoutMs to override, or null to disable." +
    firstEvent
  );
}

/** Error message surfaced on the run when the watchdog fires mid-turn. */
export function formatAcpxEventInactivityErrorMessage(timeoutMs: number): string {
  return `watchdog: no ACP events for ${formatDuration(timeoutMs)}; the turn was cancelled as unresponsive.`;
}

/**
 * Error message for the pre-first-event flavour of the same kill.
 *
 * Same `errorCode` — the retry classification is identical and there is nothing
 * to gain from splitting it — but the wording has to let an operator reading a
 * failed run tell "went quiet halfway through a tool call" apart from "never
 * said anything at all", because those two point at completely different causes.
 */
export function formatAcpxFirstEventTimeoutErrorMessage(timeoutMs: number): string {
  return (
    `watchdog: no ACP events at all in the ${formatDuration(timeoutMs)} since the session was established; ` +
    "the turn was cancelled as unresponsive."
  );
}
