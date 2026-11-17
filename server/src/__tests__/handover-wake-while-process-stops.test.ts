import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { and, eq, like } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  agentWakeupRequests, agents, authUsers, companies, companyMemberships, createDb, environmentLeases, heartbeatRuns,
  issueComments, issueRecoveryActions, issues, EMBEDDED_POSTGRES_TEST_TIMEOUT_MS,
} from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { drainHeartbeatRunsToQuiescence } from "./helpers/drain-heartbeat-runs.js";
import { runningProcesses, type AdapterExecutionContext, type AdapterExecutionResult } from "../adapters/index.ts";
import { heartbeatService } from "../services/heartbeat.ts";
import { getExecutionBlocker } from "../services/execution-blocker.js";
import { readProcessStartedAt } from "../services/hot-restart.js";

// The first run of an agent listed here is the handing-over run: it starts a real child process, reports it as the
// run's process, and returns when the run is stopped. The child itself is left alive, as a provider process that is
// still stopping.
const handingOver = vi.hoisted(() => ({ agents: new Set<string>(), children: new Map<string, unknown>(),
  stopped: new Map<string, () => boolean | Promise<boolean>>() }));
const mockAdapterExecute = vi.hoisted(() =>
  vi.fn(async (_context: AdapterExecutionContext): Promise<AdapterExecutionResult> => ({
    exitCode: 0, signal: null, timedOut: false, errorMessage: null,
    summary: "Assignee turn.", provider: "test", model: "test-model",
  })),
);

vi.mock("../adapters/index.ts", async () => {
  const actual = await vi.importActual<typeof import("../adapters/index.ts")>("../adapters/index.ts");
  return { ...actual, getServerAdapter: vi.fn(() => ({ supportsLocalAgentJwt: false, execute: mockAdapterExecute })) };
});

