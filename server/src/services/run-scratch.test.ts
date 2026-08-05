import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  HEARTBEAT_RUN_SCRATCH_MARKER,
  buildHeartbeatRunScratchEnv,
  cleanupHeartbeatRunScratch,
  prepareHeartbeatRunScratch,
  reapOrphanedRunScratchDirs,
  resolveHeartbeatRunScratchRoot,
  type HeartbeatRunScratch,
  type HeartbeatRunScratchOwnerVerdict,
} from "./run-scratch.js";

const cleanupDirs = new Set<string>();

async function trackScratch(scratch: HeartbeatRunScratch) {
  cleanupDirs.add(scratch.dir);
  return scratch;
}

afterEach(async () => {
  await Promise.all(
    Array.from(cleanupDirs, (dir) =>
      fs.rm(dir, { recursive: true, force: true }).catch(() => undefined),
    ),
  );
  cleanupDirs.clear();
});

describe("heartbeat run scratch cleanup", () => {
  it("removes only a marked run-owned scratch directory", async () => {
    const scratch = await trackScratch(await prepareHeartbeatRunScratch({
      companyId: "company-1",
      agentId: "agent-1",
      runId: "run-1",
      issueId: "issue-1",
      issueIdentifier: "PAP-13071",
      now: new Date("2026-07-08T00:00:00.000Z"),
    }));
    await fs.writeFile(path.join(scratch.dir, "tool-cache.txt"), "cache");

    const result = await cleanupHeartbeatRunScratch({ scratch });

    expect(result).toEqual({ removed: true, dir: scratch.dir });
    await expect(fs.stat(scratch.dir)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("preserves paperclip-named directories without the ownership marker", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-run-unmarked-"));
    cleanupDirs.add(dir);
    const scratch: HeartbeatRunScratch = {
      dir,
      markerPath: path.join(dir, HEARTBEAT_RUN_SCRATCH_MARKER),
      metadata: {
        version: 1,
        companyId: "company-1",
        agentId: "agent-1",
        runId: "run-1",
        issueId: null,
        issueIdentifier: null,
        createdAt: new Date("2026-07-08T00:00:00.000Z").toISOString(),
      },
    };

    const result = await cleanupHeartbeatRunScratch({ scratch });

    expect(result).toEqual({ removed: false, dir, reason: "unmarked" });
    await expect(fs.stat(dir)).resolves.toMatchObject({ isDirectory: expect.any(Function) });
  });

  it("preserves marked scratch when the marker owner does not match the run", async () => {
    const scratch = await trackScratch(await prepareHeartbeatRunScratch({
      companyId: "company-1",
      agentId: "agent-1",
      runId: "run-1",
    }));
    const mismatched = {
      ...scratch,
      metadata: {
        ...scratch.metadata,
        runId: "run-2",
      },
    };

    const result = await cleanupHeartbeatRunScratch({ scratch: mismatched });

    expect(result).toEqual({ removed: false, dir: scratch.dir, reason: "owner_mismatch" });
    await expect(fs.stat(scratch.dir)).resolves.toMatchObject({ isDirectory: expect.any(Function) });
  });

  it("skips cleanup while the run process group is still alive", async () => {
    const scratch = await trackScratch(await prepareHeartbeatRunScratch({
      companyId: "company-1",
      agentId: "agent-1",
      runId: "run-1",
    }));

    const result = await cleanupHeartbeatRunScratch({
      scratch,
      processGroupId: 123,
      isProcessGroupAlive: () => true,
    });

    expect(result).toEqual({ removed: false, dir: scratch.dir, reason: "process_group_alive" });
    await expect(fs.stat(scratch.dir)).resolves.toMatchObject({ isDirectory: expect.any(Function) });
  });

  it("builds explicit scratch env without clobbering configured temp dirs", async () => {
    const scratch = await trackScratch(await prepareHeartbeatRunScratch({
      companyId: "company-1",
      agentId: "agent-1",
      runId: "run-1",
    }));

    const result = buildHeartbeatRunScratchEnv({ TMPDIR: "/custom/tmp" }, scratch);

    expect(result.env.PAPERCLIP_RUN_SCRATCH_DIR).toBe(scratch.dir);
    expect(result.env.PAPERCLIP_TASK_SCRATCH_DIR).toBe(scratch.dir);
    expect(result.env.PAPERCLIP_SCRATCH_DIR).toBe(scratch.dir);
    expect(result.env.PAPERCLIP_TMPDIR).toBe(scratch.dir);
    expect(result.env.TMPDIR).toBeUndefined();
    expect(result.env.TEMP).toBe(scratch.dir);
    expect(result.env.TMP).toBe(scratch.dir);
    expect(result.tempKeysApplied).toEqual(["TEMP", "TMP"]);
  });
});

// (ENGA-2918) A run exports its scratch as the child's TMPDIR, so a Paperclip
// server started from inside a run creates every later scratch *within* that
// run's directory. The nested subtree then outlives every run in it and the
// path grows past the 104-byte limit for Unix domain sockets.
describe("heartbeat run scratch root resolution", () => {
  const originalTmpDir = process.env.TMPDIR;

  afterEach(() => {
    if (originalTmpDir === undefined) delete process.env.TMPDIR;
    else process.env.TMPDIR = originalTmpDir;
  });

  // Synthetic root on purpose: resolution is pure path arithmetic, and
  // `os.tmpdir()` is itself a `paperclip-run-*` scratch whenever the suite runs
  // inside an agent run — the very nesting this un-nests — so using it as the
  // expected root would fail everywhere it matters.
  it("walks back out of nested run scratch segments", () => {
    const real = path.join(path.sep, "fixture-temp-root");
    const nested = path.join(real, "paperclip-run-a-1-aaaaaa", "paperclip-run-b-2-bbbbbb");

    expect(resolveHeartbeatRunScratchRoot(nested)).toBe(real);
    expect(resolveHeartbeatRunScratchRoot(real)).toBe(real);
  });

  it("creates a sibling scratch even when TMPDIR points inside another run's scratch", async () => {
    const outer = await trackScratch(await prepareHeartbeatRunScratch({
      companyId: "company-1",
      agentId: "agent-1",
      runId: "run-outer",
    }));
    const root = path.dirname(outer.dir);
    process.env.TMPDIR = outer.dir;

    const inner = await trackScratch(await prepareHeartbeatRunScratch({
      companyId: "company-1",
      agentId: "agent-1",
      runId: "run-inner",
    }));

    expect(path.dirname(inner.dir)).toBe(root);
    expect(inner.dir.startsWith(`${outer.dir}${path.sep}`)).toBe(false);
  });

  it("still cleans a scratch while TMPDIR points inside another run's scratch", async () => {
    const scratch = await trackScratch(await prepareHeartbeatRunScratch({
      companyId: "company-1",
      agentId: "agent-1",
      runId: "run-1",
    }));
    process.env.TMPDIR = path.join(path.dirname(scratch.dir), "paperclip-run-other-9-zzzzzz");

    const result = await cleanupHeartbeatRunScratch({ scratch });

    expect(result).toEqual({ removed: true, dir: scratch.dir });
  });
});

describe("orphaned run scratch reaper", () => {
  let root = "";

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "scratch-reap-root-"));
    cleanupDirs.add(root);
  });

  async function seedScratchDir(input: {
    parent?: string;
    name: string;
    runId?: string | null;
    ageMs?: number;
  }) {
    const dir = path.join(input.parent ?? root, input.name);
    await fs.mkdir(dir, { recursive: true });
    if (input.runId) {
      await fs.writeFile(
        path.join(dir, HEARTBEAT_RUN_SCRATCH_MARKER),
        JSON.stringify({
          version: 1,
          companyId: "company-1",
          agentId: "agent-1",
          runId: input.runId,
          issueId: null,
          issueIdentifier: null,
          createdAt: new Date("2026-08-05T00:00:00.000Z").toISOString(),
        }),
      );
    }
    if (input.ageMs) {
      const when = new Date(Date.now() - input.ageMs);
      await fs.utimes(dir, when, when);
    }
    return dir;
  }

  function resolveOwnerFrom(verdicts: Record<string, HeartbeatRunScratchOwnerVerdict>) {
    return (metadata: { runId: string }) => verdicts[metadata.runId] ?? "unknown";
  }

  it("removes scratch left behind by terminal runs and keeps live ones", async () => {
    const dead = await seedScratchDir({ name: "paperclip-run-enga-1-aaaaaa", runId: "run-dead" });
    const live = await seedScratchDir({ name: "paperclip-run-enga-2-bbbbbb", runId: "run-live" });
    const unmarked = await seedScratchDir({ name: "paperclip-run-enga-3-cccccc" });
    const unrelated = await seedScratchDir({ name: "not-a-run-scratch" });

    const result = await reapOrphanedRunScratchDirs({
      root,
      resolveOwner: resolveOwnerFrom({ "run-dead": "reclaim", "run-live": "keep" }),
    });

    expect(result.removed).toEqual([dead]);
    expect(result.kept).toEqual(
      expect.arrayContaining([
        { dir: live, reason: "run_active" },
        { dir: unmarked, reason: "unmarked_too_young" },
      ]),
    );
    await expect(fs.stat(dead)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(fs.stat(live)).resolves.toBeTruthy();
    await expect(fs.stat(unrelated)).resolves.toBeTruthy();
  });

  // The dominant leftover shape in the wild: cleanup removed the directory
  // (marker and all), then the child that survived its kill re-created it to
  // write a `node-compile-cache`. Nothing owns these, and the old
  // "no marker means hands off" rule would have kept all 312 of them forever.
  it("collects stale marker-less husks a surviving child re-created", async () => {
    const husk = await seedScratchDir({ name: "paperclip-run-enga-1-aaaaaa" });
    await fs.mkdir(path.join(husk, "node-compile-cache"), { recursive: true });
    const staleAt = new Date(Date.now() - 48 * 60 * 60 * 1000);
    await fs.utimes(husk, staleAt, staleAt);

    const result = await reapOrphanedRunScratchDirs({
      root,
      resolveOwner: () => "keep",
      unknownOwnerMinAgeMs: 24 * 60 * 60 * 1000,
    });

    expect(result.removed).toEqual([husk]);
    await expect(fs.stat(husk)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("refuses to delete a dead parent that still holds a live nested scratch", async () => {
    const parent = await seedScratchDir({ name: "paperclip-run-enga-1-aaaaaa", runId: "run-parent" });
    const nested = await seedScratchDir({
      parent,
      name: "paperclip-run-enga-2-bbbbbb",
      runId: "run-nested-live",
    });

    const result = await reapOrphanedRunScratchDirs({
      root,
      resolveOwner: resolveOwnerFrom({ "run-parent": "reclaim", "run-nested-live": "keep" }),
    });

    expect(result.removed).toEqual([]);
    expect(result.kept).toEqual(
      expect.arrayContaining([
        { dir: nested, reason: "run_active" },
        { dir: parent, reason: "nested_kept" },
      ]),
    );
    await expect(fs.stat(nested)).resolves.toBeTruthy();
  });

  it("collects a dead nested subtree bottom-up", async () => {
    const parent = await seedScratchDir({ name: "paperclip-run-enga-1-aaaaaa", runId: "run-parent" });
    await seedScratchDir({ parent, name: "paperclip-run-enga-2-bbbbbb", runId: "run-nested" });

    const result = await reapOrphanedRunScratchDirs({
      root,
      resolveOwner: resolveOwnerFrom({ "run-parent": "reclaim", "run-nested": "reclaim" }),
    });

    expect(result.removed).toContain(parent);
    await expect(fs.stat(parent)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("gives an unknown owner a staleness cushion before collecting it", async () => {
    const fresh = await seedScratchDir({ name: "paperclip-run-enga-1-aaaaaa", runId: "run-unknown-fresh" });
    const stale = await seedScratchDir({
      name: "paperclip-run-enga-2-bbbbbb",
      runId: "run-unknown-stale",
      ageMs: 48 * 60 * 60 * 1000,
    });

    const result = await reapOrphanedRunScratchDirs({
      root,
      resolveOwner: () => "unknown",
      unknownOwnerMinAgeMs: 24 * 60 * 60 * 1000,
    });

    expect(result.removed).toEqual([stale]);
    expect(result.kept).toEqual([{ dir: fresh, reason: "unknown_owner_too_young" }]);
  });

  it("never collects a directory the current process lives in", async () => {
    const host = await seedScratchDir({ name: "paperclip-run-enga-1-aaaaaa", runId: "run-host" });
    const previousTmpDir = process.env.TMPDIR;
    process.env.TMPDIR = path.join(host, "nested-tmp");
    try {
      const result = await reapOrphanedRunScratchDirs({
        root,
        resolveOwner: () => "reclaim",
      });
      expect(result.removed).toEqual([]);
      expect(result.kept).toEqual([{ dir: host, reason: "protected_path" }]);
    } finally {
      if (previousTmpDir === undefined) delete process.env.TMPDIR;
      else process.env.TMPDIR = previousTmpDir;
    }
  });
});
