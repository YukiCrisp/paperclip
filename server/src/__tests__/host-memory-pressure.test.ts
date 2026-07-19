import { describe, expect, it } from "vitest";
import {
  buildHostMemorySnapshot,
  classifyHostMemoryPressure,
  computeHostBoundedRunSlots,
  DEFAULT_MAX_SWAP_USED_BYTES,
  DEFAULT_MIN_AVAILABLE_RATIO,
  parseMemsize,
  parseSwapUsage,
  parseVmStat,
  resolveHostConcurrencyCap,
  resolveHostMemoryPressureConfig,
  type HostMemoryPressureThresholds,
  type HostMemorySnapshot,
} from "../services/host-memory-pressure.js";

const THRESHOLDS: HostMemoryPressureThresholds = {
  minAvailableRatio: 0.1,
  maxSwapUsedBytes: 4 * 1024 * 1024 * 1024,
};

describe("computeHostBoundedRunSlots", () => {
  it("passes per-agent slots through when the host cap is disabled (null)", () => {
    expect(computeHostBoundedRunSlots({ perAgentSlots: 5, hostCap: null, hostRunningCount: 100 })).toBe(5);
  });

  it("bounds per-agent slots by the remaining host budget", () => {
    // host cap 10, already 8 running -> only 2 host slots left, below the 5 per-agent slots.
    expect(computeHostBoundedRunSlots({ perAgentSlots: 5, hostCap: 10, hostRunningCount: 8 })).toBe(2);
  });

  it("keeps per-agent slots when the host budget is larger", () => {
    expect(computeHostBoundedRunSlots({ perAgentSlots: 3, hostCap: 20, hostRunningCount: 5 })).toBe(3);
  });

  it("never returns negative slots when the host is already over the cap", () => {
    expect(computeHostBoundedRunSlots({ perAgentSlots: 5, hostCap: 10, hostRunningCount: 14 })).toBe(0);
  });
});

describe("resolveHostConcurrencyCap", () => {
  it("returns null (disabled) when unset, empty, or non-positive", () => {
    expect(resolveHostConcurrencyCap({})).toBeNull();
    expect(resolveHostConcurrencyCap({ MAX_CONCURRENT_RUNS_HOST: "" })).toBeNull();
    expect(resolveHostConcurrencyCap({ MAX_CONCURRENT_RUNS_HOST: "0" })).toBeNull();
    expect(resolveHostConcurrencyCap({ MAX_CONCURRENT_RUNS_HOST: "-4" })).toBeNull();
    expect(resolveHostConcurrencyCap({ MAX_CONCURRENT_RUNS_HOST: "abc" })).toBeNull();
  });

  it("parses a positive integer cap", () => {
    expect(resolveHostConcurrencyCap({ MAX_CONCURRENT_RUNS_HOST: "12" })).toBe(12);
    expect(resolveHostConcurrencyCap({ MAX_CONCURRENT_RUNS_HOST: "9.9" })).toBe(9);
  });
});

describe("resolveHostMemoryPressureConfig", () => {
  it("defaults to gate disabled with default thresholds", () => {
    const cfg = resolveHostMemoryPressureConfig({});
    expect(cfg.gateEnabled).toBe(false);
    expect(cfg.thresholds.minAvailableRatio).toBe(DEFAULT_MIN_AVAILABLE_RATIO);
    expect(cfg.thresholds.maxSwapUsedBytes).toBe(DEFAULT_MAX_SWAP_USED_BYTES);
  });

  it("enables the gate and honors threshold overrides", () => {
    const cfg = resolveHostMemoryPressureConfig({
      HEARTBEAT_MEMORY_PRESSURE_GATE: "on",
      HEARTBEAT_MEMORY_MIN_AVAILABLE_RATIO: "0.2",
      HEARTBEAT_MEMORY_MAX_SWAP_USED_MB: "2048",
    });
    expect(cfg.gateEnabled).toBe(true);
    expect(cfg.thresholds.minAvailableRatio).toBe(0.2);
    expect(cfg.thresholds.maxSwapUsedBytes).toBe(2048 * 1024 * 1024);
  });

  it("ignores out-of-range ratio overrides", () => {
    expect(resolveHostMemoryPressureConfig({ HEARTBEAT_MEMORY_MIN_AVAILABLE_RATIO: "1.5" }).thresholds.minAvailableRatio)
      .toBe(DEFAULT_MIN_AVAILABLE_RATIO);
    expect(resolveHostMemoryPressureConfig({ HEARTBEAT_MEMORY_MIN_AVAILABLE_RATIO: "0" }).thresholds.minAvailableRatio)
      .toBe(DEFAULT_MIN_AVAILABLE_RATIO);
  });
});