// STUDIO-0066: production, 17 Nov 2026, TR-1526. At 16:01:15 the Unity developer handed the task to the CTO in review,
// by a change of assignee alone. Its run 84d24f1c was cancelled with `issue_reassigned`; its process was still
// stopping and its environment lease was released at 16:01:32 only. At 16:01:18 the CTO's `issue_assigned` wake met
// `execution_owner_active` (`recoveryActionId: null`). It carried no comment, so it was written as a skipped receipt,
// which nothing reads again: the CTO had no run until a comment 58 minutes later.
const NOTICE_MARKER = "<!-- execution-owner-stall-notice -->";
const support = await getEmbeddedPostgresTestSupport();
(support.supported ? describe : describe.skip)("hand-over wake while the previous run's process stops (STUDIO-0066)", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  let heartbeat: ReturnType<typeof heartbeatService>;
  const children = new Set<ChildProcess>();
  beforeAll(async () => {
    database = await startEmbeddedPostgresTestDatabase("handover-wake-process-stops-");
    db = createDb(database.connectionString);
    heartbeat = heartbeatService(db, { runtimeEnv: { ...process.env, PAPERCLIP_IN_WORKTREE: "false" } });
  }, EMBEDDED_POSTGRES_TEST_TIMEOUT_MS);
  afterEach(async () => {
    for (const child of children) child.kill("SIGKILL");
    children.clear();
    handingOver.agents.clear(); handingOver.children.clear(); handingOver.stopped.clear();
    await drainHeartbeatRunsToQuiescence(db, heartbeat);
    mockAdapterExecute.mockReset();
    mockAdapterExecute.mockImplementation(async () => ({ exitCode: 0, signal: null, timedOut: false, errorMessage: null,
      summary: "Assignee turn.", provider: "test", model: "test-model" }));
    runningProcesses.clear();
  });
  afterAll(async () => { await database?.cleanup(); });

  const pidAlive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
  async function stopChild(child: ChildProcess) {
    child.kill("SIGKILL");
    await vi.waitFor(() => expect(pidAlive(child.pid!)).toBe(false), { timeout: 5_000, interval: 50 });
  }
  async function liveChild() {
    const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
    children.add(child);
    await vi.waitFor(() => expect(child.pid && pidAlive(child.pid)).toBeTruthy(), { timeout: 5_000, interval: 20 });
    return child;
  }

  async function company() {
    const companyId = randomUUID(), dev = randomUUID(), cto = randomUUID(), other = randomUUID(), issueId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Hand-over", defaultResponsibleUserId: "responsible-user",
      issuePrefix: `H${companyId.replaceAll("-", "").slice(0, 6).toUpperCase()}`, requireBoardApprovalForNewAgents: false });
    await db.insert(authUsers).values({ id: "responsible-user", name: "Fixture user", email: "responsible-user@example.test",
      createdAt: new Date(), updatedAt: new Date() }).onConflictDoNothing();
    await db.insert(companyMemberships).values({ companyId, principalType: "user", principalId: "responsible-user",
      status: "active", membershipRole: "member" });
    await db.insert(agents).values([[dev, "Dev Unity"], [cto, "CTO"], [other, "Game Tester"]].map(([id, name]) => ({ id, companyId,
      name, role: "engineer", status: "active" as const, adapterType: "codex_local",
      adapterConfig: {}, runtimeConfig: { heartbeat: { wakeOnDemand: true, maxConcurrentRuns: 1 } }, permissions: {} })));
    return { companyId, dev, cto, other, issueId };
  }
  type Ids = Awaited<ReturnType<typeof company>>;

  /** The developer's run is already cancelled by the reassignment; its process or its lease is still there. */
  async function seedStoppedOwner(owner: "process" | "lease" | "remote_workspace") {
    const ids = await company();
    const devRunId = randomUUID();
    await db.insert(issues).values({ id: ids.issueId, companyId: ids.companyId, title: "Handed to review", status: "in_review",
      priority: "medium", assigneeAgentId: ids.cto });
    const child = owner === "process" ? await liveChild() : null;
    await db.insert(heartbeatRuns).values({ id: devRunId, companyId: ids.companyId, agentId: ids.dev, runtimeMode: "legacy",
      invocationSource: "assignment", status: owner === "remote_workspace" ? "failed" : "cancelled",
      errorCode: owner === "remote_workspace" ? "workspace_restore_failed" : "issue_reassigned",
      startedAt: new Date(Date.now() - 6 * 60_000), finishedAt: new Date(Date.now() - 3_000),
      processPid: child?.pid ?? null, contextSnapshot: { issueId: ids.issueId, taskId: ids.issueId },
      runnerProfileJson: { adapterDispatch: { adapterType: "codex_local" } },
      error: "Cancelled before issue reassignment",
      resultJson: owner === "remote_workspace"
        ? { workspaceRestoreFailure: "restore_unsafe_archive",
          workspaceRestoreRecovery: { schema: "paperclip.workspace-restore-recovery.v1", leaseIds: [] } }
        : { reassignmentStopConfirmed: true } });
    const [lease] = owner === "lease"
      ? await db.insert(environmentLeases).values({ companyId: ids.companyId, issueId: ids.issueId, heartbeatRunId: devRunId,
        status: "active" }).returning()
      : [null];
    const release = async () => {
      if (child) await stopChild(child);
      if (lease) await db.update(environmentLeases).set({ releasedAt: new Date(), status: "released" })
        .where(eq(environmentLeases.id, lease.id));
    };
    return { ...ids, devRunId, child, release };
  }
  type Fixture = Ids & { devRunId: string; release: () => Promise<void> };

  // The wake the issue update route sends on a change of assignee WITHOUT a comment (routes/issues.ts, addWakeup).
  function assignmentWake(f: Fixture, agentId = f.cto) {
    return heartbeat.wakeup(agentId, {
      source: "assignment", triggerDetail: "system", reason: "issue_assigned",
      payload: { issueId: f.issueId, mutation: "update", interruptedRunId: f.devRunId },
      requestedByActorType: "agent", requestedByActorId: f.dev,
      contextSnapshot: { issueId: f.issueId, source: "issue.update", interruptedRunId: f.devRunId },
    });
  }
  const assignmentRuns = (f: Ids, agentId: string) => db.select().from(heartbeatRuns)
    .where(and(eq(heartbeatRuns.companyId, f.companyId), eq(heartbeatRuns.agentId, agentId),
      eq(heartbeatRuns.invocationSource, "assignment")));
  const wakesOf = (f: Ids, agentId: string) => db.select().from(agentWakeupRequests)
    .where(and(eq(agentWakeupRequests.companyId, f.companyId), eq(agentWakeupRequests.agentId, agentId)));
  const keptWakes = async (f: Ids, agentId: string) =>
    (await wakesOf(f, agentId)).filter(wake => wake.status === "deferred_issue_execution");
  const notes = (f: Ids) => db.select().from(issueComments).where(and(eq(issueComments.companyId, f.companyId),
    eq(issueComments.issueId, f.issueId), eq(issueComments.authorType, "system"), like(issueComments.body, `%${NOTICE_MARKER}%`)));
  const wakeRow = async (id: string) => (await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, id)))[0];
  async function startsOnce(f: Ids, agentId: string) {
    await vi.waitFor(async () => {
      expect((await assignmentRuns(f, agentId)).map(run => run.status)).toEqual(["succeeded"]);
    }, { timeout: 15_000, interval: 100 });
    const [run] = await assignmentRuns(f, agentId);
    await heartbeat.waitForRunExecutionDrain(run.id);
    return run;
  }

  async function keptWake(f: Fixture) {
    expect(await assignmentWake(f)).toBeNull();
    const kept = await keptWakes(f, f.cto);
    expect(kept).toHaveLength(1);
    expect(kept[0]).toMatchObject({ reason: "issue_assigned", source: "assignment", runId: null, finishedAt: null,
      payload: expect.objectContaining({ issueId: f.issueId, ownershipHandoverWake: true,
        executionWait: expect.objectContaining({ reason: "execution_recovery", recoveryActionId: null }) }) });
    return kept[0];
  }

  it("keeps the new assignee's wake while the reassigned run's real process is alive, then starts it when the process stops", async () => {
    // The real path: a run started by the heartbeat, with a real child process, cut by the reassignment as the issue
    // update route cuts it, then the route's wake of the new assignee.
    const ids = await company();
    await db.insert(issues).values({ id: ids.issueId, companyId: ids.companyId, title: "Handed to review", status: "todo",
      priority: "medium", assigneeAgentId: ids.dev });
    let providerProcess: ChildProcess | null = null;
    mockAdapterExecute.mockImplementation(async (context) => {
      if (context.agent.id !== ids.dev || providerProcess) return { exitCode: 0, signal: null, timedOut: false,
        errorMessage: null, summary: "Assignee turn.", provider: "test", model: "test-model" };
      providerProcess = await liveChild();
      const startedAt = await readProcessStartedAt(providerProcess.pid!).catch(() => null);
      await context.onSpawn?.({ pid: providerProcess.pid!, processGroupId: null, startedAt: startedAt ?? new Date().toISOString() });
      // The turn lasts until the run is stopped. The provider process is left alive: it is still stopping.
      await vi.waitFor(async () => {
        const [row] = await db.select({ status: heartbeatRuns.status }).from(heartbeatRuns).where(eq(heartbeatRuns.id, context.runId));
        expect(row?.status).not.toBe("running");
      }, { timeout: 30_000, interval: 50 });
      return { exitCode: null, signal: "SIGTERM", timedOut: false, errorMessage: "stopped", provider: "test", model: "test-model" };
    });
    const devRun = await heartbeat.wakeup(ids.dev, { source: "assignment", triggerDetail: "system", reason: "issue_assigned",
      payload: { issueId: ids.issueId, mutation: "create" }, requestedByActorType: "user", requestedByActorId: "responsible-user",
      contextSnapshot: { issueId: ids.issueId, source: "issue.create" } });
    expect(devRun).not.toBeNull();
    await vi.waitFor(async () => {
      const [row] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, devRun!.id));
      expect(row).toMatchObject({ status: "running", processPid: providerProcess?.pid });
    }, { timeout: 15_000, interval: 50 });

    // The developer hands the task to the CTO in review, by a change of assignee alone (routes/issues.ts).
    const cancelled = await heartbeat.cancelRun(devRun!.id, "Cancelled before issue reassignment", {
      errorCode: "issue_reassigned", resultJson: { reassignmentStopConfirmed: true, issueMutationStopId: randomUUID() },
      eventMessage: "run cancelled before issue reassignment", eventPayload: { issueId: ids.issueId } });
    expect(cancelled).toMatchObject({ status: "cancelled", errorCode: "issue_reassigned" });
    await db.update(issues).set({ assigneeAgentId: ids.cto, status: "in_review", updatedAt: new Date() })
      .where(eq(issues.id, ids.issueId));
    expect(pidAlive(providerProcess!.pid!)).toBe(true);
    expect(await getExecutionBlocker(db, ids.companyId, ids.issueId)).toMatchObject({ runId: devRun!.id,
      cause: "execution_owner_active", recoveryActionId: null,
      nextAction: "The previous provider process is still running. Stop it before continuing this task." });

    const f = { ...ids, devRunId: devRun!.id, release: async () => stopChild(providerProcess!) };
    const kept = await keptWake(f);
    // While the process is alive, a sweep starts nothing and keeps the wake.
    await heartbeat.resumeQueuedRuns();
    expect(await assignmentRuns(f, f.cto)).toHaveLength(0);
    expect(await wakeRow(kept.id)).toMatchObject({ status: "deferred_issue_execution", runId: null });
    expect(mockAdapterExecute.mock.calls.filter(([context]) => context?.agent.id === f.cto)).toHaveLength(0);

    await f.release();
    expect(await getExecutionBlocker(db, ids.companyId, ids.issueId)).toBeNull();
    await heartbeat.resumeQueuedRuns();
    const run = await startsOnce(f, f.cto);
    expect(run).toMatchObject({ agentId: f.cto, contextSnapshot: expect.objectContaining({ issueId: f.issueId, source: "issue.update" }) });
    expect(run.contextSnapshot).not.toHaveProperty("executionWait");
    expect(run.contextSnapshot).not.toHaveProperty("ownershipHandoverWake");
    // The kept copy was retired; ordinary admission wrote the run's own receipt, without the mark.
    expect(await wakeRow(kept.id)).toMatchObject({ status: "skipped", runId: null });
    const started = (await wakesOf(f, f.cto)).find(wake => wake.runId === run.id);
    expect(started?.payload).not.toHaveProperty("ownershipHandoverWake");
    // Delivered once: another sweep starts nothing.
    await heartbeat.resumeQueuedRuns();
    expect(await assignmentRuns(f, f.cto)).toHaveLength(1);
    expect(await keptWakes(f, f.cto)).toHaveLength(0);
    expect(await notes(f)).toHaveLength(0);
  }, 90_000);

  it.each(["process", "lease"] as const)("keeps and then starts the wake behind the stopped run's %s", async owner => {
    const f = await seedStoppedOwner(owner);
    const kept = await keptWake(f);
    await heartbeat.resumeQueuedRuns();
    expect(await assignmentRuns(f, f.cto)).toHaveLength(0);
    await f.release();
    await heartbeat.resumeQueuedRuns();
    await startsOnce(f, f.cto);
    expect(await wakeRow(kept.id)).toMatchObject({ status: "skipped", runId: null });
  });

  it("counts a second hand-over wake on the kept one, and starts one run", async () => {
    const f = await seedStoppedOwner("process");
    const kept = await keptWake(f);
    expect(await assignmentWake(f)).toBeNull();
    expect(await assignmentWake(f)).toBeNull();
    const rows = await keptWakes(f, f.cto);
    expect(rows.map(row => row.id)).toEqual([kept.id]);
    expect(rows[0].coalescedCount).toBe(2);
    // The worker's next check is counted from `updatedAt`: counting a wake must not push it back.
    expect(rows[0].updatedAt.getTime()).toBe(kept.updatedAt.getTime());
    expect((await wakesOf(f, f.cto)).filter(wake => wake.status === "skipped")).toHaveLength(0);
    await f.release();
    await heartbeat.resumeQueuedRuns();
    await startsOnce(f, f.cto);
    await heartbeat.resumeQueuedRuns();
    expect(await assignmentRuns(f, f.cto)).toHaveLength(1);
  });

  it("tells the thread once when the process does not stop, keeps the wake, and still starts it when it stops", async () => {
    const f = await seedStoppedOwner("process");
    const kept = await keptWake(f);
    // Nine minutes: under the limit, nothing is written.
    await db.update(agentWakeupRequests).set({ requestedAt: new Date(Date.now() - 9 * 60_000) }).where(eq(agentWakeupRequests.id, kept.id));
    await heartbeat.resumeQueuedRuns();
    expect(await notes(f)).toHaveLength(0);
    // Eleven minutes: one note, and the wake stays kept.
    await db.update(agentWakeupRequests).set({ requestedAt: new Date(Date.now() - 11 * 60_000) }).where(eq(agentWakeupRequests.id, kept.id));
    await heartbeat.resumeQueuedRuns();
    const [note] = await notes(f);
    expect(note.body).toContain("CTO has not started on this task: its wake has waited 11 minutes for the previous run of Dev Unity");
    expect(note.body).toContain(`(${f.devRunId.slice(0, 8)})`);
    expect(note.body).toContain("The previous provider process is still running. Stop it before continuing this task.");
    expect(note.body).toContain(`<!-- execution-owner-stall-notice-for:${f.devRunId} -->`);
    expect(note).toMatchObject({ authorType: "system", authorAgentId: null });
    expect(await wakeRow(kept.id)).toMatchObject({ status: "deferred_issue_execution", runId: null });
    // No loop: later sweeps write nothing more and start nothing; the note wakes nobody.
    await heartbeat.resumeQueuedRuns();
    await heartbeat.resumeQueuedRuns();
    expect(await notes(f)).toHaveLength(1);
    expect(await assignmentRuns(f, f.cto)).toHaveLength(0);
    expect(mockAdapterExecute).not.toHaveBeenCalled();
    expect((await wakesOf(f, f.cto)).filter(wake => wake.id !== kept.id)).toHaveLength(0);
    // The process finally stops: the kept wake starts the assignee.
    await f.release();
    await heartbeat.resumeQueuedRuns();
    await startsOnce(f, f.cto);
    expect(await notes(f)).toHaveLength(1);
  });

  it("retires the kept wake when the assignee already ran on the task after it was kept", async () => {
    const f = await seedStoppedOwner("lease");
    const kept = await keptWake(f);
    await f.release();
    // Another wake of the CTO gets through first (a comment, as on TR-1078): its run reads the task.
    const commentId = randomUUID();
    await db.insert(issueComments).values({ id: commentId, companyId: f.companyId, issueId: f.issueId, authorAgentId: f.dev,
      body: "Ready for review." });
    const direct = await heartbeat.wakeup(f.cto, { source: "assignment", triggerDetail: "system", reason: "issue_assigned",
      payload: { issueId: f.issueId, commentId, mutation: "update" }, requestedByActorType: "agent", requestedByActorId: f.dev,
      contextSnapshot: { issueId: f.issueId, taskId: f.issueId, commentId, wakeCommentId: commentId, source: "issue.update" } });
    expect(direct).not.toBeNull();
    await startsOnce(f, f.cto);
    await heartbeat.resumeQueuedRuns();
    await heartbeat.resumeQueuedRuns();
    expect(await assignmentRuns(f, f.cto)).toHaveLength(1);                       // no second run for the same hand-over
    expect(await wakeRow(kept.id)).toMatchObject({ status: "coalesced", runId: null,
      error: expect.stringContaining(`Served by run ${direct!.id}`) });
  });

  it("leaves a wake of an agent that is not the assignee as a skipped receipt", async () => {
    const f = await seedStoppedOwner("process");
    expect(await assignmentWake(f, f.other)).toBeNull();
    expect(await keptWakes(f, f.other)).toHaveLength(0);
    expect((await wakesOf(f, f.other)).map(wake => wake.status)).toEqual(["skipped"]);
  });

  it("does not change a hold by a remote workspace that has not confirmed its stop", async () => {
    const f = await seedStoppedOwner("remote_workspace");
    expect(await getExecutionBlocker(db, f.companyId, f.issueId)).toMatchObject({ cause: "execution_owner_active",
      recoveryActionId: null, nextAction: expect.stringContaining("retained workspace environment has not confirmed") });
    expect(await assignmentWake(f)).toBeNull();
    expect(await keptWakes(f, f.cto)).toHaveLength(0);
    expect((await wakesOf(f, f.cto)).map(wake => wake.status)).toEqual(["skipped"]);
  });

  it("does not change a hold that carries a recovery action", async () => {
    const f = await seedStoppedOwner("process");
    await f.release();
    const earlierRunId = randomUUID();
    await db.insert(heartbeatRuns).values({ id: earlierRunId, companyId: f.companyId, agentId: f.cto, runtimeMode: "legacy",
      invocationSource: "on_demand", status: "cancelled", errorCode: "cancelled",
      startedAt: new Date(Date.now() - 20 * 60_000), finishedAt: new Date(Date.now() - 19 * 60_000),
      createdAt: new Date(Date.now() - 20 * 60_000), contextSnapshot: { issueId: f.issueId, taskId: f.issueId },
      resultJson: { cancellation: { source: "operator", expected: true, reason: "Cancelled by the board" } } });
    const [action] = await db.insert(issueRecoveryActions).values({ companyId: f.companyId, sourceIssueId: f.issueId,
      kind: "active_run_watchdog", cause: "legacy_execution_requires_reconciliation",
      fingerprint: `legacy-execution:${earlierRunId}`, status: "active", ownerType: "board",
      nextAction: "Inspect the stopped work.", evidence: { runId: earlierRunId, automaticRecovery: { replay: "blocked" } } }).returning();
    expect(await getExecutionBlocker(db, f.companyId, f.issueId)).toMatchObject({ recoveryActionId: action.id });
    expect(await assignmentWake(f)).toBeNull();
    expect(await keptWakes(f, f.cto)).toHaveLength(0);
    expect((await wakesOf(f, f.cto)).map(wake => wake.status)).toEqual(["skipped"]);
  });
});
