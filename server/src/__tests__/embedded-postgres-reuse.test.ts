import { describe, expect, it, vi } from "vitest";

import {
  EMBEDDED_POSTGRES_FAST_SHUTDOWN_WAIT_MS,
  EMBEDDED_POSTGRES_IMMEDIATE_SHUTDOWN_WAIT_MS,
  EMBEDDED_POSTGRES_REUSE_POLL_INTERVAL_MS,
  EMBEDDED_POSTGRES_SHUTDOWN_WAIT_MS,
  resolveEmbeddedPostgresReuse,
  type EmbeddedPostgresReuseDeps,
} from "../lib/embedded-postgres-reuse.js";

function buildDeps(overrides: Partial<EmbeddedPostgresReuseDeps> = {}): EmbeddedPostgresReuseDeps {
  return {
    getRunningPid: vi.fn(() => null),
    isConnectable: vi.fn(async () => false),
    signal: vi.fn(),
    sleep: vi.fn(async () => {}),
    warn: vi.fn(),
    ...overrides,
  };
}

describe("resolveEmbeddedPostgresReuse", () => {
  it("starts fresh when no postmaster pid is running", async () => {
    const deps = buildDeps();
    await expect(resolveEmbeddedPostgresReuse(deps)).resolves.toEqual({ action: "start-fresh" });
    expect(deps.isConnectable).not.toHaveBeenCalled();
    expect(deps.sleep).not.toHaveBeenCalled();
  });

  it("reuses a running postmaster that accepts connections", async () => {
    const deps = buildDeps({
      getRunningPid: vi.fn(() => 4242),
      isConnectable: vi.fn(async () => true),
    });
    await expect(resolveEmbeddedPostgresReuse(deps)).resolves.toEqual({ action: "reuse", pid: 4242 });
    expect(deps.signal).not.toHaveBeenCalled();
    expect(deps.sleep).not.toHaveBeenCalled();
  });

  it("waits out a shutting-down postmaster and starts fresh once it exits", async () => {
    // pid stays alive for three polls, then the postmaster finishes exiting
    const pids = [4242, 4242, 4242, 4242, null];
    const deps = buildDeps({
      getRunningPid: vi.fn(() => (pids.length > 1 ? pids.shift()! : pids[0])),
    });
    await expect(resolveEmbeddedPostgresReuse(deps)).resolves.toEqual({ action: "start-fresh" });
    expect(deps.signal).not.toHaveBeenCalled();
    expect(deps.sleep).toHaveBeenCalledWith(EMBEDDED_POSTGRES_REUSE_POLL_INTERVAL_MS);
    expect(deps.warn).toHaveBeenCalledWith(expect.stringContaining("not accepting connections"));
  });

  it("reuses a postmaster that becomes reachable during the wait instead of signalling it", async () => {
    // Alive the whole time, unreachable at first (e.g. "the database system is
    // starting up" during crash recovery), serving by the time the wait ends.
    let connectable = false;
    const deps = buildDeps({
      getRunningPid: vi.fn(() => 4242),
      sleep: vi.fn(async () => {
        connectable = true;
      }),
      isConnectable: vi.fn(async () => connectable),
    });
    await expect(resolveEmbeddedPostgresReuse(deps)).resolves.toEqual({ action: "reuse", pid: 4242 });
    expect(deps.signal).not.toHaveBeenCalled();
  });

  it("escalates to a fast shutdown (SIGINT) when the wait deadline passes", async () => {
    let sigintSent = false;
    const deps = buildDeps({
      getRunningPid: vi.fn(() => (sigintSent ? null : 4242)),
      signal: vi.fn((_pid, sig) => {
        if (sig === "SIGINT") sigintSent = true;
      }),
    });
    await expect(resolveEmbeddedPostgresReuse(deps)).resolves.toEqual({ action: "start-fresh" });
    expect(deps.signal).toHaveBeenCalledTimes(1);
    expect(deps.signal).toHaveBeenCalledWith(4242, "SIGINT");
    const waitPolls = Math.ceil(EMBEDDED_POSTGRES_SHUTDOWN_WAIT_MS / EMBEDDED_POSTGRES_REUSE_POLL_INTERVAL_MS);
    expect(vi.mocked(deps.sleep).mock.calls.length).toBeGreaterThanOrEqual(waitPolls);
  });

  it("escalates to an immediate shutdown (SIGQUIT) when SIGINT does not stop it", async () => {
    let sigquitSent = false;
    const deps = buildDeps({
      getRunningPid: vi.fn(() => (sigquitSent ? null : 4242)),
      signal: vi.fn((_pid, sig) => {
        if (sig === "SIGQUIT") sigquitSent = true;
      }),
    });
    await expect(resolveEmbeddedPostgresReuse(deps)).resolves.toEqual({ action: "start-fresh" });
    expect(vi.mocked(deps.signal).mock.calls.map(([, sig]) => sig)).toEqual(["SIGINT", "SIGQUIT"]);
  });

  it("throws a descriptive error when the postmaster survives every escalation", async () => {
    const deps = buildDeps({
      getRunningPid: vi.fn(() => 4242),
    });
    await expect(resolveEmbeddedPostgresReuse(deps)).rejects.toThrow(/pid 4242/);
    const totalPolls =
      Math.ceil(EMBEDDED_POSTGRES_SHUTDOWN_WAIT_MS / EMBEDDED_POSTGRES_REUSE_POLL_INTERVAL_MS) +
      Math.ceil(EMBEDDED_POSTGRES_FAST_SHUTDOWN_WAIT_MS / EMBEDDED_POSTGRES_REUSE_POLL_INTERVAL_MS) +
      Math.ceil(EMBEDDED_POSTGRES_IMMEDIATE_SHUTDOWN_WAIT_MS / EMBEDDED_POSTGRES_REUSE_POLL_INTERVAL_MS);
    expect(vi.mocked(deps.sleep).mock.calls.length).toBe(totalPolls);
  });

  it("ignores signal delivery failures (postmaster exited between poll and kill)", async () => {
    const pidValues = { alive: true };
    const deps = buildDeps({
      getRunningPid: vi.fn(() => (pidValues.alive ? 4242 : null)),
      signal: vi.fn(() => {
        pidValues.alive = false;
        throw new Error("ESRCH");
      }),
    });
    await expect(resolveEmbeddedPostgresReuse(deps)).resolves.toEqual({ action: "start-fresh" });
  });
});
