import { describe, expect, it, vi } from "vitest";
import { createTestHarness } from "@paperclipai/plugin-sdk/testing";
import manifest from "../src/manifest.js";
import plugin from "../src/worker.js";
import { diffResponse } from "./fixtures.js";

describe("workspace diff plugin", () => {
  it("declares workspace Changes tabs and host diff capability", () => {
    expect(manifest.capabilities).toContain("ui.detailTab.register");
    expect(manifest.capabilities).toContain("execution.workspaces.read");
    expect(manifest.ui?.slots).toContainEqual(expect.objectContaining({
      type: "detailTab",
      displayName: "Changes",
      entityTypes: ["execution_workspace", "project_workspace"],
    }));
  });

  it("fetches changed workspace diffs through the host bridge client", async () => {
    const harness = createTestHarness({ manifest });
    const getDiff = vi.fn().mockResolvedValue(diffResponse());
    harness.ctx.executionWorkspaces.getDiff = getDiff;
    await plugin.definition.setup(harness.ctx);

    const result = await harness.getData("workspace-diff", {
      workspaceId: "workspace-1",
      companyId: "company-1",
      view: "working-tree",
      includeUntracked: false,
      paths: ["src/app.ts"],
    });

    expect(getDiff).toHaveBeenCalledWith("workspace-1", "company-1", {
      view: "working-tree",
      baseRef: null,
      includeUntracked: false,
      paths: ["src/app.ts"],
    });
    expect(result).toMatchObject({
      stats: { fileCount: 1 },
      files: [expect.objectContaining({ path: "src/app.ts" })],
    });
  });

  it("returns empty and truncated host responses without fabricating filesystem data", async () => {
    const harness = createTestHarness({ manifest });
    const empty = diffResponse({ files: [] });
    const truncated = diffResponse({
      files: [],
      truncated: true,
      warnings: [{ code: "file_count_truncated", message: "Too many files.", path: null }],
    });
    const getDiff = vi.fn()
      .mockResolvedValueOnce(empty)
      .mockResolvedValueOnce(truncated);
    harness.ctx.executionWorkspaces.getDiff = getDiff;
    await plugin.definition.setup(harness.ctx);

    await expect(harness.getData("workspace-diff", {
      workspaceId: "workspace-1",
      companyId: "company-1",
    })).resolves.toMatchObject({ files: [], truncated: false });
    await expect(harness.getData("workspace-diff", {
      workspaceId: "workspace-1",
      companyId: "company-1",
    })).resolves.toMatchObject({ files: [], truncated: true });
  });

  it("returns a clear bridge error when required context is missing", async () => {
    const harness = createTestHarness({ manifest });
    await plugin.definition.setup(harness.ctx);

    await expect(harness.getData("workspace-diff", {
      workspaceId: "workspace-1",
    })).rejects.toThrow("workspaceId and companyId are required");
  });
});
