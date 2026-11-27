import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { and, asc, eq, inArray } from "drizzle-orm";
import { activityLog, agents, agentWakeupRequests, companies, createDb, environmentLeases, heartbeatRunEvents, heartbeatRuns,
  issueRecoveryActions, issues } from "@paperclipai/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startEmbeddedPostgresTestDatabase } from "../__tests__/helpers/embedded-postgres.js";
import { configureAgentLifecycle, createAgentLifecycle } from "./agent-lifecycle.js";
import { createLifecycleDriver } from "./agent-lifecycle-driver.js";
import { getExecutionBlocker } from "./execution-blocker.js";
import { environmentService } from "./environments.js";
import { PAUSE_CUT_WORK_CONTINUED, PAUSE_CUT_WORK_KEPT, PAUSE_CUT_WORK_NOT_CONTINUED, PAUSE_CUT_WORK_REQUEST_FILED }
  from "./pause-resume-continuation.js";

/** Written as text, so that these cases also run, and fail on their behaviour, against a server without the entry. */
const PAUSE_CUT_WORK_UNBLOCKED = "agent.pause_cut_work_unblocked";

// STUDIO-0107: production, 26 Nov 2026. The Board paused every role for a pose window; the cut runs' holds then
// blocked their tasks (receipt legacyCancellationBlock), and at the resume the continuation of STUDIO-0074 refused
// them as blocked: eleven tasks waited for the Board's reconciliation (tools/reconcile-cut-run.mjs), and the CTO
// and the Infra Manager could not lift them (TR-3435). The resume now gives the task back its status when the
// server itself proves that the cut run stopped, and continues it once; any other block or cut keeps the Board path.
describe("a task the hold of a run cut by a pause blocked, when the role resumes", () => {
  let temporary: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  let work: ReturnType<typeof configureAgentLifecycle>;
  beforeAll(async () => {
    temporary = await startEmbeddedPostgresTestDatabase("pause-cut-own-block-");
    db = createDb(temporary.connectionString);
    work = configureAgentLifecycle(db, createLifecycleDriver(db, {} as never));
  });
  afterAll(async () => { await work?.stop(); await temporary?.cleanup(); });

  const GONE_PID = 2_000_000_000;
  const HOUR = 3600_000;
  const PERSON = { userId: "board", source: "local_implicit" };
  const TRACES = [PAUSE_CUT_WORK_CONTINUED, PAUSE_CUT_WORK_KEPT, PAUSE_CUT_WORK_NOT_CONTINUED, PAUSE_CUT_WORK_REQUEST_FILED,
    PAUSE_CUT_WORK_UNBLOCKED];
  const pauseStop = (at: Date) => ({
    cancellation: { reason: "Cancelled due to agent pause", source: "control_plane", expected: true,
      initiator: { type: "system" }, recordedAt: at.toISOString() },
    pauseStop: { holds: ["manual"], companyPauseReason: null }, stopReason: "paused" });
  type Cut = {
    /** How the run ended: the pause's cut by default. */
    run?: { status: string; errorCode: string; resultJson: Record<string, unknown> };
    leaseNotReleased?: boolean;
    processPid?: number;
  };
  const state = async (agentId: string) => (await db.select().from(agents).where(eq(agents.id, agentId)))[0]!;

  /**
   * A role paused through the lifecycle fourteen hours ago; on its task, the run the pause cut (legacy, a recorded
   * process, one local lease), its hold settled with replay blocked, and the task blocked by that settlement with
   * the receipt it writes (execution-recovery-resolution.ts): the run, the status version of the block, the status before.
   */
  async function fixture(options: Cut = {}) {
    const companyId = randomUUID(), agentId = randomUUID(), issueId = randomUUID(), cutRunId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Own block", issuePrefix: `B${companyId.slice(0, 6)}` });
    await db.insert(agents).values({ id: agentId, companyId, name: "Dev", role: "engineer",
      adapterType: "claude_local", status: "idle", runtimeConfig: { heartbeat: { wakeOnDemand: true, maxConcurrentRuns: 1 } } });
    await createAgentLifecycle(db).pauseAgent(agentId);
    await work.process(agentId);
    expect((await state(agentId)).lifecycleState).toBe("paused");
    await db.update(agents).set({ pausedAt: new Date(Date.now() - 14 * HOUR) }).where(eq(agents.id, agentId));
    const finishedAt = new Date(Date.now() - 13 * HOUR);
    await db.insert(issues).values({ id: issueId, companyId, title: "Cut by a pause", status: "in_progress", assigneeAgentId: agentId });
    const run = options.run ?? { status: "cancelled", errorCode: "agent_paused", resultJson: pauseStop(finishedAt) };
    await db.insert(heartbeatRuns).values({ id: cutRunId, companyId, agentId, invocationSource: "automation", triggerDetail: "system",
      status: run.status, runtimeMode: "legacy", executionStage: "settled", errorCode: run.errorCode,
      contextSnapshot: { issueId }, startedAt: new Date(finishedAt.getTime() - 356_000), finishedAt,
      processPid: options.processPid ?? GONE_PID, resultJson: run.resultJson });
    const [blocked] = await db.update(issues).set({ status: "blocked" }).where(eq(issues.id, issueId)).returning();
    const [hold] = await db.insert(issueRecoveryActions).values({ companyId, sourceIssueId: issueId,
      kind: "active_run_watchdog", cause: "legacy_execution_requires_reconciliation", fingerprint: `legacy-execution:${cutRunId}`,
      status: "resolved", outcome: "blocked", ownerType: "board", returnOwnerAgentId: agentId, nextAction: "Automatic recovery stopped.",
      evidence: { runId: cutRunId,
        legacyCancellationBlock: { runId: cutRunId, statusVersion: blocked!.statusVersion, previousStatus: "in_progress" },
        automaticRecovery: { policy: "preserve_without_replay_v1", runId: cutRunId, replay: "blocked", actionOutcome: "unknown" } } }).returning();
    const environment = await environmentService(db).ensureLocalEnvironment(companyId);
    await db.insert(environmentLeases).values({ companyId, environmentId: environment.id, heartbeatRunId: cutRunId, issueId,
      provider: "local", status: options.leaseNotReleased ? "active" : "expired", leasePolicy: "ephemeral",
      releasedAt: options.leaseNotReleased ? null : new Date(finishedAt.getTime() + 70_000), metadata: { agentId, driver: "local" } });
    await db.insert(heartbeatRunEvents).values({ companyId, agentId, runId: cutRunId, seq: 1,
      eventType: "native.process_identity_recorded", stream: "system", level: "info", message: "identity" });
    // The agent is busy elsewhere: an admitted run stays queued instead of launching a provider.
    await db.insert(heartbeatRuns).values({ companyId, agentId, status: "running" });
    return { companyId, agentId, issueId, cut: { id: cutRunId }, hold: hold!, blockedVersion: blocked!.statusVersion };
  }
  type Fixture = Awaited<ReturnType<typeof fixture>>;
  async function roleResumes(f: Fixture) {
    await createAgentLifecycle(db).resumeAgent(f.agentId, "user", PERSON);
    await work.process(f.agentId);
    expect((await state(f.agentId)).lifecycleState).toBe("ready");
  }
  const task = async (f: Fixture) => (await db.select().from(issues).where(eq(issues.id, f.issueId)))[0]!;
  const traces = (f: Fixture) => db.select().from(activityLog).where(and(eq(activityLog.companyId, f.companyId),
    eq(activityLog.entityType, "issue"), eq(activityLog.entityId, f.issueId), inArray(activityLog.action, TRACES)))
    .orderBy(asc(activityLog.createdAt));
  const traceList = async (f: Fixture) => (await traces(f)).map(entry => entry.details?.reason ? `${entry.action}:${entry.details.reason}` : entry.action);
  const continuations = async (f: Fixture) => (await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.companyId, f.companyId)))
    .filter(run => run.contextSnapshot?.previousRunId === f.cut.id);
  const retries = async (f: Fixture) => (await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.companyId, f.companyId)))
    .filter(wake => wake.payload?.issueId === f.issueId && wake.idempotencyKey?.startsWith("task-retry:pause-resume:"));
  /** The task keeps its block and its hold: nothing was filed, nothing started. */
  async function expectHeld(f: Fixture) {
    expect(await task(f)).toMatchObject({ status: "blocked", statusVersion: expect.any(Number) });
    expect(await getExecutionBlocker(db, f.companyId, f.issueId)).toMatchObject({ recoveryActionId: f.hold.id, runId: f.cut.id });
    expect(await continuations(f)).toHaveLength(0);
    expect(await retries(f)).toHaveLength(0);
  }

  it("the stop proven by the server: the task gets its status back, then one continuation, and nothing holds it", async () => {
    const f = await fixture();
    expect(await getExecutionBlocker(db, f.companyId, f.issueId)).toMatchObject({ recoveryActionId: f.hold.id });
    await roleResumes(f);
    expect((await task(f)).status).toBe("in_progress");
    const started = await continuations(f);
    expect(started).toHaveLength(1);
    expect(started[0]).toMatchObject({ agentId: f.agentId, status: "queued",
      contextSnapshot: { previousRunId: f.cut.id, explicitUserContinuation: { previousRunId: f.cut.id } } });
    expect(await getExecutionBlocker(db, f.companyId, f.issueId)).toBeNull();
    expect(await traceList(f)).toEqual([PAUSE_CUT_WORK_UNBLOCKED, PAUSE_CUT_WORK_REQUEST_FILED, PAUSE_CUT_WORK_CONTINUED]);
    expect((await traces(f))[0]).toMatchObject({ actorType: "system", actorId: "pause-resume",
      details: { interruptedRunId: f.cut.id, recoveryActionId: f.hold.id, restoredStatus: "in_progress",
        blockedStatusVersion: f.blockedVersion, resumedByUserId: PERSON.userId, actorSource: PERSON.source } });
    expect(await retries(f)).toMatchObject([{ requestedByActorType: "user", requestedByActorId: PERSON.userId }]);
  });

  it("once: the ready hook called again, then a whole new pause and resume, start nothing more", async () => {
    const f = await fixture();
    await roleResumes(f);
    await createLifecycleDriver(db, {} as never).onReady!(await state(f.agentId) as never);
    expect(await continuations(f)).toHaveLength(1);
    await db.update(heartbeatRuns).set({ status: "succeeded", finishedAt: new Date() })
      .where(and(eq(heartbeatRuns.agentId, f.agentId), inArray(heartbeatRuns.status, ["queued", "running"])));
    await createAgentLifecycle(db).pauseAgent(f.agentId);
    await work.process(f.agentId);
    expect((await state(f.agentId)).lifecycleState).toBe("paused");
    await roleResumes(f);
    expect(await continuations(f)).toHaveLength(1);
    expect(await retries(f)).toHaveLength(1);
    expect(await traceList(f)).toEqual([PAUSE_CUT_WORK_UNBLOCKED, PAUSE_CUT_WORK_REQUEST_FILED, PAUSE_CUT_WORK_CONTINUED]);
  });

  it.each<[string, Cut["run"]]>([
    ["a run cut by a failure", { status: "failed", errorCode: "adapter_failed", resultJson: { stopReason: "failed" } }],
    ["a run a person cancelled", { status: "cancelled", errorCode: "cancelled", resultJson: {
      cancellation: { reason: "Cancelled by the board", source: "board", expected: true, initiator: { type: "user", id: "board" },
        recordedAt: new Date().toISOString() }, stopReason: "cancelled" } }],
  ])("%s: the hold and the block stay, for the Board", async (_what, run) => {
    const f = await fixture({ run });
    await roleResumes(f);
    await expectHeld(f);
    expect(await traces(f)).toHaveLength(0);
  });

  it("a pause-cut run whose environment is not released: the hold and the block stay, and the task says why", async () => {
    const f = await fixture({ leaseNotReleased: true });
    await roleResumes(f);
    await expectHeld(f);
    expect(await traceList(f)).toEqual([`${PAUSE_CUT_WORK_NOT_CONTINUED}:task_blocked_stop_not_proven`]);
    expect((await traces(f))[0]!.details).toMatchObject({ recoveryActionId: f.hold.id,
      stopProof: expect.stringContaining("environment") });
  });

  it("a pause-cut run whose process is still alive on the server: the hold and the block stay", async () => {
    const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 120000)"], { stdio: "ignore" });
    const gone = once(child, "exit");
    try {
      const f = await fixture({ processPid: child.pid! });
      await roleResumes(f);
      await expectHeld(f);
      expect(await traceList(f)).toEqual([`${PAUSE_CUT_WORK_NOT_CONTINUED}:task_blocked_stop_not_proven`]);
      expect((await traces(f))[0]!.details).toMatchObject({ stopProof: expect.stringContaining("still running") });
    } finally { child.kill("SIGKILL"); await gone; }
  });

  it("a block the role set after the hold's (the status moved since the receipt): left alone", async () => {
    const f = await fixture();
    await db.update(issues).set({ status: "in_progress" }).where(eq(issues.id, f.issueId));
    await db.update(issues).set({ status: "blocked" }).where(eq(issues.id, f.issueId));
    await roleResumes(f);
    await expectHeld(f);
    expect(await traceList(f)).toEqual([`${PAUSE_CUT_WORK_NOT_CONTINUED}:task_blocked`]);
  });
});
