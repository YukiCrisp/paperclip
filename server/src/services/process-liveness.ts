import { execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";

const execFile = promisify(execFileCallback);

// Low-level OS process-liveness primitives, shared by the heartbeat reaper
// (server/src/services/heartbeat.ts) and the issue checkout self-reclaim path
// (server/src/services/issues.ts). Kept in a leaf module with no service-layer
// imports so both can use it without an import cycle (heartbeat imports issues).

// `process.kill(pid, 0)` only checks that *some* process currently holds the
// pid; it does not prove identity. Returns false for a missing/invalid pid.
export function isProcessAlive(pid: number | null | undefined): boolean {
  if (typeof pid !== "number" || !Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException | undefined)?.code;
    if (code === "EPERM") return true;
    if (code === "ESRCH") return false;
    return false;
  }
}

// Allowance for the skew between the wall-clock we stamp right after spawn()
// (processStartedAt) and the OS-reported process start time, which `ps -o
// lstart=` only resolves to whole seconds. A reused PID belongs to a process
// that started long after the original child died (the staleness threshold
// guarantees a multi-minute gap), so a few seconds of tolerance separates "same
// process" from "PID was recycled" without any risk of confusing the two.
export const PROCESS_IDENTITY_START_TOLERANCE_MS = 5_000;

// Reads the OS-reported start time of `pid` (epoch ms) using `ps -o lstart=`,
// which works on both macOS and Linux. Returns null when the platform is
// unsupported, the process is gone, or the timestamp cannot be parsed.
export async function readProcessStartedAtMs(pid: number): Promise<number | null> {
  if (process.platform === "win32") return null;
  if (!Number.isInteger(pid) || pid <= 0) return null;
  try {
    const { stdout } = await execFile("ps", ["-o", "lstart=", "-p", String(pid)]);
    const text = stdout.trim();
    if (!text) return null;
    const parsed = Date.parse(text);
    return Number.isNaN(parsed) ? null : parsed;
  } catch {
    return null;
  }
}

// Liveness check hardened against PID reuse. `process.kill(pid, 0)` only proves
// *some* process holds that PID -- after a detached child dies the OS can hand
// the same PID to an unrelated process, which the bare check reports as "alive"
// forever, pinning the run in "running" and leaking its issue lock permanently
// (ENGA-502). When we have a recorded start time we additionally require the OS
// process-start time to match it within tolerance; a mismatch means the PID was
// recycled and the original child is dead. When identity cannot be established
// (no recorded start time, or `ps` unavailable) we fall back to the liveness-only
// result so we never false-positive a genuinely live detached run into a reap.
export async function isTrackedProcessAlive(
  pid: number | null | undefined,
  expectedStartedAt: Date | string | null | undefined,
): Promise<boolean> {
  if (!isProcessAlive(pid)) return false;
  if (expectedStartedAt == null) return true;
  const expectedMs =
    expectedStartedAt instanceof Date
      ? expectedStartedAt.getTime()
      : Date.parse(String(expectedStartedAt));
  if (Number.isNaN(expectedMs)) return true;
  const actualMs = await readProcessStartedAtMs(pid as number);
  if (actualMs == null) return true;
  return Math.abs(actualMs - expectedMs) <= PROCESS_IDENTITY_START_TOLERANCE_MS;
}
