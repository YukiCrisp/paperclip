import { spawn } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";
import { isPidAlive, terminateLocalService } from "./local-service-supervisor.js";

const spawnedPids = new Set<number>();

/**
 * Start a process that is NOT a child of this one, so `kill(pid, 0)` answers
 * about a real live process rather than an unreaped zombie of the test runner.
 */
async function spawnOrphan(script: string): Promise<number> {
  const leader = spawn(
    process.execPath,
    [
      "-e",
      [
        "const { spawn } = require('node:child_process');",
        `const child = spawn(process.execPath, ['-e', ${JSON.stringify(script)}], { stdio: 'ignore' });`,
        "process.stdout.write(String(child.pid));",
        "setTimeout(() => process.exit(0), 25);",
      ].join(" "),
    ],
    { detached: true, stdio: ["ignore", "pipe", "ignore"] },
  );

  let stdout = "";
  leader.stdout?.on("data", (chunk) => {
    stdout += String(chunk);
  });
  await new Promise<void>((resolve, reject) => {
    leader.once("error", reject);
    leader.once("exit", () => resolve());
  });

  const pid = Number.parseInt(stdout.trim(), 10);
  if (!Number.isInteger(pid) || pid <= 0) {
    throw new Error(`Failed to capture orphan pid: ${stdout}`);
  }
  spawnedPids.add(pid);
  await waitFor(() => isPidAlive(pid));
  return pid;
}

async function waitFor(predicate: () => boolean, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("Timed out waiting for condition");
}

afterEach(() => {
  for (const pid of spawnedPids) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // Already gone.
    }
  }
  spawnedPids.clear();
});

// (ENGA-2918) These outcomes are the whole point of the function: every caller
// writes a terminal run status straight after it, so "we sent a signal" is not
// good enough — the answer has to say whether the process is actually gone.
describe.skipIf(process.platform === "win32")("terminateLocalService", () => {
  it("reports the target exited when it honours the first signal", async () => {
    const pid = await spawnOrphan("setInterval(() => {}, 1000)");

    const result = await terminateLocalService({ pid, processGroupId: null });

    expect(result).toMatchObject({
      outcome: "exited",
      confirmedDead: true,
      pid,
      targetedProcessGroup: false,
    });
    expect(isPidAlive(pid)).toBe(false);
  });

  it("escalates to SIGKILL and confirms the kill when the target ignores SIGTERM", async () => {
    const pid = await spawnOrphan("process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)");

    const result = await terminateLocalService(
      { pid, processGroupId: null },
      { forceAfterMs: 300 },
    );

    expect(result).toMatchObject({ outcome: "force_killed", confirmedDead: true, pid });
    expect(isPidAlive(pid)).toBe(false);
  }, 15_000);

  it("reports a target that is already gone rather than swallowing the failed signal", async () => {
    const pid = await spawnOrphan("setInterval(() => {}, 1000)");
    process.kill(pid, "SIGKILL");
    await waitFor(() => !isPidAlive(pid));

    const result = await terminateLocalService({ pid, processGroupId: null });

    expect(result).toMatchObject({ outcome: "not_running", confirmedDead: true, pid });
  });

  it("does not claim a kill it could not confirm", async () => {
    // pid 1 is init: signalling it fails with EPERM while it stays very much
    // alive, which is exactly the case the old `catch { return; }` hid.
    const result = await terminateLocalService({ pid: 1, processGroupId: null });

    expect(result).toMatchObject({ outcome: "still_alive", confirmedDead: false, pid: 1 });
  });
});
