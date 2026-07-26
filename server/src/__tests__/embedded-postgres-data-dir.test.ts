import { mkdtempSync, mkdirSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { realpathSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  normalizeDataDirPath,
  reachableDataDirMatches,
} from "../lib/embedded-postgres-data-dir.js";

// Real symlinks on disk, not mocks: the bug being guarded is precisely that
// `resolve()` does not touch the filesystem, so a fake normalizer would not
// reproduce it.
let root: string;
/** The path an operator configured, traversing a symlinked parent. */
let linkedDataDir: string;
/** The same cluster as PostgreSQL reports it: fully resolved. */
let realDataDir: string;
/** A different cluster on the same machine. */
let foreignDataDir: string;

beforeAll(() => {
  // macOS /tmp is itself a symlink to /private/tmp, so realpath the root first:
  // otherwise every path below carries an extra symlink hop and the "foreign"
  // control would differ for the wrong reason.
  root = realpathSync(mkdtempSync(join(tmpdir(), "enga-2448-")));
  realDataDir = join(root, "instances", "default", "db");
  mkdirSync(realDataDir, { recursive: true });
  foreignDataDir = join(root, "instances", "other", "db");
  mkdirSync(foreignDataDir, { recursive: true });

  symlinkSync(join(root, "instances"), join(root, "instances-link"), "dir");
  linkedDataDir = join(root, "instances-link", "default", "db");
});

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("normalizeDataDirPath", () => {
  it("resolves symlinks in the path", () => {
    expect(normalizeDataDirPath(linkedDataDir)).toBe(realDataDir);
  });

  it("falls back to an absolute path when the directory does not exist yet", () => {
    const missing = join(root, "not-created-yet", "db");
    expect(normalizeDataDirPath(missing)).toBe(missing);
  });
});

describe("reachableDataDirMatches", () => {
  it("matches when the configured data directory reaches the cluster through a symlink", () => {
    // ENGA-2448 regression guard. PostgreSQL's `SHOW data_directory` reports the
    // resolved path; the configured side may not be resolved. With a bare
    // `resolve()` on both sides these two strings differ, the healthy postmaster
    // is declared unreachable, and boot escalates SIGINT → SIGQUIT against it.
    expect(reachableDataDirMatches(realDataDir, linkedDataDir)).toBe(true);
    expect(reachableDataDirMatches(linkedDataDir, realDataDir)).toBe(true);
  });

  it("still matches when neither side involves a symlink", () => {
    expect(reachableDataDirMatches(realDataDir, `${realDataDir}/.`)).toBe(true);
  });

  it("does not match a foreign cluster", () => {
    // The property the SIGQUIT path depends on: normalizing must not make two
    // genuinely different clusters compare equal.
    expect(reachableDataDirMatches(foreignDataDir, realDataDir)).toBe(false);
    expect(reachableDataDirMatches(foreignDataDir, linkedDataDir)).toBe(false);
  });

  it("does not match a symlink pointing at a foreign cluster", () => {
    const decoy = join(root, "decoy-db");
    symlinkSync(foreignDataDir, decoy, "dir");
    expect(reachableDataDirMatches(decoy, linkedDataDir)).toBe(false);
  });

  it("treats a failed probe (null / undefined) as a mismatch", () => {
    expect(reachableDataDirMatches(null, realDataDir)).toBe(false);
    expect(reachableDataDirMatches(undefined, realDataDir)).toBe(false);
  });
});
