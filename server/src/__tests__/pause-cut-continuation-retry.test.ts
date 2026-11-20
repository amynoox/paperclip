import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { and, asc, eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  activityLog, agentWakeupRequests, agents, authUsers, companies, companyMemberships, createDb, environmentLeases, environments,
  heartbeatRunEvents, heartbeatRuns, issueComments, issueRecoveryActions, issues, projects, projectWorkspaces,
  EMBEDDED_POSTGRES_TEST_TIMEOUT_MS,
} from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { drainHeartbeatRunsToQuiescence } from "./helpers/drain-heartbeat-runs.js";
import { runningProcesses, type AdapterExecutionContext, type AdapterExecutionResult } from "../adapters/index.ts";
import { heartbeatService } from "../services/heartbeat.ts";
import { environmentService } from "../services/environments.js";
import {
  keepPauseCutWorkAfterFailedStart, PAUSE_CUT_WORK_CONTINUED, PAUSE_CUT_WORK_NOT_CONTINUED, PAUSE_CUT_WORK_REQUEST_FILED,
  PAUSE_CUT_WORK_START_FAILED_DELAYS_MS, PAUSE_CUT_WORK_START_FAILED_MAX_MS, PAUSE_RESUME_RETRY_KEY_PREFIX,
} from "../services/pause-resume-continuation.js";
import { readPauseCutWorkAskedAgain, type PauseCutWorkAskedAgain } from "../services/pause-cut-asked-again.js";
import { requestTaskRetry } from "../services/task-retry.js";

const mockAdapterExecute = vi.hoisted(() =>
  vi.fn(async (_context: AdapterExecutionContext): Promise<AdapterExecutionResult> => ({
    exitCode: 0, signal: null, timedOut: false, errorMessage: null, summary: "Turn.", provider: "test", model: "test-model",
  })),
);

vi.mock("../adapters/index.ts", async () => {
  const actual = await vi.importActual<typeof import("../adapters/index.ts")>("../adapters/index.ts");
  return { ...actual, getServerAdapter: vi.fn(() => ({ supportsLocalAgentJwt: false, execute: mockAdapterExecute })) };
});

// The ssh lease probe is the only ssh step replaced: a failing probe throws the raw error `ssh` gave, through the
// product's own classifier. Every other step is the server's real path.
const probe = vi.hoisted(() => ({ failure: null as null | (() => Error), calls: 0 }));
vi.mock("@paperclipai/adapter-utils/ssh", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@paperclipai/adapter-utils/ssh")>();
  return {
    ...actual,
    ensureSshWorkspaceReady: async (config: { remoteWorkspacePath: string }) => {
      probe.calls += 1;
      if (probe.failure) throw actual.withSshConnectFailureCause(probe.failure());
      return { remoteCwd: config.remoteWorkspacePath };
    },
  };
});
const linkDown = () => Object.assign(new Error("Command failed: ssh ...\nssh: connect to host 100.124.59.108 port 22: Connection timed out\n"),
  { code: 255, killed: false, stdout: "", stderr: "ssh: connect to host 100.124.59.108 port 22: Connection timed out\n" });

// STUDIO-0074 (L15). A run a pause cut is continued by the Retry the resume files in a person's name. When that
// continuation fails before its engine is called (the lease of its machine is not obtained), the product schedules
// no retry for it and the task was blocked at that failure. The task is now held, and the same person's request
// is filed again, with growing waits, for twelve hours.
const SUCCESS: AdapterExecutionResult = { exitCode: 0, signal: null, timedOut: false, errorMessage: null,
  summary: "Turn.", provider: "test", model: "test-model" };
