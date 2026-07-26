// Decides whether the embedded postmaster referenced by postmaster.pid can be
// reused for this boot. A postmaster that is mid-shutdown still holds
// postmaster.pid and still answers kill(pid, 0), so PID liveness alone is not a
// safe reuse signal: booting against it fails on the first connection with
// "FATAL: the database system is shutting down" and the server exits within
// seconds — fast enough to exhaust the ENGA-328 supervisor's retry budget
// before a slow shutdown (checkpoint) completes (ENGA-1310).
//
// The reuse decision here is "alive AND accepting connections". When the
// postmaster is alive but unreachable, we wait (bounded) for it to finish
// exiting so the caller can start a fresh one, escalating to a PostgreSQL fast
// shutdown (SIGINT) and then an immediate shutdown (SIGQUIT) only after the
// wait deadline passes.
//
// The wait polls connectability alongside PID liveness: "alive but unreachable"
// also covers a postmaster still doing crash recovery, which becomes usable on
// its own. Polling both means such a postmaster is reused within a poll interval
// instead of costing the whole 60s deadline inside the supervisor's 90s boot
// health window.

export const EMBEDDED_POSTGRES_REUSE_POLL_INTERVAL_MS = 1_000;
// Common case: a SIGTERM'd parent server whose postmaster is checkpointing.
// Must comfortably exceed a slow checkpoint but leave room inside one
// supervisor boot attempt (90s health window) for the fresh start that follows.
export const EMBEDDED_POSTGRES_SHUTDOWN_WAIT_MS = 60_000;
export const EMBEDDED_POSTGRES_FAST_SHUTDOWN_WAIT_MS = 15_000;
export const EMBEDDED_POSTGRES_IMMEDIATE_SHUTDOWN_WAIT_MS = 5_000;

export type EmbeddedPostgresReuseDeps = {
  /** Re-reads postmaster.pid and probes liveness; null once the postmaster is gone. */
  getRunningPid: () => number | null;
  /** True when the port advertised in postmaster.pid answers and serves the expected data directory. */
  isConnectable: () => Promise<boolean>;
  signal: (pid: number, signal: "SIGINT" | "SIGQUIT") => void;
  sleep: (ms: number) => Promise<void>;
  warn: (message: string) => void;
};

export type EmbeddedPostgresReuseResult =
  | { action: "reuse"; pid: number }
  | { action: "start-fresh" };

type PostmasterWaitResult =
  | { state: "gone" }
  | { state: "connectable"; pid: number }
  | { state: "alive"; pid: number };

/**
 * Polls until the postmaster exits or the deadline passes.
 *
 * `probeConnectable` also checks connectability on every poll, so a postmaster
 * that is merely slow to come up (crash recovery) is picked up within one poll
 * interval instead of after the whole deadline. Waits that follow a shutdown
 * signal leave it off: we have already committed to killing that postmaster,
 * and one in fast/immediate shutdown refuses new connections anyway.
 */
async function waitForPostmasterExit(
  deps: EmbeddedPostgresReuseDeps,
  waitMs: number,
  { probeConnectable }: { probeConnectable: boolean },
): Promise<PostmasterWaitResult> {
  const polls = Math.ceil(waitMs / EMBEDDED_POSTGRES_REUSE_POLL_INTERVAL_MS);
  let pid = deps.getRunningPid();
  for (let i = 0; i < polls && pid !== null; i++) {
    await deps.sleep(EMBEDDED_POSTGRES_REUSE_POLL_INTERVAL_MS);
    pid = deps.getRunningPid();
    if (pid === null) break;
    if (probeConnectable && (await deps.isConnectable())) {
      return { state: "connectable", pid };
    }
  }
  return pid === null ? { state: "gone" } : { state: "alive", pid };
}

export async function resolveEmbeddedPostgresReuse(
  deps: EmbeddedPostgresReuseDeps,
): Promise<EmbeddedPostgresReuseResult> {
  let pid = deps.getRunningPid();
  if (pid === null) return { action: "start-fresh" };

  if (await deps.isConnectable()) return { action: "reuse", pid };

  deps.warn(
    `Embedded PostgreSQL pid ${pid} is alive but not accepting connections (likely shutting down); ` +
      `waiting up to ${EMBEDDED_POSTGRES_SHUTDOWN_WAIT_MS / 1000}s for it to exit before starting fresh`,
  );
  const waited = await waitForPostmasterExit(deps, EMBEDDED_POSTGRES_SHUTDOWN_WAIT_MS, {
    probeConnectable: true,
  });
  if (waited.state === "gone") return { action: "start-fresh" };
  if (waited.state === "connectable") {
    deps.warn(`Embedded PostgreSQL pid ${waited.pid} started accepting connections while waiting; reusing it`);
    return { action: "reuse", pid: waited.pid };
  }
  pid = waited.pid;

  for (const [signalName, waitMs] of [
    ["SIGINT", EMBEDDED_POSTGRES_FAST_SHUTDOWN_WAIT_MS],
    ["SIGQUIT", EMBEDDED_POSTGRES_IMMEDIATE_SHUTDOWN_WAIT_MS],
  ] as const) {
    // Not every "alive but unreachable" postmaster is dying — one still doing
    // crash recovery ("the database system is starting up") also refuses
    // connections, and it becomes usable on its own. Re-probe before each
    // escalation so we never signal a postmaster that has just come up.
    if (await deps.isConnectable()) {
      deps.warn(`Embedded PostgreSQL pid ${pid} started accepting connections while waiting; reusing it`);
      return { action: "reuse", pid };
    }
    deps.warn(
      `Embedded PostgreSQL pid ${pid} still alive after wait deadline; sending ${signalName} and waiting up to ${waitMs / 1000}s`,
    );
    try {
      deps.signal(pid, signalName);
    } catch {
      // ESRCH etc. — the postmaster exited between the poll and the kill.
    }
    const signalled = await waitForPostmasterExit(deps, waitMs, { probeConnectable: false });
    if (signalled.state === "gone") return { action: "start-fresh" };
    pid = signalled.pid;
  }

  throw new Error(
    `Embedded PostgreSQL pid ${pid} is not accepting connections and survived SIGINT/SIGQUIT; ` +
      "refusing to reuse it or start a second postmaster on the same data directory. " +
      "Stop the old process manually, then restart the server.",
  );
}
