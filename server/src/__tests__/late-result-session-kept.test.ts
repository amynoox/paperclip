import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { and, asc, eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  activityLog, agentTaskSessions, agentWakeupRequests, agents, authUsers, companies, companyMemberships, createDb, environmentLeases,
  executionWorkspaces, heartbeatRunEvents, heartbeatRuns, issueComments, issueRecoveryActions, issues, workspaceOperations,
  EMBEDDED_POSTGRES_TEST_TIMEOUT_MS,
} from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { drainHeartbeatRunsToQuiescence } from "./helpers/drain-heartbeat-runs.js";
import { runningProcesses, type AdapterExecutionContext, type AdapterExecutionResult } from "../adapters/index.ts";
import { heartbeatService } from "../services/heartbeat.ts";
import { environmentService } from "../services/environments.js";
import { requestTaskRetry } from "../services/task-retry.js";
import { pauseCutSourceLeftItsWorkspace, readFreshWorkspaceReadiness } from "../services/fresh-workspace-continuation.js";
import { markExecutionReconciliation } from "../services/execution-recovery-resolution.js";
import { createHeartbeatRunState } from "../services/heartbeat/run-state.js";
import { TASK_SESSION_REMOVED } from "../services/task-session-removal.js";

const mockAdapterExecute = vi.hoisted(() =>
  vi.fn(async (_context: AdapterExecutionContext): Promise<AdapterExecutionResult> => ({
    exitCode: 0, signal: null, timedOut: false, errorMessage: null, summary: "Turn.", provider: "test", model: "test-model",
  })),
);

// STUDIO-0075: KEEP_SESSION_AFTER_PERSON_STOP is a constant. With PAPERCLIP_TEST_PERSON_STOP=off (set by
// late-result-session-kept.person-stop-off.test.ts, which runs this file again) the module is replaced by the same
// rules with the switch off; without it the real module is used, untouched.
const PERSON_STOP_KEEPS = process.env.PAPERCLIP_TEST_PERSON_STOP !== "off";
vi.mock("../services/cut-run-session.js", async () => {
  const actual = await vi.importActual<typeof import("../services/cut-run-session.js")>("../services/cut-run-session.js");
  if (process.env.PAPERCLIP_TEST_PERSON_STOP !== "off") return actual;
  const { isGovernancePauseStop } = await vi.importActual<typeof import("../services/governance-pause-stop.js")>("../services/governance-pause-stop.js");
  return { ...actual, KEEP_SESSION_AFTER_PERSON_STOP: false,
    cancelledRunKeepsSession: (run: Parameters<typeof actual.cancelledRunKeepsSession>[0]) => isGovernancePauseStop(run) };
});

vi.mock("../adapters/index.ts", async () => {
  const actual = await vi.importActual<typeof import("../adapters/index.ts")>("../adapters/index.ts");
  return { ...actual, getServerAdapter: vi.fn(() => ({ supportsLocalAgentJwt: false, execute: mockAdapterExecute })) };
});

// STUDIO-0075: production, 20 Nov 2026, 03:00 UTC. Two routed runs (claude_local, codex_local) lost the link to their
// worker machine; their retries opened new conversations in the same remote folder. The owner's rule: a machine that
// loses its connection must not lose its work; the same role resumes where it was, on the same machine.
// From its version 0.30.19 the worker router returns, in its FAILURE result, the session its engine had opened: the
// ordinary fields of an adapter result, for four codes. Each case runs real heartbeat runs with a stand-in adapter that
// returns results of that shape, and reads what the server keeps for the task and hands to the next run.
const SUCCESS: AdapterExecutionResult = { exitCode: 0, signal: null, timedOut: false, errorMessage: null,
  summary: "Turn.", provider: "test", model: "test-model" };
