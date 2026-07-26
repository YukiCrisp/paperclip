// Canonicalises data directory paths so "is the postgres that answered *our*
// cluster?" survives symlinks.
//
// Both sides of that question arrive in different shapes: PostgreSQL's
// `SHOW data_directory` (and postmaster.pid line 2) reports the resolved real
// path, while the configured `dataDir` is whatever the operator wrote — which
// may traverse a symlink. Comparing with `resolve()` alone leaves the symlink
// unresolved on our side only, so a healthy postmaster serving exactly this
// cluster reads as "some other cluster is on that port". The caller treats that
// as unreachable and escalates SIGINT → SIGQUIT against a healthy postmaster
// (ENGA-2448, the same misfire class as ENGA-2446/2447).

import { realpathSync } from "node:fs";
import { resolve } from "node:path";

/**
 * Absolute, symlink-resolved form of `path`.
 *
 * Falls back to `resolve()` when the path does not exist yet (a data directory
 * we are about to initialise) or is unreadable: an absolute path is still a far
 * better comparison key than the raw string, and both sides get the same
 * treatment.
 */
export function normalizeDataDirPath(path: string): string {
  try {
    return realpathSync(resolve(path));
  } catch {
    return resolve(path);
  }
}

/**
 * True when the data directory reported by a reachable postgres is the cluster
 * this boot expects to own.
 *
 * `reachableDataDir` is the raw result of `SHOW data_directory`, which is null
 * when the probe failed — a non-string is always a mismatch.
 */
export function reachableDataDirMatches(
  reachableDataDir: string | null | undefined,
  expectedDataDir: string,
  normalizePath: (path: string) => string = normalizeDataDirPath,
): boolean {
  if (typeof reachableDataDir !== "string") return false;
  return normalizePath(reachableDataDir) === normalizePath(expectedDataDir);
}
