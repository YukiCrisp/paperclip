// Host-wide resource governance for the local run scheduler (ENGA-2152).
//
// Background: `maxConcurrentRuns` is enforced per-agent only, so N agents each
// allowed 20 concurrent runs can, in aggregate, spawn far more local child
// processes than a single host's RAM can hold. On 2026-07-14 that aggregate
// oversubscription drove a 16GB Mac into swap thrashing; the kernel's memory
// pressure killed / stalled child processes, and the scheduler's liveness check
// reported them as `process_lost` ("server may have restarted") even though the
// server never restarted.
//
// This module provides two structural levers, both OFF by default so merging is
// inert until an operator opts in via env (the deploy that enables them stays
// behind the normal approval gate):
//   1. A host-global concurrency cap (`MAX_CONCURRENT_RUNS_HOST`) that bounds the
//      total number of tracked local child-process runs across every agent.
//   2. A memory-pressure gate that defers starting queued runs while the host is
//      under memory pressure (measured via `vm_stat` + `sysctl` on macOS), so a
//      pressured host does not immediately restart the very runs it just lost
//      (retry storm).
//
// The pressure probe is also used to reclassify the ambiguous null-pid loss as
// `host_resource_pressure` and to attach a host-memory snapshot to the run for
// post-hoc diagnosis. Reclassification/snapshot capture does NOT require the gate
// to be enabled — it is diagnostic and safe to always run on the rare loss path.

import { execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";

const execFile = promisify(execFileCallback);

const BYTES_PER_MB = 1024 * 1024;

/** Default page size assumed when `vm_stat` output omits the header (bytes). */
const DEFAULT_PAGE_SIZE_BYTES = 4096;

/** Below this fraction of total RAM reported free/reclaimable → memory pressure. */
export const DEFAULT_MIN_AVAILABLE_RATIO = 0.08;

/** Swap usage above this many bytes → treated as thrashing → memory pressure. */
export const DEFAULT_MAX_SWAP_USED_BYTES = 6 * 1024 * BYTES_PER_MB; // 6 GiB

export interface HostMemorySnapshot {
  /** Where the numbers came from; `unavailable` means we could not measure. */
  source: "vm_stat" | "unavailable";
  pageSizeBytes: number | null;
  /** Pages counted as free-ish (free + purgeable + speculative). */
  reclaimablePages: number | null;
  reclaimableBytes: number | null;
  totalBytes: number | null;
  swapUsedBytes: number | null;
  /** reclaimableBytes / totalBytes, or null when either is unknown. */
  availableRatio: number | null;
}

export interface HostMemoryPressureThresholds {
  minAvailableRatio: number;
  /** null disables the swap signal. */
  maxSwapUsedBytes: number | null;
}

export interface HostMemoryPressureResult {
  underPressure: boolean;
  reason: "low_available" | "swap_thrashing" | null;
  snapshot: HostMemorySnapshot;
  thresholds: HostMemoryPressureThresholds;
}

export interface HostMemoryPressureConfig {
  /** When true, the scheduler defers queued-run starts under pressure. */
  gateEnabled: boolean;
  thresholds: HostMemoryPressureThresholds;
}

const UNAVAILABLE_SNAPSHOT: HostMemorySnapshot = {
  source: "unavailable",
  pageSizeBytes: null,
  reclaimablePages: null,
  reclaimableBytes: null,
  totalBytes: null,
  swapUsedBytes: null,
  availableRatio: null,
};

// ---------------------------------------------------------------------------
// Env config resolution (pure)
// ---------------------------------------------------------------------------

function parsePositiveInt(value: string | undefined): number | null {
  if (value === undefined) return null;
  const trimmed = value.trim();
  if (trimmed === "") return null;
  const parsed = Number(trimmed);
  if (!Number.isFinite(parsed)) return null;
  const floored = Math.floor(parsed);
  return floored > 0 ? floored : null;
}

function isTruthyEnv(value: string | undefined): boolean {
  if (value === undefined) return false;
  const normalized = value.trim().toLowerCase();
  return normalized === "true" || normalized === "1" || normalized === "yes" || normalized === "on";
}

/**
 * Resolve the host-global concurrency cap from `MAX_CONCURRENT_RUNS_HOST`.
 * Returns null (feature disabled — preserve per-agent-only behavior) when the
 * env var is unset, empty, non-numeric, or non-positive.
 */
export function resolveHostConcurrencyCap(env: Record<string, string | undefined>): number | null {
  return parsePositiveInt(env.MAX_CONCURRENT_RUNS_HOST);
}

/**
 * Resolve the memory-pressure gate config. The gate is opt-in via
 * `HEARTBEAT_MEMORY_PRESSURE_GATE`; thresholds always fall back to sane defaults
 * so the pressure probe (used for reclassification) is meaningful even when the
 * gate is disabled.
 */
export function resolveHostMemoryPressureConfig(
  env: Record<string, string | undefined>,
): HostMemoryPressureConfig {
  const ratioRaw = env.HEARTBEAT_MEMORY_MIN_AVAILABLE_RATIO?.trim();
  const parsedRatio = ratioRaw ? Number(ratioRaw) : NaN;
  const minAvailableRatio =
    Number.isFinite(parsedRatio) && parsedRatio > 0 && parsedRatio < 1
      ? parsedRatio
      : DEFAULT_MIN_AVAILABLE_RATIO;

  const swapMb = parsePositiveInt(env.HEARTBEAT_MEMORY_MAX_SWAP_USED_MB);
  const maxSwapUsedBytes = swapMb != null ? swapMb * BYTES_PER_MB : DEFAULT_MAX_SWAP_USED_BYTES;

  return {
    gateEnabled: isTruthyEnv(env.HEARTBEAT_MEMORY_PRESSURE_GATE),
    thresholds: { minAvailableRatio, maxSwapUsedBytes },
  };
}

// ---------------------------------------------------------------------------
// Host-global slot arithmetic (pure)
// ---------------------------------------------------------------------------

/**
 * Bound the per-agent available slots by the remaining host-global budget.
 * `availableSlots = min(perAgentSlots, hostCap - hostRunningCount)`, never < 0.
 * When `hostCap` is null the host lever is disabled and per-agent slots pass
 * through unchanged.
 */
export function computeHostBoundedRunSlots(input: {
  perAgentSlots: number;
  hostCap: number | null;
  hostRunningCount: number;
}): number {
  const perAgent = Math.max(0, Math.floor(input.perAgentSlots));
  if (input.hostCap == null) return perAgent;
  const hostRemaining = Math.max(0, input.hostCap - Math.max(0, input.hostRunningCount));
  return Math.min(perAgent, hostRemaining);
}

// ---------------------------------------------------------------------------
// vm_stat / sysctl parsing (pure)
// ---------------------------------------------------------------------------

/**
 * Parse `vm_stat` output. Returns page size and the page counts we care about.
 * Missing fields come back as 0 pages (best-effort); page size falls back to the
 * common 4096 when the header is absent.
 */
export function parseVmStat(output: string): {
  pageSizeBytes: number;
  freePages: number;
  purgeablePages: number;
  speculativePages: number;
} {
  const headerMatch = output.match(/page size of (\d+) bytes/i);
  const pageSizeBytes = headerMatch ? Number(headerMatch[1]) : DEFAULT_PAGE_SIZE_BYTES;

  const readPages = (label: string): number => {
    const re = new RegExp(`Pages ${label}:\\s*(\\d+)\\.`, "i");
    const match = output.match(re);
    return match ? Number(match[1]) : 0;
  };

  return {
    pageSizeBytes: Number.isFinite(pageSizeBytes) && pageSizeBytes > 0 ? pageSizeBytes : DEFAULT_PAGE_SIZE_BYTES,
    freePages: readPages("free"),
    purgeablePages: readPages("purgeable"),
    speculativePages: readPages("speculative"),
  };
}

/** Parse `sysctl -n hw.memsize` (integer bytes). Returns null when unparseable. */
export function parseMemsize(output: string): number | null {
  const parsed = Number(output.trim());
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

/**
 * Parse `sysctl -n vm.swapusage`, e.g.
 * `total = 2048.00M  used = 1893.25M  free = 154.75M  (encrypted)`.
 * Returns used bytes, or null when unparseable.
 */
export function parseSwapUsage(output: string): number | null {
  const match = output.match(/used\s*=\s*([\d.]+)([KMGT]?)/i);
  if (!match) return null;
  const value = Number(match[1]);
  if (!Number.isFinite(value)) return null;
  const unit = match[2].toUpperCase();
  const multiplier =
    unit === "K" ? 1024
      : unit === "M" ? 1024 * 1024
      : unit === "G" ? 1024 * 1024 * 1024
      : unit === "T" ? 1024 * 1024 * 1024 * 1024
      : 1;
  return Math.round(value * multiplier);
}

/**
 * Build a snapshot from parsed vm_stat + sysctl outputs (pure).
 * `reclaimable` = free + purgeable + speculative pages (memory obtainable
 * without swapping); this is the conservative "how much can we hand out now".
 */
export function buildHostMemorySnapshot(input: {
  vmStat: ReturnType<typeof parseVmStat>;
  totalBytes: number | null;
  swapUsedBytes: number | null;
}): HostMemorySnapshot {
  const { pageSizeBytes, freePages, purgeablePages, speculativePages } = input.vmStat;
  const reclaimablePages = freePages + purgeablePages + speculativePages;
  const reclaimableBytes = reclaimablePages * pageSizeBytes;
  const availableRatio =
    input.totalBytes && input.totalBytes > 0 ? reclaimableBytes / input.totalBytes : null;
  return {
    source: "vm_stat",
    pageSizeBytes,
    reclaimablePages,
    reclaimableBytes,
    totalBytes: input.totalBytes,
    swapUsedBytes: input.swapUsedBytes,
    availableRatio,
  };
}

/**
 * Classify a snapshot against thresholds (pure). An `unavailable` snapshot is
 * never under pressure (fail-open): if we cannot measure the host we must not
 * stall every run.
 */
export function classifyHostMemoryPressure(
  snapshot: HostMemorySnapshot,
  thresholds: HostMemoryPressureThresholds,
): HostMemoryPressureResult {
  if (snapshot.source === "unavailable") {
    return { underPressure: false, reason: null, snapshot, thresholds };
  }
  if (
    thresholds.maxSwapUsedBytes != null &&
    snapshot.swapUsedBytes != null &&
    snapshot.swapUsedBytes > thresholds.maxSwapUsedBytes
  ) {
    return { underPressure: true, reason: "swap_thrashing", snapshot, thresholds };
  }
  if (snapshot.availableRatio != null && snapshot.availableRatio < thresholds.minAvailableRatio) {
    return { underPressure: true, reason: "low_available", snapshot, thresholds };
  }
  return { underPressure: false, reason: null, snapshot, thresholds };
}

// ---------------------------------------------------------------------------
// Impure probe
// ---------------------------------------------------------------------------

async function readSysctl(key: string): Promise<string | null> {
  try {
    const { stdout } = await execFile("sysctl", ["-n", key], { timeout: 2000 });
    return stdout;
  } catch {
    return null;
  }
}

/**
 * Measure host memory pressure. macOS-only (uses `vm_stat`/`sysctl`); on any
 * other platform, or if the commands fail, returns an `unavailable` snapshot
 * that classifies as not-under-pressure (fail-open — the gate becomes a no-op
 * rather than stalling the host).
 */
export async function probeHostMemoryPressure(
  thresholds: HostMemoryPressureThresholds,
): Promise<HostMemoryPressureResult> {
  if (process.platform !== "darwin") {
    return { underPressure: false, reason: null, snapshot: UNAVAILABLE_SNAPSHOT, thresholds };
  }
  let vmStatOut: string;
  try {
    const { stdout } = await execFile("vm_stat", [], { timeout: 2000 });
    vmStatOut = stdout;
  } catch {
    return { underPressure: false, reason: null, snapshot: UNAVAILABLE_SNAPSHOT, thresholds };
  }
  const [memsizeOut, swapOut] = await Promise.all([
    readSysctl("hw.memsize"),
    readSysctl("vm.swapusage"),
  ]);
  const snapshot = buildHostMemorySnapshot({
    vmStat: parseVmStat(vmStatOut),
    totalBytes: memsizeOut ? parseMemsize(memsizeOut) : null,
    swapUsedBytes: swapOut ? parseSwapUsage(swapOut) : null,
  });
  return classifyHostMemoryPressure(snapshot, thresholds);
}

export type ProbeHostMemoryPressure = typeof probeHostMemoryPressure;
