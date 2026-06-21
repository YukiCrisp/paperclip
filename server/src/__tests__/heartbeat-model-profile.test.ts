import { describe, expect, it } from "vitest";
import {
  listAdapterModelProfiles,
  type AdapterModelProfileDefinition,
} from "../adapters/index.js";
import {
  applyRoutineModelProfileWakeContext,
  mergeModelProfileAdapterConfig,
  normalizeModelProfileWakeContext,
  resolveModelProfileApplication,
  resolveWakeReasonModelProfile,
} from "../services/heartbeat.ts";
import { parseRoutineModelProfileMap } from "../config.ts";

const cheapProfile: AdapterModelProfileDefinition = {
  key: "cheap",
  label: "Cheap",
  adapterConfig: {
    model: "adapter-cheap",
    modelReasoningEffort: "low",
  },
  source: "adapter_default",
};

describe("heartbeat model profile application", () => {
  it("uses the Codex local adapter cheap default when the agent has no runtime override", async () => {
    const modelProfile = resolveModelProfileApplication({
      adapterModelProfiles: await listAdapterModelProfiles("codex_local"),
      agentRuntimeConfig: {},
      issueModelProfile: "cheap",
      contextSnapshot: {},
    });

    expect(modelProfile).toMatchObject({
      requested: "cheap",
      requestedBy: "issue_override",
      applied: "cheap",
      configSource: "adapter_default",
      fallbackReason: null,
      adapterConfig: {
        model: "gpt-5.3-codex-spark",
        modelReasoningEffort: "high",
      },
    });
  });

  it("applies cheap profile patches before explicit issue adapter config overrides", () => {
    const modelProfile = resolveModelProfileApplication({
      adapterModelProfiles: [cheapProfile],
      agentRuntimeConfig: {},
      issueModelProfile: "cheap",
      contextSnapshot: {},
    });

    const merged = mergeModelProfileAdapterConfig({
      baseConfig: {
        model: "primary",
        modelReasoningEffort: "high",
        approvalPolicy: "strict",
      },
      modelProfile,
      issueAdapterConfig: {
        model: "issue-explicit",
      },
    });

    expect(modelProfile).toMatchObject({
      requested: "cheap",
      requestedBy: "issue_override",
      applied: "cheap",
      configSource: "adapter_default",
      fallbackReason: null,
    });
    expect(merged).toEqual({
      model: "issue-explicit",
      modelReasoningEffort: "low",
      approvalPolicy: "strict",
    });
  });

  it("lets agent runtime profile config customize adapter defaults", () => {
    const modelProfile = resolveModelProfileApplication({
      adapterModelProfiles: [cheapProfile],
      agentRuntimeConfig: {
        modelProfiles: {
          cheap: {
            adapterConfig: {
              model: "agent-cheap",
            },
          },
        },
      },
      issueModelProfile: null,
      contextSnapshot: { modelProfile: "cheap" },
    });

    expect(modelProfile).toMatchObject({
      requested: "cheap",
      requestedBy: "wake_context",
      applied: "cheap",
      configSource: "agent_runtime",
      adapterConfig: {
        model: "agent-cheap",
        modelReasoningEffort: "low",
      },
    });
  });

  it("falls back to the primary config when the adapter does not support the requested profile", () => {
    const modelProfile = resolveModelProfileApplication({
      adapterModelProfiles: [],
      agentRuntimeConfig: {
        modelProfiles: {
          cheap: {
            adapterConfig: {
              model: "agent-cheap",
            },
          },
        },
      },
      issueModelProfile: null,
      contextSnapshot: { modelProfile: "cheap" },
    });

    const merged = mergeModelProfileAdapterConfig({
      baseConfig: {
        model: "primary",
      },
      modelProfile,
      issueAdapterConfig: null,
    });

    expect(modelProfile).toMatchObject({
      requested: "cheap",
      applied: null,
      fallbackReason: "adapter_profile_not_supported",
      adapterConfig: null,
    });
    expect(merged).toEqual({ model: "primary" });
  });

  it("normalizes a wake payload model profile into run context", () => {
    const contextSnapshot = normalizeModelProfileWakeContext({
      contextSnapshot: {},
      payload: { modelProfile: "cheap" },
    });

    expect(contextSnapshot).toMatchObject({ modelProfile: "cheap" });
  });
});

