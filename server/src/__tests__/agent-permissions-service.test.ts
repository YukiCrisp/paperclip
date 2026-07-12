import { describe, expect, it } from "vitest";
import {
  agentPermissionsSchema,
  updateAgentPermissionsSchema,
} from "@paperclipai/shared";
import {
  defaultPermissionsForRole,
  normalizeAgentPermissions,
} from "../services/agent-permissions.js";

describe("agent permissions service", () => {
  it("keeps agent-creation authority least-privileged by default", () => {
    expect(defaultPermissionsForRole("ceo").canCreateAgents).toBe(true);
    expect(defaultPermissionsForRole("CTO").canCreateAgents).toBe(false);
    expect(defaultPermissionsForRole("engineering-manager").canCreateAgents).toBe(false);
    expect(defaultPermissionsForRole("engineer").canCreateAgents).toBe(false);
  });

  it("enables skill creation for every role by default", () => {
    expect(defaultPermissionsForRole("ceo").canCreateSkills).toBe(true);
    expect(defaultPermissionsForRole("CTO").canCreateSkills).toBe(true);
    expect(defaultPermissionsForRole("engineering-manager").canCreateSkills).toBe(true);
    expect(defaultPermissionsForRole("engineer").canCreateSkills).toBe(true);
  });

  it("preserves explicit canCreateAgents overrides", () => {
    expect(normalizeAgentPermissions({ canCreateAgents: false }, "cto").canCreateAgents).toBe(false);
    expect(normalizeAgentPermissions({ canCreateAgents: true }, "engineer").canCreateAgents).toBe(true);
  });

  it("grants resume authority to the CEO role by default only", () => {
    expect(defaultPermissionsForRole("ceo").canResumeAgents).toBe(true);
    expect(defaultPermissionsForRole("CEO").canResumeAgents).toBe(true);
    expect(defaultPermissionsForRole("cto").canResumeAgents).toBe(false);
    expect(defaultPermissionsForRole("engineer").canResumeAgents).toBe(false);
  });

  it("preserves explicit canResumeAgents overrides", () => {
    expect(normalizeAgentPermissions({ canResumeAgents: true }, "engineer").canResumeAgents).toBe(true);
    expect(normalizeAgentPermissions({ canResumeAgents: false }, "ceo").canResumeAgents).toBe(false);
  });

  it("defaults canResumeAgents from role when unspecified", () => {
    expect(normalizeAgentPermissions({ canCreateAgents: true }, "ceo").canResumeAgents).toBe(true);
    expect(normalizeAgentPermissions({ canCreateAgents: false }, "engineer").canResumeAgents).toBe(false);
  });

  it("defaults missing skill creation permission to true and preserves explicit false", () => {
    expect(normalizeAgentPermissions({}, "engineer").canCreateSkills).toBe(true);
    expect(normalizeAgentPermissions({ canCreateSkills: false }, "ceo").canCreateSkills).toBe(false);
    expect(normalizeAgentPermissions({ canCreateSkills: true }, "engineer").canCreateSkills).toBe(true);
  });

  it("validates skill creation permission with a default-on value", () => {
    expect(agentPermissionsSchema.parse({ canCreateAgents: false }).canCreateSkills).toBe(true);
    expect(agentPermissionsSchema.parse({ canCreateAgents: false, canCreateSkills: false }).canCreateSkills).toBe(false);
    expect(updateAgentPermissionsSchema.parse({
      canCreateAgents: false,
      canAssignTasks: false,
    }).canCreateSkills).toBeUndefined();
    expect(updateAgentPermissionsSchema.parse({
      canCreateAgents: false,
      canCreateSkills: false,
      canAssignTasks: false,
    }).canCreateSkills).toBe(false);
  });
});
