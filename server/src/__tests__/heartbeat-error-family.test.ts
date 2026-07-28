import { describe, expect, it } from "vitest";
import { readHeartbeatRunErrorFamily } from "../services/heartbeat.ts";

function failedRun(input: {
  error?: string | null;
  errorCode?: string | null;
  resultJson?: unknown;
}) {
  return {
    error: input.error ?? null,
    errorCode: input.errorCode ?? null,
    resultJson: input.resultJson ?? null,
  };
}

// Verbatim strings observed on runs that failed while the host could not reach the
// API. They are the whole reason the acpx phase buckets get a message gate rather
// than a blanket code mapping.
const CONNECTION_REFUSED_TURN_ERROR = "Internal error: API Error: Unable to connect to API (ConnectionRefused)";
const SESSION_INIT_TIMEOUT_ERROR =
  "Claude ACP session creation timed out before session/new completed. This matches the known persistent-session stall seen with some Claude Code and @agentclientprotocol/claude-agent-acp combinations.";

describe("readHeartbeatRunErrorFamily", () => {
  it("keeps the pre-existing families intact", () => {
    expect(readHeartbeatRunErrorFamily(failedRun({ errorCode: "provider_quota" }))).toBe("provider_quota");
    expect(readHeartbeatRunErrorFamily(failedRun({ errorCode: "codex_transient_upstream" }))).toBe(
      "transient_upstream",
    );
    expect(readHeartbeatRunErrorFamily(failedRun({ errorCode: "claude_transient_upstream" }))).toBe(
      "transient_upstream",
    );
    expect(readHeartbeatRunErrorFamily(failedRun({ errorCode: "codex_harness_crash" }))).toBe(
      "transient_upstream",
    );
    expect(readHeartbeatRunErrorFamily(failedRun({ errorCode: "adapter_failed" }))).toBeNull();
  });

  it("still prefers a family the adapter persisted on the run", () => {
    expect(
      readHeartbeatRunErrorFamily(
        failedRun({ errorCode: "acpx_turn_failed", resultJson: { errorFamily: "provider_quota" } }),
      ),
    ).toBe("provider_quota");
  });

  it("classifies acpx connectivity loss as transient upstream", () => {
    expect(
      readHeartbeatRunErrorFamily(
        failedRun({ errorCode: "acpx_turn_failed", error: CONNECTION_REFUSED_TURN_ERROR }),
      ),
    ).toBe("transient_upstream");
    expect(
      readHeartbeatRunErrorFamily(
        failedRun({ errorCode: "acpx_session_init_failed", error: SESSION_INIT_TIMEOUT_ERROR }),
      ),
    ).toBe("transient_upstream");
  });

  it("reads the connectivity message from result json when the error column is empty", () => {
    expect(
      readHeartbeatRunErrorFamily(
        failedRun({
          errorCode: "acpx_turn_failed",
          resultJson: { summary: "API Error: Unable to connect to API (ConnectionRefused)" },
        }),
      ),
    ).toBe("transient_upstream");
    expect(
      readHeartbeatRunErrorFamily(
        failedRun({
          errorCode: "acpx_turn_failed",
          resultJson: { errorMessage: "connect ECONNREFUSED 127.0.0.1:443" },
        }),
      ),
    ).toBe("transient_upstream");
    expect(
      readHeartbeatRunErrorFamily(
        failedRun({ errorCode: "acpx_turn_failed", resultJson: { message: "socket hang up" } }),
      ),
    ).toBe("transient_upstream");
  });

  it("leaves genuine acpx failures unclassified so they still surface as errors", () => {
    expect(
      readHeartbeatRunErrorFamily(
        failedRun({
          errorCode: "acpx_turn_failed",
          error: "Internal error: tool execution failed after 3 attempts",
          resultJson: { summary: "Internal error: tool execution failed after 3 attempts" },
        }),
      ),
    ).toBeNull();
    expect(
      readHeartbeatRunErrorFamily(
        failedRun({ errorCode: "acpx_turn_failed", error: "Turn aborted by the client" }),
      ),
    ).toBeNull();
    expect(
      readHeartbeatRunErrorFamily(failedRun({ errorCode: "acpx_session_init_failed" })),
    ).toBeNull();
  });

  it("does not let the connectivity gate widen other error codes", () => {
    expect(
      readHeartbeatRunErrorFamily(
        failedRun({ errorCode: "adapter_failed", error: CONNECTION_REFUSED_TURN_ERROR }),
      ),
    ).toBeNull();
    expect(
      readHeartbeatRunErrorFamily(
        failedRun({ errorCode: "acpx_auth_required", error: CONNECTION_REFUSED_TURN_ERROR }),
      ),
    ).toBeNull();
  });
});
