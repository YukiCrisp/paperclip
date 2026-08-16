import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { describe, expect, it } from "vitest";

// Fork-local invariant inventory (ENGA-3057).
//
// This fork carries behaviour changes that upstream does not have. Upstream
// follow merges resolve conflicts in bulk and can silently drop one of them:
// `2f484dd51` ("Merge origin/master (218 commits) into local fork") deleted the
// ENGA-2157 scheduler splay *together with its own test file*, so nothing went
// red and the :00 thundering-herd ran unnoticed for 14 days (ENGA-3056).
//
// Each entry below asserts that a fork-local fix is still wired at HEAD. A
// merge that drops one turns this file red instead of going quiet.
//
// Deliberate limit: if a merge deletes *this* file too, nothing here fires.
// The out-of-repo companion covers that case and does not live in this repo:
//   ~/.paperclip/ops/fork-invariants/check-fork-invariants.sh
// It asserts this file exists, and derives the symbol list automatically from
// the fork-only commits (`git log origin/master..master`), so it also covers
// fork fixes that nobody remembered to add here.
//
// When upstream converges on its own version of a fix, update the entry to the
// upstream symbol name (that is a rename, not a loss) — and mirror the change
// in the out-of-repo allowlist.

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SERVER_SRC = path.resolve(HERE, "..");
const REPO_ROOT = path.resolve(SERVER_SRC, "../..");

type ForkInvariant = {
  /** Owning issue, for the person reading the failure. */
  issue: string;
  what: string;
  /** Path relative to the repo root. */
  file: string;
  /** Substrings that must all still be present in that file. */
  markers: string[];
  /** Optional: marker -> minimum occurrence count (catches "defined but unwired"). */
  minOccurrences?: Record<string, number>;
};

const FORK_INVARIANTS: ForkInvariant[] = [
  {
    issue: "ENGA-2157",
    what: "deterministic per-trigger scheduler splay (flattens the :00 thundering-herd)",
    file: "server/src/services/routines.ts",
    markers: ["ROUTINE_TRIGGER_JITTER_WINDOW_SEC", "triggerSplayOffsetSeconds", "nextScheduledRunAt"],
    // 1 definition + every site that persists a scheduled trigger's nextRunAt.
    // A merge that keeps the helper but re-points a persist site back at the
    // clean cron tick silently un-splays that path, so count the call sites.
    minOccurrences: { "nextScheduledRunAt(": 8 },
  },
  {
    issue: "ENGA-2152",
    what: "host-wide run governance cap (prevents process_lost from memory thrashing)",
    file: "server/src/services/heartbeat.ts",
    markers: ["resolveHostConcurrencyCap"],
  },
  {
    issue: "ENGA-2426/2429",
    what: "pre-spawn no-op cancels count as no-progress in the re-wake throttle",
    file: "server/src/services/issue-rewake-throttle.ts",
    markers: ["isPreSpawnNoOpCancelRun"],
  },
  {
    issue: "ENGA-1610/1612",
    what: "stranded routine-execution issues are cancelled, not blocked",
    file: "server/src/services/recovery/service.ts",
    markers: ["cancelStrandedRoutineExecutionIssue"],
  },
  {
    issue: "ENGA-2149",
    what: "provider_quota-stranded issues are parked until the quota resets",
    file: "server/src/services/recovery/service.ts",
    markers: ["isProviderQuotaRecovery"],
  },
  {
    issue: "ENGA-2161",
    what: "unset-fallback agent concurrency defaults to 3, not upstream's 20",
    file: "packages/shared/src/constants.ts",
    markers: ["export const AGENT_DEFAULT_MAX_CONCURRENT_RUNS = 3;"],
  },
];

function readRepoFile(relPath: string) {
  return readFileSync(path.join(REPO_ROOT, relPath), "utf8");
}

function occurrences(haystack: string, needle: string) {
  return haystack.split(needle).length - 1;
}

describe("fork-local invariants survive upstream merges (ENGA-3057)", () => {
  for (const invariant of FORK_INVARIANTS) {
    it(`${invariant.issue}: ${invariant.what}`, () => {
      const source = readRepoFile(invariant.file);
      for (const marker of invariant.markers) {
        expect(
          source.includes(marker),
          `${invariant.issue} is gone from ${invariant.file}: no "${marker}". ` +
            `An upstream merge most likely dropped it — restore it or, if upstream ` +
            `converged on its own version, update this inventory entry.`,
        ).toBe(true);
      }
      for (const [marker, min] of Object.entries(invariant.minOccurrences ?? {})) {
        const found = occurrences(source, marker);
        expect(
          found,
          `${invariant.issue} looks partially unwired in ${invariant.file}: ` +
            `"${marker}" appears ${found}x, expected at least ${min}x.`,
        ).toBeGreaterThanOrEqual(min);
      }
    });
  }

  it("keeps the ENGA-2157 splay test alongside the implementation", () => {
    // The 2026-07-26 merge deleted implementation and test together, which is
    // exactly why nothing went red. Assert the pair explicitly.
    expect(() => readRepoFile("server/src/__tests__/routine-trigger-splay.test.ts")).not.toThrow();
  });
});