type Turn = (context: AdapterExecutionContext) => Promise<AdapterExecutionResult>;
vi.setConfig({ testTimeout: 90_000 });
const support = await getEmbeddedPostgresTestSupport();
(support.supported ? describe : describe.skip).each([
  { adapterType: "codex_local", first: "thread-first", cut: "thread-cut", other: "thread-other" },
  { adapterType: "claude_local", first: "11111111-1111-4111-8111-111111111111", cut: "22222222-2222-4222-8222-222222222222",
    other: "33333333-3333-4333-8333-333333333333" },
])("the session a failed $adapterType run returns", ({ adapterType, first, cut, other }) => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  let heartbeat: ReturnType<typeof heartbeatService>;
  // The product starts runs by itself too (it repairs the task's disposition after a run that ends well, it retries a
  // lost link): a turn is taken by whichever run of the task executes next, and every execution is recorded.
  const turns = new Map<string, Turn[]>();
  const executions = new Map<string, Array<{ runId: string; runtime: AdapterExecutionContext["runtime"] }>>();
  const play: Turn = async context => {
    const key = context.agent.companyId;
    executions.set(key, [...(executions.get(key) ?? []), { runId: context.runId, runtime: context.runtime }]);
    const turn = turns.get(key)?.shift();
    return turn ? turn(context) : SUCCESS;
  };
  beforeAll(async () => {
    database = await startEmbeddedPostgresTestDatabase("late-result-session-kept-");
    db = createDb(database.connectionString);
    heartbeat = heartbeatService(db, { runtimeEnv: { ...process.env, PAPERCLIP_IN_WORKTREE: "false" } });
    mockAdapterExecute.mockImplementation(play);
  }, EMBEDDED_POSTGRES_TEST_TIMEOUT_MS);
  afterEach(async () => {
    await drainHeartbeatRunsToQuiescence(db, heartbeat);
    runningProcesses.clear();
  });
  afterAll(async () => { await database?.cleanup(); });

  const FOLDER = "/srv/work/6d499883/63d1cf8b/work";
  const MACHINE = { transport: "ssh", host: "mac-03", port: 22, username: "worker", remoteCwd: FOLDER };
  const paramsOf = (sessionId: string) => ({ sessionId, cwd: FOLDER, remoteExecution: MACHINE });
  /** The worker router's failure result: the ordinary session fields, with one of its four codes. */
  const routerFailure = (errorCode: string, sessionId: string | null, extra: Partial<AdapterExecutionResult> = {}): AdapterExecutionResult => ({
    exitCode: 1, signal: null, timedOut: false, errorCode, errorMessage: errorCode.replaceAll("_", " "),
    ...(sessionId ? { sessionId, sessionDisplayId: sessionId, sessionParams: paramsOf(sessionId) } : {}), ...extra });

  async function seed() {
    const companyId = randomUUID(), agentId = randomUUID(), issueId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Cut run", defaultResponsibleUserId: "responsible-user",
      issuePrefix: `C${companyId.replaceAll("-", "").slice(0, 6).toUpperCase()}`, requireBoardApprovalForNewAgents: false });
    await db.insert(authUsers).values({ id: "responsible-user", name: "Fixture user", email: "responsible-user@example.test",
      createdAt: new Date(), updatedAt: new Date() }).onConflictDoNothing();
    await db.insert(companyMemberships).values({ companyId, principalType: "user", principalId: "responsible-user",
      status: "active", membershipRole: "member" }).onConflictDoNothing();
    await db.insert(agents).values({ id: agentId, companyId, name: "Dev Unity", role: "engineer", status: "active",
      adapterType, adapterConfig: {}, runtimeConfig: { heartbeat: { wakeOnDemand: true, maxConcurrentRuns: 1 } }, permissions: {} });
    await db.insert(issues).values({ id: issueId, companyId, title: "Routed task", status: "todo", priority: "medium",
      assigneeAgentId: agentId });
    turns.set(companyId, []);
    executions.set(companyId, []);
    return { companyId, agentId, issueId };
  }
  type Fixture = Awaited<ReturnType<typeof seed>>;
  const reread = async (runId: string) => (await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, runId)))[0]!;
  const taskSession = async (f: Fixture) => (await db.select().from(agentTaskSessions).where(and(
    eq(agentTaskSessions.companyId, f.companyId), eq(agentTaskSessions.agentId, f.agentId),
    eq(agentTaskSessions.taskKey, f.issueId))))[0] ?? null;
  const state = async (f: Fixture) => JSON.stringify({
    runs: (await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.companyId, f.companyId)).orderBy(asc(heartbeatRuns.createdAt)))
      .map(run => [run.status, run.errorCode]),
    wakes: (await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.companyId, f.companyId)))
      .map(wake => [wake.status, wake.reason, wake.error, wake.payload?.executionWait]),
    task: (await db.select().from(issues).where(eq(issues.id, f.issueId))).map(issue => issue.status) });
  /** The n-th execution of the adapter for the task, once its run is settled. */
  async function execution(f: Fixture, n: number) {
    await vi.waitFor(async () => {
      expect(executions.get(f.companyId)!.length, await state(f)).toBeGreaterThanOrEqual(n);
      const run = await reread(executions.get(f.companyId)![n - 1]!.runId);
      expect(["succeeded", "failed", "cancelled", "timed_out"], await state(f)).toContain(run.status);
    }, { timeout: 25_000, interval: 100 });
    const { runId, runtime } = executions.get(f.companyId)![n - 1]!;
    await heartbeat.waitForRunExecutionDrain(runId);
    return { run: await reread(runId), sessionId: runtime.sessionId, sessionParams: runtime.sessionParams };
  }
  /** The wake the issue update route sends to the assignee. */
  const assignmentWake = (f: Fixture) => heartbeat.wakeup(f.agentId, { source: "assignment", triggerDetail: "system",
    reason: "issue_assigned", payload: { issueId: f.issueId, mutation: "update" },
    requestedByActorType: "user", requestedByActorId: "responsible-user",
    contextSnapshot: { issueId: f.issueId, taskId: f.issueId, source: "issue.update" } });
  /** A person writes on the task: the wake of the comment route. */
  async function personMessage(f: Fixture) {
    const commentId = randomUUID();
    await db.insert(issueComments).values({ id: commentId, companyId: f.companyId, issueId: f.issueId, authorType: "user",
      authorUserId: "responsible-user", body: "Go on." });
    await heartbeat.wakeup(f.agentId, { source: "automation", triggerDetail: "system", reason: "issue_commented",
      requestedByActorType: "user", requestedByActorId: "responsible-user",
      payload: { issueId: f.issueId, commentId }, contextSnapshot: { issueId: f.issueId, wakeCommentId: commentId } }).catch(() => undefined);
  }
  /**
   * What production holds about a cut run and the stand-in adapter does not write: its process is recorded and gone,
   * its lease is released. A person's request to continue needs that proof (explicit-native-continuation.ts).
   */
  async function stopProven(f: Fixture, runId: string, lease: "local" | "ssh" = "local") {
    // Over ssh the proof is the pause's own (STUDIO-0073): the run ended more than ten minutes ago.
    const ended = new Date(Date.now() - (lease === "ssh" ? 11 * 60_000 : 0));
    await db.update(heartbeatRuns).set({ processPid: 2_000_000_000, ...(lease === "ssh" ? { finishedAt: ended } : {}) })
      .where(eq(heartbeatRuns.id, runId));
    await db.insert(heartbeatRunEvents).values({ companyId: f.companyId, agentId: f.agentId, runId, seq: 100_000,
      eventType: "native.process_identity_recorded", stream: "system", level: "info", message: "identity" });
    const environment = await environmentService(db).ensureLocalEnvironment(f.companyId);
    // Over ssh the run has no lease but its ssh lease.
    if (lease === "ssh") await db.delete(environmentLeases).where(eq(environmentLeases.heartbeatRunId, runId));
    await db.insert(environmentLeases).values({ companyId: f.companyId, environmentId: environment.id, heartbeatRunId: runId,
      issueId: f.issueId, provider: lease, status: "expired", leasePolicy: "ephemeral", releasedAt: ended,
      ...(lease === "ssh" ? { providerLeaseId: `ssh://worker@mac-03:22${FOLDER}/${runId}`, cleanupStatus: "success" } : {}),
      metadata: { agentId: f.agentId, driver: lease } });
  }
  /** What the run says of its late result: the record in its result, and its event. */
  async function lateResultOf(runId: string) {
    const events = await db.select().from(heartbeatRunEvents).where(and(eq(heartbeatRunEvents.runId, runId),
      eq(heartbeatRunEvents.eventType, "run.late_result")));
    return { record: (await reread(runId)).resultJson?.lateResult, events: events.map(event => [event.level, event.payload?.session]) };
  }
  /** A later run of the role on the task, created `afterMs` after the given run, and optionally the session it wrote. */
  async function laterRun(f: Fixture, of: string, afterMs: number, wrote: string | null, status = "succeeded") {
    const [later] = await db.insert(heartbeatRuns).values({ companyId: f.companyId, agentId: f.agentId, status,
      contextSnapshot: { issueId: f.issueId }, createdAt: new Date((await reread(of)).createdAt.getTime() + afterMs),
      ...(status === "succeeded" ? { finishedAt: new Date() } : {}) }).returning();
    if (wrote) await db.update(agentTaskSessions).set({ sessionParamsJson: paramsOf(wrote), sessionDisplayId: wrote, lastRunId: later!.id })
      .where(and(eq(agentTaskSessions.agentId, f.agentId), eq(agentTaskSessions.taskKey, f.issueId)));
    return later!;
  }
  /**
   * A first run that ends well in session `first`, then the run whose engine opened session `cut` and that ends as
   * `cutTurn` says. Returns that second run.
   */
  async function cutRun(f: Fixture, cutTurn: Turn) {
    turns.get(f.companyId)!.push(async () => ({ ...SUCCESS, sessionId: first, sessionDisplayId: first, sessionParams: paramsOf(first) }), cutTurn);
    await assignmentWake(f);
    await execution(f, 1);
    expect((await taskSession(f))?.sessionParamsJson).toMatchObject(paramsOf(first));
    // The product repairs the disposition by itself after a run that ends well; this wake joins that run or starts one.
    await assignmentWake(f);
    return (await execution(f, 2)).run;
  }
  /** A person stops the run from the Board: the cancellation names a user as its author. */
  const personStops = (runId: string) => heartbeat.cancelRun(runId, "Cancelled by the board",
    { resultJson: { cancelledByActorType: "user", cancelledByUserId: "responsible-user" } });
  /** A wake no person asked for, of a kind that resumes the task's session. */
  const automaticWake = (f: Fixture) => heartbeat.wakeup(f.agentId, { source: "automation", triggerDetail: "system",
    reason: "issue_blockers_resolved", payload: { issueId: f.issueId }, requestedByActorType: "system", requestedByActorId: "test",
    contextSnapshot: { issueId: f.issueId, taskId: f.issueId, wakeReason: "issue_blockers_resolved" } });
  /** The task is a conversation of the role with a person, and the run belongs to its current session generation. */
  async function asConversation(f: Fixture, runId: string) {
    await db.update(issues).set({ conversationAgentId: f.agentId, conversationUserId: "responsible-user", conversationState: "active" })
      .where(eq(issues.id, f.issueId));
    await db.update(heartbeatRuns).set({ contextSnapshot: sql`${heartbeatRuns.contextSnapshot} || '{"conversationSessionGeneration": 0}'::jsonb` })
      .where(eq(heartbeatRuns.id, runId));
  }
  const notConversation = (f: Fixture) => db.update(issues).set({ conversationAgentId: null, conversationUserId: null, conversationState: null })
    .where(eq(issues.id, f.issueId));
  /** What the next execution of the adapter for the task is given to resume, after `trigger`. */
  async function nextExecution(f: Fixture, trigger: () => Promise<unknown>) {
    const done = executions.get(f.companyId)!.length;
    await trigger();
    return execution(f, done + 1);
  }

  it("a lost link: the session of the failure result is kept, and the transient retry resumes it", async () => {
    const f = await seed();
    const lost = await cutRun(f, async () => routerFailure("router_provider_stop_unverified", cut));
    expect(lost).toMatchObject({ status: "failed", errorCode: "router_provider_stop_unverified", sessionIdAfter: cut });
    const kept = await taskSession(f);
    expect(kept).toMatchObject({ sessionDisplayId: cut, lastRunId: lost.id });
    expect(kept!.sessionParamsJson).toMatchObject(paramsOf(cut));
    // The server's own retry of a lost link, once its delay has passed.
    const retry = await nextExecution(f, async () => {
      const [scheduled] = await db.select().from(heartbeatRuns).where(and(eq(heartbeatRuns.companyId, f.companyId),
        eq(heartbeatRuns.status, "scheduled_retry")));
      expect(scheduled, await state(f)).toMatchObject({ retryOfRunId: lost.id });
      await db.update(heartbeatRuns).set({ scheduledRetryAt: new Date(Date.now() - 60_000) }).where(eq(heartbeatRuns.id, scheduled!.id));
      await heartbeat.promoteDueScheduledRetries();
      await heartbeat.resumeQueuedRuns();
    });
    expect(retry.run).toMatchObject({ retryOfRunId: lost.id });
    expect(retry).toMatchObject({ sessionId: cut, sessionParams: paramsOf(cut) });
  });

  it("a pause that cancels the run: the session of its late result is kept, and the person's request after it resumes that session", async () => {
    const f = await seed();
    const cancelled = await cutRun(f, async () => {
      // The pause route stops the role's runs; the router's result comes after.
      await heartbeat.cancelActiveForAgent(f.agentId);
      return routerFailure("router_cancelled", cut);
    });
    expect(cancelled).toMatchObject({ status: "cancelled", sessionIdAfter: cut });
    expect(await lateResultOf(cancelled.id)).toMatchObject({ record: { errorCode: "router_cancelled", session: "kept" }, events: [["info", "kept"]] });
    const kept = await taskSession(f);
    expect(kept).toMatchObject({ sessionDisplayId: cut, lastRunId: cancelled.id });
    expect(kept!.sessionParamsJson).toMatchObject(paramsOf(cut));
    // The configuration fingerprint a finished run gets is on it.
    expect(Object.keys(kept!.sessionParamsJson ?? {}).some(key => key.startsWith("__paperclip"))).toBe(true);
    // The role is resumed and a person asks to go on: the run that continues the cut run is given that session.
    await stopProven(f, cancelled.id);
    const next = await nextExecution(f, () => personMessage(f));
    expect(next.run.contextSnapshot).toMatchObject({ previousRunId: cancelled.id });
    expect(next.run.contextSnapshot).not.toHaveProperty("forceFreshSession");
    expect({ sessionId: next.sessionId, sessionParams: next.sessionParams }).toMatchObject({ sessionId: cut, sessionParams: paramsOf(cut) });
  });

  it("a run another path settled first: the session of its late result is kept", async () => {
    const f = await seed();
    const stopped = await cutRun(f, async context => {
      await heartbeat.cancelRun(context.runId, "Cancelled by the board");
      return routerFailure("router_interactive_transport_lost", cut);
    });
    expect(stopped).toMatchObject({ status: "cancelled", sessionIdAfter: cut });
    expect(await taskSession(f)).toMatchObject({ sessionDisplayId: cut, lastRunId: stopped.id });
    expect((await taskSession(f))?.sessionParamsJson).toMatchObject(paramsOf(cut));
    // A stop that is neither a pause nor a person's: the person's next request keeps the product's rule, a new conversation.
    await stopProven(f, stopped.id);
    const next = await nextExecution(f, () => personMessage(f));
    expect(next.run.contextSnapshot).toMatchObject({ previousRunId: stopped.id, forceFreshSession: true });
    expect(next).toMatchObject({ sessionId: null });
  });

  // The order of two runs of the role on the task is the order of their creation. A late result is written only when
  // no run created at the same time or later has written the task's session, and that is read under the task's lock.
  it("a late result does not replace the session a later run of the role already wrote, nor one created at the same time", async () => {
    for (const afterMs of [60_000, 0]) {
      const f = await seed();
      const stopped = await cutRun(f, async context => {
        await heartbeat.cancelRun(context.runId, "Cancelled by the board");
        // Meanwhile a later run of the role on the task has ended and written its own session.
        await laterRun(f, context.runId, afterMs, other);
        return routerFailure("router_cancelled", cut);
      });
      expect(await taskSession(f)).toMatchObject({ sessionDisplayId: other });
      // The run does not name a session that is not the task's, and says its result was left aside.
      expect(stopped.sessionIdAfter).toBeNull();
      expect(await lateResultOf(stopped.id)).toMatchObject({ record: { errorCode: "router_cancelled", session: "left" }, events: [["info", "left"]] });
    }
  });

  it("a later run still running, which has written nothing yet: the late result is kept until that run writes its own", async () => {
    const f = await seed();
    const stopped = await cutRun(f, async context => {
      await heartbeat.cancelRun(context.runId, "Cancelled by the board");
      await laterRun(f, context.runId, 60_000, null, "running");
      return routerFailure("router_cancelled", cut);
    });
    expect(await taskSession(f)).toMatchObject({ sessionDisplayId: cut, lastRunId: stopped.id });
    await db.delete(heartbeatRuns).where(and(eq(heartbeatRuns.companyId, f.companyId), eq(heartbeatRuns.status, "running")));
  });

  it("a later run that writes while the late result waits for the task's lock is not overwritten", async () => {
    const f = await seed();
    let committed!: Promise<unknown>;
    const stopped = await cutRun(f, async context => {
      await heartbeat.cancelRun(context.runId, "Cancelled by the board");
      // A later run holds the task's lock, as every session write does, and writes its session before it lets go.
      let locked!: () => void;
      const hasLock = new Promise<void>(resolve => { locked = resolve; });
      committed = db.transaction(async tx => {
        await tx.execute(sql`select id from issues where id = ${f.issueId} for update`);
        locked();
        await new Promise(resolve => setTimeout(resolve, 1_500));
        const [later] = await tx.insert(heartbeatRuns).values({ companyId: f.companyId, agentId: f.agentId, status: "succeeded",
          contextSnapshot: { issueId: f.issueId }, createdAt: new Date(Date.now() + 60_000), finishedAt: new Date() }).returning();
        await tx.update(agentTaskSessions).set({ sessionParamsJson: paramsOf(other), sessionDisplayId: other, lastRunId: later!.id })
          .where(and(eq(agentTaskSessions.agentId, f.agentId), eq(agentTaskSessions.taskKey, f.issueId)));
      });
      await hasLock;
      return routerFailure("router_cancelled", cut);
    });
    await committed;
    expect(await taskSession(f)).toMatchObject({ sessionDisplayId: other });
    expect(await lateResultOf(stopped.id)).toMatchObject({ record: { session: "left" } });
  });

  it("a late clearSession does not forget the session a later run of the role wrote", async () => {
    const f = await seed();
    const stopped = await cutRun(f, async context => {
      await heartbeat.cancelRun(context.runId, "Cancelled by the board");
      await laterRun(f, context.runId, 60_000, other);
      return routerFailure("router_cancelled", null, { clearSession: true });
    });
    expect(await taskSession(f)).toMatchObject({ sessionDisplayId: other });
    expect(await lateResultOf(stopped.id)).toMatchObject({ record: { session: "left" } });
  });

  // The resume of a role files the Retry of the person who resumed it for each run its pause cut
  // (pause-resume-continuation.ts; the key is the one that file writes). A Retry opens a new conversation; that one
  // goes on in the session kept from the cut run. Production, 22 Nov 2026 (TR-2432): the run restarted by itself and
  // its log said "forceFreshSession was requested".
  const retryOf = async (f: Fixture, runId: string, key: string) => {
    const receipt = await requestTaskRetry({ db, companyId: f.companyId, issueId: f.issueId, actorId: "responsible-user",
      actorSource: "local_implicit", observedRunId: runId, idempotencyKey: key });
    expect(receipt).toMatchObject({ accepted: true });
    await heartbeat.resumeTaskRetry(f.companyId, receipt.requestId!);
  };
  const logOf = async (runId: string) => (await heartbeat.readLog(runId)).content;
  /** What the product decided about the workspace of a Retry's run: the activity it wrote for that run. */
  const workspaceChoiceOf = async (f: Fixture, runId: string) => (await db.select().from(activityLog).where(and(
    eq(activityLog.companyId, f.companyId), eq(activityLog.entityId, f.issueId), eq(activityLog.runId, runId))))
    .filter(entry => entry.action === "issue.fresh_workspace_selected" || entry.action === "issue.retry_workspace_reused")
    .map(entry => [entry.action, entry.details?.mode]);
  /** The folder a run worked in. */
  const folderOf = (run: { contextSnapshot: Record<string, unknown> | null }) =>
    String((run.contextSnapshot?.paperclipWorkspace as { cwd?: unknown } | undefined)?.cwd);
  it("the resume of the role continues the run its pause cut: the run goes on in the session kept from it, in the task's own workspace", async () => {
    const f = await seed();
    const cancelled = await cutRun(f, async () => {
      await heartbeat.cancelActiveForAgent(f.agentId);
      return routerFailure("router_cancelled", cut);
    });
    expect(await taskSession(f)).toMatchObject({ sessionDisplayId: cut, lastRunId: cancelled.id });
    await stopProven(f, cancelled.id);
    const next = await nextExecution(f, () => retryOf(f, cancelled.id, `pause-resume:${cancelled.id}:${randomUUID()}`));
    expect(next.run.contextSnapshot).toMatchObject({ previousRunId: cancelled.id, explicitUserContinuation: { previousRunId: cancelled.id } });
    expect(next.run.contextSnapshot).not.toHaveProperty("forceFreshSession");
    // The run works where the cut run worked: the product would have given this Retry a fresh isolated workspace,
    // another folder and another workspace mode, and refused the session for that.
    expect(await workspaceChoiceOf(f, next.run.id)).toEqual([["issue.retry_workspace_reused", "pause_resume_task_workspace"]]);
    // A run prepared twice (its start taken again) reads this again: same answer, and the task still says it once.
    expect(await readFreshWorkspaceReadiness(db, next.run as never)).toBeNull();
    expect(await workspaceChoiceOf(f, next.run.id)).toEqual([["issue.retry_workspace_reused", "pause_resume_task_workspace"]]);
    expect(folderOf(next.run)).toBe(folderOf(cancelled));
    expect(folderOf(next.run)).not.toContain("isolated-workspace-attempts");
    const log = await logOf(next.run.id);
    expect(log).not.toContain("Skipping saved session resume");
    expect(log).not.toContain("forceFreshSession was requested");
    expect({ sessionId: next.sessionId, sessionParams: next.sessionParams }).toMatchObject({ sessionId: cut, sessionParams: paramsOf(cut) });
    // Read several times at once, with the line not written yet: every reader has the same answer, and one line.
    await db.delete(activityLog).where(and(eq(activityLog.runId, next.run.id), eq(activityLog.action, "issue.retry_workspace_reused")));
    expect(await Promise.all(Array.from({ length: 8 }, () => readFreshWorkspaceReadiness(db, next.run as never))))
      .toEqual(Array.from({ length: 8 }, () => null));
    expect(await workspaceChoiceOf(f, next.run.id)).toEqual([["issue.retry_workspace_reused", "pause_resume_task_workspace"]]);
    // The cut run is no longer seen to have left its workspace (the cleanup of a lease it took failed): the answer is
    // the Retry's own choice again, a fresh isolated workspace, as before this patch.
    await db.update(environmentLeases).set({ cleanupStatus: "failed" }).where(eq(environmentLeases.heartbeatRunId, cancelled.id));
    expect(await readFreshWorkspaceReadiness(db, next.run as never)).toMatchObject({ mode: "fresh_isolated_workspace", sourceRunId: cancelled.id });
  });

  // What the server reads before it keeps the task's workspace for the run that continues a pause-cut run: each
  // thing, one at a time, on the true rows of a cut run.
  it("the task's workspace is kept only when the cut run is seen to have left it: each thing the server reads", async () => {
    const f = await seed();
    const cancelled = await cutRun(f, async () => {
      await heartbeat.cancelActiveForAgent(f.agentId);
      return routerFailure("router_cancelled", cut);
    });
    await stopProven(f, cancelled.id);
    const successorRunId = randomUUID();
    const read = async (patch: Record<string, unknown> = {}) => pauseCutSourceLeftItsWorkspace(db, { companyId: f.companyId,
      issueId: f.issueId, successorRunId, source: { ...(await reread(cancelled.id)), ...patch } as never });
    expect(await read()).toBeNull();
    // The cut run is not settled.
    expect(await read({ status: "running" })).toBe("source_not_settled");
    expect(await read({ finishedAt: null })).toBe("source_not_settled");
    expect(await read({ controllerLeaseExpiresAt: new Date(Date.now() + 60_000) })).toBe("source_not_settled");
    expect(await read({ controllerLeaseExpiresAt: new Date(Date.now() - 60_000) })).toBeNull();
    // A repair of its workspace is due, by its result or by the cause of a hold on it.
    expect(await read({ resultJson: { ...(cancelled.resultJson ?? {}), workspaceRestoreFailure: { reason: "restore failed" } } })).toBe("workspace_repair_required");
    // The hold the product itself wrote on the cut run, or one written here when it wrote none.
    const [written] = await db.select().from(issueRecoveryActions).where(and(eq(issueRecoveryActions.companyId, f.companyId),
      eq(issueRecoveryActions.sourceIssueId, f.issueId), sql`${issueRecoveryActions.evidence}->>'runId' = ${cancelled.id}`));
    const hold = written ?? (await db.insert(issueRecoveryActions).values({ companyId: f.companyId, sourceIssueId: f.issueId,
      kind: "active_run_watchdog", cause: "legacy_execution_requires_reconciliation", fingerprint: `legacy-execution:${cancelled.id}`,
      status: "resolved", ownerType: "board", nextAction: "Review the cut run.", evidence: { runId: cancelled.id } }).returning())[0]!;
    await db.update(issueRecoveryActions).set({ cause: "native_workspace_sync_out_unrecoverable" }).where(eq(issueRecoveryActions.id, hold.id));
    expect(await read()).toBe("workspace_repair_required");
    // A recovery generation is still at work on it.
    await db.update(issueRecoveryActions).set({ cause: hold.cause,
      evidence: { ...(hold.evidence as Record<string, unknown>), systemRecovery: { state: "scheduled" } } }).where(eq(issueRecoveryActions.id, hold.id));
    expect(await read()).toBe("recovery_generation_unsettled");
    await db.update(issueRecoveryActions).set({ cause: hold.cause, evidence: hold.evidence }).where(eq(issueRecoveryActions.id, hold.id));
    expect(await read()).toBeNull();
    // A lease it took is not released, or its cleanup failed or is still due: whatever the lease's provider.
    const [lease] = await db.select().from(environmentLeases).where(eq(environmentLeases.heartbeatRunId, cancelled.id));
    for (const patch of [{ releasedAt: null }, { cleanupStatus: "failed" }, { status: "pending_cleanup" }, { status: "active" }]) {
      await db.update(environmentLeases).set(patch).where(eq(environmentLeases.id, lease!.id));
      expect(await read(), JSON.stringify(patch)).toBe("source_lease_not_released");
      await db.update(environmentLeases).set({ releasedAt: lease!.releasedAt, cleanupStatus: lease!.cleanupStatus, status: lease!.status })
        .where(eq(environmentLeases.id, lease!.id));
    }
    await db.update(environmentLeases).set({ provider: "ssh" }).where(eq(environmentLeases.id, lease!.id));
    expect(await read()).toBeNull();
    // The task is bound to a workspace: a project folder, shared, not the task's own isolated directory.
    const [shared] = await db.insert(executionWorkspaces).values({ companyId: f.companyId, name: "Project folder",
      cwd: path.join(FOLDER, "does-not-exist-here"), mode: "shared_workspace", strategyType: "project_primary" }).returning();
    await db.update(issues).set({ executionWorkspaceId: shared!.id }).where(eq(issues.id, f.issueId));
    expect(await read()).toBeNull();
    // Another run holds that workspace by a lease, or an operation runs on it.
    const [other] = await db.insert(environmentLeases).values({ companyId: f.companyId, environmentId: lease!.environmentId,
      executionWorkspaceId: shared!.id, provider: "local", status: "active", leasePolicy: "ephemeral",
      metadata: { agentId: f.agentId, driver: "local" } }).returning();
    expect(await read()).toBe("lease_held");
    await db.delete(environmentLeases).where(eq(environmentLeases.id, other!.id));
    const [operation] = await db.insert(workspaceOperations).values({ companyId: f.companyId, issueId: f.issueId,
      executionWorkspaceId: shared!.id, phase: "workspace_finalize", status: "running" }).returning();
    expect(await read()).toBe("operation_running");
    await db.delete(workspaceOperations).where(eq(workspaceOperations.id, operation!.id));
    expect(await read()).toBeNull();
    // The cut run worked in another workspace than the one the task is bound to now.
    const [elsewhere] = await db.insert(executionWorkspaces).values({ companyId: f.companyId, name: "Another folder",
      cwd: path.join(FOLDER, "elsewhere"), mode: "shared_workspace", strategyType: "project_primary" }).returning();
    await db.update(environmentLeases).set({ executionWorkspaceId: elsewhere!.id }).where(eq(environmentLeases.id, lease!.id));
    expect(await read()).toBe("binding_not_source_workspace");
    await db.update(issues).set({ executionWorkspaceId: null }).where(eq(issues.id, f.issueId));
    expect(await read()).toBe("binding_not_source_workspace");
    // The task's own isolated local directory, the one the cut run used: it must still be there.
    const [own] = await db.insert(executionWorkspaces).values({ companyId: f.companyId, name: "Task directory", sourceIssueId: f.issueId,
      cwd: path.join(FOLDER, "does-not-exist-here"), mode: "isolated_workspace", strategyType: "git_worktree", providerType: "local_fs" }).returning();
    await db.update(issues).set({ executionWorkspaceId: own!.id }).where(eq(issues.id, f.issueId));
    await db.update(environmentLeases).set({ executionWorkspaceId: own!.id }).where(eq(environmentLeases.id, lease!.id));
    expect(await read()).toBe("directory_missing");
    const real = await fs.mkdtemp(path.join((await import("node:os")).tmpdir(), "task-directory-"));
    await db.update(executionWorkspaces).set({ cwd: real }).where(eq(executionWorkspaces.id, own!.id));
    expect(await read()).toBeNull();
    // Its Git state must still be readable: a link to a repository that is no longer there is not.
    await fs.writeFile(path.join(real, ".git"), "gitdir: /nowhere/that/exists\n");
    expect(await read()).toBe("git_unreadable");
    await fs.rm(path.join(real, ".git"), { force: true });
    expect(await read()).toBeNull();
    await fs.rm(real, { recursive: true, force: true });
  });

  // The run is cut in the middle of a write. The resume starts in the same folder: nothing is reset, nothing is
  // lost, and the role finds its work as it left it.
  it("a run cut during a write: the resume starts in the same workspace, with the half-written work as it is", async () => {
    const f = await seed();
    let written = "";
    const cancelled = await cutRun(f, async context => {
      written = path.join(String((context.context.paperclipWorkspace as { cwd: string }).cwd), `half-written-${f.issueId}.txt`);
      await fs.writeFile(written, "first half of the wor");
      await heartbeat.cancelActiveForAgent(f.agentId);
      return routerFailure("router_cancelled", cut);
    });
    await stopProven(f, cancelled.id);
    let found: { folder: string; content: string | null } | null = null;
    turns.get(f.companyId)!.push(async context => {
      const folder = String((context.context.paperclipWorkspace as { cwd: string }).cwd);
      found = { folder, content: await fs.readFile(path.join(folder, path.basename(written)), "utf8").catch(() => null) };
      return SUCCESS;
    });
    const next = await nextExecution(f, () => retryOf(f, cancelled.id, `pause-resume:${cancelled.id}:${randomUUID()}`));
    expect(found).toEqual({ folder: path.dirname(written), content: "first half of the wor" });
    expect(folderOf(next.run)).toBe(folderOf(cancelled));
    expect(next).toMatchObject({ sessionId: cut });
    await fs.rm(written, { force: true });
  });

  it("a Retry a person clicks on the run a pause cut still opens a new conversation", async () => {
    const f = await seed();
    const cancelled = await cutRun(f, async () => {
      await heartbeat.cancelActiveForAgent(f.agentId);
      return routerFailure("router_cancelled", cut);
    });
    expect(await taskSession(f)).toMatchObject({ sessionDisplayId: cut, lastRunId: cancelled.id });
    await stopProven(f, cancelled.id);
    const next = await nextExecution(f, () => retryOf(f, cancelled.id, randomUUID()));
    expect(next.run.contextSnapshot).toMatchObject({ previousRunId: cancelled.id, forceFreshSession: true });
    expect(next).toMatchObject({ sessionId: null });
    // And its workspace is the product's choice for a Retry, unchanged: a fresh isolated one.
    expect(await workspaceChoiceOf(f, next.run.id)).toEqual([["issue.fresh_workspace_selected", "fresh_isolated_workspace"]]);
    expect(folderOf(next.run)).not.toBe(folderOf(cancelled));
  });

  // Only a run a PAUSE cut is continued in its own folder. A run that failed, or that something else cancelled, left
  // its folder in a state nobody chose: its retry keeps the product's fresh workspace, even under the resume's key.
  it.each<[string, Turn | "system" | "person"]>([
    ["failed", async () => routerFailure("adapter_failed", cut)],
    ["was cancelled by the system, not by a pause", "system"],
    ["was stopped by a person, not by a pause", "person"],
  ])("the retry of a run that %s keeps a fresh workspace: the folder it left is never reopened", async (_how, ending) => {
    const f = await seed();
    const ended = await cutRun(f, ending === "system" ? async context => {
      await heartbeat.cancelRun(context.runId, "Cancelled by another path");
      return routerFailure("router_cancelled", cut);
    } : ending === "person" ? async context => {
      await personStops(context.runId);
      return routerFailure("router_cancelled", cut);
    } : ending);
    await stopProven(f, ended.id);
    const next = await nextExecution(f, () => retryOf(f, ended.id, `pause-resume:${ended.id}:${randomUUID()}`));
    expect(next.run.contextSnapshot).toMatchObject({ previousRunId: ended.id, taskRetryRequestId: expect.any(String), forceFreshSession: true });
    expect(await workspaceChoiceOf(f, next.run.id)).toEqual([["issue.fresh_workspace_selected", "fresh_isolated_workspace"]]);
    expect(folderOf(next.run)).not.toBe(folderOf(ended));
    expect(folderOf(next.run)).toContain("isolated-workspace-attempts");
    expect(next).toMatchObject({ sessionId: null });
  });

  it("the resume of the role, when the task's session was written by another run than the cut one: a new conversation", async () => {
    const f = await seed();
    // The cut run's result names no session: the task still holds the session of the run before it.
    const cancelled = await cutRun(f, async () => {
      await heartbeat.cancelActiveForAgent(f.agentId);
      return routerFailure("router_cancelled", null);
    });
    expect((await taskSession(f))?.lastRunId).not.toBe(cancelled.id);
    expect(await taskSession(f)).toMatchObject({ sessionDisplayId: first });
    await stopProven(f, cancelled.id);
    const next = await nextExecution(f, () => retryOf(f, cancelled.id, `pause-resume:${cancelled.id}:${randomUUID()}`));
    expect(next.run.contextSnapshot).toMatchObject({ previousRunId: cancelled.id, forceFreshSession: true });
    expect(next).toMatchObject({ sessionId: null });
  });

  it("the resume of the role, when nothing holds the task any more and its session is another run's: a new conversation", async () => {
    const f = await seed();
    const cancelled = await cutRun(f, async () => {
      await heartbeat.cancelActiveForAgent(f.agentId);
      return routerFailure("router_cancelled", null);
    });
    expect(await taskSession(f)).toMatchObject({ sessionDisplayId: first });
    await stopProven(f, cancelled.id);
    // The hold of the cut run was settled before the request is sent: the run that starts continues nothing.
    await db.update(issueRecoveryActions).set({ status: "resolved", outcome: "cancelled", resolvedAt: new Date() })
      .where(eq(issueRecoveryActions.sourceIssueId, f.issueId));
    const next = await nextExecution(f, () => retryOf(f, cancelled.id, `pause-resume:${cancelled.id}:${randomUUID()}`));
    expect(next.run.contextSnapshot).toMatchObject({ previousRunId: cancelled.id, forceFreshSession: true });
    expect(next).toMatchObject({ sessionId: null });
  });

  // A session removed on purpose always wins over a late result: the result of a run created before the removal
  // never puts the session back. The removal leaves a mark the late write reads (task-session-removal.ts).
  type Removal = (f: Fixture, cutRunId: string) => Promise<unknown>;
  const REMOVALS: Array<[string, Removal]> = [
    ["a person resets the role's session for the task", f => heartbeat.resetRuntimeSession(f.agentId, { taskKey: f.issueId })],
    // The guard against relaunch loops (the series of TR-2069) gives the session up by this same call.
    ["the guard against relaunch loops gives the session up", f => createHeartbeatRunState(db).clearTaskSessions(f.companyId, f.agentId,
      { taskKey: f.issueId, adapterType })],
    // STUDIO-0048: recovery drops the session the cut run left mid-turn, by the real settlement.
    ["recovery drops the session the cut run left mid-turn", async (f, cutRunId) => {
      // The hold of the cut run: the one the server wrote when it cancelled the run, or one written here.
      const held = await db.select().from(issueRecoveryActions).where(and(eq(issueRecoveryActions.companyId, f.companyId),
        eq(issueRecoveryActions.sourceIssueId, f.issueId), sql`${issueRecoveryActions.evidence}->>'runId' = ${cutRunId}`));
      const action = held[0] ?? (await db.insert(issueRecoveryActions).values({ companyId: f.companyId, sourceIssueId: f.issueId,
        kind: "active_run_watchdog", cause: "legacy_execution_requires_reconciliation", fingerprint: `legacy-execution:${cutRunId}`,
        status: "active", ownerType: "board", nextAction: "Review the cut run.", evidence: { runId: cutRunId } }).returning())[0]!;
      await markExecutionReconciliation(db, action, { runId: cutRunId } as never, "responsible-user", undefined, { dependencyBlockedOnly: true });
    }],
  ];
  it.each(REMOVALS)("%s, then the cut run's late result arrives: the session is not put back", async (_what, remove) => {
    const f = await seed();
    const cancelled = await cutRun(f, async context => {
      await heartbeat.cancelActiveForAgent(f.agentId);
      expect(await taskSession(f)).toMatchObject({ sessionDisplayId: first });
      await remove(f, context.runId);
      expect(await taskSession(f)).toBeNull();
      return routerFailure("router_cancelled", cut);
    });
    expect(cancelled).toMatchObject({ status: "cancelled" });
    expect(await taskSession(f)).toBeNull();
    expect(cancelled.sessionIdAfter).toBeNull();
    expect(await lateResultOf(cancelled.id)).toMatchObject({ record: { session: "left", sameSessionAsTask: false }, events: [["info", "left"]] });
  });

  it("a session removed BEFORE the cut run was created does not hold that run's late result: it is kept", async () => {
    const f = await seed();
    const cancelled = await cutRun(f, async context => {
      await heartbeat.cancelActiveForAgent(f.agentId);
      await heartbeat.resetRuntimeSession(f.agentId, { taskKey: f.issueId });
      // That removal is older than the run: its mark is moved to one second before the run was created.
      await db.execute(sql`update activity_log set created_at = (select created_at from heartbeat_runs where id = ${context.runId}) - interval '1 second'
        where company_id = ${f.companyId} and action = ${TASK_SESSION_REMOVED}`);
      return routerFailure("router_cancelled", cut);
    });
    expect(cancelled).toMatchObject({ status: "cancelled", sessionIdAfter: cut });
    expect(await taskSession(f)).toMatchObject({ sessionDisplayId: cut, lastRunId: cancelled.id });
    expect(await lateResultOf(cancelled.id)).toMatchObject({ record: { session: "kept", sameSessionAsTask: true } });
  });

  it("a session removed for ANOTHER task of the role does not hold this task's late result", async () => {
    const f = await seed();
    const cancelled = await cutRun(f, async () => {
      await heartbeat.cancelActiveForAgent(f.agentId);
      // The role's session for another task is reset while this run is cut.
      await heartbeat.resetRuntimeSession(f.agentId, { taskKey: randomUUID() });
      return routerFailure("router_cancelled", cut);
    });
    expect(cancelled).toMatchObject({ status: "cancelled", sessionIdAfter: cut });
    expect(await taskSession(f)).toMatchObject({ sessionDisplayId: cut, lastRunId: cancelled.id });
  });

  // Sessions are kept per role (agent_task_sessions is keyed by the agent): what the former role holds is never what
  // the new assignee resumes. While the cut run of the former role still holds the task, the product starts no run of
  // the new role at all (its request is kept: "the previous execution has not finished or its owner changed").
  it("a task handed to another role: the session kept for the former role never serves the new one", async () => {
    const f = await seed();
    // The conversation of the former role, kept when the system cancelled its run.
    const stopped = await cutRun(f, async context => {
      await heartbeat.cancelRun(context.runId, "Cancelled by another path");
      await asConversation(f, context.runId);
      return routerFailure("router_cancelled", cut);
    });
    expect(await taskSession(f)).toMatchObject({ sessionDisplayId: cut, lastRunId: stopped.id });
    await notConversation(f);
    const newRole = randomUUID();
    await db.insert(agents).values({ id: newRole, companyId: f.companyId, name: "Other role", role: "engineer", status: "active",
      adapterType, adapterConfig: {}, runtimeConfig: { heartbeat: { wakeOnDemand: true, maxConcurrentRuns: 1 } }, permissions: {} });
    await db.update(issues).set({ assigneeAgentId: newRole }).where(eq(issues.id, f.issueId));
    const [former] = await db.select().from(agents).where(eq(agents.id, f.agentId));
    const [assignee] = await db.select().from(agents).where(eq(agents.id, newRole));
    const sessions = createHeartbeatRunState(db);
    // What a wake of each role would resume on this task (the product's own reader).
    expect(await sessions.resolveSessionBeforeForWakeup(former!, f.issueId)).toBe(cut);
    expect(await sessions.resolveSessionBeforeForWakeup(assignee!, f.issueId)).toBeNull();
    expect(await db.select().from(agentTaskSessions).where(eq(agentTaskSessions.agentId, newRole))).toHaveLength(0);
    // A run of the new role on another task of the same company: no session of the former role either.
    const otherTask = randomUUID();
    await db.insert(issues).values({ id: otherTask, companyId: f.companyId, title: "Another task", status: "todo", priority: "medium", assigneeAgentId: newRole });
    const next = await nextExecution(f, () => heartbeat.wakeup(newRole, { source: "assignment", triggerDetail: "system",
      reason: "issue_assigned", payload: { issueId: otherTask, mutation: "update" },
      requestedByActorType: "user", requestedByActorId: "responsible-user",
      contextSnapshot: { issueId: otherTask, taskId: otherTask, source: "issue.update" } }));
    expect(next.run.agentId).toBe(newRole);
    expect(next).toMatchObject({ sessionId: null });
    expect(await taskSession(f)).toMatchObject({ sessionDisplayId: cut });
  });

  // The owner's rule (20 Nov 2026): the conversation with a role is kept when its run is cancelled, whatever cancelled
  // it. The product's own rule was that a conversation takes no session from a cancelled run.
  it("a conversation task keeps the session of a run the system cancelled, and the person's next request goes on in it", async () => {
    const f = await seed();
    const stopped = await cutRun(f, async context => {
      // Neither a pause nor a person: the control plane cancels the run (recovery, a shutdown, another path).
      await heartbeat.cancelRun(context.runId, "Cancelled by another path");
      await asConversation(f, context.runId);
      return routerFailure("router_cancelled", cut);
    });
    expect(stopped).toMatchObject({ status: "cancelled", sessionIdAfter: cut });
    expect(await taskSession(f)).toMatchObject({ sessionDisplayId: cut, lastRunId: stopped.id });
    expect(await lateResultOf(stopped.id)).toMatchObject({ record: { session: "kept", sameSessionAsTask: true }, events: [["info", "kept"]] });
    // The task is still the conversation: the person writes, and the run that answers resumes that session.
    await stopProven(f, stopped.id);
    const next = await nextExecution(f, () => personMessage(f));
    expect(next.run.contextSnapshot).toMatchObject({ previousRunId: stopped.id });
    expect(next.run.contextSnapshot).not.toHaveProperty("forceFreshSession");
    expect(next).toMatchObject({ sessionId: cut });
    await notConversation(f);
  });

  it("a conversation task whose cut run belongs to an older generation of the conversation takes no session from it", async () => {
    const f = await seed();
    const stopped = await cutRun(f, async context => {
      await heartbeat.cancelRun(context.runId, "Cancelled by another path");
      await asConversation(f, context.runId);
      // The person started the conversation afresh since: the run belongs to the generation before.
      await db.update(issues).set({ conversationSessionGeneration: 1 }).where(eq(issues.id, f.issueId));
      return routerFailure("router_cancelled", cut);
    });
    expect(await taskSession(f)).toMatchObject({ sessionDisplayId: first });
    expect(stopped.sessionIdAfter).toBeNull();
    expect(await lateResultOf(stopped.id)).toMatchObject({ record: { session: "left", sameSessionAsTask: false }, events: [["info", "left"]] });
    await db.update(issues).set({ conversationSessionGeneration: 0 }).where(eq(issues.id, f.issueId));
    await notConversation(f);
  });

  it("a conversation task keeps the session of a run a pause cut, like any task, and the request after the pause resumes it", async () => {
    const f = await seed();
    const cancelled = await cutRun(f, async context => {
      await heartbeat.cancelActiveForAgent(f.agentId);
      await asConversation(f, context.runId);
      return routerFailure("router_cancelled", cut);
    });
    expect(cancelled).toMatchObject({ status: "cancelled", sessionIdAfter: cut });
    expect(await taskSession(f)).toMatchObject({ sessionDisplayId: cut, lastRunId: cancelled.id });
    expect(await lateResultOf(cancelled.id)).toMatchObject({ record: { session: "kept", sameSessionAsTask: true } });
    // The task is an ordinary task again for the request that follows (a conversation's own delivery is not this case).
    await notConversation(f);
    await stopProven(f, cancelled.id);
    const next = await nextExecution(f, () => personMessage(f));
    expect(next.run.contextSnapshot).not.toHaveProperty("forceFreshSession");
    expect(next).toMatchObject({ sessionId: cut });
  });

  // The owner's decision, 20 Nov 2026: after a person stops a run in Paperclip and then writes, the role keeps its
  // conversation. KEEP_SESSION_AFTER_PERSON_STOP is that decision; these cases hold for both of its values.
  it(`a person stops the run, then writes: the session of the stopped run is ${PERSON_STOP_KEEPS ? "resumed" : "left aside, a new conversation"}`, async () => {
    const f = await seed();
    const stopped = await cutRun(f, async context => {
      await personStops(context.runId);
      return routerFailure("router_cancelled", cut);
    });
    expect(stopped.resultJson).toMatchObject({ cancellation: { initiator: { type: "user" } } });
    await stopProven(f, stopped.id);
    const next = await nextExecution(f, () => personMessage(f));
    expect(next.run.contextSnapshot).toMatchObject({ previousRunId: stopped.id });
    if (PERSON_STOP_KEEPS) {
      expect(await lateResultOf(stopped.id)).toMatchObject({ record: { session: "kept", sameSessionAsTask: true } });
      expect(next.run.contextSnapshot).not.toHaveProperty("forceFreshSession");
      expect({ sessionId: next.sessionId, sessionParams: next.sessionParams }).toMatchObject({ sessionId: cut, sessionParams: paramsOf(cut) });
    } else {
      // The product's rule: the stopped run's session is not the task's, and the person's request opens a new one.
      expect(await lateResultOf(stopped.id)).toMatchObject({ record: { session: "left", sameSessionAsTask: false } });
      expect(stopped.sessionIdAfter).toBeNull();
      expect(next.run.contextSnapshot).toMatchObject({ forceFreshSession: true });
      expect(next).toMatchObject({ sessionId: null });
    }
  });

  // After a person's stop the product holds the task until a person asks (the hold of the stopped run): an automatic
  // wake starts nothing, so no automatic run can take the stopped run's session, whatever the switch says. The
  // session question only arises for the person's own request (the case above).
  it("a person stops the run, then an automatic wake comes: nothing starts until a person asks", async () => {
    const f = await seed();
    const stopped = await cutRun(f, async context => {
      await personStops(context.runId);
      return routerFailure("router_cancelled", cut);
    });
    expect(await taskSession(f)).toMatchObject({ sessionDisplayId: PERSON_STOP_KEEPS ? cut : first });
    await stopProven(f, stopped.id);
    const before = executions.get(f.companyId)!.length;
    await automaticWake(f).catch(() => undefined);
    await drainHeartbeatRunsToQuiescence(db, heartbeat);
    expect(executions.get(f.companyId)!.length).toBe(before);
    const refused = (await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.companyId, f.companyId)))
      .filter(wake => wake.payload?.issueId === f.issueId && wake.status === "skipped");
    expect(refused.map(wake => wake.reason)).toContain("execution_reconciliation_required");
    // The person then writes: the run that starts is the continuation of the stopped run.
    const next = await nextExecution(f, () => personMessage(f));
    expect(next.run.contextSnapshot).toMatchObject({ previousRunId: stopped.id });
    expect(next).toMatchObject({ sessionId: PERSON_STOP_KEEPS ? cut : null });
  });

  it("a person stops the run and its result never brings a session: the person's request opens a new conversation, and its log says why", async () => {
    const f = await seed();
    const stopped = await cutRun(f, async context => {
      await personStops(context.runId);
      return routerFailure("router_cancelled", null);
    });
    expect(await taskSession(f)).toMatchObject({ sessionDisplayId: first });
    await stopProven(f, stopped.id);
    const next = await nextExecution(f, () => personMessage(f));
    expect(next.run.contextSnapshot).toMatchObject({ previousRunId: stopped.id, forceFreshSession: true });
    expect(next).toMatchObject({ sessionId: null });
    const log = (await heartbeat.readLog(next.run.id)).content;
    if (PERSON_STOP_KEEPS) expect(log).toContain(`a new conversation starts: the session of the cut run ${stopped.id} was not kept for this task (yet)`);
    else expect(log).toContain("forceFreshSession was requested");
  });

  it("a late session that cannot be written leaves an error event on the run, not only a line in the server's log", async () => {
    const f = await seed();
    const stopped = await cutRun(f, async context => {
      await heartbeat.cancelRun(context.runId, "Cancelled by the board");
      // PostgreSQL refuses this character in a JSON value: the write of the session fails.
      return routerFailure("router_cancelled", cut, { sessionParams: { ...paramsOf(cut), cwd: `${FOLDER}/\u0000` } });
    });
    expect(await taskSession(f)).toMatchObject({ sessionDisplayId: first });
    expect(stopped.sessionIdAfter).toBeNull();
    expect((await lateResultOf(stopped.id)).events).toEqual([["error", "failed"]]);
  });

  it("a late result that names no session leaves the task's session as it was", async () => {
    const f = await seed();
    const stopped = await cutRun(f, async context => {
      await heartbeat.cancelRun(context.runId, "Cancelled by the board");
      return routerFailure("router_cancelled", null);
    });
    expect(stopped).toMatchObject({ status: "cancelled", sessionIdAfter: null });
    const kept = await taskSession(f);
    expect(kept).toMatchObject({ sessionDisplayId: first });
    // Nothing was written for the late run: the row is still the first run's.
    expect(kept!.lastRunId).not.toBe(stopped.id);
  });

  it("clearSession in a failure forgets the session, also when the result comes late", async () => {
    const f = await seed();
    await cutRun(f, async () => routerFailure("router_provider_stop_unverified", null, { clearSession: true }));
    expect(await taskSession(f)).toBeNull();

    const late = await seed();
    const stopped = await cutRun(late, async context => {
      await heartbeat.cancelRun(context.runId, "Cancelled by the board");
      return routerFailure("router_cancelled", null, { clearSession: true });
    });
    expect(await taskSession(late)).toBeNull();
    expect(await lateResultOf(stopped.id)).toMatchObject({ record: { session: "cleared" }, events: [["info", "cleared"]] });
  });

  // The request after a pause continues in the session of the cut run only when that session is really the task's.
  it("after a pause, when the cut run's result brought no session (it never came, or the server restarted first): a new conversation", async () => {
    const f = await seed();
    const cancelled = await cutRun(f, async () => {
      await heartbeat.cancelActiveForAgent(f.agentId);
      return routerFailure("router_cancelled", null);
    });
    // The task still holds the session of the run BEFORE the cut run, which knows nothing of what the cut run did.
    expect(await taskSession(f)).toMatchObject({ sessionDisplayId: first });
    expect((await taskSession(f))!.lastRunId).not.toBe(cancelled.id);
    await stopProven(f, cancelled.id);
    const next = await nextExecution(f, () => personMessage(f));
    expect(next.run.contextSnapshot).toMatchObject({ previousRunId: cancelled.id, forceFreshSession: true });
    expect(next).toMatchObject({ sessionId: null });
    // One line in the continuation's log says that the conversation is new, and why.
    expect((await heartbeat.readLog(next.run.id)).content)
      .toContain(`a new conversation starts: the session of the cut run ${cancelled.id} was not kept for this task (yet)`);
  });

  it("after a pause over an ssh lease: the kept session is resumed on the proof the pause itself accepted", async () => {
    const f = await seed();
    const cancelled = await cutRun(f, async () => {
      await heartbeat.cancelActiveForAgent(f.agentId);
      return routerFailure("router_provider_stop_unverified", cut);
    });
    expect(await lateResultOf(cancelled.id)).toMatchObject({ record: { errorCode: "router_provider_stop_unverified", session: "kept" } });
    await stopProven(f, cancelled.id, "ssh");
    const next = await nextExecution(f, () => personMessage(f));
    expect(next.run.contextSnapshot).toMatchObject({ previousRunId: cancelled.id });
    expect(next.run.contextSnapshot).not.toHaveProperty("forceFreshSession");
    expect({ sessionId: next.sessionId, sessionParams: next.sessionParams }).toMatchObject({ sessionId: cut, sessionParams: paramsOf(cut) });
  });

  it("after a budget pause too: the kept session is resumed", async () => {
    const f = await seed();
    const cancelled = await cutRun(f, async () => {
      await heartbeat.cancelActiveForAgent(f.agentId);
      return routerFailure("router_cancelled", cut);
    });
    // The stop a budget issues carries its own reason; it is a pause stop like the others (governance-pause-stop.ts).
    await db.update(heartbeatRuns).set({ resultJson: sql`jsonb_set(${heartbeatRuns.resultJson}, '{cancellation,reason}', '"Cancelled due to budget pause"')` })
      .where(eq(heartbeatRuns.id, cancelled.id));
    await stopProven(f, cancelled.id);
    const next = await nextExecution(f, () => personMessage(f));
    expect(next.run.contextSnapshot).toMatchObject({ previousRunId: cancelled.id });
    expect(next.run.contextSnapshot).not.toHaveProperty("forceFreshSession");
    expect(next).toMatchObject({ sessionId: cut });
  });

  it("another configuration: the kept session is not handed to the next run, and the run's log says so", async () => {
    const f = await seed();
    const lost = await cutRun(f, async () => routerFailure("router_provider_stop_unverified", cut));
    expect((await taskSession(f))?.sessionParamsJson).toMatchObject(paramsOf(cut));
    await db.update(agents).set({ adapterConfig: { model: "another-model" } }).where(eq(agents.id, f.agentId));
    const retry = await nextExecution(f, async () => {
      await db.update(heartbeatRuns).set({ scheduledRetryAt: new Date(Date.now() - 60_000) })
        .where(and(eq(heartbeatRuns.companyId, f.companyId), eq(heartbeatRuns.status, "scheduled_retry")));
      await heartbeat.promoteDueScheduledRetries();
      await heartbeat.resumeQueuedRuns();
    });
    expect(retry.run).toMatchObject({ retryOfRunId: lost.id });
    expect(retry).toMatchObject({ sessionId: null });
    expect((await heartbeat.readLog(retry.run.id)).content).toMatch(/Skipping saved session resume for task/);
  });
});
