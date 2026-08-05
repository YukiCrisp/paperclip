import type { Dirent } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

export const HEARTBEAT_RUN_SCRATCH_MARKER = ".paperclip-run-scratch.json";
export const HEARTBEAT_RUN_SCRATCH_PREFIX = "paperclip-run-";

export interface HeartbeatRunScratchMetadata {
  version: 1;
  companyId: string;
  agentId: string;
  runId: string;
  issueId: string | null;
  issueIdentifier: string | null;
  createdAt: string;
}

export interface HeartbeatRunScratch {
  dir: string;
  markerPath: string;
  metadata: HeartbeatRunScratchMetadata;
}

export interface HeartbeatRunScratchEnvResult {
  env: Record<string, string>;
  tempKeysApplied: string[];
}

export type HeartbeatRunScratchCleanupResult =
  | { removed: true; dir: string }
  | { removed: false; dir: string; reason: "missing" | "unmarked" | "owner_mismatch" | "process_group_alive" };

const TEMP_ENV_KEYS = ["TMPDIR", "TEMP", "TMP"] as const;
const ISSUE_SEGMENT_MAX_CHARS = 32;
const RUN_SCRATCH_ROOT_MAX_UNNEST_DEPTH = 16;

/**
 * Resolve the directory new run scratches are created under.
 *
 * `os.tmpdir()` just reports `$TMPDIR`, and a run's own scratch is exported as
 * `TMPDIR` to its child. So whenever a Paperclip server (or a `paperclipai`
 * CLI that spawns one) is started from inside a run — an agent starting a dev
 * server is the common case — every scratch it creates lands *inside* that
 * run's scratch. Observed in the wild three levels deep:
 * `.../paperclip-run-enga-2193-…/paperclip-run-enga-2236-…/paperclip-run-enga-2912-…`.
 *
 * That nesting is not just untidy. The parent's cleanup is gated on its own
 * child exiting, so the whole subtree outlives every run in it, and the path
 * grows past the 104-byte `sockaddr_un` limit until tools that open a Unix
 * socket under `TMPDIR` (`tsx`, for one) fail outright.
 *
 * Walking back out of any `paperclip-run-*` segments lands on the real temp
 * root, so scratch dirs stay siblings no matter how deeply nested the process
 * that created them is.
 */
