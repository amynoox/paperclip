import { randomUUID } from "node:crypto";
import { and, asc, eq, inArray } from "drizzle-orm";
import { activityLog, agents, agentWakeupRequests, companies, createDb, environmentLeases, heartbeatRunEvents, heartbeatRuns,
  issueComments, issueRecoveryActions, issueRelations, issueThreadInteractions, issues } from "@paperclipai/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startEmbeddedPostgresTestDatabase } from "../__tests__/helpers/embedded-postgres.js";
import { logActivity } from "./activity-log.js";
import { createLifecycleDriver } from "./agent-lifecycle-driver.js";
import { getExecutionBlocker } from "./execution-blocker.js";
import { heartbeatService } from "./heartbeat.js";
import { environmentService } from "./environments.js";
import { PAUSE_CUT_WORK_CONTINUED, PAUSE_CUT_WORK_NOT_CONTINUED } from "./pause-resume-continuation.js";

// STUDIO-0074: production, 18-20 Nov 2026. A manual pause cut the runs of a role (run 5f24df87: legacy, cancelled
// `agent_paused`, pauseStop manual, a recorded process that is gone, one local lease released). Each cut run left its
// hold, and after the resume a person had to ask again on every task. The owner decided that the resume of a role
// continues the runs its pause cut. The cases replay that run as it was read in the database, then call the ready hook
// of the lifecycle driver: the function the lifecycle worker calls when the role has resumed.
describe("the runs a pause cut, when the role resumes", () => {
  let temporary: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  beforeAll(async () => {
    temporary = await startEmbeddedPostgresTestDatabase("pause-resume-continuation-");
    db = createDb(temporary.connectionString);
  });
  afterAll(async () => { await temporary?.cleanup(); });

  const GONE_PID = 2_000_000_000;
  type Options = {
    lease?: "local" | "ssh";
    finishedMinutesAgo?: number;
    taskStatus?: string;
    /** Who the `agent.resumed` entry names; `none` writes no entry. */
    resumedBy?: "user" | "agent" | "none";
    /** Replaces the pause's cancellation record. */
    resultJson?: Record<string, unknown>;
    errorCode?: string;
  };
  const manualPauseStop = (at: Date, holds: string[] = ["manual"]) => ({
    cancellation: { reason: "Cancelled due to agent pause", source: "control_plane", expected: true,
      initiator: { type: "system" }, recordedAt: at.toISOString() },
    pauseStop: { holds, companyPauseReason: null }, stopReason: "paused",
    effectiveTimeoutSec: 0, timeoutConfigured: false, timeoutFired: false, timeoutSource: null });
  const resumeEntry = (f: { companyId: string; agentId: string }, by: "user" | "agent" = "user") => logActivity(db, {
    companyId: f.companyId, action: "agent.resumed", entityType: "agent", entityId: f.agentId,
    ...(by === "user" ? { actorType: "user" as const, actorId: "board", details: { actorSource: "local_implicit" } }
      : { actorType: "agent" as const, actorId: f.agentId, agentId: f.agentId }) });
  async function fixture(options: Options = {}) {
    const companyId = randomUUID(), agentId = randomUUID(), issueId = randomUUID(), cutRunId = randomUUID();
    const finishedAt = new Date(Date.now() - (options.finishedMinutesAgo ?? 13 * 60) * 60_000);
    await db.insert(companies).values({ id: companyId, name: "Pause resume", issuePrefix: `R${companyId.slice(0, 6)}` });
    await db.insert(agents).values({ id: agentId, companyId, name: "Dev", role: "engineer",
      adapterType: "claude_local", status: "idle", runtimeConfig: { heartbeat: { wakeOnDemand: true, maxConcurrentRuns: 1 } } });
    await db.insert(issues).values({ id: issueId, companyId, title: "Cut by a pause", status: options.taskStatus ?? "todo",
      assigneeAgentId: agentId });
    const [cut] = await db.insert(heartbeatRuns).values({ id: cutRunId, companyId, agentId,
      invocationSource: "automation", triggerDetail: "system",
      status: "cancelled", runtimeMode: "legacy", executionStage: "settled", errorCode: options.errorCode ?? "agent_paused",
      error: "Cancelled due to agent pause", processPid: GONE_PID, contextSnapshot: { issueId },
      startedAt: new Date(finishedAt.getTime() - 356_000), finishedAt,
      resultJson: options.resultJson ?? manualPauseStop(finishedAt) }).returning();
    const [hold] = await db.insert(issueRecoveryActions).values({ companyId, sourceIssueId: issueId,
      kind: "active_run_watchdog", cause: "legacy_execution_requires_reconciliation", fingerprint: `legacy-execution:${cutRunId}`,
      status: "resolved", outcome: "blocked", ownerType: "board", nextAction: "Automatic recovery stopped.",
      evidence: { runId: cutRunId, automaticRecovery: { policy: "preserve_without_replay_v1", runId: cutRunId, replay: "blocked", actionOutcome: "unknown" } } }).returning();
    const environment = await environmentService(db).ensureLocalEnvironment(companyId);
    const provider = options.lease ?? "local";
    await db.insert(environmentLeases).values({ companyId, environmentId: environment.id, heartbeatRunId: cutRunId, issueId,
      provider, ...(provider === "local" ? {} : { providerLeaseId: `${provider}://worker@mac-03:22/w/${cutRunId}`, cleanupStatus: "success" }),
      status: "expired", leasePolicy: "ephemeral", releasedAt: new Date(finishedAt.getTime() + 70_000),
      metadata: { agentId, driver: provider } });
    await db.insert(heartbeatRunEvents).values({ companyId, agentId, runId: cutRunId, seq: 1,
      eventType: "native.process_identity_recorded", stream: "system", level: "info", message: "identity" });
    // The agent is busy elsewhere: an admitted run stays queued instead of launching a provider.
    await db.insert(heartbeatRuns).values({ companyId, agentId, status: "running" });
    const f = { companyId, agentId, issueId, cut: cut!, hold: hold! };
    if (options.resumedBy !== "none") await resumeEntry(f, options.resumedBy ?? "user");
    return f;
  }
  type Fixture = Awaited<ReturnType<typeof fixture>>;
  /** The role has resumed: the lifecycle worker calls the driver's ready hook. */
  async function roleResumes(f: Fixture) {
    const [agent] = await db.select().from(agents).where(eq(agents.id, f.agentId));
    await createLifecycleDriver(db, {} as never).onReady!(agent as never);
  }
  const traces = (f: Fixture) => db.select().from(activityLog).where(and(eq(activityLog.companyId, f.companyId),
    eq(activityLog.entityType, "issue"), eq(activityLog.entityId, f.issueId),
    inArray(activityLog.action, [PAUSE_CUT_WORK_CONTINUED, PAUSE_CUT_WORK_NOT_CONTINUED]))).orderBy(asc(activityLog.createdAt));
  const wakes = (f: Fixture) => db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.companyId, f.companyId));
  const continuations = async (f: Fixture) => (await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.companyId, f.companyId)))
    .filter(run => run.contextSnapshot?.previousRunId === f.cut.id);
  async function expectContinued(f: Fixture) {
    const started = await continuations(f);
    expect(started, JSON.stringify((await wakes(f)).map(wake => ({ status: wake.status, wait: wake.payload?.executionWait })))).toHaveLength(1);
    expect(started[0]).toMatchObject({ agentId: f.agentId, status: "queued",
      contextSnapshot: { previousRunId: f.cut.id, explicitUserContinuation: { previousRunId: f.cut.id } } });
    expect(await getExecutionBlocker(db, f.companyId, f.issueId)).toBeNull();
    const recorded = await traces(f);
    expect(recorded).toHaveLength(1);
    expect(recorded[0]).toMatchObject({ action: PAUSE_CUT_WORK_CONTINUED, actorType: "system", actorId: "pause-resume",
      details: { interruptedRunId: f.cut.id, resumedByUserId: "board", continuationRunId: started[0]!.id } });
    // The request is the Retry of the person who resumed the role.
    const [retry] = (await wakes(f)).filter(wake => wake.reason === "task_retry");
    expect(retry).toMatchObject({ requestedByActorType: "user", requestedByActorId: "board" });
  }
  /** Nothing started, the hold still holds the task, and one entry on the task says why. */
  async function expectRefused(f: Fixture, reason: string, details: Record<string, unknown> = {}) {
    expect(await continuations(f)).toHaveLength(0);
    const recorded = await traces(f);
    expect(recorded.map(entry => [entry.action, entry.details?.reason])).toEqual([[PAUSE_CUT_WORK_NOT_CONTINUED, reason]]);
    expect(recorded[0]!.details).toMatchObject({ interruptedRunId: f.cut.id, ...details });
  }
  /** Not a run this resume has to look at: no entry, no request, nothing started. */
  async function expectNotLookedAt(f: Fixture) {
    expect(await continuations(f)).toHaveLength(0);
    expect(await traces(f)).toHaveLength(0);
    expect((await wakes(f)).filter(wake => wake.reason === "task_retry")).toHaveLength(0);
  }

  describe("continues by itself", () => {
    it("the run of production: a local lease, a recorded process that is gone", async () => {
      const f = await fixture();
      await roleResumes(f);
      await expectContinued(f);
    });

    it("the same run over an ssh lease, on the stop proof the pause itself accepted", async () => {
      const f = await fixture({ lease: "ssh" });
      await roleResumes(f);
      await expectContinued(f);
    });

    it("once: the ready hook called again, then a second resume, start nothing more", async () => {
      const f = await fixture();
      await roleResumes(f);
      await roleResumes(f);
      await resumeEntry(f);
      await roleResumes(f);
      await expectContinued(f);
    });
  });

  describe("does not start, and says why on the task", () => {
    it("a run whose stop is not proven: the request stays saved, and starts when the proof comes", async () => {
      const f = await fixture({ lease: "ssh", finishedMinutesAgo: 5 });
      await roleResumes(f);
      await expectRefused(f, "stop_not_proven", { wait: "remote_cleanup", saved: true });
      expect(await getExecutionBlocker(db, f.companyId, f.issueId)).toMatchObject({ recoveryActionId: f.hold.id });
      // The delay of the pause's proof passes; the deferred-receipt pass dispatches the saved request.
      const proven = new Date(Date.now() - 13 * 3600_000);
      await db.update(heartbeatRuns).set({ finishedAt: proven }).where(eq(heartbeatRuns.id, f.cut.id));
      await db.update(environmentLeases).set({ releasedAt: proven }).where(eq(environmentLeases.heartbeatRunId, f.cut.id));
      await heartbeatService(db).resumeExecutionWaitComments({ companyId: f.companyId });
      expect(await continuations(f)).toHaveLength(1);
    });

    it("a task where a person's decision is pending", async () => {
      const f = await fixture();
      await db.insert(issueThreadInteractions).values({ companyId: f.companyId, issueId: f.issueId,
        kind: "request_confirmation", continuationPolicy: "none", payload: {}, effectiveResolverPolicy: "human_only" } as never);
      await roleResumes(f);
      await expectRefused(f, "waiting_for_person", { wait: "decision_pending", saved: true });
    });

    it("a blocked task", async () => {
      const f = await fixture({ taskStatus: "blocked" });
      await roleResumes(f);
      await expectRefused(f, "task_blocked");
      expect((await wakes(f)).filter(wake => wake.reason === "task_retry")).toHaveLength(0);
    });

    it("a task with an unresolved blocker, until a resume that finds the blocker done", async () => {
      const f = await fixture();
      const blockerId = randomUUID();
      await db.insert(issues).values({ id: blockerId, companyId: f.companyId, title: "Blocker", status: "todo" });
      await db.insert(issueRelations).values({ companyId: f.companyId, issueId: blockerId, relatedIssueId: f.issueId, type: "blocks" });
      await roleResumes(f);
      await expectRefused(f, "blocked_by_dependency");
      expect((await wakes(f)).filter(wake => wake.reason === "task_retry")).toHaveLength(0);
      // The same resume does not look again; the next resume does.
      await db.update(issues).set({ status: "done" }).where(eq(issues.id, blockerId));
      await roleResumes(f);
      expect(await continuations(f)).toHaveLength(0);
      await resumeEntry(f);
      await roleResumes(f);
      expect(await continuations(f)).toHaveLength(1);
      expect((await traces(f)).map(entry => entry.action)).toEqual([PAUSE_CUT_WORK_NOT_CONTINUED, PAUSE_CUT_WORK_CONTINUED]);
    });

    it("a task a person already asked to continue: the message kept during the pause starts it, once", async () => {
      const f = await fixture({ resumedBy: "none" });
      const commentId = randomUUID();
      await db.insert(issueComments).values({ id: commentId, companyId: f.companyId, issueId: f.issueId, authorType: "user",
        authorUserId: "board", body: "Resume: the fleet is ready." });
      await db.update(agents).set({ status: "paused", pauseReason: "manual", pausedAt: new Date() }).where(eq(agents.id, f.agentId));
      await expect(heartbeatService(db).wakeup(f.agentId, { source: "automation", triggerDetail: "system",
        reason: "issue_reopened_via_comment", requestedByActorType: "user", requestedByActorId: "board",
        payload: { issueId: f.issueId, commentId }, contextSnapshot: { issueId: f.issueId, wakeCommentId: commentId } }))
        .rejects.toThrow(/not invokable/);
      await db.update(agents).set({ status: "idle", pauseReason: null, pausedAt: null }).where(eq(agents.id, f.agentId));
      await resumeEntry(f);
      await roleResumes(f);
      const recorded = await traces(f);
      expect(recorded.map(entry => [entry.action, entry.details?.reason])).toEqual([[PAUSE_CUT_WORK_NOT_CONTINUED, "already_requested_by_person"]]);
      expect((await wakes(f)).filter(wake => wake.reason === "task_retry")).toHaveLength(0);
      await heartbeatService(db).resumeQueuedRuns();
      expect(await continuations(f)).toHaveLength(1);
    });

    it("a task whose hold was already released by a reconciliation", async () => {
      const f = await fixture();
      await db.update(issueRecoveryActions).set({ evidence: { runId: f.cut.id } }).where(eq(issueRecoveryActions.id, f.hold.id));
      expect(await getExecutionBlocker(db, f.companyId, f.issueId)).toBeNull();
      await roleResumes(f);
      await expectRefused(f, "hold_already_released");
      expect((await wakes(f)).filter(wake => wake.reason === "task_retry")).toHaveLength(0);
    });

    it("a resume that no person asked for", async () => {
      const byAgent = await fixture({ resumedBy: "agent" });
      await roleResumes(byAgent);
      await expectRefused(byAgent, "resumed_without_a_person");
      expect((await wakes(byAgent)).filter(wake => wake.reason === "task_retry")).toHaveLength(0);
      const unrecorded = await fixture({ resumedBy: "none" });
      await roleResumes(unrecorded);
      await expectRefused(unrecorded, "resumed_without_a_person");
    });
  });

  describe("does not look at", () => {
    it("a run a budget pause cut, which has its own continuation", async () => {
      const f = await fixture({ resultJson: manualPauseStop(new Date(Date.now() - 13 * 3600_000), ["budget"]) });
      await roleResumes(f);
      await expectNotLookedAt(f);
    });

    it("a run that was not cut by a pause", async () => {
      const at = new Date(Date.now() - 13 * 3600_000).toISOString();
      const f = await fixture({ errorCode: "issue_reassigned",
        resultJson: { cancellation: { reason: "Cancelled because the task was reassigned", source: "control_plane",
          expected: true, initiator: { type: "system" }, recordedAt: at }, stopReason: "cancelled" } });
      await roleResumes(f);
      await expectNotLookedAt(f);
    });

    it("a task on which the role already ran after the cut, a task handed to another role, a closed task", async () => {
      const ranSince = await fixture();
      await db.insert(heartbeatRuns).values({ companyId: ranSince.companyId, agentId: ranSince.agentId, status: "succeeded",
        contextSnapshot: { issueId: ranSince.issueId }, startedAt: new Date(Date.now() - 60_000), finishedAt: new Date() });
      await roleResumes(ranSince);
      await expectNotLookedAt(ranSince);
      const handedOver = await fixture();
      const otherId = randomUUID();
      await db.insert(agents).values({ id: otherId, companyId: handedOver.companyId, name: "Other", role: "engineer",
        adapterType: "claude_local", status: "idle" });
      await db.update(issues).set({ assigneeAgentId: otherId }).where(eq(issues.id, handedOver.issueId));
      await roleResumes(handedOver);
      await expectNotLookedAt(handedOver);
      const closed = await fixture({ taskStatus: "done" });
      await roleResumes(closed);
      await expectNotLookedAt(closed);
    });
  });
});
