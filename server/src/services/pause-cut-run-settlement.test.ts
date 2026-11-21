import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { activityLog, agents, agentWakeupRequests, companies, createDb, environmentLeases, heartbeatRunEvents, heartbeatRuns,
  issueComments, issueRecoveryActions, issues } from "@paperclipai/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startEmbeddedPostgresTestDatabase } from "../__tests__/helpers/embedded-postgres.js";
import { createLifecycleDriver } from "./agent-lifecycle-driver.js";
import { getExecutionBlocker } from "./execution-blocker.js";
import { settleUnrecoverableExecutions } from "./execution-recovery-resolution.js";
import { heartbeatService } from "./heartbeat.js";
import { environmentService } from "./environments.js";
import { requestTaskRetry } from "./task-retry.js";

// STUDIO-0076, the second path. Production: a pause cut the runs of routed roles; about a minute later the settlement
// of each cut run's hold blocked its task (`issue.execution_recovery_settled`, replay `not_authorized`, outcome
// `blocked`): TR-1802 and TR-1733 on 18 Nov at 10:03:45 and 10:03:49 (pause from 10:02:22 to 11:31), five tasks at
// 13:19:05 after the pause of 13:18, TR-2081 and TR-2069 on 20 Nov at 00:52:30. After the resume the continuation of
// the cut run then refused the blocked task. The cut runs are those of routed roles: cancelled, not acknowledged, so
// their hold is not a conversation hold and reaches the settlement.
describe("the hold of a run a pause cut, while its role is paused", () => {
  let temporary: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  beforeAll(async () => {
    temporary = await startEmbeddedPostgresTestDatabase("pause-cut-run-settlement-");
    db = createDb(temporary.connectionString);
  });
  afterAll(async () => { await temporary?.cleanup(); });

  const GONE_PID = 2_000_000_000;
  const cancellation = (reason: string, at: Date) => ({ reason, source: "control_plane", expected: true,
    initiator: { type: "system" }, recordedAt: at.toISOString() });
  /** The forms production recorded for a run a pause cut, and one run that no pause cut. */
  const FORMS = {
    // The direct pause route: `agent_paused`, no pause marker (four of the eight runs read on 20 Nov).
    route: (at: Date) => ({ errorCode: "agent_paused", error: "Cancelled due to agent pause",
      resultJson: { cancellation: cancellation("Cancelled due to agent pause", at) } }),
    // The lifecycle's own stop, with the pause marker: TR-1802 and TR-1826 on 18 Nov at 13:18.
    lifecycle: (at: Date) => ({ errorCode: "cancelled", error: "Agent lifecycle stop requested",
      resultJson: { cancellation: cancellation("Agent lifecycle stop requested", at), pauseStop: { holds: ["manual"], companyPauseReason: null } } }),
    // A budget's stop.
    budget: (at: Date) => ({ errorCode: "cancelled", error: "Cancelled due to budget pause",
      resultJson: { cancellation: cancellation("Cancelled due to budget pause", at) } }),
    // Not a pause: the control plane cancelled the run for another reason.
    other: (at: Date) => ({ errorCode: "cancelled", error: "Cancelled by the control plane",
      resultJson: { cancellation: cancellation("Cancelled by the control plane", at) } }),
  } as const;
  type Form = keyof typeof FORMS;

  /** A role paused five minutes ago, its task at work, the run the pause cut four minutes ago, and that run's hold. */
  async function fixture(form: Form, options: { hold?: string; leaseReleased?: boolean } = {}) {
    const companyId = randomUUID(), agentId = randomUUID(), issueId = randomUUID(), cutRunId = randomUUID(), commentId = randomUUID();
    const hold = options.hold ?? "manual";
    const finishedAt = new Date(Date.now() - 4 * 60_000);
    await db.insert(companies).values({ id: companyId, name: "Pause settlement", issuePrefix: `S${companyId.slice(0, 6)}` });
    await db.insert(agents).values({ id: agentId, companyId, name: "Dev Unity", role: "engineer", adapterType: "claude_local",
      status: "paused", pauseReason: hold, pausedAt: new Date(Date.now() - 5 * 60_000), lifecycleState: "paused", lifecycleHolds: [hold],
      runtimeConfig: { heartbeat: { wakeOnDemand: true, maxConcurrentRuns: 1 } } });
    await db.insert(issues).values({ id: issueId, companyId, title: "Cut by a pause", status: "in_progress", assigneeAgentId: agentId });
    const [cut] = await db.insert(heartbeatRuns).values({ id: cutRunId, companyId, agentId, invocationSource: "automation",
      triggerDetail: "system", status: "cancelled", runtimeMode: "legacy", executionStage: "settled", processPid: GONE_PID,
      contextSnapshot: { issueId }, startedAt: new Date(finishedAt.getTime() - 356_000), finishedAt, ...FORMS[form](finishedAt) }).returning();
    const [action] = await db.insert(issueRecoveryActions).values({ companyId, sourceIssueId: issueId, kind: "active_run_watchdog",
      cause: "legacy_execution_requires_reconciliation", fingerprint: `legacy-execution:${cutRunId}`, status: "active", ownerType: "board",
      returnOwnerAgentId: agentId, previousOwnerAgentId: agentId, nextAction: "Reconcile the cut run.", evidence: { runId: cutRunId } }).returning();
    const environment = await environmentService(db).ensureLocalEnvironment(companyId);
    await db.insert(environmentLeases).values({ companyId, environmentId: environment.id, heartbeatRunId: cutRunId, issueId,
      provider: "local", status: options.leaseReleased === false ? "active" : "expired", leasePolicy: "ephemeral",
      releasedAt: options.leaseReleased === false ? null : new Date(finishedAt.getTime() + 70_000), metadata: { agentId, driver: "local" } });
    // A sequence number the run's own events never reach: the settlement appends its event to this run.
    await db.insert(heartbeatRunEvents).values({ companyId, agentId, runId: cutRunId, seq: 100_000,
      eventType: "native.process_identity_recorded", stream: "system", level: "info", message: "identity" });
    await db.insert(issueComments).values({ id: commentId, companyId, issueId, authorType: "user", authorUserId: "board",
      body: "Go on.", createdAt: new Date(Date.now() - 60_000) });
    return { companyId, agentId, issueId, cut: cut!, action: action!, commentId };
  }
  type Fixture = Awaited<ReturnType<typeof fixture>>;
  const taskOf = async (f: Fixture) => (await db.select().from(issues).where(eq(issues.id, f.issueId)))[0]!;
  const holdOf = async (f: Fixture) => (await db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.id, f.action.id)))[0]!;
  const settlements = (f: Fixture) => db.select().from(activityLog).where(and(eq(activityLog.companyId, f.companyId),
    eq(activityLog.entityId, f.issueId), eq(activityLog.action, "issue.execution_recovery_settled")));
  /** The role is ready again; it is busy elsewhere, so an admitted run stays queued instead of launching a provider. */
  async function resumed(f: Fixture) {
    await db.update(agents).set({ status: "idle", pauseReason: null, pausedAt: null, lifecycleState: "ready", lifecycleHolds: [] })
      .where(eq(agents.id, f.agentId));
    await db.insert(heartbeatRuns).values({ companyId: f.companyId, agentId: f.agentId, status: "running" });
  }
  async function expectLeftToTheResume(f: Fixture) {
    expect((await taskOf(f)).status).toBe("in_progress");
    expect(await holdOf(f)).toMatchObject({ status: "active", outcome: null });
    expect(await settlements(f)).toHaveLength(0);
  }
  async function expectBlockedAsToday(f: Fixture) {
    expect((await taskOf(f)).status).toBe("blocked");
    expect(await holdOf(f)).toMatchObject({ status: "resolved", outcome: "blocked" });
    expect((await settlements(f)).map(entry => entry.details)).toMatchObject([{ outcome: "blocked", replay: "not_authorized" }]);
  }

  it.each<[Form, string]>([["route", "manual"], ["lifecycle", "manual"], ["lifecycle", "company_paused"], ["budget", "budget"]])(
    "is not settled as blocked during the pause: the %s form, hold %s", async (form, hold) => {
      const f = await fixture(form, { hold });
      // The settlement passes several times during a pause of five minutes.
      for (let pass = 0; pass < 3; pass += 1) await settleUnrecoverableExecutions(db);
      await expectLeftToTheResume(f);
    });

  it("after the pause, a person's Retry continues the cut run: the work starts again", async () => {
    for (const form of ["route", "lifecycle"] as const) {
      const f = await fixture(form);
      await settleUnrecoverableExecutions(db);
      await expectLeftToTheResume(f);
      await resumed(f);
      const receipt = await requestTaskRetry({ db, companyId: f.companyId, issueId: f.issueId, actorId: "board",
        actorSource: "local_implicit", observedRunId: f.cut.id, idempotencyKey: randomUUID() });
      expect(receipt).toMatchObject({ accepted: true, stale: false });
      await heartbeatService(db).resumeTaskRetry(f.companyId, receipt.requestId!);
      const started = (await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.companyId, f.companyId)))
        .filter(run => run.contextSnapshot?.previousRunId === f.cut.id);
      expect(started).toHaveLength(1);
      expect(started[0]).toMatchObject({ status: "queued", contextSnapshot: { explicitUserContinuation: { previousRunId: f.cut.id } } });
      expect(await getExecutionBlocker(db, f.companyId, f.issueId)).toBeNull();
      expect((await taskOf(f)).status).not.toBe("blocked");
      // Nothing is left for the settlement to block afterwards.
      await settleUnrecoverableExecutions(db);
      expect((await taskOf(f)).status).not.toBe("blocked");
    }
  });

  it("after the pause, a person's request that waits for the stop proof keeps the task from the block", async () => {
    const f = await fixture("route", { leaseReleased: false });
    await resumed(f);
    // The person's message is kept: the environment of the cut run is not released yet.
    await heartbeatService(db).wakeup(f.agentId, { source: "automation", triggerDetail: "system", reason: "issue_commented",
      requestedByActorType: "user", requestedByActorId: "board", payload: { issueId: f.issueId, commentId: f.commentId },
      contextSnapshot: { issueId: f.issueId, wakeCommentId: f.commentId } }).catch(() => undefined);
    const kept = await db.select().from(agentWakeupRequests).where(and(eq(agentWakeupRequests.companyId, f.companyId),
      eq(agentWakeupRequests.status, "deferred_issue_execution")));
    expect(kept.map(wake => wake.requestedByActorType)).toEqual(["user"]);
    await settleUnrecoverableExecutions(db);
    await expectLeftToTheResume(f);
  });

  it("after the pause, with nobody asking, the settlement takes today's path", async () => {
    const f = await fixture("lifecycle");
    await settleUnrecoverableExecutions(db);
    await expectLeftToTheResume(f);
    await resumed(f);
    await settleUnrecoverableExecutions(db);
    await expectBlockedAsToday(f);
  });

  it("a run that no pause cut is settled as today, even while its role is paused", async () => {
    const f = await fixture("other");
    await settleUnrecoverableExecutions(db);
    await expectBlockedAsToday(f);
  });

  // L10: the lifecycle's stop of a pause always marks the runs it cuts, before it cuts them (the marker is what lets
  // the resume tell a pause from a termination, which issues the same reason).
  it("the lifecycle's stop of a pause writes the pause marker on the run it cuts", async () => {
    const companyId = randomUUID(), agentId = randomUUID(), issueId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Pause marker", issuePrefix: `M${companyId.slice(0, 6)}` });
    await db.insert(agents).values({ id: agentId, companyId, name: "Game Tester", role: "qa", adapterType: "claude_local",
      status: "paused", pauseReason: "manual", pausedAt: new Date(), lifecycleState: "pausing", lifecycleHolds: ["manual"],
      lifecycleOperation: { id: randomUUID(), hostComplete: false, completedPluginIds: [], attempts: 0,
        pauseCause: { holds: ["manual"], companyPauseReason: null } } as never });
    await db.insert(issues).values({ id: issueId, companyId, title: "At work", status: "in_progress", assigneeAgentId: agentId });
    const [queued] = await db.insert(heartbeatRuns).values({ companyId, agentId, invocationSource: "assignment", triggerDetail: "system",
      status: "queued", contextSnapshot: { issueId } }).returning();
    const [agent] = await db.select().from(agents).where(eq(agents.id, agentId));
    await createLifecycleDriver(db, {} as never).runHost(agent as never);
    const [cut] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, queued!.id));
    expect(cut).toMatchObject({ status: "cancelled" });
    expect(cut!.resultJson).toMatchObject({ cancellation: { reason: "Agent lifecycle stop requested", initiator: { type: "system" } },
      pauseStop: { holds: ["manual"], companyPauseReason: null } });
  });
});
