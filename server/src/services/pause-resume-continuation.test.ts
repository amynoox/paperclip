import { randomUUID } from "node:crypto";
import { and, asc, eq, inArray, sql } from "drizzle-orm";
import { activityLog, agents, agentWakeupRequests, companies, createDb, environmentLeases, heartbeatRunEvents, heartbeatRuns,
  instanceUserRoles, issueComments, issueRecoveryActions, issueRelations, issueThreadInteractions, issues } from "@paperclipai/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startEmbeddedPostgresTestDatabase } from "../__tests__/helpers/embedded-postgres.js";
import { projectCompanyHolds } from "../modules/agent-lifecycle/adapters/company-policy.js";
import { createLifecycleStore } from "../modules/agent-lifecycle/adapters/postgres.js";
import { configureAgentLifecycle, createAgentLifecycle, createAgentLifecycleEffects } from "./agent-lifecycle.js";
import { createLifecycleDriver } from "./agent-lifecycle-driver.js";
import { getExecutionBlocker } from "./execution-blocker.js";
import { heartbeatService } from "./heartbeat.js";
import { environmentService } from "./environments.js";
import { PAUSE_CUT_WORK_CONTINUED, PAUSE_CUT_WORK_KEPT, PAUSE_CUT_WORK_NOT_CONTINUED, PAUSE_CUT_WORK_REQUEST_FILED,
  continueRunsCutByPause, pauseLiftedOf } from "./pause-resume-continuation.js";

