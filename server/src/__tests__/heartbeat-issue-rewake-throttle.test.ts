import { randomUUID } from "node:crypto";
import { and, desc, eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  activityLog,
  agentRuntimeState,
  agentWakeupRequests,
  agents,
  companies,
  companySkills,
  createDb,
  environmentLeases,
  environments,
  executionWorkspaces,
  heartbeatRunEvents,
  heartbeatRuns,
  issueComments,
  issueRelations,
  issues,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { heartbeatService } from "../services/heartbeat.ts";
import { runningProcesses } from "../adapters/index.ts";

const mockAdapterExecute = vi.hoisted(() =>
  vi.fn(async () => ({
    exitCode: 0,
    signal: null,
    timedOut: false,
    errorMessage: null,
    summary: "Issue rewake throttle test run.",
    provider: "test",
    model: "test-model",
  })),
);

vi.mock("../adapters/index.ts", async () => {
  const actual = await vi.importActual<typeof import("../adapters/index.ts")>("../adapters/index.ts");
  return {
    ...actual,
    getServerAdapter: vi.fn(() => ({
      supportsLocalAgentJwt: false,
      execute: mockAdapterExecute,
    })),
  };
});

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres issue rewake throttle tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("heartbeat issue rewake throttle", () => {
  let db!: ReturnType<typeof createDb>;
  let heartbeat!: ReturnType<typeof heartbeatService>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-heartbeat-issue-rewake-throttle-");
    db = createDb(tempDb.connectionString);
    heartbeat = heartbeatService(db);
  }, 20_000);

  afterEach(async () => {
    runningProcesses.clear();
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const runs = await db.select({ status: heartbeatRuns.status }).from(heartbeatRuns);
      if (!runs.some((run) => run.status === "queued" || run.status === "running")) break;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    // Post-run bookkeeping (run-event records, follow-up wake scheduling) can
    // still write for a moment after a run reaches a terminal status, so a
    // single delete sweep can hit a foreign-key violation when a late insert
    // lands between two deletes. Retry the sweep until it goes through clean.
    for (let attempt = 0; ; attempt += 1) {
      try {
        await db.delete(environmentLeases);
        await db.delete(issueComments);
        await db.delete(issueRelations);
        await db.delete(issues);
        await db.delete(heartbeatRunEvents);
        await db.delete(activityLog);
        await db.delete(heartbeatRuns);
        await db.delete(agentWakeupRequests);
        await db.delete(agentRuntimeState);
        await db.delete(agents);
        await db.delete(environments);
        await db.delete(executionWorkspaces);
        await db.delete(companySkills);
        await db.delete(companies);
        break;
      } catch (error) {
        if (attempt >= 4) throw error;
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
    }
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedCompanyAgentIssue() {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const issueId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
      defaultResponsibleUserId: "responsible-user",
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "CodexCoder",
      role: "engineer",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {
        heartbeat: {
          wakeOnDemand: true,
          maxConcurrentRuns: 1,
        },
      },
      permissions: {},
    });
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Interrupted import mission",
      status: "in_progress",
      priority: "medium",
      assigneeAgentId: agentId,
      responsibleUserId: "responsible-user",
    });

    return { companyId, agentId, issueId };
  }

  async function seedTerminalRun(input: {
    companyId: string;
    agentId: string;
    issueId: string;
    status?: string;
    errorCode?: string;
    finishedSecondsAgo: number;
    startedSecondsAgo?: number;
    /** Staleness cancels are decided before spawn, so they never start. */
    neverStarted?: boolean;
  }) {
    const runId = randomUUID();
    const finishedAt = new Date(Date.now() - input.finishedSecondsAgo * 1000);
    const startedAt = input.startedSecondsAgo === undefined
      ? new Date(finishedAt.getTime() - 5_000)
      : new Date(Date.now() - input.startedSecondsAgo * 1000);
    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId: input.companyId,
      agentId: input.agentId,
      invocationSource: "assignment",
      status: input.status ?? "succeeded",
      errorCode: input.errorCode ?? null,
      responsibleUserId: "responsible-user",
      createdAt: startedAt,
      startedAt: input.neverStarted ? null : startedAt,
      finishedAt,
      contextSnapshot: { issueId: input.issueId, wakeReason: "issue_assigned" },
    });
    return runId;
  }

  function assignmentWake(agentId: string, issueId: string) {
    return heartbeat.wakeup(agentId, {
      source: "assignment",
      triggerDetail: "system",
      reason: "issue_assigned",
      payload: { issueId },
      contextSnapshot: { issueId, wakeReason: "issue_assigned" },
      requestedByActorType: "system",
      requestedByActorId: "test",
    });
  }

  async function latestWakeRequest(agentId: string) {
    return db
      .select({
        status: agentWakeupRequests.status,
        reason: agentWakeupRequests.reason,
        payload: agentWakeupRequests.payload,
      })
      .from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.agentId, agentId))
      .orderBy(desc(agentWakeupRequests.requestedAt))
      .limit(1)
      .then((rows) => rows[0] ?? null);
  }

  it("skips event-free re-wakes after consecutive no-progress runs and admits them again on new input", async () => {
    const { companyId, agentId, issueId } = await seedCompanyAgentIssue();

    await seedTerminalRun({ companyId, agentId, issueId, finishedSecondsAgo: 40 });
    await seedTerminalRun({ companyId, agentId, issueId, finishedSecondsAgo: 10 });

    const throttledWake = await assignmentWake(agentId, issueId);
    expect(throttledWake).toBeNull();

    const skipped = await latestWakeRequest(agentId);
    expect(skipped?.status).toBe("skipped");
    expect(skipped?.reason).toBe("issue_rewake_throttled");
    const heartbeatSkip = (skipped?.payload as Record<string, unknown> | null)?.heartbeatSkip as
      | Record<string, unknown>
      | undefined;
    expect(heartbeatSkip?.noProgressStreak).toBe(2);
    expect(typeof heartbeatSkip?.nextAllowedAt).toBe("string");

    const runCount = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.companyId, companyId))
      .then((rows) => rows[0]?.count ?? 0);
    expect(runCount).toBe(2);

    // A board comment on the issue is new input: the next event-free wake is
    // admitted even though the streak has not been broken by a run.
    await db.insert(activityLog).values({
      companyId,
      actorType: "user",
      actorId: "board-user",
      action: "issue.comment_added",
      entityType: "issue",
      entityId: issueId,
    });

    const admittedWake = await assignmentWake(agentId, issueId);
    expect(admittedWake).not.toBeNull();
  });

  it("does not throttle comment-driven wakes even during a no-progress streak", async () => {
    const { companyId, agentId, issueId } = await seedCompanyAgentIssue();

    await seedTerminalRun({ companyId, agentId, issueId, finishedSecondsAgo: 40 });
    await seedTerminalRun({ companyId, agentId, issueId, finishedSecondsAgo: 10 });

    const commentWake = await heartbeat.wakeup(agentId, {
      source: "automation",
      triggerDetail: "system",
      reason: "issue_commented",
      payload: { issueId, commentId: randomUUID() },
      contextSnapshot: { issueId, wakeReason: "issue_commented" },
      requestedByActorType: "system",
      requestedByActorId: "test",
    });
    expect(commentWake).not.toBeNull();
  });

  it("does not throttle the wake that follows a failed run", async () => {
    const { companyId, agentId, issueId } = await seedCompanyAgentIssue();

    await seedTerminalRun({ companyId, agentId, issueId, finishedSecondsAgo: 70 });
    await seedTerminalRun({ companyId, agentId, issueId, finishedSecondsAgo: 40 });
    await seedTerminalRun({ companyId, agentId, issueId, status: "failed", finishedSecondsAgo: 10 });

    const recoveryWake = await assignmentWake(agentId, issueId);
    expect(recoveryWake).not.toBeNull();
  });

  // ENGA-2429: dequeue-time staleness cancels are the throttle's own mitigation
  // output. If they broke the streak, the throttle would be blind to the loop it
  // exists to damp — the observed failure was 358 wakes in 76 minutes on one issue.
  it("throttles a re-wake storm made of dequeue-time staleness cancels", async () => {
    const { companyId, agentId, issueId } = await seedCompanyAgentIssue();

    for (const finishedSecondsAgo of [39, 26, 13]) {
      await seedTerminalRun({
        companyId,
        agentId,
        issueId,
        status: "cancelled",
        errorCode: "issue_continuation_waiting_on_review",
        neverStarted: true,
        finishedSecondsAgo,
      });
    }

    const wake = await assignmentWake(agentId, issueId);
    expect(wake).toBeNull();

    const skipped = await latestWakeRequest(agentId);
    expect(skipped?.reason).toBe("issue_rewake_throttled");
    const heartbeatSkip = (skipped?.payload as Record<string, unknown> | null)?.heartbeatSkip as
      | Record<string, unknown>
      | undefined;
    expect(heartbeatSkip?.noProgressStreak).toBe(3);

    // No new run row: the storm stops costing control-plane writes too.
    const runCount = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.companyId, companyId))
      .then((rows) => rows[0]?.count ?? 0);
    expect(runCount).toBe(3);
  });

  it("does not throttle the wake that follows a crash-shaped cancel", async () => {
    const { companyId, agentId, issueId } = await seedCompanyAgentIssue();

    await seedTerminalRun({
      companyId,
      agentId,
      issueId,
      status: "cancelled",
      errorCode: "issue_continuation_waiting_on_review",
      neverStarted: true,
      finishedSecondsAgo: 40,
    });
    await seedTerminalRun({
      companyId,
      agentId,
      issueId,
      status: "cancelled",
      errorCode: "process_lost",
      finishedSecondsAgo: 10,
    });

    const recoveryWake = await assignmentWake(agentId, issueId);
    expect(recoveryWake).not.toBeNull();
  });

  // ENGA-2434: `issue_dependencies_blocked` is the other pre-spawn cancel code.
  // These four cases are the measurement the ticket asked for — where the
  // dependency spin is actually absorbed, and how an issue gets out of the
  // cooldown once its blockers resolve.
  describe("dependency-gate cancels", () => {
    async function seedUnresolvedBlocker(companyId: string, agentId: string, issueId: string) {
      const blockerId = randomUUID();
      await db.insert(issues).values({
        id: blockerId,
        companyId,
        title: "Upstream blocker",
        status: "in_progress",
        priority: "medium",
        assigneeAgentId: agentId,
        responsibleUserId: "responsible-user",
      });
      await db.insert(issueRelations).values({
        companyId,
        issueId: blockerId,
        relatedIssueId: issueId,
        type: "blocks",
      });
      return blockerId;
    }

    function seedDependencyBlockedStreak(companyId: string, agentId: string, issueId: string) {
      // The shape a claim-time dependency cancel leaves behind: the run was
      // queued while dependencies looked ready, the blocker landed before
      // `claimQueuedRun` reached it, and the run died before spawning.
      return Promise.all(
        [39, 26, 13].map((finishedSecondsAgo) =>
          seedTerminalRun({
            companyId,
            agentId,
            issueId,
            status: "cancelled",
            errorCode: "issue_dependencies_blocked",
            neverStarted: true,
            finishedSecondsAgo,
          }),
        ),
      );
    }

    // The ticket assumed a blocked issue could spin the same way ENGA-2429's
    // issue did. It cannot: `enqueueWakeup` has its own dependency gate that
    // fires before the throttle, so a persistently blocked issue never gets a
    // run row at all. The claim-time cancel this change covers is the narrower
    // race where the blocker lands after the run was already queued.
    it("never reaches the throttle while blockers are unresolved: no run is created at all", async () => {
      const { companyId, agentId, issueId } = await seedCompanyAgentIssue();
      await seedUnresolvedBlocker(companyId, agentId, issueId);

      for (let attempt = 0; attempt < 3; attempt += 1) {
        expect(await assignmentWake(agentId, issueId)).toBeNull();
      }

      const skipped = await latestWakeRequest(agentId);
      expect(skipped?.status).toBe("skipped");
      // Skipped by the dependency gate, not the throttle.
      expect(skipped?.reason).toBe("issue_dependencies_blocked");

      const runCount = await db
        .select({ count: sql<number>`count(*)::int` })
        .from(heartbeatRuns)
        .where(eq(heartbeatRuns.companyId, companyId))
        .then((rows) => rows[0]?.count ?? 0);
      expect(runCount).toBe(0);
    });

    it("throttles event-free wakes after a streak of claim-time dependency cancels", async () => {
      const { companyId, agentId, issueId } = await seedCompanyAgentIssue();
      await seedDependencyBlockedStreak(companyId, agentId, issueId);

      const wake = await assignmentWake(agentId, issueId);
      expect(wake).toBeNull();

      const skipped = await latestWakeRequest(agentId);
      expect(skipped?.reason).toBe("issue_rewake_throttled");
      const heartbeatSkip = (skipped?.payload as Record<string, unknown> | null)?.heartbeatSkip as
        | Record<string, unknown>
        | undefined;
      expect(heartbeatSkip?.noProgressStreak).toBe(3);

      const runCount = await db
        .select({ count: sql<number>`count(*)::int` })
        .from(heartbeatRuns)
        .where(eq(heartbeatRuns.companyId, companyId))
        .then((rows) => rows[0]?.count ?? 0);
      expect(runCount).toBe(3);
    });

    // The load-bearing check. Recovery must not depend on the cooldown expiring,
    // or a 30-minute ceiling would become a 30-minute stall on every unblock.
    it("admits the blockers-resolved wake while the cooldown is still running", async () => {
      const { companyId, agentId, issueId } = await seedCompanyAgentIssue();
      const blockerId = randomUUID();
      await seedDependencyBlockedStreak(companyId, agentId, issueId);

      expect(await assignmentWake(agentId, issueId)).toBeNull();
      expect((await latestWakeRequest(agentId))?.reason).toBe("issue_rewake_throttled");

      // Same wake the issue update/comment routes and the issue-graph liveness
      // backstop emit when the last blocker clears.
      const resolvedWake = await heartbeat.wakeup(agentId, {
        source: "automation",
        triggerDetail: "system",
        reason: "issue_blockers_resolved",
        payload: { issueId, resolvedBlockerIssueId: blockerId, blockerIssueIds: [blockerId] },
        contextSnapshot: {
          issueId,
          taskId: issueId,
          wakeReason: "issue_blockers_resolved",
          source: "issue.update",
          resolvedBlockerIssueId: blockerId,
          blockerIssueIds: [blockerId],
        },
        requestedByActorType: "system",
        requestedByActorId: "test",
      });
      expect(resolvedWake).not.toBeNull();
    });

    it("clears the streak for later event-free wakes once the resolution activity lands", async () => {
      const { companyId, agentId, issueId } = await seedCompanyAgentIssue();
      await seedDependencyBlockedStreak(companyId, agentId, issueId);

      expect(await assignmentWake(agentId, issueId)).toBeNull();

      // Logged by every path that emits `issue_blockers_resolved`, so an
      // assignment poller that arrives after the wake was consumed is admitted
      // too instead of waiting out the cooldown.
      await db.insert(activityLog).values({
        companyId,
        actorType: "system",
        actorId: "issue_update",
        agentId,
        action: "issue.blockers_resolved_wake_emitted",
        entityType: "issue",
        entityId: issueId,
      });

      expect(await assignmentWake(agentId, issueId)).not.toBeNull();
    });
  });

  it("does not throttle when a recent run produced issue-visible progress", async () => {
    const { companyId, agentId, issueId } = await seedCompanyAgentIssue();

    await seedTerminalRun({ companyId, agentId, issueId, finishedSecondsAgo: 40 });
    const progressRunId = await seedTerminalRun({ companyId, agentId, issueId, finishedSecondsAgo: 10 });
    await db.insert(activityLog).values({
      companyId,
      actorType: "agent",
      actorId: agentId,
      agentId,
      runId: progressRunId,
      action: "issue.comment_added",
      entityType: "issue",
      entityId: issueId,
      createdAt: new Date(Date.now() - 11_000),
    });

    const wake = await assignmentWake(agentId, issueId);
    expect(wake).not.toBeNull();
  });

  it("does not count progress on another issue toward the current issue", async () => {
    const { companyId, agentId, issueId } = await seedCompanyAgentIssue();
    const otherIssueId = randomUUID();
    await db.insert(issues).values({
      id: otherIssueId,
      companyId,
      title: "Related follow-up",
      status: "in_progress",
      priority: "medium",
      assigneeAgentId: agentId,
      responsibleUserId: "responsible-user",
    });

    await seedTerminalRun({ companyId, agentId, issueId, finishedSecondsAgo: 40 });
    const progressRunId = await seedTerminalRun({ companyId, agentId, issueId, finishedSecondsAgo: 10 });
    await db.insert(activityLog).values({
      companyId,
      actorType: "agent",
      actorId: agentId,
      agentId,
      runId: progressRunId,
      action: "issue.comment_added",
      entityType: "issue",
      entityId: otherIssueId,
      createdAt: new Date(Date.now() - 11_000),
    });

    const wake = await assignmentWake(agentId, issueId);
    expect(wake).toBeNull();
    expect((await latestWakeRequest(agentId))?.reason).toBe("issue_rewake_throttled");
  });

  it("counts a long-running session that finished inside the lookback window", async () => {
    const { companyId, agentId, issueId } = await seedCompanyAgentIssue();

    await seedTerminalRun({
      companyId,
      agentId,
      issueId,
      finishedSecondsAgo: 40,
      startedSecondsAgo: 7 * 60 * 60,
    });
    await seedTerminalRun({ companyId, agentId, issueId, finishedSecondsAgo: 10 });

    const wake = await assignmentWake(agentId, issueId);
    expect(wake).toBeNull();
    expect((await latestWakeRequest(agentId))?.reason).toBe("issue_rewake_throttled");
  });
});
