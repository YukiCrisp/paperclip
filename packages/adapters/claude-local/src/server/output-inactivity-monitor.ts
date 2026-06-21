import { parseJson } from "@paperclipai/adapter-utils/server-utils";

export const DEFAULT_CLAUDE_OUTPUT_INACTIVITY_TIMEOUT_MS = 15 * 60 * 1000;
export const CLAUDE_OUTPUT_INACTIVITY_MONITOR_SIGTERM_GRACE_MS = 5_000;

// Run-level wall-clock backstop. Aligns with the platform-level 4h critical
// silent-run monitor: a genuinely hung claude run self-terminates and frees
// its slot rather than holding it until an operator intervenes. This is the
// `opts.timeoutSec` hook the local adapter historically left at 0 (disabled).
export const DEFAULT_CLAUDE_RUN_WALL_CLOCK_TIMEOUT_SEC = 4 * 60 * 60;

export type ClaudeOutputInactivityMonitorResolution =
  | { mode: "default"; timeoutMs: number }
  | { mode: "configured"; timeoutMs: number }
  | { mode: "disabled"; reason: "explicit_null" }
  | { mode: "default"; timeoutMs: number; reason: "non_positive" };

/**
 * Resolve the inactivity monitor timeout from raw adapter config.
 *
 * - `null`         → disabled (explicit escape hatch).
 * - missing/`undefined` → default 15m.
 * - number > 0     → configured value.
 * - number ≤ 0     → default 15m (and a `non_positive` note for logging).
 */
export function resolveClaudeInactivityTimeout(rawValue: unknown): ClaudeOutputInactivityMonitorResolution {
  if (rawValue === null) return { mode: "disabled", reason: "explicit_null" };
  if (typeof rawValue === "number" && Number.isFinite(rawValue)) {
    if (rawValue > 0) return { mode: "configured", timeoutMs: rawValue };
    return { mode: "default", timeoutMs: DEFAULT_CLAUDE_OUTPUT_INACTIVITY_TIMEOUT_MS, reason: "non_positive" };
  }
  return { mode: "default", timeoutMs: DEFAULT_CLAUDE_OUTPUT_INACTIVITY_TIMEOUT_MS };
}

export type ClaudeRunWallClockResolution =
  | { mode: "passthrough"; timeoutSec: number }
  | { mode: "configured"; timeoutSec: number }
  | { mode: "default"; timeoutSec: number }
  | { mode: "default"; timeoutSec: number; reason: "non_positive" }
  | { mode: "disabled"; reason: "explicit_null" };

/**
 * Resolve the run-level wall-clock cap for the streaming inference process.
 *
 * `resolvedTimeoutSec` is whatever {@link resolveAdapterExecutionTargetTimeoutSec}
 * already produced (an explicit `config.timeoutSec`, or a sandbox default).
 * When that path already yields a positive cap we honor it verbatim
 * (`passthrough`) — the operator/sandbox owns the deadline. Only when it is 0
 * (the historical "disabled for local" case) do we apply a backstop:
 *
 * - `runWallClockTimeoutSec` === `null`        → stay disabled (escape hatch).
 * - `runWallClockTimeoutSec` number > 0        → that value.
 * - `runWallClockTimeoutSec` number ≤ 0        → default 4h (`non_positive` note).
 * - missing/`undefined`                        → default 4h.
 */
export function resolveClaudeRunWallClockTimeoutSec(input: {
  resolvedTimeoutSec: number;
  rawRunWallClockTimeoutSec: unknown;
}): ClaudeRunWallClockResolution {
  const { resolvedTimeoutSec, rawRunWallClockTimeoutSec } = input;
  if (typeof resolvedTimeoutSec === "number" && Number.isFinite(resolvedTimeoutSec) && resolvedTimeoutSec > 0) {
    return { mode: "passthrough", timeoutSec: Math.floor(resolvedTimeoutSec) };
  }
  if (rawRunWallClockTimeoutSec === null) {
    return { mode: "disabled", reason: "explicit_null" };
  }
  if (typeof rawRunWallClockTimeoutSec === "number" && Number.isFinite(rawRunWallClockTimeoutSec)) {
    if (rawRunWallClockTimeoutSec > 0) {
      return { mode: "configured", timeoutSec: Math.floor(rawRunWallClockTimeoutSec) };
    }
    return { mode: "default", timeoutSec: DEFAULT_CLAUDE_RUN_WALL_CLOCK_TIMEOUT_SEC, reason: "non_positive" };
  }
  return { mode: "default", timeoutSec: DEFAULT_CLAUDE_RUN_WALL_CLOCK_TIMEOUT_SEC };
}

