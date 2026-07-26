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
  /** True when the configured port answers and serves the expected data directory. */
  isConnectable: () => Promise<boolean>;
  signal: (pid: number, signal: "SIGINT" | "SIGQUIT") => void;
  sleep: (ms: number) => Promise<void>;
  warn: (message: string) => void;
};

export type EmbeddedPostgresReuseResult =
  | { action: "reuse"; pid: number }
  | { action: "start-fresh" };

async function waitForPostmasterExit(deps: EmbeddedPostgresReuseDeps, waitMs: number): Promise<number | null> {
  const polls = Math.ceil(waitMs / EMBEDDED_POSTGRES_REUSE_POLL_INTERVAL_MS);
  let pid = deps.getRunningPid();
  for (let i = 0; i < polls && pid !== null; i++) {
    await deps.sleep(EMBEDDED_POSTGRES_REUSE_POLL_INTERVAL_MS);
    pid = deps.getRunningPid();
  }
  return pid;
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
  pid = await waitForPostmasterExit(deps, EMBEDDED_POSTGRES_SHUTDOWN_WAIT_MS);
  if (pid === null) return { action: "start-fresh" };

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
    pid = await waitForPostmasterExit(deps, waitMs);
    if (pid === null) return { action: "start-fresh" };
  }

  throw new Error(
    `Embedded PostgreSQL pid ${pid} is not accepting connections and survived SIGINT/SIGQUIT; ` +
      "refusing to reuse it or start a second postmaster on the same data directory. " +
      "Stop the old process manually, then restart the server.",
  );
}
