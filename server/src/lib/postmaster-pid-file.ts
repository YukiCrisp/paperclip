// Reads postmaster.pid and decides whether the PID it names is *our* postmaster.
//
// The reuse logic in embedded-postgres-reuse.ts escalates to SIGINT/SIGQUIT when
// a live PID from this file refuses connections, so "is this PID really the
// postmaster of this data directory?" has to be answered before we shoot. PID
// liveness alone is not enough: a postmaster killed uncleanly (SIGKILL, OOM,
// power loss) leaves postmaster.pid behind, and its PID is eventually recycled
// by an unrelated process (PIDs on this machine sit in the 50k range and macOS
// wraps around 100k), which would then be signalled (ENGA-2447).
//
// postmaster.pid layout (PostgreSQL src/include/utils/pidfile.h):
//   1 postmaster PID          2 data directory      3 start time (epoch)
//   4 port                    5 socket directory    6 listen address
//   7 shared memory key
//
// We check lines 1, 2 and 4 plus the process name. PostgreSQL itself confirms
// identity via the shared memory key on line 7, which we cannot read from Node;
// the data directory on line 2 plus a `postgres` process name rejects both a
// recycled PID and a pid file belonging to another cluster.

export type PostmasterPidInfo = {
  pid: number;
  /** The port the postmaster advertises on line 4, or the fallback when that line is absent. */
  port: number;
};

export type PostmasterPidFileDeps = {
  /** postmaster.pid contents, or null when the file is missing or unreadable. */
  readPidFile: () => string | null;
  /** kill(pid, 0) — true while a process with this PID exists. */
  isPidRunning: (pid: number) => boolean;
  /** True when the PID belongs to a postgres process (guards against PID reuse). */
  isPostgresProcess: (pid: number) => boolean;
  /** Canonicalises a path for comparison (resolve + realpath where possible). */
  normalizePath: (path: string) => string;
  /** The data directory this boot expects to own. */
  expectedDataDir: string;
  /** Used when the pid file has no port line yet (postmaster still writing it). */
  fallbackPort: number;
};

/** True for the command name of a postmaster: `postgres`, a full path to it, or the legacy `postmaster`. */
export function commandLooksLikePostgres(command: string): boolean {
  const name = command.trim().split("/").pop() ?? "";
  return name.startsWith("postgres") || name.startsWith("postmaster");
}

/**
 * Returns the pid/port of the postmaster owning `expectedDataDir`, or null when
 * there is no such postmaster — including when a pid file exists but names a PID
 * that is dead, recycled by another program, or serving a different cluster.
 *
 * Null is the non-destructive answer: the caller starts fresh, and PostgreSQL's
 * own data directory lock still refuses a second postmaster if one is really
 * there. Signalling is reserved for a PID this function vouched for.
 */
export function readPostmasterPidInfo(deps: PostmasterPidFileDeps): PostmasterPidInfo | null {
  const contents = deps.readPidFile();
  if (contents === null) return null;

  const lines = contents.split("\n");
  const pid = Number(lines[0]?.trim());
  if (!Number.isInteger(pid) || pid <= 0) return null;

  // Line 2 must name our data directory. An empty line 2 means we cannot verify
  // whose pid file this is, and an unverified PID is one we must never signal.
  const pidFileDataDir = lines[1]?.trim();
  if (!pidFileDataDir) return null;
  if (deps.normalizePath(pidFileDataDir) !== deps.normalizePath(deps.expectedDataDir)) return null;

  if (!deps.isPidRunning(pid)) return null;
  if (!deps.isPostgresProcess(pid)) return null;

  const pidFilePort = Number(lines[3]?.trim());
  // A pid file still being written has no port line yet; fall back to the
  // configured port rather than failing the probe outright.
  const port = Number.isInteger(pidFilePort) && pidFilePort > 0 ? pidFilePort : deps.fallbackPort;
  return { pid, port };
}
