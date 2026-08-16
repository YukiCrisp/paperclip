import { describe, expect, it } from "vitest";
import { classifyContinuationFailure, continuationRetryPolicyKeyForErrorCode } from "./service.js";

const run = (errorCode: string | null) =>
  ({ errorCode } as unknown as Parameters<typeof classifyContinuationFailure>[0]);

describe("pause durability: continuation retry classification", () => {
  it("agent_paused is retryable so work resumes (Option A: Resume Continues Work)", () => {
    // Pause still emits errorCode agent_paused for observability, but it is NOT
    // non-retryable. On resume the agent becomes invokable again and this classifies
    // as default/retryable, so the continuation re-enqueues and the issue continues
    // rather than escalating to blocked. Durability is guaranteed separately by the
    // execution-start guard (Change B), not by this classification.
    const c = classifyContinuationFailure(run("agent_paused"));
    expect(c.kind).toBe("default");
    expect(c.maxAttempts).toBeGreaterThan(0);
  });

  it("agent_not_invokable (execution-start abort) is non-retryable", () => {
    expect(classifyContinuationFailure(run("agent_not_invokable")).kind).toBe("non_retryable");
  });

  it("timed_out (timeout) still retries as transient infra", () => {
    const c = classifyContinuationFailure(run("timeout"));
    expect(c.kind).toBe("transient_infra");
    expect(c.maxAttempts).toBeGreaterThan(0);
  });

  it("codex harness crashes retry as transient infra", () => {
    const c = classifyContinuationFailure(run("codex_harness_crash"));
    expect(c.kind).toBe("transient_infra");
    expect(c.maxAttempts).toBeGreaterThan(0);
  });

  // A handshake the watchdog cut did no work at all, so a retry costs nothing
  // and is the only useful response. Unregistered it would fall to the default
  // branch — one attempt — and escalate the issue to `blocked` on a single
  // strike, which is strictly worse than the unbounded stall it replaced.
  it("acpx handshake watchdog kills retry as transient infra", () => {
    const c = classifyContinuationFailure(run("acpx_handshake_timeout"));
    expect(c.kind).toBe("transient_infra");
    expect(c.maxAttempts).toBeGreaterThan(0);
  });

  // Same policy as the neighbouring acpx codes, which is what makes a host-side
  // outage count as one episode in the retry-streak detector instead of a run
  // of unrelated single strikes.
  it("shares its retry policy with the other acpx failure codes", () => {
    expect(continuationRetryPolicyKeyForErrorCode("acpx_handshake_timeout")).toBe(
      continuationRetryPolicyKeyForErrorCode("acpx_session_init_failed"),
    );
  });

  it("generic cancelled (non-pause cancellation) is NOT non-retryable", () => {
    // non-pause cancellations (the internal invokability cancel and budget pause) keep errorCode "cancelled" -> default branch
    expect(classifyContinuationFailure(run("cancelled")).kind).toBe("default");
  });

  it("genuine failure with no/unknown code retries via default branch", () => {
    expect(classifyContinuationFailure(run(null)).kind).toBe("default");
    expect(classifyContinuationFailure(run("some_adapter_error")).kind).toBe("default");
  });
});
