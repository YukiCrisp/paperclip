import { describe, expect, it } from "vitest";
import {
  PROVIDER_QUOTA_RECOVERY_DEFAULT_BACKOFF_MS,
  classifyAdapterFailureForRecovery,
} from "./service.js";

describe("classifyAdapterFailureForRecovery", () => {
  it("classifies usage-limit messages and parses the provider reset time", () => {
    const now = new Date("2026-07-15T20:00:00.000Z");
    const classification = classifyAdapterFailureForRecovery({
      errorCode: "adapter_failed",
      error: "You've hit your usage limit for GPT-5. Try again at 4:30 PM (America/Chicago).",
      resultJson: null,
    }, now);

    expect(classification).toEqual({
      kind: "provider_quota",
      retryAt: new Date("2026-07-15T21:30:00.000Z"),
      parsedResetTime: true,
    });
  });

  it("uses the default recovery backoff when quota reset time is absent", () => {
    const now = new Date("2026-07-15T20:00:00.000Z");
    const classification = classifyAdapterFailureForRecovery({
      errorCode: "adapter_failed",
      error: "Provider quota exceeded for this model.",
      resultJson: null,
    }, now);

    expect(classification).toEqual({
      kind: "provider_quota",
      retryAt: new Date(now.getTime() + PROVIDER_QUOTA_RECOVERY_DEFAULT_BACKOFF_MS),
      parsedResetTime: false,
    });
  });

  it("treats timezone-less provider reset clocks as UTC", () => {
    const now = new Date("2026-07-15T20:00:00.000Z");
    const classification = classifyAdapterFailureForRecovery({
      errorCode: "adapter_failed",
      error: "You've hit your usage limit. Try again at 4:30 PM.",
      resultJson: null,
    }, now);

    expect(classification).toEqual({
      kind: "provider_quota",
      retryAt: new Date("2026-07-16T16:30:00.000Z"),
      parsedResetTime: true,
    });
  });

  it("parses provider reset clocks in 24-hour format", () => {
    const now = new Date("2026-07-15T20:00:00.000Z");
    const classification = classifyAdapterFailureForRecovery({
      errorCode: "adapter_failed",
      error: "You've hit your usage limit. Try again at 21:30 (UTC).",
      resultJson: null,
    }, now);

    expect(classification).toEqual({
      kind: "provider_quota",
      retryAt: new Date("2026-07-15T21:30:00.000Z"),
      parsedResetTime: true,
    });
  });

  it.each([
    "model_not_found: requested model does not exist",
    "No API credentials were found for this provider",
    "API key is not set",
  ])("classifies configuration failures: %s", (error) => {
    expect(classifyAdapterFailureForRecovery({
      errorCode: "adapter_failed",
      error,
      resultJson: null,
    })).toEqual({ kind: "configuration_incomplete" });
  });

  it("ignores quota-like text from non-adapter failures", () => {
    expect(classifyAdapterFailureForRecovery({
      errorCode: "timeout",
      error: "Provider quota exceeded while waiting for a downstream service.",
      resultJson: null,
    })).toBeNull();
  });

  it("does not treat a generic capacity limit as provider quota", () => {
    expect(classifyAdapterFailureForRecovery({
      errorCode: "adapter_failed",
      error: "Workspace storage capacity limit reached.",
      resultJson: null,
    })).toBeNull();
  });
});

describe("acpx session-limit failures", () => {
  // Verbatim from a live failed run: `error_code='acpx_turn_failed'` with the
  // seat's session-limit message on the run's `error` column.
  const SESSION_LIMIT =
    "Internal error: You've hit your session limit · resets 2pm (Asia/Tokyo)";
  // 03:24Z is 12:24 JST, so the same day's 14:00 JST (= 05:00Z) is still ahead.
  const now = new Date("2026-08-16T03:24:00.000Z");

  it("parks a run the adapter tagged as provider_quota", () => {
    expect(classifyAdapterFailureForRecovery({
      errorCode: "acpx_turn_failed",
      error: SESSION_LIMIT,
      resultJson: { errorFamily: "provider_quota" },
    }, now)).toEqual({
      kind: "provider_quota",
      retryAt: new Date("2026-08-16T05:00:00.000Z"),
      parsedResetTime: true,
    });
  });

  it("honours a retryNotBefore the adapter already resolved", () => {
    expect(classifyAdapterFailureForRecovery({
      errorCode: "acpx_turn_failed",
      error: SESSION_LIMIT,
      resultJson: {
        errorFamily: "provider_quota",
        retryNotBefore: "2026-08-16T05:00:00.000Z",
      },
    }, now)).toEqual({
      kind: "provider_quota",
      retryAt: new Date("2026-08-16T05:00:00.000Z"),
      parsedResetTime: true,
    });
  });

  it("reads the 'resets <clock> (<zone>)' wording instead of the flat backoff", () => {
    // The one-hour default would resume at 04:24Z against a 05:00Z reset and
    // burn one more failed run, so falling back here is not harmless.
    const classification = classifyAdapterFailureForRecovery({
      errorCode: "adapter_failed",
      error: SESSION_LIMIT,
      resultJson: null,
    }, now);

    expect(classification).toEqual({
      kind: "provider_quota",
      retryAt: new Date("2026-08-16T05:00:00.000Z"),
      parsedResetTime: true,
    });
    expect(classification).not.toEqual(expect.objectContaining({
      retryAt: new Date(now.getTime() + PROVIDER_QUOTA_RECOVERY_DEFAULT_BACKOFF_MS),
    }));
  });

  it("ignores an untagged acpx turn failure that merely mentions a session limit", () => {
    // The adapter's family tag is the gate. Without it, `acpx_turn_failed` stays
    // the generic turn-failure bucket and must not be parked on message text
    // alone — the message could be the agent's own words echoed into the run.
    expect(classifyAdapterFailureForRecovery({
      errorCode: "acpx_turn_failed",
      error: "The agent wrote about hitting a session limit and then crashed.",
      resultJson: null,
    }, now)).toBeNull();
  });
});
