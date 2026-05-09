import { describe, it, expect } from "vitest";
import {
  ADAPTER_DEFAULTS,
  getAdapterDefaults,
  type AdapterDefaults,
} from "./adapter-defaults.js";

describe("adapter defaults registry", () => {
  it("claude_local has known shape", () => {
    const d = getAdapterDefaults("claude_local");
    expect(d.runtimeImage).toMatch(/agent-runtime-claude/);
    expect(d.envKeys).toContain("ANTHROPIC_API_KEY");
    expect(d.allowFqdns).toContain("api.anthropic.com");
  });

  it("returns defaults for an unknown adapter", () => {
    const d = getAdapterDefaults("totally-made-up");
    // Unknown adapter falls back to base image + zero env keys + zero FQDNs.
    // The driver still functions (will fail to invoke the unknown CLI inside
    // the container) but provisioning succeeds.
    expect(d.runtimeImage).toMatch(/agent-runtime-base/);
    expect(d.envKeys).toEqual([]);
    expect(d.allowFqdns).toEqual([]);
  });

  it("every registered adapter has a non-empty runtimeImage", () => {
    for (const [type, defaults] of Object.entries(ADAPTER_DEFAULTS)) {
      expect(defaults.runtimeImage, `adapter=${type}`).toBeTruthy();
    }
  });

  it("type guard: AdapterDefaults requires the three fields", () => {
    const sample: AdapterDefaults = { runtimeImage: "x", envKeys: [], allowFqdns: [] };
    expect(sample.runtimeImage).toBe("x");
  });
});