export interface ClaudeOutputInactivityMonitorState {
  fired: boolean;
  spawnedAt: number;
  lastEventAt: number;
  firedAt: number | null;
  parsedEventCount: number;
}

export interface ClaudeOutputInactivityMonitorOptions {
  timeoutMs: number;
  onFire: (state: ClaudeOutputInactivityMonitorState) => void;
  now?: () => number;
  setTimer?: (cb: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
  /**
   * Per-line predicate. When omitted, any line that successfully parses as
   * JSON counts as a heartbeat event. Claude runs with
   * `--output-format stream-json`, so every system/assistant/user/result
   * event — including the assistant turns that carry thinking output — is a
   * line-delimited JSON object. We deliberately do NOT key off a specific
   * event type: the proximate incident stalled mid-inference with zero
   * stdout, so "any JSON line resets the timer" is the robust signal.
   */
  isHeartbeatLine?: (line: string) => boolean;
}

export interface ClaudeOutputInactivityMonitorHandle {
  noteStdoutChunk(chunk: string): void;
  /** Returns the current state without stopping the timer. */
  state(): ClaudeOutputInactivityMonitorState;
  /** Cancels any pending timer and returns the final state. */
  stop(): ClaudeOutputInactivityMonitorState;
}

function defaultIsHeartbeatLine(line: string): boolean {
  const trimmed = line.trim();
  if (!trimmed) return false;
  return parseJson(trimmed) !== null;
}

export function createClaudeOutputInactivityMonitor(
  options: ClaudeOutputInactivityMonitorOptions,
): ClaudeOutputInactivityMonitorHandle {
  const now = options.now ?? (() => Date.now());
  const setTimer = options.setTimer ?? ((cb, ms) => setTimeout(cb, ms));
  const clearTimer = options.clearTimer ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>));
  const isHeartbeatLine = options.isHeartbeatLine ?? defaultIsHeartbeatLine;
  const timeoutMs = options.timeoutMs;

  if (!(timeoutMs > 0)) {
    throw new Error(`createClaudeOutputInactivityMonitor requires timeoutMs > 0 (got ${timeoutMs})`);
  }

  const spawnedAt = now();
  const state: ClaudeOutputInactivityMonitorState = {
    fired: false,
    spawnedAt,
    lastEventAt: spawnedAt,
    firedAt: null,
    parsedEventCount: 0,
  };
  let timerHandle: unknown = null;
  let stopped = false;

  const fire = () => {
    if (state.fired || stopped) return;
    state.fired = true;
    state.firedAt = now();
    timerHandle = null;
    options.onFire({ ...state });
  };

  const arm = () => {
    if (stopped || state.fired) return;
    if (timerHandle != null) clearTimer(timerHandle);
    timerHandle = setTimer(fire, timeoutMs);
  };

  arm();

  return {
    noteStdoutChunk(chunk: string) {
      if (stopped || state.fired) return;
      let sawHeartbeat = false;
      for (const rawLine of chunk.split(/\r?\n/)) {
        if (isHeartbeatLine(rawLine)) {
          sawHeartbeat = true;
          state.parsedEventCount += 1;
        }
      }
      if (sawHeartbeat) {
        state.lastEventAt = now();
        arm();
      }
    },
    state() {
      return { ...state };
    },
    stop() {
      stopped = true;
      if (timerHandle != null) {
        clearTimer(timerHandle);
        timerHandle = null;
      }
      return { ...state };
    },
  };
}

/**
 * Format the inactivity monitor error message in the canonical
 * `monitor: no claude output for {N}m {S}s` shape.
 */
export function formatOutputInactivityMonitorErrorMessage(elapsedMs: number): string {
  const total = Math.max(0, Math.round(elapsedMs / 1000));
  const minutes = Math.floor(total / 60);
  const seconds = total - minutes * 60;
  return `monitor: no claude output for ${minutes}m ${seconds}s`;
}