type Turn = (context: AdapterExecutionContext) => Promise<AdapterExecutionResult>;
const PERSON = "responsible-user";
const TERMINAL = ["succeeded", "failed", "cancelled", "timed_out"];
vi.setConfig({ testTimeout: 120_000 });
const support = await getEmbeddedPostgresTestSupport();
(support.supported ? describe : describe.skip)("the continuation of a run a pause cut cannot start", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  let heartbeat: ReturnType<typeof heartbeatService>;
  let workspaceCwd: string;
  const turns = new Map<string, Turn[]>();
  const executions = new Map<string, string[]>();
  const play: Turn = async context => {
    const key = context.agent.companyId;
    executions.set(key, [...(executions.get(key) ?? []), context.runId]);
    const turn = turns.get(key)?.shift();
    return turn ? turn(context) : SUCCESS;
  };
  beforeAll(async () => {
    database = await startEmbeddedPostgresTestDatabase("pause-cut-continuation-retry-");
    db = createDb(database.connectionString);
    heartbeat = heartbeatService(db, { runtimeEnv: { ...process.env, PAPERCLIP_IN_WORKTREE: "false" } });
    mockAdapterExecute.mockImplementation(play);
    workspaceCwd = await fs.mkdtemp(path.join(os.tmpdir(), "pause-cut-continuation-retry-"));
    // The project folder is a Git checkout, as a role's project is: an attempt in a fresh workspace is cut from it.
    const git = (...args: string[]) => execFileSync("git", args, { cwd: workspaceCwd, stdio: "ignore" });
    git("init", "-q");
    git("-c", "user.email=fixture@example.test", "-c", "user.name=Fixture", "commit", "--allow-empty", "-q", "-m", "init");
  }, EMBEDDED_POSTGRES_TEST_TIMEOUT_MS);
  afterEach(async () => {
    probe.failure = null;
    await db.update(agentWakeupRequests).set({ status: "cancelled", finishedAt: new Date() })
      .where(eq(agentWakeupRequests.status, "deferred_issue_execution"));
    await drainHeartbeatRunsToQuiescence(db, heartbeat);
    runningProcesses.clear();
  });
  afterAll(async () => { await database?.cleanup(); if (workspaceCwd) await fs.rm(workspaceCwd, { recursive: true, force: true }); });

  /** A role with a project folder, and an ssh machine it does not use yet. */
  async function seed() {
    const companyId = randomUUID(), agentId = randomUUID(), issueId = randomUUID();
    const projectId = randomUUID(), projectWorkspaceId = randomUUID(), environmentId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Cut continuation", defaultResponsibleUserId: PERSON,
      issuePrefix: `K${companyId.replaceAll("-", "").slice(0, 6).toUpperCase()}`, requireBoardApprovalForNewAgents: false });
    await db.insert(authUsers).values({ id: PERSON, name: "Fixture user", email: "responsible-user@example.test",
      createdAt: new Date(), updatedAt: new Date() }).onConflictDoNothing();
    await db.insert(companyMemberships).values({ companyId, principalType: "user", principalId: PERSON,
      status: "active", membershipRole: "member" }).onConflictDoNothing();
    await db.insert(projects).values({ id: projectId, companyId, name: "Project" });
    await db.insert(projectWorkspaces).values({ id: projectWorkspaceId, companyId, projectId, name: "Primary workspace",
      sourceType: "local_path", cwd: workspaceCwd, isPrimary: true });
    await db.insert(environments).values({ id: environmentId, name: `PK-SSH ${environmentId.slice(0, 8)}`, driver: "ssh", status: "active",
      config: { host: "infra-test.invalid", username: "pk-infra", remoteWorkspacePath: workspaceCwd } });
    await db.insert(agents).values({ id: agentId, companyId, name: "Infra Manager", role: "engineer", status: "active",
      adapterType: "claude_local", adapterConfig: {}, runtimeConfig: { heartbeat: { wakeOnDemand: true, maxConcurrentRuns: 1 } }, permissions: {} });
    await db.insert(issues).values({ id: issueId, companyId, title: "Infra task", status: "todo", priority: "medium", assigneeAgentId: agentId,
      projectId, projectWorkspaceId });
    turns.set(companyId, []);
    executions.set(companyId, []);
    return { companyId, agentId, issueId, environmentId };
  }
  type Fixture = Awaited<ReturnType<typeof seed>>;
  const reread = async (runId: string) => (await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, runId)))[0]!;
  const runsOf = (f: Fixture) => db.select().from(heartbeatRuns).where(eq(heartbeatRuns.companyId, f.companyId)).orderBy(asc(heartbeatRuns.createdAt));
  const taskOf = async (f: Fixture) => (await db.select().from(issues).where(eq(issues.id, f.issueId)))[0]!;
  const blocks = async (f: Fixture) => (await db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.sourceIssueId, f.issueId)))
    .filter(action => action.status === "active" && action.kind === "stranded_assigned_issue");
  const entries = async (f: Fixture, action: string) => (await db.select().from(activityLog).where(and(eq(activityLog.companyId, f.companyId),
    eq(activityLog.entityId, f.issueId), eq(activityLog.action, action))).orderBy(asc(activityLog.createdAt))).map(entry => entry.details ?? {});
  const notes = async (f: Fixture) => (await db.select().from(issueComments).where(eq(issueComments.issueId, f.issueId)))
    .filter(comment => comment.authorType === "system" && comment.body.includes("could not start"));
  /** The requests asked again after a failed start, oldest first, with their mark and the failed run their key names. */
  async function askedAgain(f: Fixture) {
    const wakes = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.companyId, f.companyId))
      .orderBy(asc(agentWakeupRequests.requestedAt));
    return wakes.flatMap(wake => {
      const mark = readPauseCutWorkAskedAgain(wake.payload);
      if (!mark) return [];
      expect(wake.idempotencyKey).toMatch(new RegExp(`^${PAUSE_RESUME_RETRY_KEY_PREFIX}[0-9a-f-]{36}:[0-9a-f-]{36}:again:${mark.attempt}$`));
      return [{ wake, failedRunId: wake.idempotencyKey!.slice(PAUSE_RESUME_RETRY_KEY_PREFIX.length).split(":")[0]!, ...mark }];
    });
  }
  /** Rewrites the mark of a request asked again: time passes without waiting for it. */
  async function remark(wakeId: string, change: (mark: PauseCutWorkAskedAgain) => PauseCutWorkAskedAgain) {
    const [wake] = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, wakeId));
    await db.update(agentWakeupRequests).set({ payload: { ...wake!.payload,
      pauseCutWorkAskedAgain: change(readPauseCutWorkAskedAgain(wake!.payload)!) } }).where(eq(agentWakeupRequests.id, wakeId));
  }
  async function execution(f: Fixture, n: number) {
    await vi.waitFor(async () => {
      expect(executions.get(f.companyId)!.length).toBeGreaterThanOrEqual(n);
      expect(TERMINAL).toContain((await reread(executions.get(f.companyId)![n - 1]!)).status);
    }, { timeout: 25_000, interval: 100 });
    const runId = executions.get(f.companyId)![n - 1]!;
    await heartbeat.waitForRunExecutionDrain(runId);
    return reread(runId);
  }
  const assignmentWake = (f: Fixture) => heartbeat.wakeup(f.agentId, { source: "assignment", triggerDetail: "system",
    reason: "issue_assigned", payload: { issueId: f.issueId, mutation: "update" },
    requestedByActorType: "user", requestedByActorId: PERSON,
    contextSnapshot: { issueId: f.issueId, taskId: f.issueId, source: "issue.update" } });
  /** The cut run's engine is gone and its environment is released: the stop is proven. */
  async function stopProven(f: Fixture, runId: string) {
    await db.update(heartbeatRuns).set({ processPid: 2_000_000_000 }).where(eq(heartbeatRuns.id, runId));
    await db.insert(heartbeatRunEvents).values({ companyId: f.companyId, agentId: f.agentId, runId, seq: 100_000,
      eventType: "native.process_identity_recorded", stream: "system", level: "info", message: "identity" });
    const environment = await environmentService(db).ensureLocalEnvironment(f.companyId);
    await db.insert(environmentLeases).values({ companyId: f.companyId, environmentId: environment.id, heartbeatRunId: runId,
      issueId: f.issueId, provider: "local", status: "expired", leasePolicy: "ephemeral", releasedAt: new Date(),
      metadata: { agentId: f.agentId, driver: "local" } });
  }
  /** The role now works on its ssh machine, and the link to it is down. */
  async function machineUnreachable(f: Fixture) {
    await db.update(agents).set({ defaultEnvironmentId: f.environmentId }).where(eq(agents.id, f.agentId));
    probe.failure = linkDown;
  }
  /**
   * The machine answers again. The ssh machine of this file cannot run a real command, so the return of the link is
   * played by the role's local environment: the lease is obtained and the engine is called.
   */
  async function machineAnswers(f: Fixture) {
    await db.update(agents).set({ defaultEnvironmentId: null }).where(eq(agents.id, f.agentId));
    probe.failure = null;
    // The engine's next turn finishes the task, so that the product asks for no further run.
    turns.get(f.companyId)!.push(async () => {
      await db.update(issues).set({ status: "done" }).where(eq(issues.id, f.issueId));
      return SUCCESS;
    });
  }
  /** Everything the server does by itself after an event: queued runs start, and end. */
  async function settle(f: Fixture) {
    await heartbeat.resumeQueuedRuns();
    await vi.waitFor(async () => {
      expect((await runsOf(f)).filter(run => !TERMINAL.includes(run.status) && run.status !== "scheduled_retry")).toHaveLength(0);
    }, { timeout: 25_000, interval: 100 });
    await heartbeat.drainActiveRunExecutions();
  }
  /**
   * A run cut by a pause, its stop proven, then the request the resume files in the person's name (the key is the
   * one pause-resume-continuation.ts files: the cut run and the ready operation), dispatched while the machine is
   * unreachable. Returns the cut run and the continuation that could not start.
   */
  async function continuationThatCannotStart(f: Fixture, key = (cutRunId: string) => `pause-resume:${cutRunId}:${randomUUID()}`) {
    turns.get(f.companyId)!.push(async () => SUCCESS, async () => {
      await heartbeat.cancelActiveForAgent(f.agentId);
      return { exitCode: 1, signal: null, timedOut: false, errorCode: "router_cancelled", errorMessage: "router cancelled" };
    });
    await assignmentWake(f);
    await execution(f, 1);
    await assignmentWake(f);
    const cut = await execution(f, 2);
    expect(cut).toMatchObject({ status: "cancelled", errorCode: "agent_paused" });
    await stopProven(f, cut.id);
    const receipt = await requestTaskRetry({ db, companyId: f.companyId, issueId: f.issueId, actorId: PERSON,
      actorSource: "local_implicit", observedRunId: cut.id, idempotencyKey: key(cut.id) });
    expect(receipt).toMatchObject({ accepted: true });
    await machineUnreachable(f);
    await heartbeat.resumeTaskRetry(f.companyId, receipt.requestId!);
    await settle(f);
    const failed = (await runsOf(f)).find(run => run.contextSnapshot?.previousRunId === cut.id && run.contextSnapshot?.explicitUserContinuation);
    expect(failed).toMatchObject({ status: "failed", errorCode: "environment_provider_unavailable", processPid: null });
    return { cut, failed: failed! };
  }
  const scheduledRetries = async (f: Fixture) => (await runsOf(f)).filter(run => run.status === "scheduled_retry");
  /** The retry the product scheduled comes due, as it would in real time, and runs. */
  async function scheduledRetryComesDue(f: Fixture) {
    const [scheduled] = await scheduledRetries(f);
    expect(scheduled).toBeDefined();
    await heartbeat.promoteDueScheduledRetries(new Date(scheduled!.scheduledRetryAt!.getTime() + 1_000));
    await settle(f);
    return reread(scheduled!.id);
  }
  /** Every retry the product scheduled by itself comes due and fails, until it schedules no more. Returns the last run. */
  async function productRetriesRunOut(f: Fixture) {
    let last = (await runsOf(f)).at(-1)!;
    for (let turn = 0; turn < 10 && (await scheduledRetries(f)).length; turn += 1) last = await scheduledRetryComesDue(f);
    expect(await scheduledRetries(f)).toHaveLength(0);
    return last;
  }
  /** The deferred-receipt work looks at every kept request again (heartbeat/deferred-receipt-work.ts, about every 30 s). */
  async function keptRequestsAreLookedAtAgain(f: Fixture) {
    await heartbeat.resumeExecutionWaitComments({ companyId: f.companyId });
    await settle(f);
  }
  /** The wait of the request asked last has passed: it may start now. */
  async function itsTimeHasCome(f: Fixture) {
    await remark((await askedAgain(f)).at(-1)!.wake.id, mark => ({ ...mark, notBefore: Date.now() - 1_000 }));
  }

  it("the task is held, the same person's request is filed again and waits; when the machine answers, the work starts again", async () => {
    const f = await seed();
    const { cut, failed } = await continuationThatCannotStart(f);
    // The product scheduled no retry for that run, as before.
    expect((await runsOf(f)).filter(run => run.retryOfRunId === failed.id)).toHaveLength(0);
    // The task is not blocked, and nothing is asked of the Board.
    expect(await taskOf(f)).toMatchObject({ status: "in_progress" });
    expect(await blocks(f)).toHaveLength(0);
    // The Retry is filed again on the failed run, in the same person's name, and waits thirty seconds.
    let asked = await askedAgain(f);
    expect(asked).toHaveLength(1);
    expect(asked[0]).toMatchObject({ failedRunId: failed.id, attempt: 1, cutRunId: cut.id,
      wake: { status: "deferred_issue_execution", requestedByActorType: "user", requestedByActorId: PERSON,
        payload: { issueId: f.issueId, taskRetry: { actorId: PERSON, actorSource: "local_implicit", sourceRunId: failed.id } } } });
    expect(asked[0]!.notBefore - failed.finishedAt!.getTime()).toBe(30_000);
    expect(asked[0]!.seriesStartedAt).toBe(failed.finishedAt!.getTime());
    expect((await entries(f, PAUSE_CUT_WORK_REQUEST_FILED)).filter(entry => entry.reason === "start_failed")).toMatchObject([
      { interruptedRunId: failed.id, cutRunId: cut.id, attempt: 1, errorCode: "environment_provider_unavailable",
        resumedByUserId: PERSON, actorSource: "local_implicit", retryRequestId: asked[0]!.wake.id }]);
    expect(await notes(f)).toHaveLength(1);
    expect((await notes(f))[0]!.body).toContain("environment_provider_unavailable");

    // Looked at before its time: nothing starts.
    const before = (await runsOf(f)).length;
    await keptRequestsAreLookedAtAgain(f);
    expect((await runsOf(f)).length).toBe(before);
    expect((await askedAgain(f))[0]!.wake.status).toBe("deferred_issue_execution");

    // Its time comes and the machine is still unreachable. The request starts an ordinary run (the failed start left
    // no hold to continue past), which fails the same way; the product now retries that run by itself.
    await itsTimeHasCome(f);
    await keptRequestsAreLookedAtAgain(f);
    const second = (await runsOf(f)).find(run => run.contextSnapshot?.taskRetryRequestId === asked[0]!.wake.id && !run.retryOfRunId)!;
    expect(second).toMatchObject({ status: "failed", errorCode: "environment_provider_unavailable" });
    expect(second.contextSnapshot?.explicitUserContinuation).toBeUndefined();
    expect((await entries(f, PAUSE_CUT_WORK_CONTINUED)).at(-1)).toMatchObject({ interruptedRunId: failed.id,
      continuationRunId: second.id, afterFailedStart: true, attempt: 1, cutRunId: cut.id, resumedByUserId: PERSON });
    expect(await scheduledRetries(f)).toMatchObject([{ retryOfRunId: second.id, scheduledRetryReason: "transient_failure" }]);
    expect(await askedAgain(f)).toHaveLength(1);
    expect(await taskOf(f)).toMatchObject({ status: "in_progress" });
    expect(await blocks(f)).toHaveLength(0);

    // The machine answers: the product's retry starts, the engine is called, the work goes on.
    await machineAnswers(f);
    const called = executions.get(f.companyId)!.length;
    await scheduledRetryComesDue(f);
    expect(executions.get(f.companyId)!.length).toBe(called + 1);
    expect(await reread(executions.get(f.companyId)!.at(-1)!)).toMatchObject({ status: "succeeded", retryOfRunId: second.id });
    expect(await askedAgain(f)).toHaveLength(1);
    expect(await blocks(f)).toHaveLength(0);
    // One note for the series.
    expect(await notes(f)).toHaveLength(1);
  });

  it("when the product's own retries run out and the machine is still unreachable, the request is filed again, with a longer wait", async () => {
    const f = await seed();
    const { cut, failed } = await continuationThatCannotStart(f);
    await itsTimeHasCome(f);
    await keptRequestsAreLookedAtAgain(f);
    // The product's bounded retries of the ordinary run fail one after the other.
    const last = await productRetriesRunOut(f);
    expect(last).toMatchObject({ status: "failed", errorCode: "environment_provider_unavailable" });
    expect(last.retryOfRunId).not.toBeNull();
    // Where the task was blocked, it is held again: the second request of the series, one minute after that failure.
    const asked = await askedAgain(f);
    expect(asked).toHaveLength(2);
    expect(asked[1]).toMatchObject({ failedRunId: last.id, attempt: 2, cutRunId: cut.id, seriesStartedAt: failed.finishedAt!.getTime(),
      wake: { status: "deferred_issue_execution", requestedByActorType: "user", requestedByActorId: PERSON } });
    expect(asked[1]!.notBefore - last.finishedAt!.getTime()).toBe(60_000);
    expect(await taskOf(f)).toMatchObject({ status: "in_progress" });
    expect(await blocks(f)).toHaveLength(0);
    // Still one note: the series is the same.
    expect(await notes(f)).toHaveLength(1);

    // The machine answers and the request's time comes: the engine is called.
    await machineAnswers(f);
    await itsTimeHasCome(f);
    const called = executions.get(f.companyId)!.length;
    await keptRequestsAreLookedAtAgain(f);
    expect(executions.get(f.companyId)!.length).toBe(called + 1);
    const restarted = await reread(executions.get(f.companyId)!.at(-1)!);
    expect(restarted).toMatchObject({ status: "succeeded", contextSnapshot: { taskRetryRequestId: asked[1]!.wake.id } });
    expect((await entries(f, PAUSE_CUT_WORK_CONTINUED)).at(-1)).toMatchObject({ interruptedRunId: last.id,
      continuationRunId: restarted.id, afterFailedStart: true, attempt: 2, cutRunId: cut.id });
    expect(await blocks(f)).toHaveLength(0);
  });

  it("the waits grow: thirty seconds, one, two, four minutes, then five minutes each time", () => {
    expect(PAUSE_CUT_WORK_START_FAILED_DELAYS_MS).toEqual([30_000, 60_000, 120_000, 240_000, 300_000]);
    expect(PAUSE_CUT_WORK_START_FAILED_MAX_MS).toBe(12 * 60 * 60_000);
  });

  it("twelve hours after the first failure nothing is filed any more: the task is blocked as before, and says why", async () => {
    const f = await seed();
    const { failed } = await continuationThatCannotStart(f);
    const [first] = await askedAgain(f);
    // The series began a little more than twelve hours ago, and the request's time has come.
    await remark(first!.wake.id, mark => ({ ...mark, seriesStartedAt: Date.now() - PAUSE_CUT_WORK_START_FAILED_MAX_MS - 60_000,
      notBefore: Date.now() - 1_000 }));
    await keptRequestsAreLookedAtAgain(f);
    // The request started an ordinary run; the product's own retries of it run out.
    const last = await productRetriesRunOut(f);
    expect(last).toMatchObject({ status: "failed", errorCode: "environment_provider_unavailable" });
    expect(last.id).not.toBe(failed.id);
    expect(await askedAgain(f)).toHaveLength(1);
    expect(await taskOf(f)).toMatchObject({ status: "blocked" });
    expect(await blocks(f)).toHaveLength(1);
    expect((await entries(f, PAUSE_CUT_WORK_NOT_CONTINUED)).at(-1)).toMatchObject({ interruptedRunId: last.id,
      reason: "start_failed_for_twelve_hours" });
  });

  it("a Retry a person clicked that cannot start is not filed again: blocked as before", async () => {
    const f = await seed();
    await continuationThatCannotStart(f, () => randomUUID());
    expect(await askedAgain(f)).toHaveLength(0);
    expect(await taskOf(f)).toMatchObject({ status: "blocked" });
    expect(await blocks(f)).toHaveLength(1);
  });

  it("a run whose engine was called is never asked for again by this path", async () => {
    const f = await seed();
    const { failed } = await continuationThatCannotStart(f);
    const held = { companyId: f.companyId, issueId: f.issueId, runId: failed.id };
    // As it is, the task is held by the request that waits.
    expect(await keepPauseCutWorkAfterFailedStart(db, held)).toBe(true);
    // Once the role has run again on the task, that failed start is history: nothing is held for it.
    const newer = randomUUID();
    await db.insert(heartbeatRuns).values({ id: newer, companyId: f.companyId, agentId: f.agentId, status: "succeeded",
      contextSnapshot: { issueId: f.issueId }, finishedAt: new Date() });
    expect(await keepPauseCutWorkAfterFailedStart(db, held)).toBe(false);
    await db.delete(heartbeatRuns).where(eq(heartbeatRuns.id, newer));
    expect(await keepPauseCutWorkAfterFailedStart(db, held)).toBe(true);
    // No request waits any more (the one that was filed is taken away, so that a new one could be filed).
    await db.delete(agentWakeupRequests).where(eq(agentWakeupRequests.id, (await askedAgain(f))[0]!.wake.id));
    // The same run, had its adapter been invoked: nothing is filed.
    await db.insert(heartbeatRunEvents).values({ companyId: f.companyId, agentId: f.agentId, runId: failed.id, seq: 200_000,
      eventType: "adapter.invoke", stream: "system", level: "info", message: "adapter invocation" });
    expect(await keepPauseCutWorkAfterFailedStart(db, held)).toBe(false);
    await db.delete(heartbeatRunEvents).where(and(eq(heartbeatRunEvents.runId, failed.id), eq(heartbeatRunEvents.eventType, "adapter.invoke")));
    // Had it recorded a process: nothing is filed.
    await db.update(heartbeatRuns).set({ processPid: 2_000_000_001 }).where(eq(heartbeatRuns.id, failed.id));
    expect(await keepPauseCutWorkAfterFailedStart(db, held)).toBe(false);
    await db.update(heartbeatRuns).set({ processPid: null }).where(eq(heartbeatRuns.id, failed.id));
    // Had it failed on a code that is not a transient preparation failure: nothing is filed.
    await db.update(heartbeatRuns).set({ errorCode: "setup_failed" }).where(eq(heartbeatRuns.id, failed.id));
    expect(await keepPauseCutWorkAfterFailedStart(db, held)).toBe(false);
    expect(await askedAgain(f)).toHaveLength(0);
    // And as it really is, with no request waiting: the request is filed.
    await db.update(heartbeatRuns).set({ errorCode: "environment_provider_unavailable" }).where(eq(heartbeatRuns.id, failed.id));
    expect(await keepPauseCutWorkAfterFailedStart(db, held)).toBe(true);
    expect(await askedAgain(f)).toHaveLength(1);
  });

  it("a request asked again that a person cancelled is not filed again, and a task handed to another role is left alone", async () => {
    const f = await seed();
    const { failed } = await continuationThatCannotStart(f);
    const held = { companyId: f.companyId, issueId: f.issueId, runId: failed.id };
    const [first] = await askedAgain(f);
    await db.update(agentWakeupRequests).set({ status: "cancelled", error: "Cancelled by the board" }).where(eq(agentWakeupRequests.id, first!.wake.id));
    expect(await keepPauseCutWorkAfterFailedStart(db, held)).toBe(false);
    expect(await askedAgain(f)).toHaveLength(1);
    // Handed to another role: this run is not that role's, nothing is filed.
    const other = randomUUID();
    await db.insert(agents).values({ id: other, companyId: f.companyId, name: "Other role", role: "engineer", status: "active",
      adapterType: "claude_local", adapterConfig: {}, runtimeConfig: {}, permissions: {} });
    await db.update(agentWakeupRequests).set({ status: "deferred_issue_execution", error: null }).where(eq(agentWakeupRequests.id, first!.wake.id));
    await db.update(issues).set({ assigneeAgentId: other }).where(eq(issues.id, f.issueId));
    expect(await keepPauseCutWorkAfterFailedStart(db, held)).toBe(false);
  });
});
