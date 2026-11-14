import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  agentWakeupRequests, agents, authUsers, companies, companyMemberships, createDb, environmentLeases, heartbeatRuns,
  issueComments, issueRecoveryActions, issueRelations, issues, EMBEDDED_POSTGRES_TEST_TIMEOUT_MS,
} from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { drainHeartbeatRunsToQuiescence } from "./helpers/drain-heartbeat-runs.js";
import { runningProcesses, type AdapterExecutionContext, type AdapterExecutionResult } from "../adapters/index.ts";
import { heartbeatService } from "../services/heartbeat.ts";
import { getExecutionBlocker } from "../services/execution-blocker.js";

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

// STUDIO-0041: production, 14 Nov 2026, TR-702. At 04:09:25 the CTO reassigned
// the task to the Unity developer; its legacy run was cancelled with
// `issue_reassigned` while its local process was still alive. At 04:09:28 the
// developer's `issue_assigned` wake was saved as `deferred_issue_execution`
// behind `execution_owner_active` (`recoveryActionId: null`). Once the process
// had exited, the stranded-queue pass only released the task's latest run (the
// CTO's, never reconciled), so the developer's wake was never promoted.
const support = await getEmbeddedPostgresTestSupport();
(support.supported ? describe : describe.skip)("wake held behind a stopped execution owner", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  let heartbeat: ReturnType<typeof heartbeatService>;
  const children = new Set<ChildProcess>();
  beforeAll(async () => {
    database = await startEmbeddedPostgresTestDatabase("ownership-hold-readmission-");
    db = createDb(database.connectionString);
    heartbeat = heartbeatService(db, { runtimeEnv: { ...process.env, PAPERCLIP_IN_WORKTREE: "false" } });
  }, EMBEDDED_POSTGRES_TEST_TIMEOUT_MS);
  afterEach(async () => {
    for (const child of children) child.kill("SIGKILL");
    children.clear();
    await drainHeartbeatRunsToQuiescence(db, heartbeat);
    mockAdapterExecute.mockClear();
    runningProcesses.clear();
  });
  afterAll(async () => { await database?.cleanup(); });

  const pidAlive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
  async function stopChild(child: ChildProcess) {
    child.kill("SIGTERM");
    await vi.waitFor(() => expect(pidAlive(child.pid!)).toBe(false), { timeout: 5_000, interval: 50 });
  }

  type Owner = "process" | "lease";
  async function seed(owner: Owner) {
    const companyId = randomUUID(), cto = randomUUID(), dev = randomUUID(), issueId = randomUUID();
    const ctoRunId = randomUUID(), commentId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Reassigned task", defaultResponsibleUserId: "responsible-user",
      issuePrefix: `R${companyId.replaceAll("-", "").slice(0, 6).toUpperCase()}`, requireBoardApprovalForNewAgents: false });
    await db.insert(authUsers).values({ id: "responsible-user", name: "Fixture user", email: "responsible-user@example.test",
      createdAt: new Date(), updatedAt: new Date() }).onConflictDoNothing();
    await db.insert(companyMemberships).values({ companyId, principalType: "user", principalId: "responsible-user",
      status: "active", membershipRole: "member" });
    await db.insert(agents).values([cto, dev].map((id, index) => ({ id, companyId,
      name: index ? "Dev Unity" : "CTO", role: "engineer", status: "active" as const, adapterType: "codex_local",
      adapterConfig: {}, runtimeConfig: { heartbeat: { wakeOnDemand: true, maxConcurrentRuns: 1 } }, permissions: {} })));
    // The CTO already handed the task over to the developer.
    await db.insert(issues).values({ id: issueId, companyId, title: "Reassigned task", status: "todo", priority: "medium",
      assigneeAgentId: dev });
    let child: ChildProcess | null = null;
    if (owner === "process") {
      child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
      children.add(child);
      await vi.waitFor(() => expect(child!.pid && pidAlive(child!.pid)).toBeTruthy(), { timeout: 5_000, interval: 20 });
    }
    // The CTO's legacy run, cancelled by the reassignment.
    await db.insert(heartbeatRuns).values({ id: ctoRunId, companyId, agentId: cto, runtimeMode: "legacy",
      invocationSource: "assignment", status: "cancelled", errorCode: "issue_reassigned",
      startedAt: new Date(Date.now() - 6 * 60_000), finishedAt: new Date(Date.now() - 60_000),
      processPid: child?.pid ?? null, contextSnapshot: { issueId, taskId: issueId },
      runnerProfileJson: { adapterDispatch: { adapterType: "codex_local" } },
      error: "Cancelled before issue reassignment", resultJson: { reassignmentStopConfirmed: true } });
    const [lease] = owner === "lease"
      ? await db.insert(environmentLeases).values({ companyId, issueId, heartbeatRunId: ctoRunId, status: "active" }).returning()
      : [null];
    // Its reconciliation action was cancelled by the reassignment.
    await db.insert(issueRecoveryActions).values({ companyId, sourceIssueId: issueId, kind: "active_run_watchdog",
      cause: "legacy_execution_requires_reconciliation", fingerprint: `legacy-execution:${ctoRunId}`,
      status: "cancelled", ownerType: "board", nextAction: "Inspect the stopped work.", evidence: { runId: ctoRunId } });
    await db.insert(issueComments).values({ id: commentId, companyId, issueId, authorAgentId: cto,
      body: "Handing this to the Unity developer." });
    expect(await getExecutionBlocker(db, companyId, issueId))
      .toMatchObject({ runId: ctoRunId, cause: "execution_owner_active", recoveryActionId: null });
    const release = async () => {
      if (child) await stopChild(child);
      if (lease) await db.update(environmentLeases).set({ releasedAt: new Date(), status: "released" })
        .where(eq(environmentLeases.id, lease.id));
      expect(await getExecutionBlocker(db, companyId, issueId)).toBeNull();
    };
    return { companyId, cto, dev, issueId, ctoRunId, commentId, release };
  }
  type Fixture = Awaited<ReturnType<typeof seed>>;

  // Same wake as the issue update route on a reassignment with a comment.
  function assignmentWake(f: Fixture, idempotencyKey?: string) {
    return heartbeat.wakeup(f.dev, {
      source: "assignment", triggerDetail: "system", reason: "issue_assigned", ...(idempotencyKey ? { idempotencyKey } : {}),
      payload: { issueId: f.issueId, commentId: f.commentId, mutation: "update", interruptedRunId: f.ctoRunId },
      requestedByActorType: "agent", requestedByActorId: f.cto,
      contextSnapshot: { issueId: f.issueId, taskId: f.issueId, commentId: f.commentId, wakeCommentId: f.commentId,
        source: "issue.update", interruptedRunId: f.ctoRunId },
    });
  }

  // Assignment runs only: the mocked turn leaves the task without a
  // disposition, which later starts an unrelated disposition repair run.
  const runsOf = (f: Fixture, agentId: string) => db.select().from(heartbeatRuns)
    .where(and(eq(heartbeatRuns.companyId, f.companyId), eq(heartbeatRuns.agentId, agentId),
      eq(heartbeatRuns.invocationSource, "assignment")));
  const wakesOf = (f: Fixture, agentId: string) => db.select().from(agentWakeupRequests)
    .where(and(eq(agentWakeupRequests.companyId, f.companyId), eq(agentWakeupRequests.agentId, agentId)));
  const parseObjectWait = (row: { payload?: unknown } | undefined) =>
    ((row?.payload as { executionWait?: { reason?: string } } | undefined)?.executionWait?.reason ?? null);
  const executionsOf = (agentId: string) => mockAdapterExecute.mock.calls.filter(([context]) => context?.agent.id === agentId);

  async function heldWake(f: Fixture, idempotencyKey?: string) {
    expect(await assignmentWake(f, idempotencyKey)).toBeNull();
    const held = (await wakesOf(f, f.dev)).filter(wake => wake.status === "deferred_issue_execution");
    expect(held).toHaveLength(1);
    expect(held[0]).toMatchObject({ reason: "issue_assigned", runId: null,
      payload: expect.objectContaining({ executionWait: expect.objectContaining({ reason: "execution_recovery", recoveryActionId: null }) }) });
    return held[0];
  }

  it.each<Owner>(["process", "lease"])("starts the new assignee once the previous owner's %s is gone", async owner => {
    const f = await seed(owner);
    const held = await heldWake(f);
    // While the owner still holds the task, the sweep keeps the wake.
    await heartbeat.resumeQueuedRuns();
    expect(await runsOf(f, f.dev)).toHaveLength(0);
    expect((await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, held.id)))[0])
      .toMatchObject({ status: "deferred_issue_execution", runId: null });

    await f.release();
    await heartbeat.resumeQueuedRuns();
    await vi.waitFor(async () => {
      expect((await runsOf(f, f.dev)).map(run => run.status)).toEqual(["succeeded"]);
    }, { timeout: 15_000, interval: 100 });
    const [run] = await runsOf(f, f.dev);
    await heartbeat.waitForRunExecutionDrain(run.id);
    expect(run).toMatchObject({ agentId: f.dev,
      contextSnapshot: expect.objectContaining({ issueId: f.issueId, wakeCommentId: f.commentId }) });
    expect(run.contextSnapshot).not.toHaveProperty("executionWait");
    // The held copy was retired; ordinary admission wrote the run's own receipt.
    expect((await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, held.id)))[0])
      .toMatchObject({ status: "skipped", runId: null });
    expect(executionsOf(f.cto)).toHaveLength(0);
    // Delivered once: another sweep starts nothing.
    await heartbeat.resumeQueuedRuns();
    expect(await runsOf(f, f.dev)).toHaveLength(1);
    expect((await wakesOf(f, f.dev)).filter(wake => wake.status === "deferred_issue_execution")).toHaveLength(0);
  });

  // A held wake can carry a key covered by a partial unique index on
  // (companyId, idempotencyKey). The held copy is retired as `skipped`, outside
  // every such index that has a status condition (`interaction:` excludes
  // skipped, failed and cancelled; `tree-hold-resume:` and
  // `issue_review_path_lost:` exclude skipped only), so the new admission can
  // reuse the key instead of failing on every sweep.
  it.each(["interaction", "tree-hold-resume", "issue_review_path_lost"])(
    "re-admits a held wake whose idempotency key is unique (%s:)", async (prefix) => {
    const f = await seed("lease");
    const key = `${prefix}:${randomUUID()}`;
    const held = await heldWake(f, key);
    expect(held.idempotencyKey).toBe(key);
    await f.release();
    await heartbeat.resumeQueuedRuns();
    await vi.waitFor(async () => {
      expect((await runsOf(f, f.dev)).map(run => run.status)).toEqual(["succeeded"]);
    }, { timeout: 15_000, interval: 100 });
    const [run] = await runsOf(f, f.dev);
    await heartbeat.waitForRunExecutionDrain(run.id);
    // The held copy is skipped and the new admission reused the same key.
    const rows = (await wakesOf(f, f.dev)).filter(wake => wake.idempotencyKey === key);
    expect(rows.find(row => row.id === held.id)).toMatchObject({ status: "skipped" });
    expect(rows.filter(row => row.id !== held.id)).toHaveLength(1);
  });

  // `task-retry:` and `chat-completion:` are unique whatever the status: a
  // second row can never be inserted, so this sweep leaves them alone.
  it.each(["task-retry", "chat-completion"])("leaves a held wake keyed %s: to its own path", async (prefix) => {
    const f = await seed("lease");
    const held = await heldWake(f, `${prefix}:${randomUUID()}`);
    await f.release();
    await heartbeat.resumeQueuedRuns();
    expect(await runsOf(f, f.dev)).toHaveLength(0);
    expect((await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, held.id)))[0])
      .toMatchObject({ status: "deferred_issue_execution", runId: null });
  });

  it("keeps the wake held while the task carries an active recovery action", async () => {
    const f = await seed("process");
    const held = await heldWake(f);
    // An earlier stopped run of the task whose outcome is still unreconciled.
    const earlierRunId = randomUUID();
    await db.insert(heartbeatRuns).values({ id: earlierRunId, companyId: f.companyId, agentId: f.dev, runtimeMode: "legacy",
      invocationSource: "on_demand", status: "cancelled", errorCode: "cancelled",
      startedAt: new Date(Date.now() - 20 * 60_000), finishedAt: new Date(Date.now() - 19 * 60_000),
      createdAt: new Date(Date.now() - 20 * 60_000), contextSnapshot: { issueId: f.issueId, taskId: f.issueId },
      resultJson: { cancellation: { source: "operator", expected: true, reason: "Cancelled by the board" } } });
    const [action] = await db.insert(issueRecoveryActions).values({ companyId: f.companyId, sourceIssueId: f.issueId,
      kind: "active_run_watchdog", cause: "legacy_execution_requires_reconciliation",
      fingerprint: `legacy-execution:${earlierRunId}`, status: "active", ownerType: "board",
      nextAction: "Inspect the stopped work.", evidence: { runId: earlierRunId, automaticRecovery: { replay: "blocked" } } }).returning();
    const [child] = [...children];
    await stopChild(child!);
    expect(await getExecutionBlocker(db, f.companyId, f.issueId)).toMatchObject({ recoveryActionId: action.id });
    await heartbeat.resumeQueuedRuns();
    await heartbeat.resumeQueuedRuns();
    expect(await runsOf(f, f.dev)).toHaveLength(0);
    expect(executionsOf(f.dev)).toHaveLength(0);
    expect((await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, held.id)))[0])
      .toMatchObject({ status: "deferred_issue_execution", runId: null });
  });

  it("does not start the assignee while the task's dependencies are unresolved", async () => {
    const f = await seed("lease");
    const [blocker] = await db.insert(issues).values({ companyId: f.companyId, title: "Blocker", status: "todo",
      priority: "medium" }).returning();
    await db.insert(issueRelations).values({ companyId: f.companyId, issueId: blocker.id, relatedIssueId: f.issueId, type: "blocks" });
    const held = await heldWake(f);
    await f.release();
    await heartbeat.resumeQueuedRuns();
    await heartbeat.resumeQueuedRuns();
    expect(await runsOf(f, f.dev)).toHaveLength(0);
    expect(executionsOf(f.dev)).toHaveLength(0);
    // Ordinary admission refused it on the dependency gate and recorded why,
    // in its own receipt; the held copy was retired.
    const wakes = await wakesOf(f, f.dev);
    expect(wakes.find(wake => wake.id === held.id)).toMatchObject({ status: "skipped", runId: null });
    expect(wakes.some(wake => wake.id !== held.id && ["skipped", "deferred_issue_execution"].includes(wake.status))).toBe(true);
  });

  it("leaves a wake held for another reason untouched", async () => {
    const f = await seed("lease");
    await f.release();
    const [other] = await db.insert(agentWakeupRequests).values({ companyId: f.companyId, agentId: f.dev,
      source: "assignment", triggerDetail: "system", reason: "issue_assigned", status: "deferred_issue_execution",
      requestedByActorType: "agent", requestedByActorId: f.cto,
      payload: { issueId: f.issueId, mutation: "update",
        executionWait: { reason: "decision_pending", recoveryActionId: null, message: "A pending approval must be resolved." },
        _paperclipWakeContext: { issueId: f.issueId, source: "issue.update" } } }).returning();
    await heartbeat.resumeQueuedRuns();
    expect(await runsOf(f, f.dev)).toHaveLength(0);
    expect((await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, other.id)))[0])
      .toMatchObject({ status: "deferred_issue_execution", runId: null });
  });
});