export function resolveHeartbeatRunScratchRoot(tmpDir: string = os.tmpdir()): string {
  let dir = path.resolve(tmpDir);
  for (let depth = 0; depth < RUN_SCRATCH_ROOT_MAX_UNNEST_DEPTH; depth += 1) {
    if (!path.basename(dir).startsWith(HEARTBEAT_RUN_SCRATCH_PREFIX)) break;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return dir;
}

function sanitizePathSegment(value: string | null | undefined, fallback: string): string {
  const normalized = (value ?? "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, ISSUE_SEGMENT_MAX_CHARS)
    .replace(/[.-]+$/g, "");
  return normalized || fallback;
}

function isPathInside(parent: string, child: string): boolean {
  const relative = path.relative(parent, child);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

async function readMarker(markerPath: string): Promise<HeartbeatRunScratchMetadata | null> {
  try {
    const parsed = JSON.parse(await fs.readFile(markerPath, "utf8")) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    const rec = parsed as Record<string, unknown>;
    if (
      rec.version !== 1 ||
      typeof rec.companyId !== "string" ||
      typeof rec.agentId !== "string" ||
      typeof rec.runId !== "string" ||
      typeof rec.createdAt !== "string"
    ) {
      return null;
    }
    return {
      version: 1,
      companyId: rec.companyId,
      agentId: rec.agentId,
      runId: rec.runId,
      issueId: typeof rec.issueId === "string" ? rec.issueId : null,
      issueIdentifier: typeof rec.issueIdentifier === "string" ? rec.issueIdentifier : null,
      createdAt: rec.createdAt,
    };
  } catch {
    return null;
  }
}

export async function prepareHeartbeatRunScratch(input: {
  companyId: string;
  agentId: string;
  runId: string;
  issueId?: string | null;
  issueIdentifier?: string | null;
  now?: Date;
}): Promise<HeartbeatRunScratch> {
  const issueSegment = sanitizePathSegment(input.issueIdentifier, "unassigned");
  const runSegment = sanitizePathSegment(input.runId.slice(0, 12), "run");
  const dir = await fs.mkdtemp(
    path.join(
      resolveHeartbeatRunScratchRoot(),
      `${HEARTBEAT_RUN_SCRATCH_PREFIX}${issueSegment}-${runSegment}-`,
    ),
  );
  const markerPath = path.join(dir, HEARTBEAT_RUN_SCRATCH_MARKER);
  const metadata: HeartbeatRunScratchMetadata = {
    version: 1,
    companyId: input.companyId,
    agentId: input.agentId,
    runId: input.runId,
    issueId: input.issueId ?? null,
    issueIdentifier: input.issueIdentifier ?? null,
    createdAt: (input.now ?? new Date()).toISOString(),
  };
  await fs.writeFile(markerPath, `${JSON.stringify(metadata, null, 2)}\n`, { mode: 0o600 });
  return { dir, markerPath, metadata };
}

export function buildHeartbeatRunScratchEnv(
  existingEnv: Record<string, unknown>,
  scratch: HeartbeatRunScratch,
): HeartbeatRunScratchEnvResult {
  const env: Record<string, string> = {
    PAPERCLIP_RUN_SCRATCH_DIR: scratch.dir,
    PAPERCLIP_TASK_SCRATCH_DIR: scratch.dir,
    PAPERCLIP_SCRATCH_DIR: scratch.dir,
    PAPERCLIP_TMPDIR: scratch.dir,
  };
  const tempKeysApplied: string[] = [];
  for (const key of TEMP_ENV_KEYS) {
    const existing = existingEnv[key];
    if (typeof existing === "string" && existing.trim().length > 0) continue;
    env[key] = scratch.dir;
    tempKeysApplied.push(key);
  }
  return { env, tempKeysApplied };
}

export async function cleanupHeartbeatRunScratch(input: {
  scratch: HeartbeatRunScratch;
  processGroupId?: number | null;
  isProcessGroupAlive?: (processGroupId: number | null | undefined) => boolean;
}): Promise<HeartbeatRunScratchCleanupResult> {
  // Resolve the same way `prepareHeartbeatRunScratch` does: a server running
  // with a nested `TMPDIR` would otherwise judge its own scratch dirs to be
  // outside the temp root and refuse to ever clean them.
  const tmpRoot = resolveHeartbeatRunScratchRoot();
  const dir = path.resolve(input.scratch.dir);
  if (!isPathInside(tmpRoot, dir) || !path.basename(dir).startsWith(HEARTBEAT_RUN_SCRATCH_PREFIX)) {
    return { removed: false, dir, reason: "unmarked" };
  }
  try {
    const stats = await fs.stat(dir);
    if (!stats.isDirectory()) return { removed: false, dir, reason: "missing" };
  } catch {
    return { removed: false, dir, reason: "missing" };
  }

  const marker = await readMarker(path.join(dir, HEARTBEAT_RUN_SCRATCH_MARKER));
  if (!marker) return { removed: false, dir, reason: "unmarked" };
  if (
    marker.companyId !== input.scratch.metadata.companyId ||
    marker.agentId !== input.scratch.metadata.agentId ||
    marker.runId !== input.scratch.metadata.runId
  ) {
    return { removed: false, dir, reason: "owner_mismatch" };
  }
  if (input.isProcessGroupAlive?.(input.processGroupId) === true) {
    return { removed: false, dir, reason: "process_group_alive" };
  }

  await fs.rm(dir, { recursive: true, force: true });
  return { removed: true, dir };
}

/**
 * What the owning run's DB row says about a scratch directory:
 * - `reclaim` — the run is terminal, nothing will write here again
 * - `keep` — the run is still live
 * - `unknown` — no such run in this instance's database (a worktree instance,
 *   a reset database, a run row that aged out)
 */
export type HeartbeatRunScratchOwnerVerdict = "reclaim" | "keep" | "unknown";

export type HeartbeatRunScratchKeepReason =
  | "run_active"
  | "unknown_owner_too_young"
  | "unmarked_too_young"
  | "nested_kept"
  | "protected_path";

export interface ReapOrphanedRunScratchDirsResult {
  scanned: number;
  removed: string[];
  kept: Array<{ dir: string; reason: HeartbeatRunScratchKeepReason }>;
  failed: Array<{ dir: string; error: string }>;
}

interface RunScratchCandidate {
  dir: string;
  metadata: HeartbeatRunScratchMetadata | null;
  mtimeMs: number;
  nested: RunScratchCandidate[];
}

async function collectRunScratchCandidates(root: string, depth: number): Promise<RunScratchCandidate[]> {
  if (depth < 0) return [];
  let entries: Dirent[];
  try {
    entries = await fs.readdir(root, { withFileTypes: true });
  } catch {
    return [];
  }
  const candidates: RunScratchCandidate[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || !entry.name.startsWith(HEARTBEAT_RUN_SCRATCH_PREFIX)) continue;
    const dir = path.join(root, entry.name);
    let mtimeMs = 0;
    try {
      mtimeMs = (await fs.stat(dir)).mtimeMs;
    } catch {
      continue;
    }
    candidates.push({
      dir,
      metadata: await readMarker(path.join(dir, HEARTBEAT_RUN_SCRATCH_MARKER)),
      mtimeMs,
      // Pre-fix servers nested scratch dirs inside each other, so an orphan
      // subtree can still hide a live run's scratch underneath a dead one.
      nested: await collectRunScratchCandidates(dir, depth - 1),
    });
  }
  return candidates;
}

/**
 * Sweep leftover `paperclip-run-*` scratch directories out of the temp root.
 *
 * `executeRun`'s `finally` is the normal cleanup path, but it only runs once
 * the adapter child's promise settles — so a run whose child outlived its kill
 * leaves its scratch behind forever, with no owner and no record of where it
 * was (the path is never persisted on the run row). 322 of them had piled up by
 * the time ENGA-2912 was diagnosed. This is the independent backstop: it works
 * from the filesystem's own marker files rather than from server memory, so it
 * can also collect scratch dirs stranded by an earlier process lifetime.
 *
 * Deletion is deliberately conservative. A directory goes only when its marker
 * names a run this instance knows to be terminal (or an unknown run old enough
 * to be nobody's), and never while a nested scratch under it is being kept.
 */
export async function reapOrphanedRunScratchDirs(input: {
  resolveOwner: (metadata: HeartbeatRunScratchMetadata) => Promise<HeartbeatRunScratchOwnerVerdict> | HeartbeatRunScratchOwnerVerdict;
  root?: string;
  now?: Date;
  /** How stale an unknown-owner directory must be before it is collected. */
  unknownOwnerMinAgeMs?: number;
  maxDepth?: number;
}): Promise<ReapOrphanedRunScratchDirsResult> {
  const root = path.resolve(input.root ?? resolveHeartbeatRunScratchRoot());
  const nowMs = (input.now ?? new Date()).getTime();
  const unknownOwnerMinAgeMs = input.unknownOwnerMinAgeMs ?? 24 * 60 * 60 * 1000;
  const result: ReapOrphanedRunScratchDirsResult = { scanned: 0, removed: [], kept: [], failed: [] };

  // Never collect a directory this process is itself living in: a server booted
  // from inside a run's scratch would otherwise delete the ground under itself.
  const protectedPaths = [path.resolve(os.tmpdir()), path.resolve(process.cwd())];

  const candidates = await collectRunScratchCandidates(root, Math.max(0, input.maxDepth ?? 4));

  // Returns whether `candidate` was removed, so a parent can refuse to delete a
  // subtree that still holds something live.
  const visit = async (candidate: RunScratchCandidate): Promise<boolean> => {
    result.scanned += 1;
    let nestedAllRemoved = true;
    for (const nested of candidate.nested) {
      if (!(await visit(nested))) nestedAllRemoved = false;
    }

    if (protectedPaths.some((protectedPath) => isPathInside(candidate.dir, protectedPath))) {
      result.kept.push({ dir: candidate.dir, reason: "protected_path" });
      return false;
    }
    // A missing marker is not proof of innocence. On this host 312 of 322
    // leftovers were bare `paperclip-run-*` husks holding nothing but a
    // `node-compile-cache`: cleanup had removed the directory, and then the
    // child that outlived its kill re-created it because its `TMPDIR` still
    // pointed there. Treat those exactly like an unknown owner — collectable,
    // but only once they are stale — since a live run writes its marker in the
    // same breath as its directory.
    const verdict = candidate.metadata ? await input.resolveOwner(candidate.metadata) : "unknown";
    if (verdict === "keep") {
      result.kept.push({ dir: candidate.dir, reason: "run_active" });
      return false;
    }
    if (verdict === "unknown" && nowMs - candidate.mtimeMs < unknownOwnerMinAgeMs) {
      result.kept.push({
        dir: candidate.dir,
        reason: candidate.metadata ? "unknown_owner_too_young" : "unmarked_too_young",
      });
      return false;
    }
    if (!nestedAllRemoved) {
      result.kept.push({ dir: candidate.dir, reason: "nested_kept" });
      return false;
    }

    try {
      await fs.rm(candidate.dir, { recursive: true, force: true });
      result.removed.push(candidate.dir);
      return true;
    } catch (err) {
      result.failed.push({
        dir: candidate.dir,
        error: err instanceof Error ? err.message : String(err),
      });
      return false;
    }
  };

  for (const candidate of candidates) {
    await visit(candidate);
  }
  return result;
}
