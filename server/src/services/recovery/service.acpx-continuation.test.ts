import { describe, expect, it } from "vitest";
import { classifyContinuationFailure } from "./service.js";

const run = (errorCode: string | null) =>
  ({ errorCode } as unknown as Parameters<typeof classifyContinuationFailure>[0]);

describe("acpx continuation classification", () => {
  it("gives acpx phase failures the same bounded retry budget as adapter_failed", () => {
    const generic = classifyContinuationFailure(run("adapter_failed"));
    for (const errorCode of ["acpx_turn_failed", "acpx_session_init_failed"]) {
      const c = classifyContinuationFailure(run(errorCode));
      expect(c.kind).toBe("transient_infra");
      expect(c.maxAttempts).toBe(generic.maxAttempts);
      expect(c.baseBackoffMs).toBe(generic.baseBackoffMs);
      expect(c.errorCode).toBe(errorCode);
    }
  });

  it("no longer escalates an acpx continuation failure on a single strike", () => {
    // The default policy is one attempt, which is what would false-block an issue
    // whose continuation run happened to land during a host-side outage.
    const fallback = classifyContinuationFailure(run("acpx_unclassified_thing"));
    expect(fallback.kind).toBe("default");
    expect(classifyContinuationFailure(run("acpx_turn_failed")).maxAttempts).toBeGreaterThan(
      fallback.maxAttempts,
    );
  });

  it("leaves non-retryable codes alone", () => {
    expect(classifyContinuationFailure(run("issue_paused")).kind).toBe("non_retryable");
    expect(classifyContinuationFailure(run("budget_exhausted")).kind).toBe("non_retryable");
  });
});