// STUDIO-0074: production, 18-20 Nov 2026. A manual pause cut the runs of a role (run 5f24df87: legacy, cancelled
// `agent_paused`, pauseStop manual, a recorded process that is gone, one local lease released). Each cut run left its
// hold, and after the resume a person had to ask again on every task. The owner decided that the resume of a role
// continues the runs its pause cut.
// Each case pauses the role through the real lifecycle (command, store, worker, driver), writes the cut run as
// production recorded it, then resumes the role through the same lifecycle: the worker makes the role ready and calls
// the driver's ready hook. No case writes an `agent.resumed` activity entry: the person comes from the resume command.
describe("the runs a pause cut, when the role resumes", () => {
  let temporary: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  let work: ReturnType<typeof configureAgentLifecycle>;
  beforeAll(async () => {
    temporary = await startEmbeddedPostgresTestDatabase("pause-resume-continuation-");
    db = createDb(temporary.connectionString);
    work = configureAgentLifecycle(db, createLifecycleDriver(db, {} as never));
  });
  afterAll(async () => { await work?.stop(); await temporary?.cleanup(); });

  const GONE_PID = 2_000_000_000;
  const HOUR = 3600_000;
  const PERSON = { userId: "board", source: "local_implicit" };
  const TRACES = [PAUSE_CUT_WORK_CONTINUED, PAUSE_CUT_WORK_KEPT, PAUSE_CUT_WORK_NOT_CONTINUED, PAUSE_CUT_WORK_REQUEST_FILED];
  type CutOptions = {
    lease?: "local" | "ssh";
    finishedMinutesAgo?: number;
    /** A run the pause cut before it started: no process, no lease, no hold. */
    neverStarted?: boolean;
    holds?: string[];
    /** Replaces the pause's cancellation record. */
    resultJson?: Record<string, unknown>;
    errorCode?: string;
  };
  const pauseStop = (at: Date, holds: string[] = ["manual"]) => ({
    cancellation: { reason: "Cancelled due to agent pause", source: "control_plane", expected: true,
      initiator: { type: "system" }, recordedAt: at.toISOString() },
    pauseStop: { holds, companyPauseReason: null }, stopReason: "paused",
    effectiveTimeoutSec: 0, timeoutConfigured: false, timeoutFired: false, timeoutSource: null });
  const state = async (agentId: string) => (await db.select().from(agents).where(eq(agents.id, agentId)))[0]!;
  /** The agent is busy elsewhere: an admitted run stays queued instead of launching a provider. */
  const busy = (f: { companyId: string; agentId: string }) => db.insert(heartbeatRuns).values({ companyId: f.companyId, agentId: f.agentId, status: "running" });
  const idle = (f: { agentId: string }) => db.delete(heartbeatRuns).where(and(eq(heartbeatRuns.agentId, f.agentId), eq(heartbeatRuns.status, "running")));

  /** One task of the role, with the run the pause cut on it and what that run left behind. */
  async function cutTask(f: { companyId: string; agentId: string }, options: CutOptions & { taskStatus?: string } = {}) {
    const issueId = randomUUID(), cutRunId = randomUUID();
    const finishedAt = new Date(Date.now() - (options.finishedMinutesAgo ?? 13 * 60) * 60_000);
    await db.insert(issues).values({ id: issueId, companyId: f.companyId, title: "Cut by a pause", status: options.taskStatus ?? "todo",
      assigneeAgentId: f.agentId });
    const [cut] = await db.insert(heartbeatRuns).values({ id: cutRunId, companyId: f.companyId, agentId: f.agentId,
      invocationSource: "automation", triggerDetail: "system",
      status: "cancelled", runtimeMode: "legacy", executionStage: "settled", errorCode: options.errorCode ?? "agent_paused",
      error: "Cancelled due to agent pause", contextSnapshot: { issueId }, finishedAt,
      ...(options.neverStarted ? {} : { processPid: GONE_PID, startedAt: new Date(finishedAt.getTime() - 356_000) }),
      resultJson: options.resultJson ?? pauseStop(finishedAt, options.holds) }).returning();
    if (options.neverStarted) return { issueId, cut: cut!, hold: null };
    const [hold] = await db.insert(issueRecoveryActions).values({ companyId: f.companyId, sourceIssueId: issueId,
      kind: "active_run_watchdog", cause: "legacy_execution_requires_reconciliation", fingerprint: `legacy-execution:${cutRunId}`,
      status: "resolved", outcome: "blocked", ownerType: "board", nextAction: "Automatic recovery stopped.",
      evidence: { runId: cutRunId, automaticRecovery: { policy: "preserve_without_replay_v1", runId: cutRunId, replay: "blocked", actionOutcome: "unknown" } } }).returning();
    const environment = await environmentService(db).ensureLocalEnvironment(f.companyId);
    const provider = options.lease ?? "local";
    await db.insert(environmentLeases).values({ companyId: f.companyId, environmentId: environment.id, heartbeatRunId: cutRunId, issueId,
      provider, ...(provider === "local" ? {} : { providerLeaseId: `${provider}://worker@mac-03:22/w/${cutRunId}`, cleanupStatus: "success" }),
      status: "expired", leasePolicy: "ephemeral", releasedAt: new Date(finishedAt.getTime() + 70_000),
      metadata: { agentId: f.agentId, driver: provider } });
    await db.insert(heartbeatRunEvents).values({ companyId: f.companyId, agentId: f.agentId, runId: cutRunId, seq: 1,
      eventType: "native.process_identity_recorded", stream: "system", level: "info", message: "identity" });
    return { issueId, cut: cut!, hold: hold! };
  }
  /** A role, paused through the lifecycle fourteen hours ago, and the run that pause cut on its task. */
  async function fixture(options: CutOptions & { taskStatus?: string } = {}) {
    const companyId = randomUUID(), agentId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Pause resume", issuePrefix: `R${companyId.slice(0, 6)}` });
    await db.insert(agents).values({ id: agentId, companyId, name: "Dev", role: "engineer",
      adapterType: "claude_local", status: "idle", runtimeConfig: { heartbeat: { wakeOnDemand: true, maxConcurrentRuns: 1 } } });
    await createAgentLifecycle(db).pauseAgent(agentId);
    await work.process(agentId);
    expect(await state(agentId)).toMatchObject({ lifecycleState: "paused", lifecycleHolds: ["manual"] });
    await db.update(agents).set({ pausedAt: new Date(Date.now() - 14 * HOUR) }).where(eq(agents.id, agentId));
    const task = await cutTask({ companyId, agentId }, options);
    await busy({ companyId, agentId });
    return { companyId, agentId, ...task };
  }
  type Fixture = Awaited<ReturnType<typeof fixture>>;
  /** The resume route's command, then the lifecycle worker: the role becomes ready and the ready hook runs. */
  async function roleResumes(f: { agentId: string }, by: { userId: string; source: string } | null = PERSON) {
    await createAgentLifecycle(db).resumeAgent(f.agentId, "user", by ?? undefined);
    await work.process(f.agentId);
    expect((await state(f.agentId)).lifecycleState).toBe("ready");
  }
  type Task = { companyId: string; agentId: string; issueId: string; cut: { id: string } };
  const traces = (f: Task) => db.select().from(activityLog).where(and(eq(activityLog.companyId, f.companyId),
    eq(activityLog.entityType, "issue"), eq(activityLog.entityId, f.issueId), inArray(activityLog.action, TRACES)))
    .orderBy(asc(activityLog.createdAt));
  const traceList = async (f: Task) => (await traces(f)).map(entry => entry.details?.reason ? `${entry.action}:${entry.details.reason}` : entry.action);
  const wakes = (f: Task) => db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.companyId, f.companyId));
  /** The requests this resume filed for the task (not the wake their dispatch writes). */
  const retries = async (f: Task) => (await wakes(f)).filter(wake => wake.payload?.issueId === f.issueId
    && wake.idempotencyKey?.startsWith("task-retry:pause-resume:"));
  const continuations = async (f: Task) => (await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.companyId, f.companyId)))
    .filter(run => run.contextSnapshot?.previousRunId === f.cut.id);
  async function expectContinued(f: Task, person = PERSON) {
    const started = await continuations(f);
    expect(started, JSON.stringify((await wakes(f)).map(wake => ({ status: wake.status, wait: wake.payload?.executionWait })))).toHaveLength(1);
    expect(started[0]).toMatchObject({ agentId: f.agentId, status: "queued",
      contextSnapshot: { previousRunId: f.cut.id, explicitUserContinuation: { previousRunId: f.cut.id } } });
    expect(await getExecutionBlocker(db, f.companyId, f.issueId)).toBeNull();
    const recorded = await traces(f);
    expect(recorded.map(entry => entry.action)).toEqual([PAUSE_CUT_WORK_REQUEST_FILED, PAUSE_CUT_WORK_CONTINUED]);
    // Every entry names the system as its author, and in its details who asked and how that person was signed in.
    for (const entry of recorded) expect(entry).toMatchObject({ actorType: "system", actorId: "pause-resume",
      details: { interruptedRunId: f.cut.id, resumedByUserId: person.userId, actorSource: person.source } });
    expect(recorded[1]!.details).toMatchObject({ continuationRunId: started[0]!.id });
    // The request is the Retry of the person who asked to resume.
    expect(await retries(f)).toMatchObject([{ requestedByActorType: "user", requestedByActorId: person.userId,
      payload: { taskRetry: { actorId: person.userId, actorSource: person.source } } }]);
  }
  /** Nothing started and nothing was filed: one entry on the task says why. */
  async function expectRefused(f: Task, reason: string, details: Record<string, unknown> = {}) {
    expect(await continuations(f)).toHaveLength(0);
    expect(await traceList(f)).toEqual([`${PAUSE_CUT_WORK_NOT_CONTINUED}:${reason}`]);
    expect((await traces(f))[0]!.details).toMatchObject({ interruptedRunId: f.cut.id, ...details });
    expect(await retries(f)).toHaveLength(0);
  }
  /** The request is filed and waits: nothing started, the hold still holds the task. */
  async function expectKept(f: Task & { hold: { id: string } | null }, reason: string, wait: string) {
    expect(await continuations(f)).toHaveLength(0);
    expect(await traceList(f)).toEqual([PAUSE_CUT_WORK_REQUEST_FILED, `${PAUSE_CUT_WORK_KEPT}:${reason}`]);
    expect((await traces(f))[1]!.details).toMatchObject({ interruptedRunId: f.cut.id, wait, actorSource: PERSON.source });
    expect(await retries(f)).toMatchObject([{ status: "deferred_issue_execution" }]);
    expect(await getExecutionBlocker(db, f.companyId, f.issueId)).toMatchObject({ recoveryActionId: f.hold!.id });
  }
  /** Not a run this resume has to look at: no entry, no request, nothing started. */
  async function expectNotLookedAt(f: Task) {
    expect(await continuations(f)).toHaveLength(0);
    expect(await traces(f)).toHaveLength(0);
    expect(await retries(f)).toHaveLength(0);
  }

  describe("continues by itself", () => {
    it("the run of production: a local lease, a recorded process that is gone", async () => {
      const f = await fixture();
      await roleResumes(f);
      await expectContinued(f);
      // The person comes from the resume command, saved with it: no later write is read, so nothing can race.
      expect(pauseLiftedOf((await state(f.agentId)).lifecycleOperation)).toMatchObject({ requestedBy: PERSON });
      expect(await db.select().from(activityLog).where(and(eq(activityLog.companyId, f.companyId), eq(activityLog.action, "agent.resumed")))).toHaveLength(0);
    });

    it("the same run over an ssh lease, on the stop proof the pause itself accepted", async () => {
      const f = await fixture({ lease: "ssh" });
      await roleResumes(f);
      await expectContinued(f);
    });

    it("a resume made with a person's board key, recorded as such", async () => {
      const f = await fixture();
      const key = { userId: `operator-${randomUUID()}`, source: "board_key" };
      await db.insert(instanceUserRoles).values({ userId: key.userId, role: "instance_admin" });
      await roleResumes(f, key);
      await expectContinued(f, key);
    });

    it("every task the pause cut, in one resume", async () => {
      const f = await fixture();
      const second = { ...f, ...await cutTask(f) }, third = { ...f, ...await cutTask(f, { lease: "ssh" }) };
      await roleResumes(f);
      for (const task of [f, second, third]) await expectContinued(task);
    });

    it("once: the ready hook called again, then a whole new pause and resume, start nothing more", async () => {
      const f = await fixture();
      await roleResumes(f);
      await createLifecycleDriver(db, {} as never).onReady!(await state(f.agentId) as never);
      // The role then ran the continuation to its end.
      await db.update(heartbeatRuns).set({ status: "succeeded", finishedAt: new Date() }).where(and(eq(heartbeatRuns.agentId, f.agentId), eq(heartbeatRuns.status, "queued")));
      await idle(f);
      await createAgentLifecycle(db).pauseAgent(f.agentId);
      await work.process(f.agentId);
      expect((await state(f.agentId)).lifecycleState).toBe("paused");
      await busy(f);
      await roleResumes(f);
      expect(await continuations(f)).toHaveLength(1);
      expect(await traceList(f)).toEqual([PAUSE_CUT_WORK_REQUEST_FILED, PAUSE_CUT_WORK_CONTINUED]);
    });
  });

  describe("files the request and keeps it, and says when it starts", () => {
    it("a run whose stop is not proven: nothing starts until the proof comes", async () => {
      const f = await fixture({ lease: "ssh", finishedMinutesAgo: 5 });
      await roleResumes(f);
      await expectKept(f, "stop_not_proven", "remote_cleanup");
      // The delay of the pause's proof passes; the deferred-receipt pass dispatches the kept request.
      const proven = new Date(Date.now() - 13 * HOUR);
      await db.update(heartbeatRuns).set({ finishedAt: proven }).where(eq(heartbeatRuns.id, f.cut.id));
      await db.update(environmentLeases).set({ releasedAt: proven }).where(eq(environmentLeases.heartbeatRunId, f.cut.id));
      await heartbeatService(db).resumeExecutionWaitComments({ companyId: f.companyId });
      const started = await continuations(f);
      expect(started).toHaveLength(1);
      expect(await traceList(f)).toEqual([PAUSE_CUT_WORK_REQUEST_FILED, `${PAUSE_CUT_WORK_KEPT}:stop_not_proven`, PAUSE_CUT_WORK_CONTINUED]);
      expect((await traces(f))[2]!.details).toMatchObject({ continuationRunId: started[0]!.id, resumedByUserId: "board", actorSource: "local_implicit" });
    });

    it("a new pause before the proof: the pause cancels the kept request, and the next resume files it again", async () => {
      const f = await fixture({ lease: "ssh", finishedMinutesAgo: 5 });
      await roleResumes(f);
      await expectKept(f, "stop_not_proven", "remote_cleanup");
      await idle(f);
      await createAgentLifecycle(db).pauseAgent(f.agentId);
      await work.process(f.agentId);
      // The new pause waits for the same proof before it completes.
      expect((await state(f.agentId)).lifecycleState).toBe("pausing");
      const proven = new Date(Date.now() - 13 * HOUR);
      await db.update(heartbeatRuns).set({ finishedAt: proven }).where(eq(heartbeatRuns.id, f.cut.id));
      await db.update(environmentLeases).set({ releasedAt: proven }).where(eq(environmentLeases.heartbeatRunId, f.cut.id));
      await db.execute(sql`update agents set lifecycle_operation = lifecycle_operation - 'retryAt' where id = ${f.agentId}`);
      await work.process(f.agentId);
      expect((await state(f.agentId)).lifecycleState).toBe("paused");
      await busy(f);
      // The proof is there, but the role is paused again: nothing starts.
      await heartbeatService(db).resumeExecutionWaitComments({ companyId: f.companyId });
      expect(await continuations(f)).toHaveLength(0);
      // The new pause cancelled the kept request. The next resume files it again, and it starts.
      const [keptRequest] = await retries(f);
      expect(keptRequest).toMatchObject({ status: "cancelled" });
      await roleResumes(f);
      expect(await continuations(f), JSON.stringify((await wakes(f)).map(wake => ({ key: wake.idempotencyKey?.slice(0, 24), status: wake.status,
        error: wake.error, wait: wake.payload?.executionWait })))).toHaveLength(1);
      expect(await retries(f)).toHaveLength(2);
      expect(await traceList(f)).toEqual([PAUSE_CUT_WORK_REQUEST_FILED, `${PAUSE_CUT_WORK_KEPT}:stop_not_proven`,
        PAUSE_CUT_WORK_REQUEST_FILED, PAUSE_CUT_WORK_CONTINUED]);
      expect((await traces(f))[2]!.details).toMatchObject({ replacesRetryRequestId: keptRequest!.id });
    });

    it("a task where a person's decision is pending", async () => {
      const f = await fixture();
      await db.insert(issueThreadInteractions).values({ companyId: f.companyId, issueId: f.issueId,
        kind: "request_confirmation", continuationPolicy: "none", payload: {}, effectiveResolverPolicy: "human_only" } as never);
      await roleResumes(f);
      await expectKept(f, "waiting_for_person", "decision_pending");
    });
  });

  describe("files nothing, and says why on the task", () => {
    it("a blocked task", async () => {
      const f = await fixture({ taskStatus: "blocked" });
      await roleResumes(f);
      await expectRefused(f, "task_blocked");
      // The ready hook called again for the same ready state writes no second entry.
      await createLifecycleDriver(db, {} as never).onReady!(await state(f.agentId) as never);
      await expectRefused(f, "task_blocked");
    });

    it("a task with an unresolved blocker", async () => {
      const f = await fixture();
      const blockerId = randomUUID();
      await db.insert(issues).values({ id: blockerId, companyId: f.companyId, title: "Blocker", status: "todo" });
      await db.insert(issueRelations).values({ companyId: f.companyId, issueId: blockerId, relatedIssueId: f.issueId, type: "blocks" });
      await roleResumes(f);
      await expectRefused(f, "blocked_by_dependency");
    });

    it("a task a person already asked to continue: the message kept during the pause starts it, once", async () => {
      const f = await fixture();
      const commentId = randomUUID();
      await db.insert(issueComments).values({ id: commentId, companyId: f.companyId, issueId: f.issueId, authorType: "user",
        authorUserId: "board", body: "Resume: the fleet is ready." });
      await expect(heartbeatService(db).wakeup(f.agentId, { source: "automation", triggerDetail: "system",
        reason: "issue_reopened_via_comment", requestedByActorType: "user", requestedByActorId: "board",
        payload: { issueId: f.issueId, commentId }, contextSnapshot: { issueId: f.issueId, wakeCommentId: commentId } }))
        .rejects.toThrow(/not invokable/);
      await roleResumes(f);
      expect(await traceList(f)).toEqual([`${PAUSE_CUT_WORK_NOT_CONTINUED}:already_requested_by_person`]);
      expect(await retries(f)).toHaveLength(0);
      await heartbeatService(db).resumeQueuedRuns();
      expect(await continuations(f)).toHaveLength(1);
    });

    it("a task that nothing holds: a reconciled run, and a run the pause cut before it started", async () => {
      const reconciled = await fixture();
      await db.update(issueRecoveryActions).set({ evidence: { runId: reconciled.cut.id } }).where(eq(issueRecoveryActions.id, reconciled.hold!.id));
      expect(await getExecutionBlocker(db, reconciled.companyId, reconciled.issueId)).toBeNull();
      await roleResumes(reconciled);
      await expectRefused(reconciled, "not_held");
      const queued = await fixture({ neverStarted: true });
      await roleResumes(queued);
      await expectRefused(queued, "not_held");
    });

    it("a resume no person asked for", async () => {
      const f = await fixture();
      await roleResumes(f, null);
      await expectRefused(f, "resumed_without_a_person");
      expect((await traces(f))[0]!.details).not.toHaveProperty("resumedByUserId");
    });

    it("the company's resume, even after a person resumed the role in an earlier pause", async () => {
      const f = await fixture();
      await roleResumes(f);
      await expectContinued(f);
      // The company is paused: a new pause of the role, which cuts a run on another task. Then the company resumes.
      await idle(f);
      await db.update(heartbeatRuns).set({ status: "succeeded", finishedAt: new Date() }).where(and(eq(heartbeatRuns.agentId, f.agentId), eq(heartbeatRuns.status, "queued")));
      await db.update(companies).set({ status: "paused" }).where(eq(companies.id, f.companyId));
      await projectCompanyHolds(db, createAgentLifecycleEffects(), f.companyId);
      await work.process(f.agentId);
      expect(await state(f.agentId)).toMatchObject({ lifecycleState: "paused", lifecycleHolds: ["company_paused"] });
      await db.update(agents).set({ pausedAt: new Date(Date.now() - 14 * HOUR) }).where(eq(agents.id, f.agentId));
      const later = { ...f, ...await cutTask(f, { holds: ["company_paused"] }) };
      await busy(f);
      await db.update(companies).set({ status: "active" }).where(eq(companies.id, f.companyId));
      await projectCompanyHolds(db, createAgentLifecycleEffects(), f.companyId);
      await work.process(f.agentId);
      expect((await state(f.agentId)).lifecycleState).toBe("ready");
      // Nobody asked for this resume: the person of the earlier pause is not reused.
      await expectRefused(later, "resumed_without_a_person");
      expect(pauseLiftedOf((await state(f.agentId)).lifecycleOperation)).toMatchObject({ requestedBy: null });
    });

    it("a company pause that lands while the role is resuming: the new pause forgets who asked before it", async () => {
      const f = await fixture();
      // The person's resume is committed, and the company is paused before the role is ready.
      await createLifecycleStore(db, createAgentLifecycleEffects()).change(f.agentId, "resume", { reason: "user", requestedBy: PERSON });
      expect(await state(f.agentId)).toMatchObject({ lifecycleState: "resuming", lifecycleOperation: { resumeRequestedBy: PERSON } });
      await idle(f);
      await db.update(companies).set({ status: "paused" }).where(eq(companies.id, f.companyId));
      await projectCompanyHolds(db, createAgentLifecycleEffects(), f.companyId);
      await work.process(f.agentId);
      expect(await state(f.agentId)).toMatchObject({ lifecycleState: "paused", lifecycleHolds: ["company_paused"] });
      await db.update(agents).set({ pausedAt: new Date(Date.now() - 14 * HOUR) }).where(eq(agents.id, f.agentId));
      await busy(f);
      await db.update(companies).set({ status: "active" }).where(eq(companies.id, f.companyId));
      await projectCompanyHolds(db, createAgentLifecycleEffects(), f.companyId);
      await work.process(f.agentId);
      expect((await state(f.agentId)).lifecycleState).toBe("ready");
      await expectRefused(f, "resumed_without_a_person");
    });

    it("a resume made with a key whose person may not change the task: the product's own check keeps the request", async () => {
      const f = await fixture();
      await roleResumes(f, { userId: `stranger-${randomUUID()}`, source: "board_key" });
      expect(await continuations(f)).toHaveLength(0);
      expect(await traceList(f)).toEqual([PAUSE_CUT_WORK_REQUEST_FILED, `${PAUSE_CUT_WORK_KEPT}:retry_authority_denied`]);
    });

    it("a resume signed in by a source the Retry does not accept", async () => {
      const f = await fixture();
      await roleResumes(f, { userId: "board", source: "mcp_oauth" });
      await expectRefused(f, "resume_source_not_allowed", { actorSource: "mcp_oauth", resumedByUserId: "board" });
    });
  });

  describe("does not look at", () => {
    it("a run a budget pause cut, which has its own continuation", async () => {
      const f = await fixture({ holds: ["budget"] });
      await roleResumes(f);
      await expectNotLookedAt(f);
    });

    it("a run that was not cut by a pause", async () => {
      const at = new Date(Date.now() - 13 * HOUR).toISOString();
      const f = await fixture({ errorCode: "issue_reassigned",
        resultJson: { cancellation: { reason: "Cancelled because the task was reassigned", source: "control_plane",
          expected: true, initiator: { type: "system" }, recordedAt: at }, stopReason: "cancelled" } });
      await roleResumes(f);
      await expectNotLookedAt(f);
    });

    it("a run cut before the pause that is lifted", async () => {
      const f = await fixture({ finishedMinutesAgo: 20 * 60 });
      await roleResumes(f);
      await expectNotLookedAt(f);
    });

    it("a ready state that follows no pause", async () => {
      const companyId = randomUUID(), agentId = randomUUID();
      await db.insert(companies).values({ id: companyId, name: "Pause resume", issuePrefix: `R${companyId.slice(0, 6)}` });
      await db.insert(agents).values({ id: agentId, companyId, name: "Dev", role: "engineer", adapterType: "claude_local", status: "idle" });
      const f = { companyId, agentId, ...await cutTask({ companyId, agentId }) };
      expect(pauseLiftedOf((await state(agentId)).lifecycleOperation)).toBeNull();
      await createLifecycleDriver(db, {} as never).onReady!(await state(agentId) as never);
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

  it("files no request when its record cannot be written, and fails loudly", async () => {
    const f = await fixture();
    const second = { ...f, ...await cutTask(f, { taskStatus: "blocked" }) };
    const lifted = { readyOperationId: randomUUID(), pausedAt: new Date(Date.now() - 14 * HOUR), requestedBy: PERSON };
    const sweep = continueRunsCutByPause(db, { companyId: f.companyId, agentId: f.agentId, ...lifted,
      resumeTaskRetry: (companyId, requestId) => heartbeatService(db).resumeTaskRetry(companyId, requestId),
      record: async () => { throw new Error("activity log unavailable"); } });
    await expect(sweep).rejects.toThrow(/failed for 2 task\(s\)/);
    for (const task of [f, second]) await expectNotLookedAt(task);
    expect(await getExecutionBlocker(db, f.companyId, f.issueId)).toMatchObject({ recoveryActionId: f.hold!.id });
  });
});