describe("parseVmStat", () => {
  const sample = [
    "Mach Virtual Memory Statistics: (page size of 16384 bytes)",
    "Pages free:                               10000.",
    "Pages active:                            234567.",
    "Pages inactive:                          111111.",
    "Pages speculative:                         2000.",
    "Pages purgeable:                           5000.",
    "Pages wired down:                        333333.",
  ].join("\n");

  it("reads page size and the free/purgeable/speculative page counts", () => {
    const parsed = parseVmStat(sample);
    expect(parsed.pageSizeBytes).toBe(16384);
    expect(parsed.freePages).toBe(10000);
    expect(parsed.purgeablePages).toBe(5000);
    expect(parsed.speculativePages).toBe(2000);
  });

  it("falls back to a default page size and zero counts on missing fields", () => {
    const parsed = parseVmStat("garbage output with no pages");
    expect(parsed.pageSizeBytes).toBe(4096);
    expect(parsed.freePages).toBe(0);
    expect(parsed.purgeablePages).toBe(0);
  });
});

describe("parseMemsize / parseSwapUsage", () => {
  it("parses hw.memsize bytes", () => {
    expect(parseMemsize("17179869184\n")).toBe(17179869184);
    expect(parseMemsize("nope")).toBeNull();
  });

  it("parses vm.swapusage used bytes with unit suffixes", () => {
    expect(parseSwapUsage("total = 2048.00M  used = 1893.25M  free = 154.75M  (encrypted)")).toBe(
      Math.round(1893.25 * 1024 * 1024),
    );
    expect(parseSwapUsage("total = 4.00G  used = 2.00G  free = 2.00G")).toBe(2 * 1024 * 1024 * 1024);
    expect(parseSwapUsage("no usage here")).toBeNull();
  });
});

describe("classifyHostMemoryPressure", () => {
  const totalBytes = 16 * 1024 * 1024 * 1024;

  const snapshotWith = (reclaimableBytes: number, swapUsedBytes: number): HostMemorySnapshot =>
    buildHostMemorySnapshot({
      vmStat: {
        pageSizeBytes: 1,
        freePages: reclaimableBytes,
        purgeablePages: 0,
        speculativePages: 0,
      },
      totalBytes,
      swapUsedBytes,
    });

  it("flags swap thrashing", () => {
    const result = classifyHostMemoryPressure(snapshotWith(totalBytes * 0.5, 5 * 1024 * 1024 * 1024), THRESHOLDS);
    expect(result.underPressure).toBe(true);
    expect(result.reason).toBe("swap_thrashing");
  });

  it("flags low available memory", () => {
    const result = classifyHostMemoryPressure(snapshotWith(totalBytes * 0.05, 0), THRESHOLDS);
    expect(result.underPressure).toBe(true);
    expect(result.reason).toBe("low_available");
  });

  it("reports no pressure when both signals are healthy", () => {
    const result = classifyHostMemoryPressure(snapshotWith(totalBytes * 0.5, 1024 * 1024 * 1024), THRESHOLDS);
    expect(result.underPressure).toBe(false);
    expect(result.reason).toBeNull();
  });

  it("fails open for an unavailable snapshot (never blocks when unmeasurable)", () => {
    const unavailable: HostMemorySnapshot = {
      source: "unavailable",
      pageSizeBytes: null,
      reclaimablePages: null,
      reclaimableBytes: null,
      totalBytes: null,
      swapUsedBytes: null,
      availableRatio: null,
    };
    const result = classifyHostMemoryPressure(unavailable, THRESHOLDS);
    expect(result.underPressure).toBe(false);
  });
});