describe("ENGA-616 routine model-profile lever", () => {
  describe("parseRoutineModelProfileMap", () => {
    it("returns an empty map when unset, blank, or malformed (lever off)", () => {
      expect(parseRoutineModelProfileMap(undefined)).toEqual({});
      expect(parseRoutineModelProfileMap("")).toEqual({});
      expect(parseRoutineModelProfileMap("   ")).toEqual({});
      expect(parseRoutineModelProfileMap("{not json")).toEqual({});
      expect(parseRoutineModelProfileMap("[\"cheap\"]")).toEqual({});
      expect(parseRoutineModelProfileMap("\"cheap\"")).toEqual({});
    });

    it("keeps only entries whose value is a known model-profile key", () => {
      expect(
        parseRoutineModelProfileMap(
          JSON.stringify({
            heartbeat_timer: "cheap",
            issue_monitor_due: "cheap",
            issue_assigned: "opus", // unknown profile key -> dropped
            "": "cheap", // empty reason -> dropped
            bad: 123, // non-string value -> dropped
          }),
        ),
      ).toEqual({ heartbeat_timer: "cheap", issue_monitor_due: "cheap" });
    });
  });

  describe("resolveWakeReasonModelProfile", () => {
    const map = { heartbeat_timer: "cheap", issue_monitor_due: "cheap" } as const;

    it("returns the mapped profile for a matching wake reason", () => {
      expect(resolveWakeReasonModelProfile({ wakeReason: "heartbeat_timer", map })).toBe("cheap");
    });

    it("returns null for unmapped reasons, blank input, or an empty map", () => {
      expect(resolveWakeReasonModelProfile({ wakeReason: "issue_assigned", map })).toBeNull();
      expect(resolveWakeReasonModelProfile({ wakeReason: null, map })).toBeNull();
      expect(resolveWakeReasonModelProfile({ wakeReason: "  ", map })).toBeNull();
      expect(resolveWakeReasonModelProfile({ wakeReason: "heartbeat_timer", map: {} })).toBeNull();
      expect(resolveWakeReasonModelProfile({ wakeReason: "heartbeat_timer", map: null })).toBeNull();
    });
  });

  describe("applyRoutineModelProfileWakeContext", () => {
    const map = { heartbeat_timer: "cheap" } as const;

    it("tiers a routine wake reason to its mapped profile", () => {
      const contextSnapshot = applyRoutineModelProfileWakeContext({
        contextSnapshot: { wakeReason: "heartbeat_timer" },
        routineModelProfileMap: map,
      });
      expect(contextSnapshot).toMatchObject({ modelProfile: "cheap" });
    });

    it("leaves assignment-style wakes on the agent's primary model", () => {
      const contextSnapshot = applyRoutineModelProfileWakeContext({
        contextSnapshot: { wakeReason: "issue_assigned" },
        routineModelProfileMap: map,
      });
      expect(contextSnapshot.modelProfile).toBeUndefined();
    });

    it("never overrides an explicitly requested profile", () => {
      const contextSnapshot = applyRoutineModelProfileWakeContext({
        contextSnapshot: { wakeReason: "heartbeat_timer", modelProfile: "cheap" },
        routineModelProfileMap: {},
      });
      expect(contextSnapshot).toMatchObject({ modelProfile: "cheap" });
    });

    it("is a no-op when the lever is off (empty map)", () => {
      const contextSnapshot = applyRoutineModelProfileWakeContext({
        contextSnapshot: { wakeReason: "heartbeat_timer" },
        routineModelProfileMap: {},
      });
      expect(contextSnapshot.modelProfile).toBeUndefined();
    });
  });
});
