import { describe, expect, it, vi } from "vitest";

import {
  commandLooksLikePostgres,
  readPostmasterPidInfo,
  type PostmasterPidFileDeps,
} from "../lib/postmaster-pid-file.js";

const DATA_DIR = "/Users/yuki/.paperclip/instances/default/db";
const CONFIGURED_PORT = 54329;

// Shape of a real pid file, copied from the live cluster (pid/dataDir/startTime/
// port/socketDir/listenAddr).
function pidFile(
  overrides: Partial<{ pid: string; dataDir: string; startTime: string; port: string }> = {},
): string {
  const { pid = "52795", dataDir = DATA_DIR, startTime = "1785034846", port = "54329" } = overrides;
  return [pid, dataDir, startTime, port, "/tmp", "localhost", ""].join("\n");
}

function buildDeps(overrides: Partial<PostmasterPidFileDeps> = {}): PostmasterPidFileDeps {
  return {
    readPidFile: vi.fn(() => pidFile()),
    isPidRunning: vi.fn(() => true),
    isPostgresProcess: vi.fn(() => true),
    normalizePath: (path: string) => path.replace(/\/+$/, ""),
    expectedDataDir: DATA_DIR,
    fallbackPort: CONFIGURED_PORT,
    ...overrides,
  };
}

describe("readPostmasterPidInfo", () => {
  it("reads the pid and the port the postmaster advertises on line 4", () => {
    // Regression guard for ENGA-2446: the probe used to use the configured port,
    // which is the wrong one whenever boot fell back to the next free port.
    const info = readPostmasterPidInfo(buildDeps({ readPidFile: () => pidFile({ port: "54330" }) }));
    expect(info).toEqual({ pid: 52795, port: 54330 });
  });

  it("falls back to the configured port when the port line is not written yet", () => {
    const info = readPostmasterPidInfo(buildDeps({ readPidFile: () => "52795\n" + DATA_DIR + "\n1785034846\n" }));
    expect(info).toEqual({ pid: 52795, port: CONFIGURED_PORT });
  });

  it("returns null when there is no pid file", () => {
    expect(readPostmasterPidInfo(buildDeps({ readPidFile: () => null }))).toBeNull();
  });

  it("returns null when the pid line is not a positive integer", () => {
    expect(readPostmasterPidInfo(buildDeps({ readPidFile: () => pidFile({ pid: "" }) }))).toBeNull();
    expect(readPostmasterPidInfo(buildDeps({ readPidFile: () => pidFile({ pid: "-1" }) }))).toBeNull();
    expect(readPostmasterPidInfo(buildDeps({ readPidFile: () => pidFile({ pid: "nonsense" }) }))).toBeNull();
  });

  it("returns null when the pid file belongs to another cluster's data directory", () => {
    const deps = buildDeps({ readPidFile: () => pidFile({ dataDir: "/Users/yuki/.paperclip/instances/other/db" }) });
    expect(readPostmasterPidInfo(deps)).toBeNull();
    // Identity failed on the file alone; we never even asked about the process.
    expect(deps.isPidRunning).not.toHaveBeenCalled();
  });

  it("returns null when the data directory line is missing, rather than trusting the pid", () => {
    expect(readPostmasterPidInfo(buildDeps({ readPidFile: () => pidFile({ dataDir: "" }) }))).toBeNull();
  });

  it("tolerates a trailing slash on either side of the data directory comparison", () => {
    const deps = buildDeps({ readPidFile: () => pidFile({ dataDir: `${DATA_DIR}/` }) });
    expect(readPostmasterPidInfo(deps)).toEqual({ pid: 52795, port: 54329 });
  });

  it("returns null when the pid is dead", () => {
    expect(readPostmasterPidInfo(buildDeps({ isPidRunning: () => false }))).toBeNull();
  });

  it("returns null when the pid has been recycled by a process that is not postgres", () => {
    // ENGA-2447: the postmaster died uncleanly (SIGKILL/OOM/power loss) so its
    // pid file survived, and the kernel later handed that PID to something else.
    // kill(pid, 0) succeeds, so only the process identity check can catch it.
    const deps = buildDeps({ isPidRunning: () => true, isPostgresProcess: vi.fn(() => false) });
    expect(readPostmasterPidInfo(deps)).toBeNull();
    expect(deps.isPostgresProcess).toHaveBeenCalledWith(52795);
  });
});

describe("commandLooksLikePostgres", () => {
  it("accepts the command names a postmaster reports", () => {
    // macOS `ps -o comm=` prints the full path; Linux prints the bare name.
    expect(commandLooksLikePostgres("/opt/homebrew/lib/postgresql@17/bin/postgres\n")).toBe(true);
    expect(commandLooksLikePostgres("postgres")).toBe(true);
    expect(commandLooksLikePostgres("postmaster")).toBe(true);
  });

  it("rejects unrelated processes that inherited the pid", () => {
    expect(commandLooksLikePostgres("/usr/local/bin/node")).toBe(false);
    expect(commandLooksLikePostgres("/bin/zsh")).toBe(false);
    expect(commandLooksLikePostgres("")).toBe(false);
  });
});
