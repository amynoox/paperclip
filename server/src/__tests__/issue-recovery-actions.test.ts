import { resolveExternalTestDatabaseUrl } from "./helpers/external-test-database.js";
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import express from "express";
import request from "supertest";
import { and, eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { renderPaperclipWakePrompt } from "@paperclipai/adapter-utils/server-utils";
import {
  costEvents,
  agents,
  agentRuntimeState,
  authUsers,
  agentTaskSessions,
  agentWakeupRequests,
  activityLog,
  caseHandoffs,
  cases,
  companies,
  createDb,
  documentRevisions,
  documents,
  environmentLeases,
  environments,
  heartbeatRuns,
  issueComments,
  issueInboxArchives,
  issueRecoveryActions,
  issueRelations,
  issueThreadInteractions,
  workspaceOperations,
  issues,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { errorHandler } from "../middleware/index.js";
import { issueRoutes } from "../routes/issues.js";
import { buildPaperclipWakePayload, heartbeatService } from "../services/heartbeat.js";
import { deliverReconciledExecutions, markExecutionReconciliation, nextAwaitingReconciliationCheckAt, resumeWithdrawnAwaitingReconciliations } from "../services/execution-recovery-resolution.js";
import { workspaceOperationService, isNativeWorkspaceFinalizationOperationActive } from "../services/workspace-operations.js";
import { issueRecoveryActionService } from "../services/issue-recovery-actions.js";
import { recoveryService } from "../services/recovery/service.js";
import { issueService } from "../services/issues.js";
import { executionProjectionForRun } from "../services/execution-projection.js";
import { caseHandoffService } from "../services/case-handoffs.js";
import { instanceSettingsService } from "../services/instance-settings.js";
import { withNativeWorkspaceFinalizationOwnership } from "../services/native-runtime/native-workspace-finalization-ownership.js";
import { noticeMetadataReferencesRecoveryAction } from "../services/recovery/successful-run-handoff.js";
import { EXECUTION_HOLD_CONFIRMATIONS_AT_ONCE, listExecutionHolds } from "../services/execution-hold.js";

const external = resolveExternalTestDatabaseUrl("PAPERCLIP_RECOVERY_ACTION_TEST_DATABASE_URL");
const embeddedPostgresSupport = external ? { supported: true, reason: undefined } : await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

function makeRecoveryActionRow(overrides: Record<string, unknown> = {}) {
  const now = new Date("2026-05-09T19:30:00.000Z");
  return {
    id: randomUUID(),
    companyId: "company-1",
    sourceIssueId: "source-1",
    recoveryIssueId: null,
    kind: "missing_disposition",
    status: "active",
    ownerType: "agent",
    ownerAgentId: "agent-1",
    ownerUserId: null,
    previousOwnerAgentId: null,
    returnOwnerAgentId: null,
    cause: "successful_run_missing_issue_disposition",
    fingerprint: "missing-disposition:fingerprint",
    evidence: {},
    nextAction: "Choose a valid issue disposition.",
    wakePolicy: null,
    monitorPolicy: null,
    attemptCount: 1,
    maxAttempts: null,
    timeoutAt: null,
    lastAttemptAt: now,
    outcome: null,
    resolutionNote: null,
    resolvedAt: null,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

// Stranded-run fixtures began before anything the test later records.
const LATEST_RUN_TIMES = { startedAt: new Date(), createdAt: new Date() };

describe("issueRecoveryActionService", () => {
  it.each(["unrelated unique constraint", "other SQLSTATE", "cyclic cause"])("does not retry %s errors", async kind => {
    const constraint = "issue_recovery_actions_active_source_uq";
    const error: Error & { cause?: unknown } = new Error("Wrapped database failure");
    error.cause = kind === "unrelated unique constraint" ? { code: "23505", constraint_name: "other_unique_constraint" }
      : kind === "other SQLSTATE" ? { code: "23503", constraint_name: constraint } : error;
    const query = { from() { return this; }, where() { return this; }, orderBy() { return this; },
      limit() { return Promise.resolve([]); } };
    const fakeDb = {
      async transaction<T>(fn: (tx: unknown) => Promise<T>): Promise<T> { return fn(fakeDb); },
      execute: vi.fn(async () => [{ pendingPreparationContinuation: false }]),
      select: vi.fn(() => query),
      insert: vi.fn(() => ({ values: () => ({ returning: async () => { throw error; } }) })),
    };
    await expect(issueRecoveryActionService(fakeDb as never).upsertSourceScoped({ companyId: "company", sourceIssueId: "issue",
      kind: "missing_disposition", cause: "saved-debt", fingerprint: "same-source", nextAction: "Restore existing work." }))
      .rejects.toBe(error);
    expect(fakeDb.select).toHaveBeenCalledOnce();
    expect(fakeDb.insert).toHaveBeenCalledOnce();
  });
  it("does not reactivate an action resolved between the active read and update", async () => {
    const existingRow = makeRecoveryActionRow({ id: "existing-action", attemptCount: 1 });
    const createdRow = makeRecoveryActionRow({ id: "new-action", attemptCount: 1 });
    const selectResults = [[existingRow], []];

    const makeSelectQuery = (rows: unknown[]) => ({
      from() {
        return this;
      },
      where() {
        return this;
      },
      orderBy() {
        return this;
      },
      limit() {
        return Promise.resolve(rows);
      },
    });

    const fakeDb = {
      async transaction<T>(fn: (tx: unknown) => Promise<T>): Promise<T> { return fn(fakeDb); },
      execute: vi.fn(async () => [{ pendingPreparationContinuation: false }]),
      select: vi.fn(() => makeSelectQuery(selectResults.shift() ?? [])),
      update: vi.fn(() => ({
        set: vi.fn(() => ({
          where: vi.fn(() => ({
            returning: vi.fn(async () => []),
          })),
        })),
      })),
      insert: vi.fn(() => ({
        values: vi.fn(() => ({
          returning: vi.fn(async () => [createdRow]),
        })),
      })),
    };

    const result = await issueRecoveryActionService(fakeDb as never).upsertSourceScoped({
      companyId: "company-1",
      sourceIssueId: "source-1",
      kind: "missing_disposition",
      ownerType: "agent",
      ownerAgentId: "agent-1",
      cause: "successful_run_missing_issue_disposition",
      fingerprint: "missing-disposition:fingerprint",
      nextAction: "Choose a valid issue disposition.",
    });

    expect(result).toMatchObject({ id: "new-action", status: "active" });
    expect(fakeDb.update).toHaveBeenCalledTimes(1);
    expect(fakeDb.insert).toHaveBeenCalledTimes(1);
  });
});

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres issue recovery action tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("issue recovery actions", () => {
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let db: ReturnType<typeof createDb>;
  let operationLogRoot: string;
  const priorOperationLogRoot = process.env.WORKSPACE_OPERATION_LOG_BASE_PATH;

  beforeAll(async () => {
    operationLogRoot = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-recovery-operation-logs-"));
    process.env.WORKSPACE_OPERATION_LOG_BASE_PATH = operationLogRoot;
    if (!external) tempDb = await startEmbeddedPostgresTestDatabase("paperclip-issue-recovery-actions-");
    db = createDb(external ?? tempDb!.connectionString);
  }, 30_000);

  afterEach(async () => {
    await db.delete(caseHandoffs);
    await db.delete(cases);
    await db.delete(documentRevisions);
    await db.delete(documents);
    await db.delete(workspaceOperations);
    await db.delete(issueThreadInteractions);
    await db.delete(issueRecoveryActions);
    await db.delete(issueComments);
    await db.delete(environmentLeases);
    await db.delete(activityLog);
    await db.delete(costEvents);
    await db.delete(agentTaskSessions);
    await db.delete(heartbeatRuns);
    await db.delete(agentWakeupRequests);
    await db.delete(environments);
    await db.delete(issueInboxArchives);
    await db.delete(issues);
    await db.delete(agentRuntimeState);
    await db.delete(agents);
    await db.delete(companies);
    await db.delete(authUsers);
  });

  afterAll(async () => {
    await db?.$client.end({ timeout: 1 });
    await tempDb?.cleanup();
    if (priorOperationLogRoot === undefined) delete process.env.WORKSPACE_OPERATION_LOG_BASE_PATH;
    else process.env.WORKSPACE_OPERATION_LOG_BASE_PATH = priorOperationLogRoot;
    await fs.rm(operationLogRoot, { recursive: true, force: true });
  });

  async function seedCompany() {
    const companyId = randomUUID();
    const managerId = randomUUID();
    const coderId = randomUUID();
    const sourceIssueId = randomUUID();
    const prefix = `RA${companyId.replaceAll("-", "").slice(0, 6).toUpperCase()}`;
    await db.insert(companies).values({
      id: companyId,
      name: "Recovery Co",
      issuePrefix: prefix,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values([
      {
        id: managerId,
        companyId,
        name: "CTO",
        role: "cto",
        status: "idle",
        adapterType: "codex_local",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      },
      {
        id: coderId,
        companyId,
        name: "Coder",
        role: "engineer",
        status: "idle",
        reportsTo: managerId,
        adapterType: "codex_local",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      },
    ]);
    await db.insert(issues).values({
      id: sourceIssueId,
      companyId,
      title: "Implement backend recovery",
      status: "in_progress",
      priority: "medium",
      assigneeAgentId: coderId,
      issueNumber: 1,
      identifier: `${prefix}-1`,
    });
    const [sourceIssue] = await db.select().from(issues).where(eq(issues.id, sourceIssueId));
    return { companyId, managerId, coderId, sourceIssueId, prefix, sourceIssue: sourceIssue! };
  }

  async function seedHeartbeatRun(input: {
    companyId: string;
    agentId: string;
    runId: string;
    issueId?: string;
    status?: string;
  }) {
    await db.insert(heartbeatRuns).values({
      id: input.runId,
      companyId: input.companyId,
      agentId: input.agentId,
      invocationSource: "manual",
      status: input.status ?? "running",
      startedAt: new Date("2026-05-13T18:00:00.000Z"),
      contextSnapshot: input.issueId ? { issueId: input.issueId } : undefined,
    });
  }

  function createApp(
    actor: any = { type: "board", source: "local_implicit" },
    opts: Parameters<typeof issueRoutes>[2] = {},
  ) {
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      (req as any).actor = actor;
      next();
    });
    app.use("/api", issueRoutes(db, {} as any, opts));
    app.use(errorHandler);
    return app;
  }

  async function seedNativeFinalizationRecovery(status: string) {
    const fixture = await seedCompany();
    const runId = randomUUID();
    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId: fixture.companyId,
      agentId: fixture.coderId,
      status,
      runtimeMode: "native",
      nativeIssueId: fixture.sourceIssueId,
      nativePhase: "finalizing",
      // Native coordinator retries resume this original run, without creating
      // the legacy scheduled_retry_reason projection.
      scheduledRetryReason: null,
      contextSnapshot: { issueId: fixture.sourceIssueId },
    });
    const svc = issueRecoveryActionService(db);
    await svc.upsertSourceScoped({
      companyId: fixture.companyId,
      sourceIssueId: fixture.sourceIssueId,
      kind: "active_run_watchdog",
      ownerType: "agent",
      ownerAgentId: fixture.coderId,
      cause: "native_finalization_invalid",
      fingerprint: `native:${runId}`,
      nextAction: "Finish the existing run.",
      wakePolicy: { kind: "resume_native_run", runId, notBefore: "2020-01-01T00:00:00Z" },
      maxAttempts: 3,
    });
    return { ...fixture, runId, svc };
  }

  it.each(["queued", "running"])("projects the exact %s native run without a legacy scheduled retry", async (status) => {
    const { companyId, sourceIssueId, runId, svc } = await seedNativeFinalizationRecovery(status);
    const expected = { runId, status, workspaceOperationId: null };
    expect((await svc.getActiveForIssue(companyId, sourceIssueId))?.nativeRunActivity).toEqual(expected);
    expect((await svc.listActiveForIssues(companyId, [sourceIssueId])).get(sourceIssueId)?.nativeRunActivity).toEqual(expected);
    const response = await request(createApp()).get(`/api/issues/${sourceIssueId}`).expect(200);
    expect(response.body.scheduledRetry).toBeNull();
    expect(response.body.activeRecoveryAction.nativeRunActivity).toEqual(expected);
  });

  it("projects an actual long-running export while its original heartbeat remains failed, then clears it", async () => {
    const { companyId, sourceIssueId, runId, svc } = await seedNativeFinalizationRecovery("failed");
    let release!: () => void;
    let started!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    const entered = new Promise<void>((resolve) => { started = resolve; });
    const work = workspaceOperationService(db).createRecorder({ companyId, issueId: sourceIssueId, heartbeatRunId: runId }).recordOperation({
      phase: "workspace_finalize", metadata: { owningService: "native_workspace_finalizer" },
      run: async () => { started(); await held; return { status: "succeeded" }; },
    });
    await entered;
    let operationId: string;
    try {
      const [operation] = await db.select().from(workspaceOperations).where(eq(workspaceOperations.heartbeatRunId, runId));
      operationId = operation!.id;
      // A slow callback remains live independently of elapsed wall-clock time.
      await db.update(workspaceOperations).set({ startedAt: new Date("2000-01-01T00:00:00Z") }).where(eq(workspaceOperations.id, operationId));
      const scope = { companyId, issueId: sourceIssueId, runId, operationId };
      expect(isNativeWorkspaceFinalizationOperationActive(scope)).toBe(true);
      expect(isNativeWorkspaceFinalizationOperationActive({ ...scope, companyId: randomUUID() })).toBe(false);
      expect((await svc.getActiveForIssue(companyId, sourceIssueId))?.nativeRunActivity).toEqual({
        runId, status: "running", workspaceOperationId: operationId,
      });
    } finally { release(); await work; }
    expect((await svc.getActiveForIssue(companyId, sourceIssueId))?.nativeRunActivity).toBeNull();
    // Even a stranded DB row cannot turn a joined callback back into activity.
    await db.update(workspaceOperations).set({ status: "running", finishedAt: null }).where(eq(workspaceOperations.id, operationId!));
    expect((await svc.getActiveForIssue(companyId, sourceIssueId))?.nativeRunActivity).toBeNull();
  });

  it("keeps the activity claim until a timed-out export callback actually joins", async () => {
    const { companyId, sourceIssueId, runId } = await seedNativeFinalizationRecovery("failed");
    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    const work = workspaceOperationService(db).createRecorder({ companyId, issueId: sourceIssueId, heartbeatRunId: runId }).recordOperation({
      phase: "workspace_finalize", metadata: { owningService: "native_workspace_finalizer" }, timeoutMs: 10,
      run: async () => { await held; return { status: "succeeded" }; },
    });
    try {
      await expect(work).rejects.toThrow("exceeded");
      const [operation] = await db.select().from(workspaceOperations).where(eq(workspaceOperations.heartbeatRunId, runId));
      const scope = { companyId, issueId: sourceIssueId, runId, operationId: operation!.id };
      expect(isNativeWorkspaceFinalizationOperationActive(scope)).toBe(true);
      release();
      await held;
      await new Promise((resolve) => setImmediate(resolve));
      expect(isNativeWorkspaceFinalizationOperationActive(scope)).toBe(false);
    } finally { release(); }
  });

  it("does not treat an orphaned running export record as live after controller loss", async () => {
    const { companyId, sourceIssueId, runId, svc } = await seedNativeFinalizationRecovery("failed");
    await db.insert(workspaceOperations).values({
      companyId, issueId: sourceIssueId, heartbeatRunId: runId,
      phase: "workspace_finalize", status: "running",
      metadata: { owningService: "native_workspace_finalizer" },
    });
    expect((await svc.getActiveForIssue(companyId, sourceIssueId))?.nativeRunActivity).toBeNull();
  });

  it.each(["company", "issue", "legacy", "finished"])("rejects an apparently live run with the wrong %s authority", async (mismatch) => {
    const { companyId, sourceIssueId, runId, svc } = await seedNativeFinalizationRecovery("running");
    const other = await seedCompany();
    // Exercise service rejection of historical corruption behind the immutable binding trigger.
    await db.transaction(async (tx) => {
      await tx.execute(sql`set local session_replication_role = replica`);
      await tx.update(heartbeatRuns).set({
      ...(mismatch === "company" ? { companyId: other.companyId, agentId: other.coderId } : {}),
      ...(mismatch === "issue" ? { nativeIssueId: other.sourceIssueId } : {}),
      ...(mismatch === "legacy" ? { runtimeMode: "legacy" } : {}),
      ...(mismatch === "finished" ? { finishedAt: new Date() } : {}),
    }).where(eq(heartbeatRuns.id, runId));
    });
    expect((await svc.getActiveForIssue(companyId, sourceIssueId))?.nativeRunActivity).toBeNull();
  });

  it.each(["company", "issue", "run", "phase", "owner", "finished"])(
    "does not borrow native finalization activity with a different %s binding", async (mismatch) => {
      const { companyId, sourceIssueId, runId, svc } = await seedNativeFinalizationRecovery("failed");
      const other = await seedNativeFinalizationRecovery("running");
      await db.insert(workspaceOperations).values({
        companyId: mismatch === "company" ? other.companyId : companyId,
        issueId: mismatch === "issue" ? other.sourceIssueId : sourceIssueId,
        heartbeatRunId: mismatch === "run" ? other.runId : runId,
        phase: mismatch === "phase" ? "workspace_prepare" : "workspace_finalize",
        status: "running", finishedAt: mismatch === "finished" ? new Date() : null,
        metadata: { owningService: mismatch === "owner" ? "different_service" : "native_workspace_finalizer" },
      });
      expect((await svc.getActiveForIssue(companyId, sourceIssueId))?.nativeRunActivity).toBeNull();
      expect((await svc.listActiveForIssues(companyId, [sourceIssueId, other.sourceIssueId])).get(sourceIssueId)?.nativeRunActivity).toBeNull();
    },
  );

  it("converges two service instances after their real inserts compete for one active source", async () => {
    const { companyId, managerId, sourceIssueId } = await seedCompany();
    const input = { companyId, sourceIssueId, kind: "stranded_assigned_issue" as const, ownerType: "agent" as const,
      ownerAgentId: managerId, cause: "stranded_assigned_issue", fingerprint: "concurrent-source",
      evidence: { sourceRunId: "concurrent-source-run" }, lastAttemptAt: new Date("2026-11-03T12:00:00Z"),
      nextAction: "Restore the existing execution path." };
    let release!: () => void, acquired!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const locked = new Promise<void>(resolve => { acquired = resolve; });
    const lock = db.transaction(async tx => {
      await tx.execute(sql`lock table issue_recovery_actions in share mode`);
      acquired(); await gate;
    });
    await locked;
    const outcomes = Promise.allSettled([issueRecoveryActionService(db).upsertSourceScoped(input),
      issueRecoveryActionService(db).upsertSourceScoped(input)]);
    try {
      await vi.waitFor(async () => {
        const [waiting] = await db.execute<{ count: number }>(sql`select count(*)::int as count from pg_stat_activity
          where datname = current_database() and state = 'active' and wait_event_type = 'Lock'
            and query like 'insert into "issue_recovery_actions"%'`);
        expect(waiting.count).toBe(2);
      }, { timeout: 5000, interval: 20 });
    } finally { release(); await lock; await outcomes; }
    const results = await outcomes;
    const active = await db.select().from(issueRecoveryActions).where(and(eq(issueRecoveryActions.companyId, companyId),
      eq(issueRecoveryActions.sourceIssueId, sourceIssueId), sql`${issueRecoveryActions.status} in ('active', 'escalated')`));
    expect(active).toHaveLength(1);
    expect(results.flatMap(result => result.status === "rejected" ? [{
      name: result.reason?.constructor?.name, code: result.reason?.code,
      causeName: result.reason?.cause?.constructor?.name, causeCode: result.reason?.cause?.code,
      causeConstraint: result.reason?.cause?.constraint_name,
    }] : [])).toEqual([]);
    expect(results.map(result => result.status === "fulfilled" ? result.value.id : null)).toEqual([active[0]!.id, active[0]!.id]);
    // The lost insert uses the existing upsert merge, just like a second sequential call.
    expect(active[0]).toMatchObject({
      status: "active", attemptCount: 2, maxAttempts: null, timeoutAt: null,
      ownerType: "agent", ownerAgentId: managerId, ownerUserId: null,
      evidence: input.evidence, lastAttemptAt: input.lastAttemptAt,
      nextAction: input.nextAction, wakePolicy: null, monitorPolicy: null,
    });
  });

  it("upserts one active source-scoped action per issue and keeps company scoping explicit", async () => {
    const { companyId, managerId, sourceIssueId } = await seedCompany();
    const svc = issueRecoveryActionService(db);

    const first = await svc.upsertSourceScoped({
      companyId,
      sourceIssueId,
      kind: "stranded_assigned_issue",
      ownerType: "agent",
      ownerAgentId: managerId,
      cause: "stranded_assigned_issue",
      fingerprint: "recovery:fingerprint",
      evidence: { latestRunId: "run-1" },
      nextAction: "Restore a live execution path.",
      wakePolicy: { type: "wake_owner" },
    });
    const second = await svc.upsertSourceScoped({
      companyId,
      sourceIssueId,
      kind: "stranded_assigned_issue",
      ownerType: "agent",
      ownerAgentId: managerId,
      cause: "stranded_assigned_issue",
      fingerprint: "recovery:fingerprint",
      evidence: { latestRunId: "run-2" },
      nextAction: "Restore a live execution path.",
      wakePolicy: { type: "wake_owner" },
    });

    expect(second.id).toBe(first.id);
    expect(second.attemptCount).toBe(2);
    expect(second.evidence).toMatchObject({ latestRunId: "run-2" });
    expect(await svc.getActiveForIssue(companyId, sourceIssueId)).toMatchObject({ id: first.id });
    expect(await svc.getActiveForIssue(randomUUID(), sourceIssueId)).toBeNull();
  });

  it("enforces maxAttempts once and removes every automatic recovery path", async () => {
    const { companyId, managerId, sourceIssueId } = await seedCompany();
    const svc = issueRecoveryActionService(db);
    const base = {
      companyId,
      sourceIssueId,
      kind: "active_run_watchdog" as const,
      ownerType: "agent" as const,
      ownerAgentId: managerId,
      returnOwnerAgentId: managerId,
      cause: "process_lost",
      fingerprint: "run-process-lost",
      nextAction: "Resume the same run.",
      wakePolicy: { kind: "resume_native_run", runId: "run-1" },
      monitorPolicy: { kind: "watch_run", runId: "run-1" },
      maxAttempts: 3,
    };

    const first = await svc.upsertSourceScoped(base);
    const second = await svc.upsertSourceScoped(base);
    const exhausted = await svc.upsertSourceScoped(base);
    const replay = await svc.upsertSourceScoped(base);

    expect(first.attemptCount).toBe(1);
    expect(second.attemptCount).toBe(2);
    expect(exhausted).toMatchObject({
      id: first.id,
      status: "escalated",
      ownerType: "board",
      ownerAgentId: null,
      returnOwnerAgentId: managerId,
      attemptCount: 3,
      maxAttempts: 3,
      wakePolicy: null,
      monitorPolicy: null,
      outcome: "escalated",
      evidence: {
        recoveryBudget: {
          state: "exhausted",
          attemptsUsed: 3,
          maxAttempts: 3,
        },
      },
    });
    expect(replay).toEqual(exhausted);
  });

  it("preserves legacy recovery ownership when new evidence is folded into an active action", async () => {
    const { companyId, managerId, coderId, sourceIssueId } = await seedCompany();
    const svc = issueRecoveryActionService(db);
    const legacy = await svc.upsertSourceScoped({
      companyId,
      sourceIssueId,
      kind: "stranded_assigned_issue",
      ownerType: "agent",
      ownerAgentId: managerId,
      previousOwnerAgentId: coderId,
      returnOwnerAgentId: coderId,
      cause: "process_lost",
      fingerprint: "legacy-recovery",
      evidence: { latestRunId: "run-1" },
      nextAction: "Repair the execution path.",
      wakePolicy: { type: "bounded_recovery_owner", ownerAgentId: managerId, attempt: 1, maxAttempts: 5 },
      attemptCount: 1,
      maxAttempts: 5,
    });

    const updated = await svc.upsertSourceScoped({
      companyId,
      sourceIssueId,
      kind: "stranded_assigned_issue",
      ownerType: "board",
      ownerAgentId: null,
      previousOwnerAgentId: coderId,
      returnOwnerAgentId: coderId,
      cause: "process_lost",
      fingerprint: "legacy-recovery",
      evidence: { latestRunId: "run-2" },
      evidenceOnCreate: { routingPolicy: "board_escalation_no_takeover_v1" },
      nextAction: "Board decision required.",
      wakePolicy: { type: "board_escalation" },
      preserveExistingOwner: true,
    });

    expect(updated).toMatchObject({
      id: legacy.id,
      ownerType: "agent",
      ownerAgentId: managerId,
      previousOwnerAgentId: coderId,
      returnOwnerAgentId: coderId,
      attemptCount: 2,
      maxAttempts: 5,
      nextAction: "Repair the execution path.",
      evidence: expect.objectContaining({ latestRunId: "run-2" }),
      wakePolicy: expect.objectContaining({ type: "bounded_recovery_owner" }),
    });
    expect(updated.evidence).not.toHaveProperty("routingPolicy");
  });

  it("escalates stranded assigned work into a source action instead of a recovery issue", async () => {
    const { companyId, coderId, sourceIssue } = await seedCompany();
    const enqueueWakeup = vi.fn(async () => null);
    const recovery = recoveryService(db, { enqueueWakeup });
    const latestRun = {
      id: randomUUID(),
      agentId: coderId,
      status: "failed",
      error: "adapter failed",
      errorCode: "adapter_failed",
      contextSnapshot: { retryReason: "issue_continuation_needed" },
      livenessState: "needs_followup",
      ...LATEST_RUN_TIMES,
    } as const;

    const results = await Promise.all([
      recovery.escalateStrandedAssignedIssue({
        issue: sourceIssue,
        previousStatus: "in_progress",
        latestRun,
        comment: "Automatic continuation recovery failed.",
      }),
      recovery.escalateStrandedAssignedIssue({
        issue: sourceIssue,
        previousStatus: "in_progress",
        latestRun,
        comment: "Automatic continuation recovery failed.",
      }),
    ]);

    expect(results.filter(Boolean)).toHaveLength(1);
    expect(results.filter((result) => result === null)).toHaveLength(1);

    const actionRows = await db
      .select()
      .from(issueRecoveryActions)
      .where(eq(issueRecoveryActions.sourceIssueId, sourceIssue.id));
    expect(actionRows).toHaveLength(1);
    expect(actionRows[0]).toMatchObject({
      companyId,
      kind: "stranded_assigned_issue",
      status: "active",
      ownerType: "board",
      ownerAgentId: null,
      previousOwnerAgentId: coderId,
      returnOwnerAgentId: coderId,
      cause: "stranded_assigned_issue",
      attemptCount: 1,
      evidence: expect.objectContaining({
        routingPolicy: "board_escalation_no_takeover_v1",
      }),
    });

    const [updatedIssue] = await db.select().from(issues).where(eq(issues.id, sourceIssue.id));
    expect(updatedIssue).toMatchObject({
      status: "blocked",
    });
    const recoveryIssues = await db
      .select()
      .from(issues)
      .where(and(eq(issues.companyId, companyId), eq(issues.originKind, "stranded_issue_recovery")));
    expect(recoveryIssues).toHaveLength(0);
    expect(updatedIssue?.assigneeAgentId).toBe(coderId);
    expect(enqueueWakeup).not.toHaveBeenCalled();
  });

  it.each(["done", "cancelled", "reassigned", "returned_to_todo"] as const)(
    "preserves a concurrent %s decision when stale stranded recovery waits for the issue lock",
    async (decision) => {
      const { companyId, managerId, coderId, sourceIssue } = await seedCompany();
      const issuesSvc = issueService(db);
      const observed = (await issuesSvc.update(sourceIssue.id, { status: "todo" }))!;
      await db.update(agents).set({ status: "paused" }).where(eq(agents.id, coderId));
      const enqueueWakeup = vi.fn(async () => null);
      const recovery = recoveryService(db, { enqueueWakeup });
      const operatorDb = createDb(external ?? tempDb!.connectionString, { maxConnections: 1 });
      const probeDb = createDb(external ?? tempDb!.connectionString, { maxConnections: 1 });
      let release!: () => void;
      let ready!: () => void;
      let holderPid = 0;
      const locked = new Promise<void>((resolve) => { ready = resolve; });
      const gate = new Promise<void>((resolve) => { release = resolve; });
      const operator = operatorDb.transaction(async (tx) => {
        await tx.select({ id: issues.id }).from(issues)
          .where(eq(issues.id, observed.id)).for("update");
        holderPid = (await tx.execute<{ pid: number }>(sql`select pg_backend_pid() as pid`))[0]!.pid;
        ready();
        await gate;
        if (decision === "returned_to_todo") {
          await issuesSvc.update(observed.id, { status: "in_progress" }, tx);
          return issuesSvc.update(observed.id, { status: "todo" }, tx);
        }
        return issuesSvc.update(observed.id, decision === "reassigned"
          ? { assigneeAgentId: managerId }
          : { status: decision }, tx);
      });
      await locked;
      const escalation = recovery.escalateStrandedAssignedIssue({
        issue: observed,
        previousStatus: "todo",
        latestRun: null,
        comment: "The original assignee is not invokable.",
      });
      let waiting = false;
      let winner: Awaited<typeof operator>;
      try {
        const deadline = Date.now() + 5_000;
        while (!waiting && Date.now() < deadline) {
          const [state] = await probeDb.execute<{ waiting: boolean }>(sql`
            select exists (select 1 from pg_stat_activity
              where datname = current_database() and wait_event_type = 'Lock'
                and ${holderPid} = any(pg_blocking_pids(pid))) as waiting
          `);
          waiting = state!.waiting;
          if (!waiting) await new Promise((resolve) => setTimeout(resolve, 20));
        }
      } finally {
        release();
        winner = await operator;
      }
      const result = await escalation;
      expect(waiting, "recovery must contend with the actual operator row lock").toBe(true);
      expect(result).toBeNull();
      const [saved] = await db.select().from(issues).where(eq(issues.id, observed.id));
      expect(winner).toMatchObject(saved!);
      expect(saved).toMatchObject({
        status: decision === "done" || decision === "cancelled" ? decision : "todo",
        assigneeAgentId: decision === "reassigned" ? managerId : coderId,
      });
      expect(await db.select().from(issueRecoveryActions)
        .where(eq(issueRecoveryActions.sourceIssueId, observed.id))).toEqual([]);
      expect(await db.select().from(issueComments)
        .where(eq(issueComments.issueId, observed.id))).toEqual([]);
      expect(await db.select().from(agentWakeupRequests)
        .where(eq(agentWakeupRequests.companyId, companyId))).toEqual([]);
      expect(await db.select().from(activityLog)
        .where(eq(activityLog.entityId, observed.id))).toEqual([]);
      expect(enqueueWakeup).not.toHaveBeenCalled();
    },
  );

  // STUDIO-0062: production 15 Nov 2026, TR-1168. The assignee's run 05e3ab6a was cut at 14:29:13 (active legacy
  // hold bbb8ce70), the assignee paused, and stranded-work recovery blocked the task at 14:29:43 under that same
  // hold; its settlement at 14:29:46 found the task already blocked and wrote no receipt, so the Board's
  // reconciliation tool could not tell this block from one the role set itself.
  it("records the legacy cancellation receipt when stranded recovery blocks a task under the hold of its cut run", async () => {
    const { companyId, coderId, sourceIssue } = await seedCompany();
    const observed = (await issueService(db).update(sourceIssue.id, { status: "in_progress" }))!;
    const cutRunId = randomUUID();
    await db.insert(heartbeatRuns).values({ id: cutRunId, companyId, agentId: coderId, invocationSource: "assignment",
      status: "cancelled", runtimeMode: "legacy", errorCode: "cancelled", startedAt: new Date(Date.now() - 120_000),
      finishedAt: new Date(Date.now() - 60_000), contextSnapshot: { issueId: observed.id } });
    const [hold] = await db.insert(issueRecoveryActions).values({ companyId, sourceIssueId: observed.id, kind: "active_run_watchdog",
      status: "active", ownerType: "board", returnOwnerAgentId: coderId, previousOwnerAgentId: coderId,
      cause: "legacy_execution_requires_reconciliation", fingerprint: `legacy-execution:${cutRunId}`,
      nextAction: "Reconcile the cut run.", evidence: { runId: cutRunId },
    }).returning();
    // STUDIO-0076: a pause no longer blocks a task of the role, so the block of TR-1168 can no longer come from a
    // paused assignee. The receipt is kept for the block of an assignee that cannot be invoked for another reason.
    await db.update(agents).set({ status: "pending_approval" }).where(eq(agents.id, coderId));
    const enqueueWakeup = vi.fn(async () => null);
    const result = await recoveryService(db, { enqueueWakeup }).reconcileStrandedAssignedIssues();
    expect(result).toMatchObject({ escalated: 1, issueIds: [observed.id] });
    const [blocked] = await db.select().from(issues).where(eq(issues.id, observed.id));
    expect(blocked).toMatchObject({ status: "blocked", assigneeAgentId: coderId });
    const actions = await db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.sourceIssueId, observed.id));
    expect(actions.map((action) => action.id)).toEqual([hold!.id]);
    expect(actions[0]!.evidence).toMatchObject({
      runId: cutRunId,
      legacyCancellationBlock: { runId: cutRunId, statusVersion: blocked!.statusVersion, previousStatus: "in_progress" },
    });

    // No receipt for a hold whose run is not a cancelled legacy run of the assignee.
    const other = await seedCompany();
    const otherIssue = (await issueService(db).update(other.sourceIssue.id, { status: "in_progress" }))!;
    const failedRunId = randomUUID();
    await db.insert(heartbeatRuns).values({ id: failedRunId, companyId: other.companyId, agentId: other.coderId, invocationSource: "assignment",
      status: "failed", runtimeMode: "legacy", errorCode: "adapter_failed", startedAt: new Date(Date.now() - 120_000),
      finishedAt: new Date(Date.now() - 60_000), contextSnapshot: { issueId: otherIssue.id } });
    await db.insert(issueRecoveryActions).values({ companyId: other.companyId, sourceIssueId: otherIssue.id, kind: "active_run_watchdog",
      status: "active", ownerType: "board", returnOwnerAgentId: other.coderId, previousOwnerAgentId: other.coderId,
      cause: "legacy_execution_requires_reconciliation", fingerprint: `legacy-execution:${failedRunId}`,
      nextAction: "Reconcile the run.", evidence: { runId: failedRunId } });
    await db.update(agents).set({ status: "pending_approval" }).where(eq(agents.id, other.coderId));
    await recoveryService(db, { enqueueWakeup }).reconcileStrandedAssignedIssues();
    const [otherAction] = await db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.sourceIssueId, otherIssue.id));
    expect(otherAction!.evidence).not.toHaveProperty("legacyCancellationBlock");
  });

  // STUDIO-0076: a paused assignee is no longer escalated; the snapshot is now that of an assignee pending approval.
  it("escalates an unchanged snapshot of an assignee that cannot be invoked and publishes its committed notice", async () => {
    const { companyId, coderId, sourceIssue } = await seedCompany();
    const observed = (await issueService(db).update(sourceIssue.id, { status: "todo" }))!;
    await db.update(agents).set({ status: "pending_approval" }).where(eq(agents.id, coderId));
    const enqueueWakeup = vi.fn(async () => null);
    const result = await recoveryService(db, { enqueueWakeup }).reconcileStrandedAssignedIssues();
    expect(result).toMatchObject({ escalated: 1, issueIds: [observed.id] });
    expect(await db.select().from(issues).where(eq(issues.id, observed.id)))
      .toMatchObject([{ status: "blocked", assigneeAgentId: coderId }]);
    expect(await db.select().from(issueRecoveryActions)
      .where(eq(issueRecoveryActions.sourceIssueId, observed.id)))
      .toMatchObject([{ status: "active", previousOwnerAgentId: coderId }]);
    expect(await db.select().from(issueComments)
      .where(eq(issueComments.issueId, observed.id))).toHaveLength(1);
    expect(await db.select().from(activityLog)
      .where(eq(activityLog.entityId, observed.id)))
      .toMatchObject([{ details: expect.objectContaining({ status: "blocked" }) }]);
    expect(await db.select().from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.companyId, companyId))).toEqual([]);
    expect(enqueueWakeup).not.toHaveBeenCalled();
  });

  it.each(["awaiting_release", "pending_dispatch"] as const)("preserves an accepted %s agent transfer at both recovery boundaries", async state => {
    const { companyId, coderId, managerId, sourceIssue } = await seedCompany();
    await instanceSettingsService(db).updateExperimental({ enableCases: true });
    if (state === "awaiting_release") {
      const runId = randomUUID();
      await seedHeartbeatRun({ companyId, agentId: coderId, runId, issueId: sourceIssue.id, status: "failed" });
      await db.update(issues).set({ executionRunId: runId, checkoutRunId: runId })
        .where(eq(issues.id, sourceIssue.id));
    }
    const [observed] = await db.select().from(issues).where(eq(issues.id, sourceIssue.id));
    await db.update(agents).set({ status: "paused" }).where(eq(agents.id, coderId));
    const toAgentId = state === "awaiting_release" ? managerId : coderId;
    const receipt = await caseHandoffService(db).handoff(companyId,
      { type: "board", source: "local_implicit" }, {
        idempotencyKey: randomUUID(),
        case: { create: { caseType: "work", title: "Continue accepted work" } },
        bindIssueId: observed!.id,
        expectedIssueStatusVersion: observed!.statusVersion,
        toAgentId,
        phase: "verification",
        instructions: "Verify the saved work after the source execution settles.",
        workflow_document_text: "Implementation → verification → done.",
      });
    expect(receipt.state).toBe(state);
    const [pending] = await db.select().from(issues).where(eq(issues.id, observed!.id));
    if (state === "awaiting_release") expect(pending).toMatchObject({
      status: observed!.status,
      statusVersion: observed!.statusVersion,
      lastStatusDecisionId: observed!.lastStatusDecisionId,
      assigneeAgentId: observed!.assigneeAgentId,
      executionRunId: observed!.executionRunId,
      checkoutRunId: observed!.checkoutRunId,
    });
    else expect(pending).toMatchObject({ status: "todo", assigneeAgentId: coderId });
    const comments = await db.select().from(issueComments).where(eq(issueComments.issueId, pending!.id));
    const activities = await db.select().from(activityLog).where(eq(activityLog.companyId, companyId)).orderBy(activityLog.id);
    const enqueueWakeup = vi.fn(async () => null);
    const recovery = recoveryService(db, { enqueueWakeup });
    // A fresh issue snapshot alone cannot identify the ledger's successor.
    // The locked mutation boundary must consult the accepted handoff too.
    expect(await recovery.escalateStrandedAssignedIssue({
      issue: pending!, previousStatus: state === "awaiting_release" ? "in_progress" : "todo", latestRun: null,
      comment: "The original assignee is not invokable.",
    })).toBeNull();
    expect(await recovery.reconcileStrandedAssignedIssues()).toMatchObject({ escalated: 0, issueIds: [] });
    expect(await db.select().from(issues).where(eq(issues.id, pending!.id))).toEqual([pending]);
    expect(await db.select().from(caseHandoffs).where(eq(caseHandoffs.id, receipt.handoffId)))
      .toMatchObject([{ state, toAgentId }]);
    expect(await db.select().from(issueComments).where(eq(issueComments.issueId, pending!.id))).toEqual(comments);
    expect(await db.select().from(activityLog).where(eq(activityLog.companyId, companyId)).orderBy(activityLog.id)).toEqual(activities);
    expect(await db.select().from(issueRecoveryActions)).toEqual([]);
    expect(await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.companyId, companyId))).toEqual([]);
    expect(enqueueWakeup).not.toHaveBeenCalled();
  });

  it.each([false, true])("settles escalation on a one-connection pool (legacy recovery issue: %s)", async (legacyRecoveryIssue) => {
    const { sourceIssue } = await seedCompany();
    if (legacyRecoveryIssue) {
      await db.update(issues).set({ originKind: "stranded_issue_recovery", originId: sourceIssue.id })
        .where(eq(issues.id, sourceIssue.id));
    }
    const [observed] = await db.select().from(issues).where(eq(issues.id, sourceIssue.id));
    const singleConnectionDb = createDb(external ?? tempDb!.connectionString, { maxConnections: 1 });
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const work = recoveryService(singleConnectionDb, { enqueueWakeup: async () => null })
        .escalateStrandedAssignedIssue({ issue: observed!, previousStatus: "in_progress", latestRun: null });
      const result = await Promise.race([
        work,
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => reject(new Error("escalation borrowed its own exhausted connection pool")), 2_000);
        }),
      ]);
      expect(result).toMatchObject({ id: observed!.id, status: "blocked" });
      expect(await db.select().from(issueComments).where(eq(issueComments.issueId, observed!.id))).toHaveLength(1);
      expect(await db.select().from(activityLog).where(eq(activityLog.entityId, observed!.id))).toHaveLength(1);
    } finally {
      clearTimeout(timer);
      await singleConnectionDb.$client.end({ timeout: 0 });
    }
  });

  // Model the production payload: `requestedRef` keeps the operator spelling,
  // and the fingerprint carries the canonical remote ref. Two equivalent
  // spellings of one remote branch share `identityRef`, so they share one
  // fingerprint. A different branch gets a different `identityRef`.
  const makeUnresolvedBaseRefRun = (agentId: string, issueId: string) =>
    (requestedRef: string, identityRef: string) =>
      ({
        id: randomUUID(),
        agentId,
        status: "failed",
        error: `Configured workspace base ref "${requestedRef}" did not resolve to a commit on origin after an authenticated fetch.`,
        errorCode: "configuration_incomplete",
        contextSnapshot: { issueId },
        livenessState: "needs_followup",
        ...LATEST_RUN_TIMES,
        resultJson: {
          configurationIncomplete: {
            reason: "workspace_base_ref_unresolved",
            requestedRef,
            attemptedRefs: [identityRef],
            fingerprint: `workspace_base_ref:${identityRef}`,
          },
        },
      }) as const;

  it("bounds configuration-incomplete recovery by the unresolved base ref fingerprint", async () => {
    const { coderId, sourceIssue } = await seedCompany();
    const enqueueWakeup = vi.fn(async () => null);
    const recovery = recoveryService(db, { enqueueWakeup });
    const makeRun = makeUnresolvedBaseRefRun(coderId, sourceIssue.id);

    // Two reconciliations with the same unresolved ref reuse one active action.
    await recovery.escalateStrandedAssignedIssue({
      issue: sourceIssue,
      previousStatus: "in_progress",
      latestRun: makeRun("fix/foo", "origin/fix/foo"),
      recoveryCause: "configuration_incomplete",
    });
    await recovery.escalateStrandedAssignedIssue({
      issue: (await issueService(db).getById(sourceIssue.id))!,
      previousStatus: "in_progress",
      latestRun: makeRun("fix/foo", "origin/fix/foo"),
      recoveryCause: "configuration_incomplete",
    });

    const actions = await db
      .select()
      .from(issueRecoveryActions)
      .where(eq(issueRecoveryActions.sourceIssueId, sourceIssue.id));
    expect(actions).toHaveLength(1);
    expect(actions[0]).toMatchObject({
      cause: "configuration_incomplete",
      status: "active",
      attemptCount: 2,
    });
    // The fingerprint carries the canonical remote ref, so the same branch stays
    // one action and a different branch would make a distinct fingerprint.
    expect(actions[0]?.fingerprint).toBe(
      `source_scoped_recovery:${sourceIssue.companyId}:${sourceIssue.id}:configuration_incomplete:workspace_base_ref:origin/fix/foo`,
    );
  });

  it("keeps equivalent spellings of one unresolved base ref under one recovery identity", async () => {
    const { coderId, sourceIssue } = await seedCompany();
    const enqueueWakeup = vi.fn(async () => null);
    const recovery = recoveryService(db, { enqueueWakeup });
    const makeRun = makeUnresolvedBaseRefRun(coderId, sourceIssue.id);

    // The operator retries the same remote branch under two spellings. Both map
    // to the canonical `origin/fix/foo` identity, so recovery must not reset the
    // attempt count. Each failed run still needs its own actionable notice.
    const firstRun = makeRun("fix/foo", "origin/fix/foo");
    const secondRun = makeRun("origin/fix/foo", "origin/fix/foo");
    await recovery.escalateStrandedAssignedIssue({
      issue: sourceIssue,
      previousStatus: "in_progress",
      latestRun: firstRun,
      recoveryCause: "configuration_incomplete",
    });
    await recovery.escalateStrandedAssignedIssue({
      issue: (await issueService(db).getById(sourceIssue.id))!,
      previousStatus: "in_progress",
      latestRun: secondRun,
      recoveryCause: "configuration_incomplete",
    });

    const actions = await db
      .select()
      .from(issueRecoveryActions)
      .where(eq(issueRecoveryActions.sourceIssueId, sourceIssue.id));
    // One identity, one active action, the attempt count advances.
    expect(actions).toHaveLength(1);
    expect(actions[0]).toMatchObject({
      cause: "configuration_incomplete",
      status: "active",
      attemptCount: 2,
    });
    expect(actions[0]?.fingerprint).toBe(
      `source_scoped_recovery:${sourceIssue.companyId}:${sourceIssue.id}:configuration_incomplete:workspace_base_ref:origin/fix/foo`,
    );

    // Each run gets one notice bound to the same action; reconciling the
    // latest run again must not duplicate its notice.
    await recovery.escalateStrandedAssignedIssue({
      issue: (await issueService(db).getById(sourceIssue.id))!, previousStatus: "in_progress", latestRun: secondRun,
      recoveryCause: "configuration_incomplete",
    });
    const notices = await db
      .select({ metadata: issueComments.metadata })
      .from(issueComments)
      .where(
        and(
          eq(issueComments.issueId, sourceIssue.id),
          eq(issueComments.authorType, "system"),
        ),
      );
    expect(
      notices.filter((row) =>
        noticeMetadataReferencesRecoveryAction(row.metadata, actions[0]!.id),
      ),
    ).toHaveLength(2);
    expect(notices.map((row) => row.metadata?.sourceRunId).sort()).toEqual([firstRun.id, secondRun.id].sort());
  });

  it("gives a distinct recovery identity and a new operator notice when the unresolved base ref changes", async () => {
    const { coderId, sourceIssue } = await seedCompany();
    const enqueueWakeup = vi.fn(async () => null);
    const recovery = recoveryService(db, { enqueueWakeup });
    const makeRun = makeUnresolvedBaseRefRun(coderId, sourceIssue.id);

    await recovery.escalateStrandedAssignedIssue({
      issue: sourceIssue,
      previousStatus: "in_progress",
      latestRun: makeRun("fix/foo", "origin/fix/foo"),
      recoveryCause: "configuration_incomplete",
    });
    await recovery.escalateStrandedAssignedIssue({
      issue: (await issueService(db).getById(sourceIssue.id))!,
      previousStatus: "in_progress",
      latestRun: makeRun("fix/bar", "origin/fix/bar"),
      recoveryCause: "configuration_incomplete",
    });

    const actions = await db
      .select()
      .from(issueRecoveryActions)
      .where(eq(issueRecoveryActions.sourceIssueId, sourceIssue.id));
    // The prior ref keeps its own record and the new ref gets a fresh identity.
    expect(actions).toHaveLength(2);
    const priorAction = actions.find((row) =>
      row.fingerprint.endsWith("workspace_base_ref:origin/fix/foo"),
    );
    const newAction = actions.find((row) =>
      row.fingerprint.endsWith("workspace_base_ref:origin/fix/bar"),
    );
    expect(priorAction?.status).toBe("cancelled");
    expect(priorAction?.outcome).toBe("cancelled");
    expect(newAction?.status).toBe("active");
    expect(newAction?.attemptCount).toBe(1);
    expect(newAction?.id).not.toBe(priorAction?.id);

    // The operator gets one notice per distinct ref, each bound to its action.
    const systemComments = await db
      .select({ metadata: issueComments.metadata })
      .from(issueComments)
      .where(
        and(
          eq(issueComments.issueId, sourceIssue.id),
          eq(issueComments.authorType, "system"),
        ),
      );
    expect(
      systemComments.some((row) =>
        noticeMetadataReferencesRecoveryAction(row.metadata, priorAction!.id),
      ),
    ).toBe(true);
    expect(
      systemComments.some((row) =>
        noticeMetadataReferencesRecoveryAction(row.metadata, newAction!.id),
      ),
    ).toBe(true);
  });

  it.each([
    ["process_lost", undefined],
    ["adapter_failed", "successful_run_missing_state"],
    ["codex_output_inactivity_monitor", undefined],
    ["workspace_validation_failed", "workspace_validation_failed"],
    ["adapter_failed", undefined],
  ] as const)(
    "routes %s recovery through the cause-keyed playbook",
    async (errorCode, explicitCause) => {
      const { coderId, sourceIssue } = await seedCompany();
      const enqueueWakeup = vi.fn(async () => null);
      const recovery = recoveryService(db, { enqueueWakeup });
      const latestRun = {
        id: randomUUID(),
        agentId: coderId,
        status: errorCode === "adapter_failed" && explicitCause === "successful_run_missing_state"
          ? "succeeded"
          : "failed",
        error: `${errorCode} failure`,
        errorCode,
        contextSnapshot: { retryReason: "issue_continuation_needed" },
        livenessState: "needs_followup",
        ...LATEST_RUN_TIMES,
        resultJson: errorCode === "workspace_validation_failed"
          ? { workspaceValidation: { reason: "missing_workspace", fingerprint: "workspace:test" } }
          : null,
      } as const;

      await recovery.escalateStrandedAssignedIssue({
        issue: (await issueService(db).getById(sourceIssue.id))!,
        previousStatus: "in_progress",
        latestRun,
        ...(explicitCause ? { recoveryCause: explicitCause } : {}),
      });

      const [action] = await db
        .select()
        .from(issueRecoveryActions)
        .where(eq(issueRecoveryActions.sourceIssueId, sourceIssue.id));
      expect(action).toMatchObject({
        ownerType: "board",
        ownerAgentId: null,
        previousOwnerAgentId: coderId,
        returnOwnerAgentId: coderId,
        evidence: expect.objectContaining({
          routingPolicy: "board_escalation_no_takeover_v1",
        }),
        wakePolicy: expect.objectContaining({
          type: "board_escalation",
          preservesSourceAssignee: true,
        }),
      });
      expect(enqueueWakeup).not.toHaveBeenCalled();
    },
  );

  it("stands down while the latest run was cancelled by a board operator", async () => {
    const { companyId, coderId, sourceIssueId } = await seedCompany();
    await db.insert(heartbeatRuns).values({
      id: randomUUID(),
      companyId,
      agentId: coderId,
      invocationSource: "manual",
      status: "cancelled",
      error: "Cancelled by a board operator",
      errorCode: "cancelled",
      resultJson: { cancelledByActorType: "user", cancelledByUserId: "board-user" },
      startedAt: new Date("2026-07-15T20:00:00.000Z"),
      finishedAt: new Date("2026-07-15T20:01:00.000Z"),
      contextSnapshot: { issueId: sourceIssueId },
    });
    const enqueueWakeup = vi.fn(async () => null);
    const recovery = recoveryService(db, { enqueueWakeup });

    const result = await recovery.reconcileStrandedAssignedIssues();

    expect(result.operatorCancelExempted).toBe(1);
    expect(await db.select().from(issueRecoveryActions)).toHaveLength(0);
    expect(enqueueWakeup).not.toHaveBeenCalled();
  });

  it("stands down after an operator interrupt cancellation", async () => {
    const { companyId, coderId, sourceIssueId } = await seedCompany();
    await db.insert(heartbeatRuns).values({
      id: randomUUID(),
      companyId,
      agentId: coderId,
      invocationSource: "manual",
      status: "cancelled",
      error: "Interrupted by board comment",
      errorCode: "operator_interrupted",
      startedAt: new Date("2026-07-15T20:00:00.000Z"),
      finishedAt: new Date("2026-07-15T20:01:00.000Z"),
      contextSnapshot: { issueId: sourceIssueId },
    });
    const enqueueWakeup = vi.fn(async () => null);
    const recovery = recoveryService(db, { enqueueWakeup });

    const result = await recovery.reconcileStrandedAssignedIssues();

    expect(result.operatorCancelExempted).toBe(1);
    expect(enqueueWakeup).not.toHaveBeenCalled();
  });

  it("still recovers system-cancelled runs with no operator attribution", async () => {
    const { companyId, coderId, sourceIssueId } = await seedCompany();
    await db.insert(heartbeatRuns).values({
      id: randomUUID(),
      companyId,
      agentId: coderId,
      invocationSource: "manual",
      status: "cancelled",
      error: "Cancelled because the workspace lease expired",
      errorCode: "cancelled",
      startedAt: new Date("2026-07-15T20:00:00.000Z"),
      finishedAt: new Date("2026-07-15T20:01:00.000Z"),
      contextSnapshot: { issueId: sourceIssueId },
    });
    const enqueueWakeup = vi.fn(async () => null);
    const recovery = recoveryService(db, { enqueueWakeup });

    const result = await recovery.reconcileStrandedAssignedIssues();

    expect(result.operatorCancelExempted).toBe(0);
    expect(result.escalated).toBe(1);
    expect(enqueueWakeup).not.toHaveBeenCalled();
    expect(await db.select().from(issueRecoveryActions)).toEqual([expect.objectContaining({
      cause: "legacy_execution_requires_reconciliation", ownerType: "board", returnOwnerAgentId: coderId,
    })]);
  });

  it("schedules a provider-quota monitor for the original assignee without creating recovery work", async () => {
    const { companyId, coderId, sourceIssueId } = await seedCompany();
    const runId = randomUUID();
    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId,
      agentId: coderId,
      invocationSource: "manual",
      status: "failed",
      resultJson: { executionRecovery: { kind: "bootstrap", providerWorkStarted: false } },
      error: "You've hit your usage limit for GPT-5. Try again at 12:00 AM (UTC).",
      errorCode: "adapter_failed",
      startedAt: new Date("2026-07-15T20:00:00.000Z"),
      finishedAt: new Date("2026-07-15T20:01:00.000Z"),
      contextSnapshot: { issueId: sourceIssueId },
    });
    const enqueueWakeup = vi.fn(async () => null);
    const recovery = recoveryService(db, { enqueueWakeup });

    const result = await recovery.reconcileStrandedAssignedIssues();

    expect(result.providerQuotaMonitored).toBe(1);
    const [updatedIssue] = await db.select().from(issues).where(eq(issues.id, sourceIssueId));
    expect(updatedIssue).toMatchObject({
      status: "in_progress",
      assigneeAgentId: coderId,
      monitorScheduledBy: "assignee",
      monitorNotes: "Provider usage quota reached; retry the original assignee at the provider reset time.",
    });
    expect(updatedIssue?.monitorNextCheckAt).toBeInstanceOf(Date);
    expect(updatedIssue?.executionPolicy).toMatchObject({
      monitor: {
        serviceName: "AI provider quota",
        externalRef: runId,
        maxAttempts: null,
        recoveryPolicy: "wake_owner",
      },
    });
    const [updatedRun] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, runId));
    expect(updatedRun).toMatchObject({ errorCode: "provider_quota" });
    expect(updatedRun?.resultJson).toMatchObject({ errorFamily: "provider_quota" });
    expect(await db.select().from(issueRecoveryActions)).toHaveLength(0);
    expect(enqueueWakeup).not.toHaveBeenCalled();

    const secondResult = await recovery.reconcileStrandedAssignedIssues();
    expect(secondResult).toMatchObject({ providerQuotaMonitored: 0, skipped: 1 });
    expect(await db.select().from(issueRecoveryActions)).toHaveLength(0);
  });

  it("schedules another provider-quota monitor after a prior quota monitor fired", async () => {
    const { companyId, coderId, sourceIssueId } = await seedCompany();
    await db.update(issues).set({ monitorAttemptCount: 1 }).where(eq(issues.id, sourceIssueId));
    const runId = randomUUID();
    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId,
      agentId: coderId,
      invocationSource: "manual",
      status: "failed",
      resultJson: { executionRecovery: { kind: "bootstrap", providerWorkStarted: false } },
      error: "Provider quota exceeded for this model.",
      errorCode: "adapter_failed",
      startedAt: new Date("2026-07-15T21:00:00.000Z"),
      finishedAt: new Date("2026-07-15T21:01:00.000Z"),
      contextSnapshot: { issueId: sourceIssueId },
    });
    const recovery = recoveryService(db, { enqueueWakeup: vi.fn(async () => null) });

    const result = await recovery.reconcileStrandedAssignedIssues();

    expect(result.providerQuotaMonitored).toBe(1);
    const [updatedIssue] = await db.select().from(issues).where(eq(issues.id, sourceIssueId));
    expect(updatedIssue?.executionPolicy).toMatchObject({
      monitor: {
        maxAttempts: null,
        externalRef: runId,
      },
    });
  });

  it("skips provider-quota monitor scheduling for todo issues without aborting reconciliation", async () => {
    const { companyId, coderId, sourceIssueId } = await seedCompany();
    await db.update(issues).set({ status: "todo" }).where(eq(issues.id, sourceIssueId));
    const runId = randomUUID();
    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId,
      agentId: coderId,
      invocationSource: "manual",
      status: "failed",
      resultJson: { executionRecovery: { kind: "bootstrap", providerWorkStarted: false } },
      error: "Provider quota exceeded for this model.",
      errorCode: "adapter_failed",
      startedAt: new Date("2026-07-15T20:00:00.000Z"),
      finishedAt: new Date("2026-07-15T20:01:00.000Z"),
      contextSnapshot: { issueId: sourceIssueId },
    });
    const enqueueWakeup = vi.fn(async () => null);
    const recovery = recoveryService(db, { enqueueWakeup });

    const result = await recovery.reconcileStrandedAssignedIssues();

    expect(result).toMatchObject({ providerQuotaMonitored: 0, skipped: 1 });
    const [updatedIssue] = await db.select().from(issues).where(eq(issues.id, sourceIssueId));
    expect(updatedIssue).toMatchObject({
      status: "todo",
      assigneeAgentId: coderId,
      monitorNextCheckAt: null,
    });
    const [updatedRun] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, runId));
    expect(updatedRun?.errorCode).toBe("adapter_failed");
    expect(await db.select().from(issueRecoveryActions)).toHaveLength(0);
    expect(enqueueWakeup).not.toHaveBeenCalled();
  });

  it("does not create takeover recovery when a quota monitor cannot be scheduled", async () => {
    const { companyId, coderId, sourceIssueId } = await seedCompany();
    await db.update(issues).set({ status: "in_review" }).where(eq(issues.id, sourceIssueId));
    const runId = randomUUID();
    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId,
      agentId: coderId,
      invocationSource: "manual",
      status: "failed",
      resultJson: { executionRecovery: { kind: "bootstrap", providerWorkStarted: false } },
      error: "Provider quota exceeded for this model.",
      errorCode: "adapter_failed",
      startedAt: new Date("2026-07-15T20:00:00.000Z"),
      finishedAt: new Date("2026-07-15T20:01:00.000Z"),
      contextSnapshot: { issueId: sourceIssueId },
    });
    const enqueueWakeup = vi.fn(async () => null);
    const recovery = recoveryService(db, { enqueueWakeup });

    const result = await recovery.reconcileStrandedAssignedIssues();

    expect(result).toMatchObject({ providerQuotaMonitored: 0, skipped: 1 });
    const [updatedIssue] = await db.select().from(issues).where(eq(issues.id, sourceIssueId));
    expect(updatedIssue).toMatchObject({
      status: "in_review",
      assigneeAgentId: coderId,
      monitorNextCheckAt: null,
    });
    const [updatedRun] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, runId));
    expect(updatedRun?.errorCode).toBe("adapter_failed");
    expect(await db.select().from(issueRecoveryActions)).toHaveLength(0);
    expect(enqueueWakeup).not.toHaveBeenCalled();
  });

  it("schedules a quota monitor for a cross-agent active review participant", async () => {
    const { companyId, managerId, coderId, sourceIssueId } = await seedCompany();
    const stageId = randomUUID();
    await db.update(issues).set({
      status: "in_review",
      assigneeAgentId: coderId,
      executionPolicy: {
        mode: "normal",
        commentRequired: true,
        stages: [{
          id: stageId,
          type: "review",
          approvalsNeeded: 1,
          participants: [{ id: randomUUID(), type: "agent", agentId: managerId, userId: null }],
        }],
      },
      executionState: {
        status: "pending",
        currentStageId: stageId,
        currentStageIndex: 0,
        currentStageType: "review",
        currentParticipant: { type: "agent", agentId: managerId, userId: null },
        returnAssignee: { type: "agent", agentId: coderId, userId: null },
        reviewRequest: null,
        completedStageIds: [],
        lastDecisionId: null,
        lastDecisionOutcome: null,
      },
    }).where(eq(issues.id, sourceIssueId));
    const [reviewIssueBeforeRecovery] = await db.select().from(issues).where(eq(issues.id, sourceIssueId));
    expect(reviewIssueBeforeRecovery).toMatchObject({
      assigneeAgentId: coderId,
      executionState: {
        currentParticipant: { type: "agent", agentId: managerId },
        returnAssignee: { type: "agent", agentId: coderId },
      },
    });
    const runId = randomUUID();
    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId,
      agentId: managerId,
      invocationSource: "automation",
      status: "failed",
      resultJson: { executionRecovery: { kind: "bootstrap", providerWorkStarted: false } },
      error: "Provider quota exceeded for this model.",
      errorCode: "adapter_failed",
      startedAt: new Date("2026-07-15T20:00:00.000Z"),
      finishedAt: new Date("2026-07-15T20:01:00.000Z"),
      contextSnapshot: { issueId: sourceIssueId },
    });
    const enqueueWakeup = vi.fn(async () => null);
    const recovery = recoveryService(db, { enqueueWakeup });

    const result = await recovery.reconcileStrandedAssignedIssues();

    expect(result).toMatchObject({ providerQuotaMonitored: 1, reviewParticipantRequeued: 0 });
    const [updatedIssue] = await db.select().from(issues).where(eq(issues.id, sourceIssueId));
    expect(updatedIssue).toMatchObject({
      status: "in_review",
      assigneeAgentId: coderId,
      monitorNextCheckAt: expect.any(Date),
      monitorNotes: "Provider usage quota reached; retry the active review participant after the default recovery backoff.",
    });
    const [updatedRun] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, runId));
    expect(updatedRun?.errorCode).toBe("provider_quota");
    expect(await db.select().from(issueRecoveryActions)).toHaveLength(0);
    expect(enqueueWakeup).not.toHaveBeenCalled();
  });

  it("does not restamp an in_review quota monitor when the assignee has a newer terminal run", async () => {
    const { companyId, managerId, coderId, sourceIssueId } = await seedCompany();
    const stageId = randomUUID();
    await db.update(issues).set({
      status: "in_review",
      assigneeAgentId: coderId,
      executionPolicy: {
        mode: "normal",
        commentRequired: true,
        stages: [{
          id: stageId,
          type: "review",
          approvalsNeeded: 1,
          participants: [{ id: randomUUID(), type: "agent", agentId: managerId, userId: null }],
        }],
      },
      executionState: {
        status: "pending",
        currentStageId: stageId,
        currentStageIndex: 0,
        currentStageType: "review",
        currentParticipant: { type: "agent", agentId: managerId, userId: null },
        returnAssignee: { type: "agent", agentId: coderId, userId: null },
        reviewRequest: null,
        completedStageIds: [],
        lastDecisionId: null,
        lastDecisionOutcome: null,
      },
    }).where(eq(issues.id, sourceIssueId));
    const participantRunId = randomUUID();
    await db.insert(heartbeatRuns).values({
      id: participantRunId,
      companyId,
      agentId: managerId,
      invocationSource: "automation",
      status: "failed",
      resultJson: { executionRecovery: { kind: "bootstrap", providerWorkStarted: false } },
      error: "Provider quota exceeded for this model.",
      errorCode: "adapter_failed",
      startedAt: new Date("2026-07-15T20:00:00.000Z"),
      finishedAt: new Date("2026-07-15T20:01:00.000Z"),
      contextSnapshot: { issueId: sourceIssueId },
    });
    const enqueueWakeup = vi.fn(async () => null);
    const recovery = recoveryService(db, { enqueueWakeup });

    const firstResult = await recovery.reconcileStrandedAssignedIssues();

    expect(firstResult).toMatchObject({ providerQuotaMonitored: 1 });
    const [monitoredIssue] = await db.select().from(issues).where(eq(issues.id, sourceIssueId));
    const firstNextCheckAt = monitoredIssue?.monitorNextCheckAt;
    expect(firstNextCheckAt).toBeInstanceOf(Date);
    expect(monitoredIssue?.executionPolicy).toMatchObject({
      monitor: {
        serviceName: "AI provider quota",
        externalRef: participantRunId,
      },
    });

    await db.insert(heartbeatRuns).values({
      id: randomUUID(),
      companyId,
      agentId: coderId,
      invocationSource: "automation",
      status: "failed",
      error: "Stale assignee wake fired after the issue entered review.",
      errorCode: "issue_assignee_changed",
      startedAt: new Date("2026-07-15T20:02:00.000Z"),
      finishedAt: new Date("2026-07-15T20:03:00.000Z"),
      contextSnapshot: { issueId: sourceIssueId },
    });

    const secondResult = await recovery.reconcileStrandedAssignedIssues();

    expect(secondResult).toMatchObject({ providerQuotaMonitored: 0, skipped: 1 });
    const [unchangedIssue] = await db.select().from(issues).where(eq(issues.id, sourceIssueId));
    expect(unchangedIssue?.monitorNextCheckAt?.getTime()).toBe(firstNextCheckAt?.getTime());
    expect(unchangedIssue?.executionPolicy).toMatchObject({
      monitor: {
        serviceName: "AI provider quota",
        externalRef: participantRunId,
      },
    });
    expect(await db.select().from(issueRecoveryActions)).toHaveLength(0);
    expect(enqueueWakeup).not.toHaveBeenCalled();
  });

  it("classifies review recovery from the active participant run instead of a newer assignee run", async () => {
    const { companyId, managerId, coderId, sourceIssueId } = await seedCompany();
    const stageId = randomUUID();
    await db.update(issues).set({
      status: "in_review",
      assigneeAgentId: coderId,
      executionPolicy: {
        mode: "normal",
        commentRequired: true,
        stages: [{
          id: stageId,
          type: "review",
          approvalsNeeded: 1,
          participants: [{ id: randomUUID(), type: "agent", agentId: managerId, userId: null }],
        }],
      },
      executionState: {
        status: "pending",
        currentStageId: stageId,
        currentStageIndex: 0,
        currentStageType: "review",
        currentParticipant: { type: "agent", agentId: managerId, userId: null },
        returnAssignee: { type: "agent", agentId: coderId, userId: null },
        reviewRequest: null,
        completedStageIds: [],
        lastDecisionId: null,
        lastDecisionOutcome: null,
      },
    }).where(eq(issues.id, sourceIssueId));
    const participantRunId = randomUUID();
    const assigneeRunId = randomUUID();
    await db.insert(heartbeatRuns).values([{
      id: participantRunId,
      companyId,
      agentId: managerId,
      invocationSource: "automation",
      status: "failed",
      error: "review process exited unexpectedly",
      errorCode: "adapter_failed",
      startedAt: new Date("2026-07-15T20:00:00.000Z"),
      finishedAt: new Date("2026-07-15T20:01:00.000Z"),
      contextSnapshot: { issueId: sourceIssueId },
    }, {
      id: assigneeRunId,
      companyId,
      agentId: coderId,
      invocationSource: "automation",
      status: "failed",
      resultJson: { executionRecovery: { kind: "bootstrap", providerWorkStarted: false } },
      error: "You've hit your usage limit. Try again at 11:00 PM (UTC)",
      errorCode: "adapter_failed",
      startedAt: new Date("2026-07-15T20:02:00.000Z"),
      finishedAt: new Date("2026-07-15T20:03:00.000Z"),
      contextSnapshot: { issueId: sourceIssueId },
    }]);
    const enqueueWakeup = vi.fn(async () => ({ id: randomUUID() } as never));
    const recovery = recoveryService(db, { enqueueWakeup });

    const result = await recovery.reconcileStrandedAssignedIssues();

    expect(result).toMatchObject({ providerQuotaMonitored: 0, reviewParticipantRequeued: 0, escalated: 1 });
    const [updatedIssue] = await db.select().from(issues).where(eq(issues.id, sourceIssueId));
    expect(updatedIssue).toMatchObject({
      status: "in_review",
      assigneeAgentId: coderId,
      monitorNextCheckAt: null,
    });
    const [assigneeRun] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, assigneeRunId));
    expect(assigneeRun?.errorCode).toBe("adapter_failed");
    expect(enqueueWakeup).not.toHaveBeenCalled();
    expect(await db.select().from(issueRecoveryActions)).toEqual([expect.objectContaining({
      cause: "legacy_execution_requires_reconciliation", ownerType: "board", returnOwnerAgentId: coderId,
      evidence: expect.objectContaining({ runId: participantRunId }),
    })]);
  });

  it("blocks a cross-agent review participant with incomplete configuration", async () => {
    const { companyId, managerId, coderId, sourceIssueId } = await seedCompany();
    const stageId = randomUUID();
    await db.update(issues).set({
      status: "in_review",
      executionPolicy: {
        mode: "normal",
        commentRequired: true,
        stages: [{
          id: stageId,
          type: "review",
          approvalsNeeded: 1,
          participants: [{ id: randomUUID(), type: "agent", agentId: managerId, userId: null }],
        }],
      },
      executionState: {
        status: "pending",
        currentStageId: stageId,
        currentStageIndex: 0,
        currentStageType: "review",
        currentParticipant: { type: "agent", agentId: managerId, userId: null },
        returnAssignee: { type: "agent", agentId: coderId, userId: null },
        reviewRequest: null,
        completedStageIds: [],
        lastDecisionId: null,
        lastDecisionOutcome: null,
      },
    }).where(eq(issues.id, sourceIssueId));
    const runId = randomUUID();
    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId,
      agentId: managerId,
      invocationSource: "automation",
      status: "failed",
      resultJson: { executionRecovery: { kind: "bootstrap", providerWorkStarted: false } },
      error: "model_not_found: requested review model does not exist",
      errorCode: "adapter_failed",
      startedAt: new Date("2026-07-15T20:00:00.000Z"),
      finishedAt: new Date("2026-07-15T20:01:00.000Z"),
      contextSnapshot: { issueId: sourceIssueId },
    });
    const enqueueWakeup = vi.fn(async () => ({ id: randomUUID() } as never));
    const recovery = recoveryService(db, { enqueueWakeup });

    const result = await recovery.reconcileStrandedAssignedIssues();

    expect(result).toMatchObject({ escalated: 1, reviewParticipantRequeued: 0 });
    const [updatedIssue] = await db.select().from(issues).where(eq(issues.id, sourceIssueId));
    expect(updatedIssue).toMatchObject({
      status: "blocked",
      assigneeAgentId: coderId,
    });
    const [updatedRun] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, runId));
    expect(updatedRun?.errorCode).toBe("configuration_incomplete");
    const [action] = await db.select().from(issueRecoveryActions);
    expect(action).toMatchObject({
      sourceIssueId,
      ownerType: "board",
      ownerAgentId: null,
      previousOwnerAgentId: coderId,
      cause: "configuration_incomplete",
      recoveryIssueId: null,
    });
    expect(enqueueWakeup).not.toHaveBeenCalled();
  });

  it("uses the default quota backoff when the provider does not state a reset time", async () => {
    const { companyId, coderId, sourceIssueId } = await seedCompany();
    await db.insert(heartbeatRuns).values({
      id: randomUUID(),
      companyId,
      agentId: coderId,
      invocationSource: "manual",
      status: "failed",
      resultJson: { executionRecovery: { kind: "bootstrap", providerWorkStarted: false } },
      error: "Provider quota exceeded for this model.",
      errorCode: "adapter_failed",
      startedAt: new Date("2026-07-15T20:00:00.000Z"),
      finishedAt: new Date("2026-07-15T20:01:00.000Z"),
      contextSnapshot: { issueId: sourceIssueId },
    });
    const recovery = recoveryService(db, { enqueueWakeup: vi.fn(async () => null) });

    const result = await recovery.reconcileStrandedAssignedIssues();

    expect(result.providerQuotaMonitored).toBe(1);
    const [updatedIssue] = await db.select().from(issues).where(eq(issues.id, sourceIssueId));
    expect(updatedIssue).toMatchObject({
      status: "in_progress",
      assigneeAgentId: coderId,
      monitorNotes: "Provider usage quota reached; retry the original assignee after the default recovery backoff.",
    });
    expect(await db.select().from(issueRecoveryActions)).toHaveLength(0);
  });

  it("classifies model lookup failures as configuration incomplete without waking a recovery owner", async () => {
    const { companyId, coderId, sourceIssueId } = await seedCompany();
    const runId = randomUUID();
    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId,
      agentId: coderId,
      invocationSource: "manual",
      status: "failed",
      resultJson: { executionRecovery: { kind: "bootstrap", providerWorkStarted: false } },
      error: "model_not_found: requested model does not exist",
      errorCode: "adapter_failed",
      startedAt: new Date("2026-07-15T20:00:00.000Z"),
      finishedAt: new Date("2026-07-15T20:01:00.000Z"),
      contextSnapshot: { issueId: sourceIssueId },
    });
    const enqueueWakeup = vi.fn(async () => null);
    const recovery = recoveryService(db, { enqueueWakeup });

    const result = await recovery.reconcileStrandedAssignedIssues();

    expect(result).toMatchObject({ escalated: 1, skipped: 0 });
    const [updatedIssue] = await db.select().from(issues).where(eq(issues.id, sourceIssueId));
    expect(updatedIssue?.status).toBe("blocked");
    const [updatedRun] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, runId));
    expect(updatedRun?.errorCode).toBe("configuration_incomplete");
    const [action] = await db.select().from(issueRecoveryActions);
    expect(action).toMatchObject({
      sourceIssueId,
      cause: "configuration_incomplete",
      recoveryIssueId: null,
    });
    expect(enqueueWakeup).not.toHaveBeenCalled();
  });

  it("does not classify stale configuration failures from a non-assignee run", async () => {
    const { companyId, managerId, coderId, sourceIssueId } = await seedCompany();
    const runId = randomUUID();
    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId,
      agentId: managerId,
      invocationSource: "manual",
      status: "failed",
      error: "model_not_found: previous assignee model does not exist",
      errorCode: "adapter_failed",
      startedAt: new Date("2026-07-15T20:00:00.000Z"),
      finishedAt: new Date("2026-07-15T20:01:00.000Z"),
      contextSnapshot: { issueId: sourceIssueId },
    });
    const enqueueWakeup = vi.fn(async () => null);
    const recovery = recoveryService(db, { enqueueWakeup });

    const result = await recovery.reconcileStrandedAssignedIssues();

    expect(result).toMatchObject({ escalated: 0, skipped: 1 });
    const [updatedIssue] = await db.select().from(issues).where(eq(issues.id, sourceIssueId));
    expect(updatedIssue).toMatchObject({
      status: "in_progress",
      assigneeAgentId: coderId,
    });
    const [updatedRun] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, runId));
    expect(updatedRun?.errorCode).toBe("adapter_failed");
    expect(await db.select().from(issueRecoveryActions)).toHaveLength(0);
    expect(enqueueWakeup).not.toHaveBeenCalled();
  });

  it("reuses the same source-scoped action when latest run IDs change while the cause stays the same", async () => {
    const { companyId, managerId, coderId, sourceIssue } = await seedCompany();
    const enqueueWakeup = vi.fn(async () => null);
    const recovery = recoveryService(db, { enqueueWakeup });
    const firstLatestRun = {
      id: randomUUID(),
      agentId: coderId,
      status: "failed",
      error: "adapter failed",
      errorCode: "adapter_failed",
      contextSnapshot: { retryReason: "issue_continuation_needed" },
      livenessState: "needs_followup",
      ...LATEST_RUN_TIMES,
    } as const;
    const secondLatestRun = {
      ...firstLatestRun,
      id: randomUUID(),
    };

    await recovery.escalateStrandedAssignedIssue({
      issue: sourceIssue,
      previousStatus: "in_progress",
      latestRun: firstLatestRun,
      comment: "Automatic continuation recovery failed.",
    });
    await recovery.escalateStrandedAssignedIssue({
      issue: (await issueService(db).getById(sourceIssue.id))!,
      previousStatus: "in_progress",
      latestRun: secondLatestRun,
      comment: "Automatic continuation recovery failed.",
    });

    const actionRows = await db
      .select()
      .from(issueRecoveryActions)
      .where(eq(issueRecoveryActions.sourceIssueId, sourceIssue.id));
    expect(actionRows).toHaveLength(1);
    expect(actionRows[0]).toMatchObject({
      companyId,
      kind: "stranded_assigned_issue",
      status: "active",
      previousOwnerAgentId: coderId,
      returnOwnerAgentId: coderId,
      cause: "stranded_assigned_issue",
      attemptCount: 2,
    });
    expect(actionRows[0]?.evidence).toMatchObject({ latestRunId: secondLatestRun.id });
    expect(enqueueWakeup).not.toHaveBeenCalled();
  });

  it("deduplicates workspace-incoherence recovery actions by the typed workspace fingerprint", async () => {
    const { companyId, coderId, sourceIssue } = await seedCompany();
    const enqueueWakeup = vi.fn(async () => null);
    const recovery = recoveryService(db, { enqueueWakeup });
    const workspaceFingerprint = `workspace_incoherence:v1:sha256:${"a".repeat(64)}`;
    const workspaceValidation = {
      reason: "git_worktree_branch_incoherence",
      fingerprint: workspaceFingerprint,
      sourceIssueId: sourceIssue.id,
      sourceIdentifier: sourceIssue.identifier,
      executionWorkspaceId: "execution-workspace-1",
      expectedBranch: "PAP-1-expected",
      actualBranch: "PAP-1-publish",
      cleanliness: "dirty",
      provenance: {
        expectedBranchExists: true,
        actualBranchExists: true,
        expectedHeadSha: "1111111111111111111111111111111111111111",
        actualHeadSha: "2222222222222222222222222222222222222222",
        sameHead: false,
      },
      safeRepair: {
        eligible: false,
        attempted: false,
        succeeded: false,
        reason: "worktree is not clean",
      },
    };
    const firstLatestRun = {
      id: randomUUID(),
      agentId: coderId,
      status: "failed",
      error: "workspace branch mismatch",
      errorCode: "workspace_validation_failed",
      contextSnapshot: {},
      livenessState: "failed",
      ...LATEST_RUN_TIMES,
      resultJson: { workspaceValidation },
    } as const;
    const secondLatestRun = {
      ...firstLatestRun,
      id: randomUUID(),
    };

    await recovery.escalateStrandedAssignedIssue({
      issue: sourceIssue,
      previousStatus: "in_progress",
      latestRun: firstLatestRun,
      comment: "Workspace failed validation.",
      recoveryCause: "workspace_validation_failed",
    });
    // Prove dedupe uses the structured recovery-action reference rather than
    // depending only on the legacy body marker.
    await db
      .update(issueComments)
      .set({ body: "Workspace recovery was already escalated." })
      .where(eq(issueComments.issueId, sourceIssue.id));
    await recovery.escalateStrandedAssignedIssue({
      issue: (await issueService(db).getById(sourceIssue.id))!,
      previousStatus: "in_progress",
      latestRun: secondLatestRun,
      comment: "Workspace failed validation.",
      recoveryCause: "workspace_validation_failed",
    });

    const actionRows = await db
      .select()
      .from(issueRecoveryActions)
      .where(eq(issueRecoveryActions.sourceIssueId, sourceIssue.id));
    expect(actionRows).toHaveLength(1);
    expect(actionRows[0]).toMatchObject({
      companyId,
      kind: "workspace_validation",
      cause: "workspace_validation_failed",
      status: "active",
      attemptCount: 2,
      fingerprint: expect.stringContaining(workspaceFingerprint),
      evidence: expect.objectContaining({
        latestRunId: secondLatestRun.id,
        latestRunErrorCode: "workspace_validation_failed",
        workspaceValidation: expect.objectContaining({
          reason: "git_worktree_branch_incoherence",
          fingerprint: workspaceFingerprint,
          sourceIssueId: sourceIssue.id,
          executionWorkspaceId: "execution-workspace-1",
          expectedBranch: "PAP-1-expected",
          actualBranch: "PAP-1-publish",
          cleanliness: "dirty",
        }),
      }),
      nextAction: expect.stringContaining("git worktree branch incoherence"),
      wakePolicy: expect.objectContaining({
        type: "board_escalation",
        reason: "workspace_validation_failed",
        preservesSourceAssignee: true,
      }),
    });

    const comments = await db.select().from(issueComments).where(eq(issueComments.issueId, sourceIssue.id));
    const escalationComments = comments.filter((comment) =>
      noticeMetadataReferencesRecoveryAction(comment.metadata, actionRows[0]!.id),
    );
    expect(escalationComments).toHaveLength(1);
    expect(escalationComments[0]?.presentation).toMatchObject({
      kind: "system_notice",
      tone: "danger",
      title: "Workspace validation failed",
    });
    expect(enqueueWakeup).not.toHaveBeenCalled();
  });

  it("keeps the source issue blocked when source-scoped wakeup is claimed synchronously", async () => {
    const { companyId, managerId, coderId, sourceIssue } = await seedCompany();
    await db.update(agents).set({ status: "paused" }).where(eq(agents.id, managerId));
    const enqueueWakeup = vi.fn(async () => {
      await db
        .update(issues)
        .set({ status: "in_progress" })
        .where(eq(issues.id, sourceIssue.id));
      return null;
    });
    const recovery = recoveryService(db, { enqueueWakeup });
    const firstLatestRun = {
      id: randomUUID(),
      agentId: coderId,
      status: "failed",
      error: "adapter failed",
      errorCode: "adapter_failed",
      contextSnapshot: { retryReason: "issue_continuation_needed" },
      livenessState: "needs_followup",
      ...LATEST_RUN_TIMES,
    } as const;

    await recovery.escalateStrandedAssignedIssue({
      issue: sourceIssue,
      previousStatus: "in_progress",
      latestRun: firstLatestRun,
      comment: "Automatic continuation recovery failed.",
    });

    const [afterFirst] = await db.select().from(issues).where(eq(issues.id, sourceIssue.id));
    expect(afterFirst?.status).toBe("blocked");
    expect(afterFirst?.assigneeAgentId).toBe(coderId);

    const secondLatestRun = {
      ...firstLatestRun,
      id: randomUUID(),
    };
    await recovery.escalateStrandedAssignedIssue({
      issue: (await issueService(db).getById(sourceIssue.id))!,
      previousStatus: "in_progress",
      latestRun: secondLatestRun,
      comment: "Automatic continuation recovery failed.",
    });

    const actionRows = await db
      .select()
      .from(issueRecoveryActions)
      .where(eq(issueRecoveryActions.sourceIssueId, sourceIssue.id));
    expect(actionRows).toHaveLength(1);
    expect(actionRows[0]).toMatchObject({
      companyId,
      kind: "stranded_assigned_issue",
      status: "active",
      previousOwnerAgentId: coderId,
      returnOwnerAgentId: coderId,
      cause: "stranded_assigned_issue",
      attemptCount: 2,
    });
    const [afterSecond] = await db.select().from(issues).where(eq(issues.id, sourceIssue.id));
    expect(afterSecond?.status).toBe("blocked");

    const comments = await db.select().from(issueComments).where(eq(issueComments.issueId, sourceIssue.id));
    expect(comments).toHaveLength(1);
    // Dedupe for structured notices is metadata-based: the short body no longer
    // carries the `Recovery action: \`id\`` marker line.
    expect(comments[0]?.body).not.toContain("Recovery action:");
    expect(noticeMetadataReferencesRecoveryAction(comments[0]?.metadata, actionRows[0]!.id)).toBe(true);
    expect(comments[0]?.presentation).toMatchObject({ kind: "system_notice", tone: "danger" });
  });

  it("does not create nested recovery artifacts when issue-backed fallback work itself fails", async () => {
    const { companyId, managerId, sourceIssueId, prefix } = await seedCompany();
    const recoveryIssueId = randomUUID();
    await db.insert(issues).values({
      id: recoveryIssueId,
      companyId,
      title: "Recover stalled issue",
      status: "in_progress",
      priority: "medium",
      assigneeAgentId: managerId,
      parentId: sourceIssueId,
      issueNumber: 2,
      identifier: `${prefix}-2`,
      originKind: "stranded_issue_recovery",
      originId: sourceIssueId,
      originFingerprint: `stranded_issue_recovery:${sourceIssueId}`,
    });
    const [recoveryIssue] = await db.select().from(issues).where(eq(issues.id, recoveryIssueId));
    const recovery = recoveryService(db, { enqueueWakeup: vi.fn(async () => null) });

    await recovery.escalateStrandedAssignedIssue({
      issue: recoveryIssue!,
      previousStatus: "in_progress",
      latestRun: {
        id: randomUUID(),
        agentId: managerId,
        status: "failed",
        error: "adapter failed",
        errorCode: "adapter_failed",
        contextSnapshot: { retryReason: "issue_continuation_needed" },
        livenessState: "needs_followup",
        ...LATEST_RUN_TIMES,
      },
    });

    const actionRows = await db.select().from(issueRecoveryActions);
    expect(actionRows).toHaveLength(0);
    const recoveryIssues = await db
      .select()
      .from(issues)
      .where(and(eq(issues.companyId, companyId), eq(issues.originKind, "stranded_issue_recovery")));
    expect(recoveryIssues).toHaveLength(1);
    expect(recoveryIssues[0]?.status).toBe("blocked");
  });

  it("exposes active recovery actions on the issue read API", async () => {
    const { companyId, managerId, sourceIssueId } = await seedCompany();
    const recoveryActionSvc = issueRecoveryActionService(db);
    const action = await recoveryActionSvc.upsertSourceScoped({
      companyId,
      sourceIssueId,
      kind: "missing_disposition",
      ownerType: "agent",
      ownerAgentId: managerId,
      cause: "successful_run_missing_issue_disposition",
      fingerprint: "missing-disposition:fingerprint",
      evidence: { sourceRunId: "run-1" },
      nextAction: "Choose a valid issue disposition.",
      wakePolicy: { type: "wake_owner" },
    });
    const app = createApp();

    const detail = await request(app).get(`/api/issues/${sourceIssueId}`).expect(200);
    expect(detail.body.activeRecoveryAction).toMatchObject({
      id: action.id,
      sourceIssueId,
      kind: "missing_disposition",
      ownerAgentId: managerId,
    });

    const list = await request(app).get(`/api/issues/${sourceIssueId}/recovery-actions`).expect(200);
    expect(list.body.active).toMatchObject({ id: action.id });
    expect(list.body.actions).toHaveLength(1);
  });

  it("lists a settled reconciliation hold that still blocks replay", async () => {
    const { companyId, coderId, sourceIssueId } = await seedCompany();
    const runId = randomUUID();
    const [action] = await db.insert(issueRecoveryActions).values({
      companyId,
      sourceIssueId,
      kind: "active_run_watchdog",
      status: "resolved",
      outcome: "blocked",
      ownerType: "board",
      returnOwnerAgentId: coderId,
      cause: "legacy_execution_requires_reconciliation",
      fingerprint: runId,
      nextAction: "Preserve recorded work without replay.",
      evidence: { runId, automaticRecovery: { replay: "blocked", actionOutcome: "unknown" } },
    }).returning();

    const list = await request(createApp()).get(`/api/issues/${sourceIssueId}/recovery-actions`).expect(200);

    expect(list.body.active).toBeNull();
    expect(list.body.actions).toEqual([
      expect.objectContaining({
        id: action!.id,
        status: "resolved",
        cause: "legacy_execution_requires_reconciliation",
        evidence: { runId, automaticRecovery: { replay: "blocked", actionOutcome: "unknown" } },
      }),
    ]);
  });

  it("projects recovery action metadata into the structured wake payload", async () => {
    const { companyId, managerId, coderId, sourceIssueId } = await seedCompany();
    const action = await issueRecoveryActionService(db).upsertSourceScoped({
      companyId,
      sourceIssueId,
      kind: "workspace_validation",
      ownerType: "agent",
      ownerAgentId: managerId,
      previousOwnerAgentId: coderId,
      returnOwnerAgentId: coderId,
      cause: "workspace_validation_failed",
      fingerprint: "workspace:wake-payload",
      evidence: {
        failureSummary: "Worktree branch does not match the pinned branch.",
        routingFallbackReason: null,
      },
      nextAction: "Repair the worktree, then return the issue to the coder.",
      wakePolicy: { type: "wake_owner" },
      maxAttempts: 3,
    });

    const payload = await buildPaperclipWakePayload({
      db,
      companyId,
      contextSnapshot: {
        issueId: sourceIssueId,
        wakeReason: "source_scoped_recovery_action",
        recoveryActionId: action.id,
        recoveryCause: action.cause,
      },
    });

    expect(payload?.recovery).toEqual({
      cause: "workspace_validation_failed",
      failureSummary: "Worktree branch does not match the pinned branch.",
      originalAssignee: { id: coderId, name: "Coder" },
      attemptCount: 1,
      maxAttempts: 3,
      nextAction: "Repair the worktree, then return the issue to the coder.",
      routingFallbackReason: null,
    });
  });

  it.each(["resolved", "cancelled"])("omits %s recovery instructions when the original worker resumes", async (status) => {
    const { companyId, coderId, sourceIssueId } = await seedCompany();
    const action = await issueRecoveryActionService(db).upsertSourceScoped({
      companyId, sourceIssueId, kind: "stranded_assigned_issue", ownerType: "board",
      returnOwnerAgentId: coderId, cause: "stranded_assigned_issue", fingerprint: "finished-recovery",
      evidence: { failureSummary: "Retry budget exhausted during cleanup." },
      nextAction: "Repair the runtime, then retry the original owner.", wakePolicy: null,
    });
    await db.update(issueRecoveryActions).set({ status, outcome: "handed_back", resolvedAt: new Date() })
      .where(eq(issueRecoveryActions.id, action.id));
    const payload = await buildPaperclipWakePayload({ db, companyId, contextSnapshot: {
      issueId: sourceIssueId, wakeReason: "issue_recovery_action_restored",
      recoveryActionId: action.id, recoveryCause: action.cause,
    } });
    expect(payload?.issue?.id).toBe(sourceIssueId);
    expect(payload?.recovery).toBeNull();
    const prompt = renderPaperclipWakePrompt(payload);
    expect(prompt).toContain("Implement backend recovery");
    expect(prompt).not.toContain("Recovery contract:");
    expect(prompt).not.toContain(action.nextAction);
    expect(prompt).not.toContain("Do not produce the deliverable");
  });

  it("accepts new verified evidence after an automatic no-replay disposition without reopening on duplicate requests", async () => {
    const { companyId, coderId, sourceIssueId } = await seedCompany();
    const runId = randomUUID();
    await seedHeartbeatRun({ companyId, agentId: coderId, runId, issueId: sourceIssueId, status: "failed" });
    await db.update(issues).set({ status: "blocked" }).where(eq(issues.id, sourceIssueId));
    const [action] = await db.insert(issueRecoveryActions).values({
      companyId, sourceIssueId, kind: "active_run_watchdog", status: "resolved", outcome: "blocked",
      ownerType: "board", returnOwnerAgentId: coderId, cause: "uncertain_external_action", fingerprint: runId,
      nextAction: "Preserve recorded work without replay.",
      evidence: { runId, automaticRecovery: { replay: "blocked", actionOutcome: "unknown" } },
    }).returning();
    const app = createApp();
    const body = { actionId: action!.id, outcome: "restored", sourceIssueStatus: "todo",
      executionReconciliation: { runId, providerStopped: true, actionOutcome: "not_performed",
        outcomeEvidence: "Provider receipts confirm the action was never submitted; the stopped process has no remaining effects." } };
    // A retry without new evidence cannot clear the hold or reopen the task.
    await request(app).post(`/api/issues/${sourceIssueId}/recovery-actions/resolve`).send({ ...body, executionReconciliation: undefined }).expect(200);
    expect((await db.select().from(issues).where(eq(issues.id, sourceIssueId)))[0]!.status).toBe("blocked");
    const resolved = await request(app).post(`/api/issues/${sourceIssueId}/recovery-actions/resolve`).send(body).expect(200);
    expect(resolved.body.issue.status).toBe("todo");
    const [recorded] = await db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.id, action!.id));
    expect(recorded!.evidence).not.toHaveProperty("automaticRecovery");
    expect(recorded!.evidence).toMatchObject({ executionReconciliation: { runId }, continuationDelivery: "pending" });
    await request(app).post(`/api/issues/${sourceIssueId}/recovery-actions/resolve`).send(body).expect(200);
    expect((await db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.id, action!.id)))[0]).toEqual(recorded);
  });

  // STUDIO-0048: production 14 Nov 2026 (TR-724, TR-723, TR-698). A follow-up
  // blocked by an open child had its assignee run cancelled by the Board; the
  // legacy hold then turned every system wake into a skipped
  // `execution_reconciliation_required` row, and the hold could only be
  // reconciled once the ticket left `blocked`.
  async function seedDependencyBlockedLegacyHold(childStatus: "in_progress" | "done" | "cancelled",
    cause = "legacy_execution_requires_reconciliation") {
    const fixture = await seedCompany();
    const { companyId, coderId, sourceIssueId, prefix } = fixture;
    const childIssueId = randomUUID();
    await db.insert(issues).values({
      id: childIssueId, companyId, title: "Open child", status: childStatus, priority: "medium",
      assigneeAgentId: coderId, parentId: sourceIssueId, issueNumber: 2, identifier: `${prefix}-2`,
    });
    await db.insert(issueRelations).values({ companyId, issueId: childIssueId, relatedIssueId: sourceIssueId, type: "blocks" });
    await db.update(issues).set({ status: "blocked" }).where(eq(issues.id, sourceIssueId));
    const cutRunId = randomUUID();
    await db.insert(heartbeatRuns).values({
      id: cutRunId, companyId, agentId: coderId, invocationSource: "assignment", status: "cancelled",
      runtimeMode: "legacy", errorCode: "cancelled", startedAt: new Date(Date.now() - 120_000),
      finishedAt: new Date(Date.now() - 60_000), contextSnapshot: { issueId: sourceIssueId },
    });
    const responsibleUserId = randomUUID();
    await db.insert(authUsers).values({ id: responsibleUserId, name: "Recovery operator",
      email: `${responsibleUserId}@example.test`, emailVerified: true, createdAt: new Date(), updatedAt: new Date() });
    await db.update(companies).set({ defaultResponsibleUserId: responsibleUserId }).where(eq(companies.id, companyId));
    // Keep the agent's only slot busy on another task so admitted wakes stay queued.
    await db.update(agents).set({ runtimeConfig: { heartbeat: { maxConcurrentRuns: 1 } } }).where(eq(agents.id, coderId));
    await seedHeartbeatRun({ companyId, agentId: coderId, runId: randomUUID(), status: "running" });
    const [action] = await db.insert(issueRecoveryActions).values({
      companyId, sourceIssueId, kind: "active_run_watchdog", status: "resolved", outcome: "blocked",
      ownerType: "board", returnOwnerAgentId: coderId, cause,
      fingerprint: `legacy-execution:${cutRunId}`, nextAction: "Automatic recovery stopped.",
      evidence: { runId: cutRunId, automaticRecovery: { replay: "blocked", actionOutcome: "unknown" } },
    }).returning();
    const body = {
      actionId: action!.id, outcome: "restored", sourceIssueStatus: "blocked",
      executionReconciliation: { runId: cutRunId, providerStopped: true, actionOutcome: "not_performed",
        outcomeEvidence: "The Board cancelled the run before any provider action; the stopped process has no remaining effects." },
    } as const;
    const wakeBlockersResolved = (key: string) => heartbeatService(db, { runtimeEnv: {} }).wakeup(coderId, {
      source: "automation", triggerDetail: "system", reason: "issue_blockers_resolved",
      payload: { issueId: sourceIssueId, resolvedBlockerIssueId: childIssueId, blockerIssueIds: [childIssueId] },
      idempotencyKey: key,
      contextSnapshot: { issueId: sourceIssueId, taskId: sourceIssueId, wakeReason: "issue_blockers_resolved",
        resolvedBlockerIssueId: childIssueId, blockerIssueIds: [childIssueId] },
    });
    // The session the cut run resumed and left mid-turn.
    await db.insert(agentTaskSessions).values({ companyId, agentId: coderId, adapterType: "codex_local", taskKey: sourceIssueId,
      sessionParamsJson: { sessionId: "cut-thread" }, sessionDisplayId: "cut-thread", lastRunId: cutRunId });
    return { ...fixture, childIssueId, cutRunId, action: action!, body, wakeBlockersResolved };
  }

  it("reconciles a legacy hold while the follow-up stays blocked by an open child, then admits its dependency wake", async () => {
    const { companyId, sourceIssueId, childIssueId, cutRunId, action, body, wakeBlockersResolved } =
      await seedDependencyBlockedLegacyHold("in_progress");
    const wakesOf = async () => db.select().from(agentWakeupRequests)
      .where(and(eq(agentWakeupRequests.companyId, companyId), eq(agentWakeupRequests.reason, "execution_reconciliation_required")));

    // Before the fix's gesture: the system wake is recorded skipped by the hold.
    await wakeBlockersResolved(`dependency-wake:${sourceIssueId}:held`);
    const held = await wakesOf();
    expect(held).toHaveLength(1);
    expect(held[0]).toMatchObject({ status: "skipped", reason: "execution_reconciliation_required" });

    // The reconciliation keeps the task blocked by its open child.
    const app = createApp();
    const resolved = await request(app).post(`/api/issues/${sourceIssueId}/recovery-actions/resolve`).send(body).expect(200);
    expect(resolved.body.issue.status).toBe("blocked");
    const [recorded] = await db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.id, action.id));
    expect(recorded).toMatchObject({ status: "resolved", outcome: "restored", evidence: {
      executionReconciliation: { runId: cutRunId, actionOutcome: "not_performed" },
      continuationDelivery: "not_requested", dependencyBlockedReconciliation: true,
    } });
    expect(recorded!.evidence).not.toHaveProperty("automaticRecovery");
    expect((await db.select().from(issues).where(eq(issues.id, sourceIssueId)))[0]!.status).toBe("blocked");
    // The next run starts fresh, as the todo path's continuation does.
    expect(await db.select().from(agentTaskSessions).where(eq(agentTaskSessions.taskKey, sourceIssueId))).toEqual([]);
    // No continuation is delivered now, and a repeated request changes nothing.
    await deliverReconciledExecutions(db, heartbeatService(db, { runtimeEnv: {} }).wakeup);
    expect(await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.retryOfRunId, cutRunId))).toEqual([]);
    await request(app).post(`/api/issues/${sourceIssueId}/recovery-actions/resolve`).send(body).expect(200);
    expect((await db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.id, action.id)))[0]).toEqual(recorded);

    // The child ends: the dependency wake is admitted, not skipped.
    await db.update(issues).set({ status: "done" }).where(eq(issues.id, childIssueId));
    await wakeBlockersResolved(`dependency-wake:${sourceIssueId}:ready`);
    expect(await wakesOf()).toHaveLength(1);
    const admitted = await db.select().from(agentWakeupRequests).where(and(
      eq(agentWakeupRequests.companyId, companyId), eq(agentWakeupRequests.reason, "issue_blockers_resolved")));
    expect(admitted).toHaveLength(1);
    expect(admitted[0]!.status).not.toBe("skipped");
    const runs = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.companyId, companyId));
    expect(runs.filter((run) => (run.contextSnapshot as Record<string, unknown> | null)?.wakeReason === "issue_blockers_resolved"
      && (run.contextSnapshot as Record<string, unknown>).issueId === sourceIssueId)).toHaveLength(1);
  });

  it.each([["done", "legacy_execution_requires_reconciliation"], ["in_progress", "uncertain_external_action"]] as const)(
    "keeps the hold when a blocked reconciliation has no unresolved blocker or another cause (child %s, %s)", async (childStatus, cause) => {
    const { sourceIssueId, action, body } = await seedDependencyBlockedLegacyHold(childStatus, cause);
    await request(createApp()).post(`/api/issues/${sourceIssueId}/recovery-actions/resolve`).send(body).expect(409);
    const [unchanged] = await db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.id, action.id));
    expect(unchanged).toMatchObject({ status: "resolved", outcome: "blocked",
      evidence: { automaticRecovery: { replay: "blocked" } } });
    expect(unchanged!.evidence).not.toHaveProperty("executionReconciliation");
    expect(await db.select().from(agentTaskSessions).where(eq(agentTaskSessions.taskKey, sourceIssueId))).toHaveLength(1);
  });

  it("accepts a blocked reconciliation behind a cancelled child but does not promise a dependency wake", async () => {
    const { sourceIssueId, action, body, cutRunId, wakeBlockersResolved, companyId } = await seedDependencyBlockedLegacyHold("cancelled");
    const resolved = await request(createApp()).post(`/api/issues/${sourceIssueId}/recovery-actions/resolve`).send(body).expect(200);
    expect(resolved.body.issue.status).toBe("blocked");
    const [recorded] = await db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.id, action.id));
    expect(recorded!.evidence).toMatchObject({ continuationDelivery: "not_requested", dependencyBlockedReconciliation: true });
    // A cancelled blocker stays unresolved: the task is not dependency-ready.
    expect((await issueService(db).getDependencyReadiness(sourceIssueId)).unresolvedBlockerCount).toBe(1);
    const projection = await executionProjectionForRun(db, companyId, cutRunId);
    expect(projection).toMatchObject({ phase: "completed", label: "Reconciled" });
    expect(projection!.nextAction).toContain("a cancelled blocker must be removed or replaced first");
    void wakeBlockersResolved;
  });

  // STUDIO-0051: a legacy hold on a task that waits on a person's answer is
  // reconciled without a continuation; the answer then wakes the assignee.
  async function seedAwaitingResponseHold(wait: "person question" | "agent question" | "approval" | "none") {
    const fixture = await seedCompany();
    const { companyId, coderId, managerId, sourceIssueId } = fixture;
    const responsibleUserId = randomUUID();
    await db.insert(authUsers).values({ id: responsibleUserId, name: "Board", email: `${responsibleUserId}@example.test`,
      emailVerified: true, createdAt: new Date(), updatedAt: new Date() });
    await db.update(companies).set({ defaultResponsibleUserId: responsibleUserId }).where(eq(companies.id, companyId));
    await db.update(agents).set({ runtimeConfig: { heartbeat: { maxConcurrentRuns: 1 } } }).where(eq(agents.id, coderId));
    await seedHeartbeatRun({ companyId, agentId: coderId, runId: randomUUID(), status: "running" });
    // Blocked by the role itself (no legacyCancellationBlock receipt): the path keeps the status.
    await db.update(issues).set({ status: "blocked" }).where(eq(issues.id, sourceIssueId));
    const cutRunId = randomUUID();
    await db.insert(heartbeatRuns).values({ id: cutRunId, companyId, agentId: coderId, invocationSource: "assignment",
      status: "cancelled", runtimeMode: "legacy", errorCode: "cancelled", startedAt: new Date(Date.now() - 120_000),
      finishedAt: new Date(Date.now() - 60_000), contextSnapshot: { issueId: sourceIssueId } });
    const [action] = await db.insert(issueRecoveryActions).values({ companyId, sourceIssueId, kind: "active_run_watchdog",
      status: "resolved", outcome: "blocked", ownerType: "board", returnOwnerAgentId: coderId,
      cause: "legacy_execution_requires_reconciliation", fingerprint: `legacy-execution:${cutRunId}`,
      nextAction: "Automatic recovery stopped.",
      evidence: { runId: cutRunId, automaticRecovery: { policy: "preserve_without_replay_v1", runId: cutRunId, replay: "blocked", actionOutcome: "unknown" } },
    }).returning();
    await db.insert(agentTaskSessions).values({ companyId, agentId: coderId, adapterType: "codex_local", taskKey: sourceIssueId,
      sessionParamsJson: { sessionId: "cut-thread" }, sessionDisplayId: "cut-thread", lastRunId: cutRunId });
    let interactionId: string | null = null;
    if (wait === "person question" || wait === "agent question") {
      const [interaction] = await db.insert(issueThreadInteractions).values({ companyId, issueId: sourceIssueId,
        kind: "request_confirmation", status: "pending", continuationPolicy: wait === "person question" ? "wake_assignee" : "none",
        ...(wait === "person question" ? { addresseeUserId: responsibleUserId } : { addresseeAgentId: managerId }),
        createdByAgentId: coderId, payload: { version: 1, prompt: "Extend the wait by one hour?" } } as never).returning();
      interactionId = interaction!.id;
    }
    let approvalId: string | null = null;
    if (wait === "approval") {
      approvalId = randomUUID();
      await db.execute(sql`insert into approvals (id, company_id, type, status, payload, requested_by_agent_id)
        values (${approvalId}, ${companyId}, 'hire_agent', 'pending', '{}'::jsonb, ${coderId})`);
      await db.execute(sql`insert into issue_approvals (company_id, issue_id, approval_id) values (${companyId}, ${sourceIssueId}, ${approvalId})`);
    }
    const body = { actionId: action!.id, outcome: "restored", sourceIssueStatus: "blocked",
      executionReconciliation: { runId: cutRunId, providerStopped: true, actionOutcome: "mixed",
        outcomeEvidence: "The Board cancelled the run for the update window; the operator checked the machine." } } as const;
    return { ...fixture, cutRunId, action: action!, body, interactionId, approvalId, responsibleUserId };
  }

  const coderWakes = (companyId: string, coderId: string) => db.select().from(agentWakeupRequests)
    .where(and(eq(agentWakeupRequests.companyId, companyId), eq(agentWakeupRequests.agentId, coderId)));
  async function dropApproval(approvalId: string | null) {
    if (!approvalId) return;
    await db.execute(sql`delete from issue_approvals where approval_id = ${approvalId}`);
    await db.execute(sql`delete from approvals where id = ${approvalId}`);
  }

  it("reconciles a hold on a task waiting on a person's question without a continuation; the answer wakes the role once", async () => {
    const { companyId, coderId, sourceIssueId, cutRunId, action, body, interactionId, responsibleUserId } = await seedAwaitingResponseHold("person question");
    const app = createApp({ type: "board", source: "local_implicit", userId: responsibleUserId });
    const resolved = await request(app).post(`/api/issues/${sourceIssueId}/recovery-actions/resolve`).send(body).expect(200);
    // Bench, lot 20: an answer's wake only starts on a task in progress; the task goes back to in_progress.
    expect(resolved.body.issue.status).toBe("in_progress");
    const [recorded] = await db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.id, action.id));
    expect(recorded).toMatchObject({ status: "resolved", outcome: "restored",
      evidence: { continuationDelivery: "not_requested", awaitingResponseReconciliation: true } });
    expect(recorded!.evidence).not.toHaveProperty("dependencyBlockedReconciliation");
    expect(await db.select().from(agentTaskSessions).where(eq(agentTaskSessions.taskKey, sourceIssueId))).toEqual([]);
    await deliverReconciledExecutions(db, heartbeatService(db, { runtimeEnv: {} }).wakeup);
    expect(await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.retryOfRunId, cutRunId))).toEqual([]);
    const before = (await coderWakes(companyId, coderId)).length;
    await request(app).post(`/api/issues/${sourceIssueId}/interactions/${interactionId}/accept`).send({}).expect(200);
    const wakes = (await coderWakes(companyId, coderId)).slice(before);
    expect(wakes.filter(row => row.status !== "skipped")).toHaveLength(1);
    expect(wakes.filter(row => row.status === "deferred_issue_execution")).toHaveLength(0);
    // The run starts in a fresh session (the cut session was dropped) and its wake
    // names the answered question, so the role reads the question and its answer.
    const [answerRun] = await db.select().from(heartbeatRuns).where(and(eq(heartbeatRuns.agentId, coderId),
      sql`${heartbeatRuns.contextSnapshot}->>'issueId' = ${sourceIssueId}`, sql`${heartbeatRuns.id} <> ${cutRunId}`));
    expect(answerRun!.contextSnapshot).toMatchObject({ interactionId });
    // Not started yet (the agent's only slot is busy): the wait is not closed by a queued run.
    expect(await resumeWithdrawnAwaitingReconciliations(db)).toBe(0);
    const [stillOpen] = await db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.id, action.id));
    expect(stillOpen!.evidence).toMatchObject({ continuationDelivery: "not_requested" });
    // Through the real dispatcher (bench, lot 20, Q1): the answer's run starts; it is not cancelled
    // issue_not_in_progress as it was on a task left blocked.
    await db.update(heartbeatRuns).set({ status: "succeeded", finishedAt: new Date() })
      .where(and(eq(heartbeatRuns.agentId, coderId), eq(heartbeatRuns.status, "running"), sql`${heartbeatRuns.id} <> ${answerRun!.id}`));
    await heartbeatService(db, { runtimeEnv: {} }).resumeQueuedRuns();
    await vi.waitFor(async () => {
      const [current] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, answerRun!.id));
      expect(current!.status).not.toBe("queued");
    }, { timeout: 15_000 });
    const [dispatched] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, answerRun!.id));
    expect(dispatched!.errorCode).not.toBe("issue_not_in_progress");
    expect(dispatched!.status).not.toBe("cancelled");
    expect(dispatched!.startedAt).not.toBeNull();
    expect(dispatched!.resultJson ?? {}).not.toHaveProperty("preDispatchCancellation");
    // Answered and started: the withdrawn-wait hand-off never fires, and the wait is closed
    // as satisfied by the answer's run (no more checks, no continuation promised).
    expect(await resumeWithdrawnAwaitingReconciliations(db)).toBe(0);
    const [satisfied] = await db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.id, action.id));
    expect(satisfied!.evidence).toMatchObject({ continuationDelivery: "satisfied", awaitingResponseSatisfiedByRunId: answerRun!.id });
    expect(await resumeWithdrawnAwaitingReconciliations(db)).toBe(0);
    expect((await coderWakes(companyId, coderId)).filter(row => row.idempotencyKey === `execution-reconciliation:${action.id}`)).toHaveLength(0);
  });

  it.each(["answered, its wake still queued", "answered, no wake recorded yet", "closed by the person's comment"] as const)(
    "never delivers a continuation when the awaited question was %s", async (kind) => {
      const { companyId, coderId, sourceIssueId, action, body, interactionId, responsibleUserId } = await seedAwaitingResponseHold("person question");
      await request(createApp()).post(`/api/issues/${sourceIssueId}/recovery-actions/resolve`).send(body).expect(200);
      await db.update(issueThreadInteractions).set((kind === "closed by the person's comment"
        ? { status: "expired", result: { version: 1, outcome: "superseded_by_comment" } }
        : { status: "answered", resolvedByUserId: responsibleUserId }) as never)
        .where(eq(issueThreadInteractions.id, interactionId!));
      await db.update(issueThreadInteractions).set({ resolvedAt: new Date(), updatedAt: new Date() } as never)
        .where(eq(issueThreadInteractions.id, interactionId!));
      if (kind === "answered, its wake still queued") await db.insert(agentWakeupRequests).values({ companyId, agentId: coderId,
        source: "automation", triggerDetail: "system", reason: "issue_interaction_answered", status: "queued",
        payload: { issueId: sourceIssueId, interactionId } } as never);
      expect(await resumeWithdrawnAwaitingReconciliations(db)).toBe(0);
      const [recorded] = await db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.id, action.id));
      expect(recorded!.evidence).toMatchObject({ continuationDelivery: "not_requested", awaitingResponseReconciliation: true });
      await deliverReconciledExecutions(db, heartbeatService(db, { runtimeEnv: {} }).wakeup);
      expect((await coderWakes(companyId, coderId)).filter(row => row.idempotencyKey === `execution-reconciliation:${action.id}`)).toHaveLength(0);
    });

  it.each(["cancelled", "replaced by an agent card"] as const)(
    "delivers the spared continuation once when the awaited question is %s after the reconciliation", async (kind) => {
      const { companyId, coderId, managerId, sourceIssueId, action, body, interactionId } = await seedAwaitingResponseHold("person question");
      await request(createApp()).post(`/api/issues/${sourceIssueId}/recovery-actions/resolve`).send(body).expect(200);
      expect(await resumeWithdrawnAwaitingReconciliations(db)).toBe(0);
      await db.update(issueThreadInteractions).set({ status: "cancelled", resolvedAt: new Date(), updatedAt: new Date() } as never)
        .where(eq(issueThreadInteractions.id, interactionId!));
      if (kind === "replaced by an agent card") await db.insert(issueThreadInteractions).values({ companyId, issueId: sourceIssueId,
        kind: "request_confirmation", status: "pending", continuationPolicy: "none", addresseeAgentId: managerId,
        createdByAgentId: coderId, payload: { version: 1, prompt: "Executor interrupted." } } as never);
      expect(await resumeWithdrawnAwaitingReconciliations(db)).toBe(1);
      expect(await resumeWithdrawnAwaitingReconciliations(db)).toBe(0);
      const heartbeat = heartbeatService(db, { runtimeEnv: {} });
      await deliverReconciledExecutions(db, heartbeat.wakeup);
      await deliverReconciledExecutions(db, heartbeat.wakeup);
      const delivered = (await coderWakes(companyId, coderId)).filter(row => row.idempotencyKey === `execution-reconciliation:${action.id}`);
      expect(delivered).toHaveLength(1);
      const [recorded] = await db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.id, action.id));
      expect(recorded!.evidence).toMatchObject({ awaitingResponseReconciliation: true });
      expect(recorded!.evidence).toHaveProperty("awaitingResponseWithdrawnAt");
    });

  it("delivers one continuation when an answer came but no run followed it within fifteen minutes (lost wake)", async () => {
    const { companyId, coderId, sourceIssueId, action, body, interactionId, responsibleUserId } = await seedAwaitingResponseHold("person question");
    await request(createApp()).post(`/api/issues/${sourceIssueId}/recovery-actions/resolve`).send(body).expect(200);
    // Reconciled thirty minutes ago; answered twenty minutes ago; its wake was lost (no row, no run).
    await db.execute(sql`update issue_recovery_actions set evidence = jsonb_set(evidence, '{executionReconciliation,recordedAt}',
      to_jsonb((now() - interval '30 minutes')::text)) where id = ${action.id}`);
    const answeredAt = new Date(Date.now() - 20 * 60_000);
    await db.update(issueThreadInteractions).set({ status: "answered", resolvedByUserId: responsibleUserId, resolvedAt: answeredAt, updatedAt: answeredAt } as never)
      .where(eq(issueThreadInteractions.id, interactionId!));
    expect(await resumeWithdrawnAwaitingReconciliations(db)).toBe(1);
    expect(await resumeWithdrawnAwaitingReconciliations(db)).toBe(0);
    const heartbeat = heartbeatService(db, { runtimeEnv: {} });
    await deliverReconciledExecutions(db, heartbeat.wakeup);
    await deliverReconciledExecutions(db, heartbeat.wakeup);
    expect((await coderWakes(companyId, coderId)).filter(row => row.idempotencyKey === `execution-reconciliation:${action.id}`)).toHaveLength(1);
  });

  it("keeps an answer held behind the reconciled hold while a blocker added afterwards is open", async () => {
    const { companyId, coderId, sourceIssueId, prefix, body, interactionId, responsibleUserId } = await seedAwaitingResponseHold("person question");
    const app = createApp({ type: "board", source: "local_implicit", userId: responsibleUserId });
    await request(app).post(`/api/issues/${sourceIssueId}/interactions/${interactionId}/accept`).send({}).expect(200);
    const held = (await coderWakes(companyId, coderId)).filter(row => row.status === "deferred_issue_execution");
    expect(held).toHaveLength(1);
    await request(app).post(`/api/issues/${sourceIssueId}/recovery-actions/resolve`).send(body).expect(200);
    const blockerId = randomUUID();
    await db.insert(issues).values({ id: blockerId, companyId, title: "Blocker added later", status: "in_progress", priority: "medium",
      assigneeAgentId: coderId, issueNumber: 9, identifier: `${prefix}-9` });
    await db.insert(issueRelations).values({ companyId, issueId: blockerId, relatedIssueId: sourceIssueId, type: "blocks" });
    await db.update(heartbeatRuns).set({ status: "succeeded", finishedAt: new Date() })
      .where(and(eq(heartbeatRuns.agentId, coderId), eq(heartbeatRuns.status, "running")));
    await heartbeatService(db, { runtimeEnv: {} }).resumeQueuedRuns();
    const [still] = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, held[0]!.id));
    expect(still!.status).toBe("deferred_issue_execution");
  });

  it("never takes a run cancelled before it started for the answer's run (bench, lot 20, Q1)", async () => {
    const { companyId, coderId, sourceIssueId, action, body, interactionId, responsibleUserId } = await seedAwaitingResponseHold("person question");
    await request(createApp()).post(`/api/issues/${sourceIssueId}/recovery-actions/resolve`).send(body).expect(200);
    await db.execute(sql`update issue_recovery_actions set evidence = jsonb_set(evidence, '{executionReconciliation,recordedAt}',
      to_jsonb((now() - interval '30 minutes')::text)) where id = ${action.id}`);
    // The answer's run was cancelled before it started (the task was not in progress then).
    await db.insert(heartbeatRuns).values({ companyId, agentId: coderId, invocationSource: "automation", triggerDetail: "system",
      status: "cancelled", errorCode: "issue_not_in_progress", startedAt: null, finishedAt: new Date(Date.now() - 19 * 60_000),
      createdAt: new Date(Date.now() - 20 * 60_000), contextSnapshot: { issueId: sourceIssueId } } as never);
    const answeredAt = new Date(Date.now() - 20 * 60_000);
    await db.update(issueThreadInteractions).set({ status: "answered", resolvedByUserId: responsibleUserId, resolvedAt: answeredAt, updatedAt: answeredAt } as never)
      .where(eq(issueThreadInteractions.id, interactionId!));
    // Not satisfied by that run; the lost-answer hand-off delivers one continuation.
    expect(await resumeWithdrawnAwaitingReconciliations(db)).toBe(1);
    const [recorded] = await db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.id, action.id));
    expect(recorded!.evidence).toMatchObject({ continuationDelivery: "pending" });
    expect(recorded!.evidence).not.toHaveProperty("awaitingResponseSatisfiedByRunId");
  });

  it.each(["cancelled at the dispatcher's second gate", "failed while preparing, retry scheduled"] as const)(
    "never closes the wait with a run that did no provider work (%s)", async (kind) => {
      const { companyId, coderId, sourceIssueId, action, body, interactionId, responsibleUserId } = await seedAwaitingResponseHold("person question");
      await request(createApp()).post(`/api/issues/${sourceIssueId}/recovery-actions/resolve`).send(body).expect(200);
      await db.update(issueThreadInteractions).set({ status: "answered", resolvedByUserId: responsibleUserId, resolvedAt: new Date(), updatedAt: new Date() } as never)
        .where(eq(issueThreadInteractions.id, interactionId!));
      const at = new Date(Date.now() + 1000);
      if (kind === "cancelled at the dispatcher's second gate") {
        await db.insert(heartbeatRuns).values({ companyId, agentId: coderId, invocationSource: "automation", triggerDetail: "system",
          status: "cancelled", errorCode: "issue_waiting_for_response", startedAt: at, finishedAt: at, createdAt: at,
          resultJson: { preDispatchCancellation: { version: 1, providerWorkStarted: false, source: "stale_queued_run_gate" } },
          contextSnapshot: { issueId: sourceIssueId } } as never);
      } else {
        await db.insert(heartbeatRuns).values({ companyId, agentId: coderId, invocationSource: "automation", triggerDetail: "system",
          status: "failed", errorCode: "environment_provider_unavailable", startedAt: at, finishedAt: at, createdAt: at,
          resultJson: { executionRecovery: { kind: "bootstrap", providerWorkStarted: false } },
          contextSnapshot: { issueId: sourceIssueId } } as never);
        await db.insert(heartbeatRuns).values({ companyId, agentId: coderId, invocationSource: "automation", triggerDetail: "system",
          status: "scheduled_retry", createdAt: at, contextSnapshot: { issueId: sourceIssueId } } as never);
      }
      expect(await resumeWithdrawnAwaitingReconciliations(db)).toBe(0);
      const [recorded] = await db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.id, action.id));
      expect(recorded!.evidence).toMatchObject({ continuationDelivery: "not_requested" });
    });

  // Third review of lot 21: a person's comment posted while the assignee's run was working on the task is not an
  // answer to wait for; that run closes the wait.
  it("does not count a person's comment posted during the assignee's run as an answer", async () => {
    const { companyId, coderId, sourceIssueId, action, body, interactionId, responsibleUserId } = await seedAwaitingResponseHold("person question");
    await request(createApp()).post(`/api/issues/${sourceIssueId}/recovery-actions/resolve`).send(body).expect(200);
    await db.update(issueThreadInteractions).set({ status: "cancelled", resolvedAt: new Date(), updatedAt: new Date() } as never)
      .where(eq(issueThreadInteractions.id, interactionId!));
    const started = new Date(Date.now() + 1000), during = new Date(Date.now() + 2000), finished = new Date(Date.now() + 3000);
    const [reading] = await db.insert(heartbeatRuns).values({ companyId, agentId: coderId, invocationSource: "automation", triggerDetail: "system",
      status: "succeeded", startedAt: started, finishedAt: finished, createdAt: started, contextSnapshot: { issueId: sourceIssueId } } as never).returning();
    await db.insert(issueComments).values({ companyId, issueId: sourceIssueId, authorUserId: responsibleUserId, body: "Also check the import step.",
      createdAt: during } as never);
    expect(await resumeWithdrawnAwaitingReconciliations(db)).toBe(0);
    const [recorded] = await db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.id, action.id));
    expect(recorded!.evidence).toMatchObject({ continuationDelivery: "satisfied", awaitingResponseSatisfiedByRunId: reading!.id });
  });

  it("stops the five-minute checks once the task of an open wait is closed", async () => {
    const { sourceIssueId, body } = await seedAwaitingResponseHold("person question");
    await request(createApp()).post(`/api/issues/${sourceIssueId}/recovery-actions/resolve`).send(body).expect(200);
    expect(await nextAwaitingReconciliationCheckAt(db)).not.toBeNull();
    await db.update(issues).set({ status: "done" }).where(eq(issues.id, sourceIssueId));
    expect(await nextAwaitingReconciliationCheckAt(db)).toBeNull();
  });

  it("does not close the wait with a run that started before the answer", async () => {
    const { companyId, coderId, sourceIssueId, action, body, interactionId, responsibleUserId } = await seedAwaitingResponseHold("person question");
    await request(createApp()).post(`/api/issues/${sourceIssueId}/recovery-actions/resolve`).send(body).expect(200);
    const before = new Date(Date.now() + 500);
    await db.insert(heartbeatRuns).values({ companyId, agentId: coderId, invocationSource: "automation", triggerDetail: "system",
      status: "succeeded", startedAt: before, finishedAt: before, createdAt: before, contextSnapshot: { issueId: sourceIssueId } } as never);
    const answeredAt = new Date(Date.now() + 2000);
    await db.update(issueThreadInteractions).set({ status: "answered", resolvedByUserId: responsibleUserId, resolvedAt: answeredAt, updatedAt: answeredAt } as never)
      .where(eq(issueThreadInteractions.id, interactionId!));
    expect(await resumeWithdrawnAwaitingReconciliations(db)).toBe(0);
    const [recorded] = await db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.id, action.id));
    expect(recorded!.evidence).toMatchObject({ continuationDelivery: "not_requested" });
  });

  it("moves the task in progress when an approval is pending and an answer is held behind the hold", async () => {
    const { companyId, coderId, sourceIssueId, action, body, approvalId } = await seedAwaitingResponseHold("approval");
    try {
      await db.insert(agentWakeupRequests).values({ companyId, agentId: coderId, source: "on_demand", triggerDetail: "manual",
        reason: "issue_commented", status: "deferred_issue_execution", requestedByActorType: "user", requestedByActorId: "board-user",
        payload: { issueId: sourceIssueId, executionWait: { recoveryActionId: action.id, reason: "execution_recovery", message: "saved" } } } as never);
      const resolved = await request(createApp()).post(`/api/issues/${sourceIssueId}/recovery-actions/resolve`).send(body).expect(200);
      expect(resolved.body.issue.status).toBe("in_progress");
    } finally {
      await db.delete(agentWakeupRequests).where(and(eq(agentWakeupRequests.agentId, coderId), eq(agentWakeupRequests.status, "deferred_issue_execution")));
      await dropApproval(approvalId);
    }
  });

  it("keeps a task waiting on a person's question in progress while its assignee is not invokable", async () => {
    const { coderId, sourceIssueId, body } = await seedAwaitingResponseHold("person question");
    await request(createApp()).post(`/api/issues/${sourceIssueId}/recovery-actions/resolve`).send(body).expect(200);
    await db.update(heartbeatRuns).set({ status: "succeeded", finishedAt: new Date() })
      .where(and(eq(heartbeatRuns.agentId, coderId), eq(heartbeatRuns.status, "running")));
    await db.update(agents).set({ status: "error" }).where(eq(agents.id, coderId));
    try {
      await heartbeatService(db, { runtimeEnv: {} }).reconcileStrandedAssignedIssues();
      const [task] = await db.select().from(issues).where(eq(issues.id, sourceIssueId));
      expect(task!.status).toBe("in_progress");
    } finally {
      await db.update(agents).set({ status: "idle" }).where(eq(agents.id, coderId));
    }
  });

  it("re-checks a pending continuation at delivery and withdraws it when a question is pending again", async () => {
    const { companyId, coderId, managerId, sourceIssueId, action, body, interactionId, responsibleUserId } = await seedAwaitingResponseHold("person question");
    void managerId;
    await request(createApp()).post(`/api/issues/${sourceIssueId}/recovery-actions/resolve`).send(body).expect(200);
    await db.update(issueThreadInteractions).set({ status: "cancelled", resolvedAt: new Date(), updatedAt: new Date() } as never)
      .where(eq(issueThreadInteractions.id, interactionId!));
    await db.delete(agentWakeupRequests).where(and(eq(agentWakeupRequests.agentId, coderId), sql`${agentWakeupRequests.payload}->>'issueId' = ${sourceIssueId}`));
    expect(await resumeWithdrawnAwaitingReconciliations(db)).toBe(1);
    // Before delivery, the role asks the person again.
    await db.insert(issueThreadInteractions).values({ companyId, issueId: sourceIssueId, kind: "request_confirmation", status: "pending",
      continuationPolicy: "wake_assignee", addresseeUserId: responsibleUserId, createdByAgentId: coderId,
      payload: { version: 1, prompt: "Still extend the wait?" } } as never);
    await deliverReconciledExecutions(db, heartbeatService(db, { runtimeEnv: {} }).wakeup);
    expect((await coderWakes(companyId, coderId)).filter(row => row.idempotencyKey === `execution-reconciliation:${action.id}`)).toHaveLength(0);
    const [recorded] = await db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.id, action.id));
    expect(recorded!.evidence).toMatchObject({ continuationDelivery: "not_requested" });
    expect(recorded!.evidence).toHaveProperty("awaitingResponseRedeliveryWithdrawnAt");
  });

  it("never merges an answer held behind the hold into a claimed wake", async () => {
    const { companyId, coderId, sourceIssueId, body, interactionId, responsibleUserId } = await seedAwaitingResponseHold("person question");
    const app = createApp({ type: "board", source: "local_implicit", userId: responsibleUserId });
    await request(app).post(`/api/issues/${sourceIssueId}/interactions/${interactionId}/accept`).send({}).expect(200);
    const held = (await coderWakes(companyId, coderId)).filter(row => row.status === "deferred_issue_execution");
    await request(app).post(`/api/issues/${sourceIssueId}/recovery-actions/resolve`).send(body).expect(200);
    await db.insert(agentWakeupRequests).values({ companyId, agentId: coderId, source: "automation", triggerDetail: "system",
      reason: "issue_blockers_resolved", status: "claimed", payload: { issueId: sourceIssueId } } as never);
    await heartbeatService(db, { runtimeEnv: {} }).resumeQueuedRuns();
    const [kept] = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, held[0]!.id));
    expect(kept!.status).not.toBe("coalesced");
  });

  it("merges an answer held behind the hold into a wake of the same task already queued (bench, lot 20, Q6)", async () => {
    const { companyId, coderId, sourceIssueId, body, interactionId, responsibleUserId } = await seedAwaitingResponseHold("person question");
    const app = createApp({ type: "board", source: "local_implicit", userId: responsibleUserId });
    await request(app).post(`/api/issues/${sourceIssueId}/interactions/${interactionId}/accept`).send({}).expect(200);
    const held = (await coderWakes(companyId, coderId)).filter(row => row.status === "deferred_issue_execution");
    expect(held).toHaveLength(1);
    await request(app).post(`/api/issues/${sourceIssueId}/recovery-actions/resolve`).send(body).expect(200);
    // A wake of the same role on the same task is already queued (the dependency wake, for example).
    const [queued] = await db.insert(agentWakeupRequests).values({ companyId, agentId: coderId, source: "automation", triggerDetail: "system",
      reason: "issue_blockers_resolved", status: "queued", payload: { issueId: sourceIssueId } } as never).returning();
    await heartbeatService(db, { runtimeEnv: {} }).resumeQueuedRuns();
    const [merged] = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, held[0]!.id));
    expect(merged!.status).toBe("coalesced");
    expect(merged!.error).toContain(queued!.id);
  });

  it("does not release a message held behind a dependency-blocked reconciliation while the blocker is open", async () => {
    const { companyId, coderId, sourceIssueId, action, body, wakeBlockersResolved } = await seedDependencyBlockedLegacyHold("in_progress");
    void wakeBlockersResolved;
    // A user's message saved behind the hold.
    const [held] = await db.insert(agentWakeupRequests).values({ companyId, agentId: coderId, source: "on_demand", triggerDetail: "manual",
      reason: "issue_commented", status: "deferred_issue_execution", requestedByActorType: "user", requestedByActorId: "board-user",
      payload: { issueId: sourceIssueId, executionWait: { recoveryActionId: action.id, reason: "execution_recovery", message: "saved" } } } as never).returning();
    await request(createApp()).post(`/api/issues/${sourceIssueId}/recovery-actions/resolve`).send(body).expect(200);
    await heartbeatService(db, { runtimeEnv: {} }).resumeQueuedRuns();
    const [still] = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, held!.id));
    expect(still!.status).toBe("deferred_issue_execution");
  });


  it("releases an answer set aside during the hold once, without a continuation on top", async () => {
    const { companyId, coderId, sourceIssueId, cutRunId, action, body, interactionId, responsibleUserId } = await seedAwaitingResponseHold("person question");
    const app = createApp({ type: "board", source: "local_implicit", userId: responsibleUserId });
    await request(app).post(`/api/issues/${sourceIssueId}/interactions/${interactionId}/accept`).send({}).expect(200);
    const held = (await coderWakes(companyId, coderId)).filter(row => row.status === "deferred_issue_execution");
    expect(held).toHaveLength(1);
    await request(app).post(`/api/issues/${sourceIssueId}/recovery-actions/resolve`).send(body).expect(200);
    const [recorded] = await db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.id, action.id));
    expect(recorded!.evidence).toMatchObject({ continuationDelivery: "not_requested", awaitingResponseReconciliation: true });
    await deliverReconciledExecutions(db, heartbeatService(db, { runtimeEnv: {} }).wakeup);
    expect(await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.retryOfRunId, cutRunId))).toEqual([]);
    // Free the agent's only slot (held by another task in this fixture), then release.
    await db.update(heartbeatRuns).set({ status: "succeeded", finishedAt: new Date() })
      .where(and(eq(heartbeatRuns.agentId, coderId), eq(heartbeatRuns.status, "running")));
    await heartbeatService(db, { runtimeEnv: {} }).resumeQueuedRuns();
    const [released] = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, held[0]!.id));
    expect(released!.status).not.toBe("deferred_issue_execution");
    const issueRuns = await db.select().from(heartbeatRuns).where(and(eq(heartbeatRuns.companyId, companyId), eq(heartbeatRuns.agentId, coderId)));
    expect(issueRuns.filter(run => run.id !== cutRunId && (run.contextSnapshot as Record<string, unknown> | null)?.issueId === sourceIssueId)).toHaveLength(1);
  });

  it("reconciles without a continuation while an approval requested by the assignee is pending", async () => {
    const { sourceIssueId, action, body, approvalId } = await seedAwaitingResponseHold("approval");
    try {
      await request(createApp()).post(`/api/issues/${sourceIssueId}/recovery-actions/resolve`).send(body).expect(200);
      const [recorded] = await db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.id, action.id));
      expect(recorded!.evidence).toMatchObject({ continuationDelivery: "not_requested", awaitingResponseReconciliation: true });
    } finally {
      await dropApproval(approvalId);
    }
  });

  it.each(["agent question", "cancelled question", "replaced by an agent question"] as const)(
    "keeps the hold when the task does not wait on a person (%s)", async (kind) => {
      const seeded = await seedAwaitingResponseHold(kind === "agent question" ? "agent question" : "person question");
      const { companyId, coderId, managerId, sourceIssueId, action, body, interactionId } = seeded;
      if (kind !== "agent question") await db.update(issueThreadInteractions).set({ status: "cancelled" } as never)
        .where(eq(issueThreadInteractions.id, interactionId!));
      if (kind === "replaced by an agent question") await db.insert(issueThreadInteractions).values({ companyId, issueId: sourceIssueId,
        kind: "request_confirmation", status: "pending", continuationPolicy: "none", addresseeAgentId: managerId,
        createdByAgentId: coderId, payload: { version: 1, prompt: "Executor interrupted." } } as never);
      await request(createApp()).post(`/api/issues/${sourceIssueId}/recovery-actions/resolve`).send(body).expect(409);
      const [unchanged] = await db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.id, action.id));
      expect(unchanged).toMatchObject({ status: "resolved", outcome: "blocked", evidence: { automaticRecovery: { replay: "blocked" } } });
    });

  async function seedReconciledDelivery() {
    const fixture = await seedCompany();
    const { companyId, coderId, sourceIssueId } = fixture;
    const responsibleUserId = randomUUID();
    await db.insert(authUsers).values({
      id: responsibleUserId,
      name: "Recovery operator",
      email: `${responsibleUserId}@example.test`,
      emailVerified: true,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    await db
      .update(companies)
      .set({ defaultResponsibleUserId: responsibleUserId })
      .where(eq(companies.id, companyId));
    await db
      .update(agents)
      .set({ runtimeConfig: { heartbeat: { maxConcurrentRuns: 1 } } })
      .where(eq(agents.id, coderId));
    const previousRunId = randomUUID();
    await seedHeartbeatRun({
      companyId,
      agentId: coderId,
      runId: previousRunId,
      issueId: sourceIssueId,
      status: "failed",
    });
    // Occupy the agent's only dispatch slot, independently of this issue. These
    // tests exercise real wake admission, but cannot launch a provider process.
    await seedHeartbeatRun({
      companyId,
      agentId: coderId,
      runId: randomUUID(),
      status: "running",
    });
    const [action] = await db
      .insert(issueRecoveryActions)
      .values({
        companyId,
        sourceIssueId,
        kind: "active_run_watchdog",
        status: "resolved",
        outcome: "restored",
        ownerType: "board",
        returnOwnerAgentId: coderId,
        cause: "uncertain_external_action",
        fingerprint: previousRunId,
        nextAction: "Continue from the verified reconciliation.",
        evidence: {
          runId: previousRunId,
          continuationDelivery: "pending",
          executionReconciliation: {
            runId: previousRunId,
            providerStopped: true,
            actionOutcome: "not_performed",
            outcomeEvidence: "Verified absent provider effect.",
          },
        },
      })
      .returning();
    return {
      ...fixture,
      previousRunId,
      action: action!,
      heartbeat: heartbeatService(db, { runtimeEnv: {} }),
    };
  }

  async function seedDuplicateReconciliationHolds() {
    const fixture = await seedReconciledDelivery();
    const { action, companyId, sourceIssueId, previousRunId, coderId } = fixture;
    const evidence = {
      runId: previousRunId,
      automaticRecovery: { replay: "blocked", actionOutcome: "unknown" },
    };
    await db.update(issues).set({ status: "blocked" }).where(eq(issues.id, sourceIssueId));
    const [canonical] = await db.update(issueRecoveryActions).set({
      outcome: "blocked", evidence, cause: "legacy_execution_requires_reconciliation",
      fingerprint: `legacy-execution:${previousRunId}`,
    }).where(eq(issueRecoveryActions.id, action.id)).returning();
    const siblings = await db.insert(issueRecoveryActions).values([0, 1].map(() => ({
      companyId, sourceIssueId, kind: "active_run_watchdog", status: "resolved", outcome: "blocked",
      ownerType: "board", returnOwnerAgentId: coderId, cause: canonical!.cause,
      fingerprint: canonical!.fingerprint, nextAction: "Preserve recorded work without replay.", evidence,
    }))).returning();
    const body = {
      actionId: action.id,
      outcome: "restored",
      sourceIssueStatus: "todo",
      executionReconciliation: {
        runId: previousRunId,
        providerStopped: true,
        actionOutcome: "not_performed",
        outcomeEvidence: "Provider receipts confirm no external action was submitted and the provider is stopped.",
      },
    } as const;
    return { ...fixture, action: canonical!, siblings, body };
  }

  it("reconciles duplicate source holds in one request and delivers exactly one continuation", async () => {
    const { companyId, sourceIssueId, previousRunId, action, siblings, body, heartbeat } =
      await seedDuplicateReconciliationHolds();
    const app = createApp();
    await request(app).post(`/api/issues/${sourceIssueId}/recovery-actions/resolve`).send(body).expect(200);
    const actions = await db.select().from(issueRecoveryActions)
      .where(eq(issueRecoveryActions.sourceIssueId, sourceIssueId));
    expect(actions).toHaveLength(3);
    const canonical = actions.find((row) => row.id === action.id)!;
    expect(canonical).toMatchObject({ status: "resolved", evidence: {
      executionReconciliation: { runId: previousRunId }, continuationDelivery: "pending",
    } });
    expect(canonical.evidence).not.toHaveProperty("automaticRecovery");
    for (const sibling of siblings) {
      const recorded = actions.find((row) => row.id === sibling.id)!;
      expect(recorded).toMatchObject({ status: "resolved", evidence: {
        executionReconciliation: { runId: previousRunId },
        continuationDelivery: "invalidated",
        coalescedIntoRecoveryActionId: action.id,
      } });
      expect(recorded.evidence).not.toHaveProperty("automaticRecovery");
    }
    await request(app).post(`/api/issues/${sourceIssueId}/recovery-actions/resolve`).send(body).expect(200);
    await request(app).post(`/api/issues/${sourceIssueId}/recovery-actions/resolve`)
      .send({ ...body, actionId: siblings[0]!.id }).expect(200);
    expect(await db.select().from(issueRecoveryActions)
      .where(eq(issueRecoveryActions.sourceIssueId, sourceIssueId))).toEqual(actions);

    await deliverReconciledExecutions(db, heartbeat.wakeup);
    await deliverReconciledExecutions(db, heartbeat.wakeup);
    const wakes = await db.select().from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.companyId, companyId));
    expect(wakes).toHaveLength(1);
    expect(wakes[0]).toMatchObject({
      status: "queued", idempotencyKey: `execution-reconciliation:${action.id}`,
    });
    const successors = await db.select().from(heartbeatRuns)
      .where(eq(heartbeatRuns.retryOfRunId, previousRunId));
    expect(successors).toHaveLength(1);
    expect(successors[0]!.id).toBe(wakes[0]!.runId);
    const receipts = await db.select().from(issueRecoveryActions)
      .where(eq(issueRecoveryActions.sourceIssueId, sourceIssueId));
    expect(receipts.filter((row) => row.evidence.continuationDelivery === "delivered")).toHaveLength(1);
    expect(receipts.filter((row) => row.evidence.continuationDelivery === "invalidated")).toHaveLength(2);
    expect(receipts.some((row) => row.evidence.continuationDelivery === "pending")).toBe(false);
  });

  it("keeps one continuation owner when duplicate resolutions contend for the issue lock", async () => {
    const { companyId, sourceIssueId, previousRunId, action, siblings, body, heartbeat } =
      await seedDuplicateReconciliationHolds();
    const app = createApp();
    let release!: () => void;
    let ready!: () => void;
    const locked = new Promise<void>((resolve) => { ready = resolve; });
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const holder = db.transaction(async (tx) => {
      await tx.select({ id: issues.id }).from(issues)
        .where(eq(issues.id, sourceIssueId)).for("update");
      ready();
      await gate;
    });
    await locked;
    const resolutions = Promise.all([action.id, siblings[0]!.id].map((actionId) =>
      request(app).post(`/api/issues/${sourceIssueId}/recovery-actions/resolve`)
        .send({ ...body, actionId }).then((response) => response),
    ));
    let waiting = 0;
    try {
      const deadline = Date.now() + 5_000;
      while (waiting < 2 && Date.now() < deadline) {
        const [state] = await db.execute<{ waiting: number }>(sql`
          select count(*)::integer as waiting from pg_stat_activity
          where datname = current_database() and wait_event_type = 'Lock'
        `);
        waiting = state!.waiting;
        if (waiting < 2) await new Promise((resolve) => setTimeout(resolve, 20));
      }
    } finally {
      release();
      await holder;
    }
    const responses = await resolutions;
    expect(waiting, "both resolution requests must wait on actual database locks").toBe(2);
    expect(responses.map((response) => response.status)).toEqual([200, 200]);
    const records = await db.select().from(issueRecoveryActions)
      .where(eq(issueRecoveryActions.sourceIssueId, sourceIssueId));
    const owners = records.filter((row) => row.evidence.continuationDelivery === "pending");
    expect(owners).toHaveLength(1);
    const owner = owners[0]!;
    expect([action.id, siblings[0]!.id]).toContain(owner.id);
    const coalesced = records.filter((row) => row.id !== owner.id);
    expect(coalesced).toHaveLength(2);
    for (const row of coalesced) {
      expect(row.evidence).toMatchObject({
        continuationDelivery: "invalidated", coalescedIntoRecoveryActionId: owner.id,
      });
    }
    expect(records.every((row) => !("automaticRecovery" in row.evidence))).toBe(true);
    const audits = await db.select().from(activityLog).where(and(
      eq(activityLog.entityId, sourceIssueId),
      sql`${activityLog.details}->>'reason' = 'same_source_execution_reconciled'`,
    ));
    expect(audits).toHaveLength(1);
    expect(audits[0]!.details).toMatchObject({ recoveryActionId: owner.id });

    await deliverReconciledExecutions(db, heartbeat.wakeup);
    await deliverReconciledExecutions(db, heartbeat.wakeup);
    const wakes = await db.select().from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.companyId, companyId));
    expect(wakes).toHaveLength(1);
    expect(wakes[0]).toMatchObject({
      status: "queued", idempotencyKey: `execution-reconciliation:${owner.id}`,
    });
    const successors = await db.select().from(heartbeatRuns)
      .where(eq(heartbeatRuns.retryOfRunId, previousRunId));
    expect(successors).toHaveLength(1);
    expect(successors[0]!.id).toBe(wakes[0]!.runId);
  });

  it.each(["live provider", "active checkout"] as const)(
    "preserves all duplicate holds when a %s rejects reconciliation",
    async (guard) => {
      const { companyId, sourceIssueId, previousRunId, coderId, body, heartbeat } =
        await seedDuplicateReconciliationHolds();
      if (guard === "live provider") {
        await db.update(heartbeatRuns).set({ processPid: process.pid })
          .where(eq(heartbeatRuns.id, previousRunId));
      } else {
        const [running] = await db.select().from(heartbeatRuns).where(and(
          eq(heartbeatRuns.agentId, coderId), eq(heartbeatRuns.status, "running"),
        ));
        await db.update(issues).set({ executionRunId: running!.id })
          .where(eq(issues.id, sourceIssueId));
      }
      const before = await db.select().from(issueRecoveryActions)
        .where(eq(issueRecoveryActions.sourceIssueId, sourceIssueId)).orderBy(issueRecoveryActions.id);
      const [issueBefore] = await db.select().from(issues).where(eq(issues.id, sourceIssueId));
      const response = await request(createApp())
        .post(`/api/issues/${sourceIssueId}/recovery-actions/resolve`).send(body).expect(409);
      expect(response.body.error).toContain(guard === "live provider"
        ? "previous provider is still running" : "locked by another active checkout or run");
      expect(await db.select().from(issueRecoveryActions)
        .where(eq(issueRecoveryActions.sourceIssueId, sourceIssueId)).orderBy(issueRecoveryActions.id)).toEqual(before);
      expect((await db.select().from(issues).where(eq(issues.id, sourceIssueId)))[0]).toEqual(issueBefore);
      expect(await db.select().from(activityLog).where(eq(activityLog.entityId, sourceIssueId))).toEqual([]);
      await deliverReconciledExecutions(db, heartbeat.wakeup);
      expect(await db.select().from(agentWakeupRequests)
        .where(eq(agentWakeupRequests.companyId, companyId))).toEqual([]);
      expect(await db.select().from(heartbeatRuns)
        .where(eq(heartbeatRuns.retryOfRunId, previousRunId))).toEqual([]);
    },
  );

  it.each(["run", "issue", "company", "cause", "fingerprint", "kind", "replay"] as const)(
    "keeps an unrelated %s recovery hold when reconciling duplicate source holds",
    async (scope) => {
      const { action, sourceIssueId, previousRunId, companyId, coderId, body } =
        await seedDuplicateReconciliationHolds();
      let unrelatedCompanyId = companyId;
      let unrelatedIssueId: string = sourceIssueId;
      let unrelatedAgentId = coderId;
      let unrelatedRunId = previousRunId;
      if (scope === "run") {
        unrelatedRunId = randomUUID();
        await seedHeartbeatRun({ companyId, agentId: coderId, runId: unrelatedRunId,
          issueId: sourceIssueId, status: "failed" });
      } else if (scope === "issue") {
        const [otherIssue] = await db.insert(issues).values({
          companyId, title: "Unrelated blocked task", status: "blocked", assigneeAgentId: coderId,
        }).returning();
        unrelatedIssueId = otherIssue!.id;
      } else if (scope === "company") {
        const other = await seedCompany();
        unrelatedCompanyId = other.companyId;
        unrelatedAgentId = other.coderId;
      }
      const [unrelated] = await db.insert(issueRecoveryActions).values({
        companyId: unrelatedCompanyId, sourceIssueId: unrelatedIssueId,
        kind: scope === "kind" ? "missing_disposition" : "active_run_watchdog",
        status: "resolved", outcome: "blocked",
        ownerType: "board", returnOwnerAgentId: unrelatedAgentId,
        cause: scope === "cause" ? "uncertain_external_action" : action.cause,
        fingerprint: scope === "fingerprint" ? randomUUID() : action.fingerprint,
        nextAction: "Preserve this independent hold.",
        evidence: {
          runId: unrelatedRunId,
          automaticRecovery: {
            replay: scope === "replay" ? "conversation_continuation" : "blocked",
            actionOutcome: "unknown",
          },
        },
      }).returning();
      await request(createApp()).post(`/api/issues/${sourceIssueId}/recovery-actions/resolve`)
        .send(body).expect(200);
      const [after] = await db.select().from(issueRecoveryActions)
        .where(eq(issueRecoveryActions.id, unrelated!.id));
      expect(after).toEqual(unrelated);
    },
  );

  const protectedRecoveryEvidence = [
    { key: "workspaceRestoreFailure", value: "restore_failed" },
    { key: "workspaceRestoreRecovery", value: { schema: "paperclip.workspace-restore-recovery.v1" } },
    { key: "systemRecovery", value: { state: "pending" } },
  ] as const;

  it.each(protectedRecoveryEvidence)(
    "does not coalesce duplicate holds from a source with $key evidence",
    async ({ key, value }) => {
      const { action, siblings, body } = await seedDuplicateReconciliationHolds();
      const [source] = await db.update(issueRecoveryActions).set({
        evidence: { ...action.evidence, [key]: value },
      }).where(eq(issueRecoveryActions.id, action.id)).returning();
      await db.transaction(async (tx) => {
        await tx.select().from(issues).where(eq(issues.id, action.sourceIssueId)).for("update");
        await markExecutionReconciliation(tx as unknown as typeof db, source!, body.executionReconciliation, "operator");
      });
      for (const sibling of siblings) {
        const [after] = await db.select().from(issueRecoveryActions)
          .where(eq(issueRecoveryActions.id, sibling.id));
        expect(after).toEqual(sibling);
      }
    },
  );

  it.each(protectedRecoveryEvidence)(
    "preserves sibling $key evidence when reconciling ordinary duplicate holds",
    async ({ key, value }) => {
      const { sourceIssueId, siblings, body, action } = await seedDuplicateReconciliationHolds();
      const [protectedSibling] = await db.update(issueRecoveryActions).set({
        evidence: { ...siblings[0]!.evidence, [key]: value },
      }).where(eq(issueRecoveryActions.id, siblings[0]!.id)).returning();
      await request(createApp()).post(`/api/issues/${sourceIssueId}/recovery-actions/resolve`)
        .send(body).expect(200);
      const [after] = await db.select().from(issueRecoveryActions)
        .where(eq(issueRecoveryActions.id, protectedSibling!.id));
      expect(after).toEqual(protectedSibling);
      const [ordinarySibling] = await db.select().from(issueRecoveryActions)
        .where(eq(issueRecoveryActions.id, siblings[1]!.id));
      expect(ordinarySibling!.evidence).toMatchObject({
        continuationDelivery: "invalidated", coalescedIntoRecoveryActionId: action.id,
      });
    },
  );

  it("preserves an already reconciled sibling when reconciling ordinary duplicate holds", async () => {
    const { sourceIssueId, siblings, body, action } = await seedDuplicateReconciliationHolds();
    const [reconciledSibling] = await db.update(issueRecoveryActions).set({
      evidence: {
        ...siblings[0]!.evidence,
        executionReconciliation: { ...body.executionReconciliation, actorId: "previous-operator" },
        continuationDelivery: "pending",
      },
    }).where(eq(issueRecoveryActions.id, siblings[0]!.id)).returning();
    await request(createApp()).post(`/api/issues/${sourceIssueId}/recovery-actions/resolve`)
      .send(body).expect(200);
    const [after] = await db.select().from(issueRecoveryActions)
      .where(eq(issueRecoveryActions.id, reconciledSibling!.id));
    expect(after).toEqual(reconciledSibling);
    const [ordinarySibling] = await db.select().from(issueRecoveryActions)
      .where(eq(issueRecoveryActions.id, siblings[1]!.id));
    expect(ordinarySibling!.evidence).toMatchObject({
      continuationDelivery: "invalidated", coalescedIntoRecoveryActionId: action.id,
    });
  });

  it("records retained workspace repair without coalescing holds or requesting a continuation", async () => {
    const { action, siblings, body } = await seedDuplicateReconciliationHolds();
    const [source] = await db.update(issueRecoveryActions).set({
      evidence: {
        ...action.evidence,
        workspaceRestoreFailure: "restore_failed",
        workspaceRestoreRecovery: { schema: "paperclip.workspace-restore-recovery.v1", leaseIds: [] },
      },
    }).where(eq(issueRecoveryActions.id, action.id)).returning();
    await db.transaction(async (tx) => {
      await tx.select().from(issues).where(eq(issues.id, action.sourceIssueId)).for("update");
      await markExecutionReconciliation(tx as unknown as typeof db, source!, {
        ...body.executionReconciliation,
        workspaceRepairEvidence: "Recovered the retained workspace files and verified the saved manifest.",
      }, "operator", undefined, { workspaceRepairOnly: true });
    });
    const [repaired] = await db.select().from(issueRecoveryActions)
      .where(eq(issueRecoveryActions.id, source!.id));
    expect(repaired!.evidence).toMatchObject({
      executionReconciliation: { runId: body.executionReconciliation.runId },
      continuationDelivery: "not_requested",
    });
    for (const sibling of siblings) {
      const [after] = await db.select().from(issueRecoveryActions)
        .where(eq(issueRecoveryActions.id, sibling.id));
      expect(after).toEqual(sibling);
    }
    const wake = vi.fn(async () => null);
    await deliverReconciledExecutions(db, wake);
    expect(wake).not.toHaveBeenCalled();
  });

  it("delivers a reconciled execution once across concurrent sweeps without a deferred duplicate", async () => {
    const { action, heartbeat } = await seedReconciledDelivery();
    let entered = 0;
    let release!: () => void;
    const bothEntered = new Promise<void>((resolve) => {
      release = resolve;
    });
    const wake: typeof heartbeat.wakeup = async (...args) => {
      entered += 1;
      if (entered === 2) release();
      await bothEntered;
      return heartbeat.wakeup(...args);
    };
    await Promise.all([
      deliverReconciledExecutions(db, wake),
      deliverReconciledExecutions(db, wake),
    ]);
    const wakes = await db
      .select()
      .from(agentWakeupRequests)
      .where(
        eq(
          agentWakeupRequests.idempotencyKey,
          `execution-reconciliation:${action.id}`,
        ),
      );
    expect(wakes).toHaveLength(1);
    expect(wakes[0]).toMatchObject({ status: "queued" });
    const [receipt] = await db
      .select()
      .from(issueRecoveryActions)
      .where(eq(issueRecoveryActions.id, action.id));
    expect(receipt!.evidence).toMatchObject({
      continuationDelivery: "delivered",
      continuationRunId: wakes[0]!.runId,
    });
  });

  it("reconciles a lost wake acknowledgement after the exact successor has already finished", async () => {
    const { action, heartbeat, companyId, previousRunId } =
      await seedReconciledDelivery();
    let successorId: string | undefined;
    await deliverReconciledExecutions(db, async (...args) => {
      const run = await heartbeat.wakeup(...args);
      expect(run).not.toBeNull();
      successorId = run!.id;
      expect(run!.retryOfRunId).toBe(previousRunId);
      throw new Error("fixture lost post-commit wake acknowledgement");
    });
    expect(successorId).toBeDefined();
    await db
      .update(heartbeatRuns)
      .set({ status: "succeeded", finishedAt: new Date() })
      .where(eq(heartbeatRuns.id, successorId!));
    await deliverReconciledExecutions(db, heartbeat.wakeup);
    const wakes = await db
      .select()
      .from(agentWakeupRequests)
      .where(
        eq(
          agentWakeupRequests.idempotencyKey,
          `execution-reconciliation:${action.id}`,
        ),
      );
    expect(wakes).toHaveLength(1);
    const [successor] = await db
      .select()
      .from(heartbeatRuns)
      .where(
        and(
          eq(heartbeatRuns.companyId, companyId),
          eq(heartbeatRuns.id, successorId!),
        ),
      );
    expect(successor).toMatchObject({
      status: "succeeded",
      retryOfRunId: previousRunId,
    });
    const [receipt] = await db
      .select()
      .from(issueRecoveryActions)
      .where(eq(issueRecoveryActions.id, action.id));
    expect(receipt!.evidence).toMatchObject({
      continuationDelivery: "delivered",
      continuationRunId: successorId,
    });
  });

  it.each(["owner", "status", "decision"] as const)(
    "rechecks the current reconciliation %s after the sweep read",
    async (changed) => {
      const { action, heartbeat, sourceIssueId, managerId } =
        await seedReconciledDelivery();
      await deliverReconciledExecutions(db, async (...args) => {
        if (changed === "owner")
          await db
            .update(issues)
            .set({ assigneeAgentId: managerId })
            .where(eq(issues.id, sourceIssueId));
        if (changed === "status")
          await db
            .update(issues)
            .set({ status: "done" })
            .where(eq(issues.id, sourceIssueId));
        if (changed === "decision")
          await db
            .update(issueRecoveryActions)
            .set({
              evidence: {
                ...action.evidence,
                executionReconciliation: {
                  ...(action.evidence.executionReconciliation as object),
                  runId: randomUUID(),
                },
              },
            })
            .where(eq(issueRecoveryActions.id, action.id));
        return heartbeat.wakeup(...args);
      });
      expect(
        await db
          .select()
          .from(agentWakeupRequests)
          .where(
            eq(
              agentWakeupRequests.idempotencyKey,
              `execution-reconciliation:${action.id}`,
            ),
          ),
      ).toHaveLength(0);
      const [receipt] = await db
        .select()
        .from(issueRecoveryActions)
        .where(eq(issueRecoveryActions.id, action.id));
      expect(receipt!.evidence.continuationDelivery).toBe("pending");
    },
  );

  it("keeps reconciliation pending behind unrelated issue work without creating a second deferred outbox", async () => {
    const { action, heartbeat, sourceIssueId, companyId, coderId } =
      await seedReconciledDelivery();
    const occupiedRunId = randomUUID();
    await seedHeartbeatRun({
      companyId,
      agentId: coderId,
      runId: occupiedRunId,
      issueId: sourceIssueId,
      status: "queued",
    });
    await deliverReconciledExecutions(db, heartbeat.wakeup);
    await deliverReconciledExecutions(db, heartbeat.wakeup);
    expect(
      await db
        .select()
        .from(agentWakeupRequests)
        .where(
          eq(
            agentWakeupRequests.idempotencyKey,
            `execution-reconciliation:${action.id}`,
          ),
        ),
    ).toHaveLength(0);
    const [occupied] = await db
      .select()
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.id, occupiedRunId));
    expect(occupied!.contextSnapshot).toEqual({ issueId: sourceIssueId });
    await db
      .update(heartbeatRuns)
      .set({ status: "succeeded", finishedAt: new Date() })
      .where(eq(heartbeatRuns.id, occupiedRunId));
    await deliverReconciledExecutions(db, heartbeat.wakeup);
    const wakes = await db
      .select()
      .from(agentWakeupRequests)
      .where(
        eq(
          agentWakeupRequests.idempotencyKey,
          `execution-reconciliation:${action.id}`,
        ),
      );
    expect(wakes).toHaveLength(1);
    expect(wakes[0]!.runId).not.toBe(occupiedRunId);
  });

  it("does not overwrite a newer reconciliation decision after a prior wake commits", async () => {
    const { action, heartbeat } = await seedReconciledDelivery();
    const newerEvidence = {
      ...action.evidence,
      continuationDelivery: "invalidated",
      operatorNote: "Do not continue after new evidence.",
    };
    await deliverReconciledExecutions(db, async (...args) => {
      const run = await heartbeat.wakeup(...args);
      expect(run).not.toBeNull();
      await db
        .update(issueRecoveryActions)
        .set({ evidence: newerEvidence })
        .where(eq(issueRecoveryActions.id, action.id));
      return run;
    });
    const [receipt] = await db
      .select()
      .from(issueRecoveryActions)
      .where(eq(issueRecoveryActions.id, action.id));
    expect(receipt!.evidence).toEqual(newerEvidence);
  });

  it("resolves an active recovery action and removes it from active projections", async () => {
    const { companyId, managerId, sourceIssueId } = await seedCompany();
    const recoveryActionSvc = issueRecoveryActionService(db);
    const action = await recoveryActionSvc.upsertSourceScoped({
      companyId,
      sourceIssueId,
      kind: "missing_disposition",
      ownerType: "agent",
      ownerAgentId: managerId,
      cause: "successful_run_missing_issue_disposition",
      fingerprint: "missing-disposition:fingerprint",
      evidence: { sourceRunId: "run-1" },
      nextAction: "Choose a valid issue disposition.",
      wakePolicy: { type: "wake_owner" },
    });
    const app = createApp();

    const resolved = await request(app)
      .post(`/api/issues/${sourceIssueId}/recovery-actions/resolve`)
      .send({
        actionId: action.id,
        outcome: "restored",
        sourceIssueStatus: "done",
        resolutionNote: "Operator confirmed the source issue is complete.",
      })
      .expect(200);

    expect(resolved.body.issue).toMatchObject({
      id: sourceIssueId,
      status: "done",
      activeRecoveryAction: null,
    });
    expect(resolved.body.recoveryAction).toMatchObject({
      id: action.id,
      status: "resolved",
      outcome: "owner_completed",
      resolutionNote: "Operator confirmed the source issue is complete.",
    });
    expect(resolved.body.recoveryAction.resolvedAt).toBeTruthy();
    expect(await recoveryActionSvc.getActiveForIssue(companyId, sourceIssueId)).toBeNull();
    expect(
      await db
        .select()
        .from(issueInboxArchives)
        .where(eq(issueInboxArchives.issueId, sourceIssueId)),
    ).toHaveLength(1);

    const detail = await request(app).get(`/api/issues/${sourceIssueId}`).expect(200);
    expect(detail.body.activeRecoveryAction).toBeNull();

    const activityRows = await db
      .select()
      .from(activityLog)
      .where(eq(activityLog.entityId, sourceIssueId));
    expect(activityRows.map((row) => row.action)).toEqual(
      expect.arrayContaining(["issue.updated", "issue.recovery_action_resolved"]),
    );
  });

  it.each(["ask_user_questions", "request_confirmation"] as const)("does not retry past a new pending %s", async (kind) => {
    const { companyId, coderId, sourceIssueId } = await seedCompany();
    await db.update(issues).set({ status: "blocked", assigneeAgentId: coderId }).where(eq(issues.id, sourceIssueId));
    const action = await issueRecoveryActionService(db).upsertSourceScoped({
      companyId, sourceIssueId, kind: "deliberate_wait_without_target", ownerType: "board",
      returnOwnerAgentId: coderId, cause: "deliberate_wait_without_target", fingerprint: "disposition:pending-interaction",
      nextAction: "Review the outcome.", wakePolicy: { type: "board_escalation" },
    });
    const [interaction] = await db.insert(issueThreadInteractions).values({
      companyId, issueId: sourceIssueId, kind, status: "pending", createdByAgentId: coderId,
      payload: kind === "request_confirmation"
        ? { version: 1, prompt: "Confirm the next step." }
        : { version: 1, questions: [{ id: "next", prompt: "Which step?", selectionMode: "single", options: [{ id: "a", label: "A" }] }] },
    }).returning();
    const wake = vi.fn(async () => null);
    const app = createApp(undefined, { recoveryActionEnqueueWakeup: wake });
    const body = { actionId: action.id, outcome: "restored", sourceIssueStatus: "todo" };
    const denied = await request(app).post(`/api/issues/${sourceIssueId}/recovery-actions/resolve`).send(body).expect(409);
    expect(denied.body.details?.code).toBe("disposition_recovery_interaction_pending");
    expect(wake).not.toHaveBeenCalled();
    expect(await db.select().from(issues).where(eq(issues.id, sourceIssueId))).toEqual([
      expect.objectContaining({ status: "blocked", assigneeAgentId: coderId }),
    ]);
    expect(await issueRecoveryActionService(db).getActiveForIssue(companyId, sourceIssueId)).toMatchObject({ id: action.id });
    expect(await db.select().from(issueThreadInteractions).where(eq(issueThreadInteractions.id, interaction!.id))).toEqual([
      expect.objectContaining({ status: "pending" }),
    ]);
    expect(await db.select().from(activityLog).where(eq(activityLog.entityId, sourceIssueId))).toHaveLength(0);
    // A settled interaction must not leave a permanent retry veto.
    await db.update(issueThreadInteractions).set({ status: "resolved", resolvedAt: new Date() }).where(eq(issueThreadInteractions.id, interaction!.id));
    await request(app).post(`/api/issues/${sourceIssueId}/recovery-actions/resolve`).send(body).expect(200);
    expect(wake).toHaveBeenCalledTimes(1);
  });

  it("retries an exhausted disposition action once, preserving the owner and audit trail", async () => {
    const { companyId, coderId, sourceIssueId } = await seedCompany();
    await db.update(issues).set({ status: "blocked", assigneeAgentId: coderId }).where(eq(issues.id, sourceIssueId));
    const action = await issueRecoveryActionService(db).upsertSourceScoped({
      companyId, sourceIssueId, kind: "deliberate_wait_without_target", ownerType: "board",
      previousOwnerAgentId: coderId, returnOwnerAgentId: coderId, cause: "deliberate_wait_without_target",
      fingerprint: "disposition:exhausted", evidence: { terminalReason: "unchanged_source_state_exhausted", sourceAttemptCount: 2, sourceMaxAttempts: 2 },
      nextAction: "Review the outcome.", wakePolicy: { type: "board_escalation" },
    });
    const wake = vi.fn(async () => null);
    const app = createApp(undefined, { recoveryActionEnqueueWakeup: wake });
    const body = { actionId: action.id, outcome: "restored", sourceIssueStatus: "todo" };
    const first = await request(app).post(`/api/issues/${sourceIssueId}/recovery-actions/resolve`).send(body).expect(200);
    expect(first.body.issue).toMatchObject({ status: "todo", assigneeAgentId: coderId, activeRecoveryAction: null });
    expect(first.body.recoveryAction).toMatchObject({ id: action.id, status: "resolved", outcome: "handed_back" });
    await request(app).post(`/api/issues/${sourceIssueId}/recovery-actions/resolve`).send(body).expect(200);
    expect(wake).toHaveBeenCalledTimes(1);
    const logs = await db.select().from(activityLog).where(eq(activityLog.entityId, sourceIssueId));
    expect(logs.filter(entry => entry.action === "issue.recovery_action_resolved")).toHaveLength(1);
    expect((await db.select().from(issues).where(eq(issues.id, sourceIssueId)))[0]).toMatchObject({ status: "todo", assigneeAgentId: coderId });
  });

  it("hands restored work back to the recorded return owner and records the outcome", async () => {
    const { companyId, managerId, coderId, sourceIssueId } = await seedCompany();
    await db
      .update(issues)
      .set({ status: "blocked", assigneeAgentId: coderId })
      .where(eq(issues.id, sourceIssueId));
    const recoveryActionSvc = issueRecoveryActionService(db);
    const action = await recoveryActionSvc.upsertSourceScoped({
      companyId,
      sourceIssueId,
      kind: "workspace_validation",
      ownerType: "agent",
      ownerAgentId: managerId,
      previousOwnerAgentId: coderId,
      returnOwnerAgentId: coderId,
      cause: "workspace_validation_failed",
      fingerprint: "workspace:fingerprint",
      evidence: { latestRunId: "run-1" },
      nextAction: "Repair the workspace and hand the issue back.",
      wakePolicy: { type: "wake_owner" },
    });

    const enqueueRecoveryActionWakeup = vi.fn(async () => null);
    const resolved = await request(createApp(undefined, {
      recoveryActionEnqueueWakeup: enqueueRecoveryActionWakeup,
    }))
      .post(`/api/issues/${sourceIssueId}/recovery-actions/resolve`)
      .send({
        actionId: action.id,
        outcome: "restored",
        sourceIssueStatus: "todo",
        resolutionNote: "Workspace repaired.",
      })
      .expect(200);

    expect(resolved.body.issue).toMatchObject({
      id: sourceIssueId,
      status: "todo",
      assigneeAgentId: coderId,
      activeRecoveryAction: null,
    });
    expect(resolved.body.recoveryAction).toMatchObject({
      id: action.id,
      status: "resolved",
      outcome: "handed_back",
    });
    expect(enqueueRecoveryActionWakeup).toHaveBeenCalledWith(
      coderId,
      expect.objectContaining({
        reason: "issue_recovery_action_restored",
        payload: expect.objectContaining({ issueId: sourceIssueId, recoveryActionId: action.id }),
      }),
    );
  });

  it("does not enqueue a restored wake when todo status and assignee are unchanged", async () => {
    const { companyId, managerId, coderId, sourceIssueId } = await seedCompany();
    await db
      .update(issues)
      .set({ status: "todo", assigneeAgentId: coderId })
      .where(eq(issues.id, sourceIssueId));
    const recoveryActionSvc = issueRecoveryActionService(db);
    const action = await recoveryActionSvc.upsertSourceScoped({
      companyId,
      sourceIssueId,
      kind: "workspace_validation",
      ownerType: "agent",
      ownerAgentId: managerId,
      previousOwnerAgentId: coderId,
      returnOwnerAgentId: coderId,
      cause: "workspace_validation_failed",
      fingerprint: "workspace:already-restored",
      evidence: { latestRunId: "run-1" },
      nextAction: "Confirm the workspace remains healthy.",
      wakePolicy: { type: "wake_owner" },
    });

    const enqueueRecoveryActionWakeup = vi.fn(async () => null);
    await request(createApp(undefined, {
      recoveryActionEnqueueWakeup: enqueueRecoveryActionWakeup,
    }))
      .post(`/api/issues/${sourceIssueId}/recovery-actions/resolve`)
      .send({
        actionId: action.id,
        outcome: "restored",
        sourceIssueStatus: "todo",
        resolutionNote: "Workspace was already restored.",
      })
      .expect(200);

    expect(enqueueRecoveryActionWakeup).not.toHaveBeenCalled();
  });

  it("resolves an active recovery action by returning the source issue to todo", async () => {
    const { companyId, managerId, sourceIssueId } = await seedCompany();
    await db
      .update(issues)
      .set({ status: "blocked", assigneeAgentId: null, assigneeUserId: "board-user" })
      .where(eq(issues.id, sourceIssueId));
    const recoveryActionSvc = issueRecoveryActionService(db);
    const action = await recoveryActionSvc.upsertSourceScoped({
      companyId,
      sourceIssueId,
      kind: "issue_graph_liveness",
      ownerType: "agent",
      ownerAgentId: managerId,
      cause: "issue_graph_liveness",
      fingerprint: "graph-liveness:try-again",
      evidence: { latestIssueStatus: "blocked" },
      nextAction: "Restore a live execution path.",
      wakePolicy: { type: "manual" },
    });
    const app = createApp();

    const resolved = await request(app)
      .post(`/api/issues/${sourceIssueId}/recovery-actions/resolve`)
      .send({
        actionId: action.id,
        outcome: "restored",
        sourceIssueStatus: "todo",
        resolutionNote: "Try the source issue again.",
      })
      .expect(200);

    expect(resolved.body.issue).toMatchObject({
      id: sourceIssueId,
      status: "todo",
      activeRecoveryAction: null,
    });
    expect(resolved.body.recoveryAction).toMatchObject({
      id: action.id,
      status: "resolved",
      outcome: "restored",
      resolutionNote: "Try the source issue again.",
    });
    expect(await recoveryActionSvc.getActiveForIssue(companyId, sourceIssueId)).toBeNull();
  });

  it("marks a recovery action stale when a blocked source issue is manually moved to todo", async () => {
    const { companyId, managerId, sourceIssueId } = await seedCompany();
    await db
      .update(issues)
      .set({ status: "blocked", assigneeAgentId: null, assigneeUserId: "board-user" })
      .where(eq(issues.id, sourceIssueId));
    const recoveryActionSvc = issueRecoveryActionService(db);
    const action = await recoveryActionSvc.upsertSourceScoped({
      companyId,
      sourceIssueId,
      kind: "issue_graph_liveness",
      ownerType: "agent",
      ownerAgentId: managerId,
      cause: "issue_graph_liveness",
      fingerprint: "graph-liveness:manual-restore",
      evidence: { latestIssueStatus: "blocked" },
      nextAction: "Restore a live execution path.",
      wakePolicy: { type: "manual" },
    });
    const app = createApp();

    const patched = await request(app)
      .patch(`/api/issues/${sourceIssueId}`)
      .send({ status: "todo" })
      .expect(200);

    expect(patched.body).toMatchObject({
      id: sourceIssueId,
      status: "todo",
      activeRecoveryAction: null,
    });

    const [actionRow] = await db
      .select()
      .from(issueRecoveryActions)
      .where(eq(issueRecoveryActions.id, action.id));
    expect(actionRow).toMatchObject({
      status: "cancelled",
      outcome: "cancelled",
      resolutionNote: "Recovery action became stale because the source issue was manually moved from blocked to todo.",
    });
    expect(actionRow?.resolvedAt).toBeTruthy();
    expect(await recoveryActionSvc.getActiveForIssue(companyId, sourceIssueId)).toBeNull();

    const detail = await request(app).get(`/api/issues/${sourceIssueId}`).expect(200);
    expect(detail.body.activeRecoveryAction).toBeNull();

    const activityRows = await db
      .select()
      .from(activityLog)
      .where(eq(activityLog.entityId, sourceIssueId));
    expect(activityRows.map((row) => row.action)).toEqual(
      expect.arrayContaining(["issue.updated", "issue.recovery_action_resolved"]),
    );
    expect(activityRows.find((row) => row.action === "issue.recovery_action_resolved")?.details).toMatchObject({
      source: "source_revalidation",
      trigger: "issue_update",
    });
  });

  it("folds stale recovery during read projection after the source issue reaches done", async () => {
    const { companyId, managerId, sourceIssueId } = await seedCompany();
    const recoveryActionSvc = issueRecoveryActionService(db);
    const action = await recoveryActionSvc.upsertSourceScoped({
      companyId,
      sourceIssueId,
      kind: "issue_graph_liveness",
      ownerType: "agent",
      ownerAgentId: managerId,
      cause: "issue_graph_liveness",
      fingerprint: "graph-liveness:done-projection",
      evidence: { latestIssueStatus: "in_progress" },
      nextAction: "Restore a live execution path.",
      wakePolicy: { type: "manual" },
    });
    await db.update(issues).set({ status: "done" }).where(eq(issues.id, sourceIssueId));
    const app = createApp();

    const detail = await request(app).get(`/api/issues/${sourceIssueId}`).expect(200);

    expect(detail.body).toMatchObject({
      id: sourceIssueId,
      status: "done",
      activeRecoveryAction: null,
    });
    const [actionRow] = await db
      .select()
      .from(issueRecoveryActions)
      .where(eq(issueRecoveryActions.id, action.id));
    expect(actionRow).toMatchObject({
      status: "cancelled",
      outcome: "cancelled",
      resolutionNote: "Recovery action became stale because the source issue reached done.",
    });
    expect(actionRow?.resolvedAt).toBeTruthy();

    const activityRows = await db
      .select()
      .from(activityLog)
      .where(eq(activityLog.entityId, sourceIssueId));
    expect(activityRows.find((row) => row.action === "issue.recovery_action_resolved")?.details).toMatchObject({
      source: "source_revalidation",
      trigger: "read_projection",
      recoveryActionId: action.id,
    });
    expect(activityRows.find((row) => row.action === "issue.recovery_action_resolved")).toMatchObject({
      actorType: "system", actorId: "recovery", agentId: null,
    });
  });

  it.each(["done", "cancelled"])("keeps one workspace owner hold across reads and sweeps of a %s task", async (status) => {
    const { companyId, coderId, sourceIssueId } = await seedCompany();
    const runId = randomUUID();
    const owner = { token: randomUUID(), hostname: "old-controller.invalid", pid: 42, processStartedAt: new Date(0).toISOString() };
    await db.insert(heartbeatRuns).values({
      id: runId, companyId, agentId: coderId, nativeIssueId: sourceIssueId,
      runtimeMode: "native", status: "failed", finishedAt: new Date(),
      runnerProfileJson: { nativeWorkspaceFinalizationOwner: owner },
    });
    await db.update(issues).set({ status }).where(eq(issues.id, sourceIssueId));
    const userId = "board-reader";
    const app = createApp({ type: "board", source: "local_implicit", userId });
    const copyback = vi.fn();
    const recovery = recoveryService(db, { enqueueWakeup: vi.fn(async () => null) });
    let firstAction: typeof issueRecoveryActions.$inferSelect | undefined;
    for (let tick = 0; tick < 3; tick += 1) {
      expect(await withNativeWorkspaceFinalizationOwnership({ db, companyId, runId }, copyback)).toEqual({ acquired: false, reason: "owner_unverified" });
      const detail = await request(app).get(`/api/issues/${sourceIssueId}`).expect(200);
      expect(detail.body.activeRecoveryAction).toMatchObject({
        cause: "native_workspace_finalization_owner_unverified", status: "active", attemptCount: 1,
      });
      await request(app).get(`/api/companies/${companyId}/issues?view=compact`).expect(200);
      await request(app).get(`/api/issues/${sourceIssueId}/recovery-actions`).expect(200);
      await recovery.reconcileStrandedAssignedIssues();
      const actions = await db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.sourceIssueId, sourceIssueId));
      expect(actions).toHaveLength(1);
      firstAction ??= actions[0]!;
      expect(actions[0]).toEqual(firstAction);
    }
    expect(copyback).not.toHaveBeenCalled();
    expect(await issueService(db).list(companyId, { touchedByUserId: userId })).toEqual([]);
    expect(await db.select().from(activityLog).where(eq(activityLog.entityId, sourceIssueId))).toHaveLength(0);

    // Only clearing the exact physical owner receipt makes this hold stale.
    await db.update(heartbeatRuns).set({ runnerProfileJson: {} }).where(eq(heartbeatRuns.id, runId));
    const cleared = await request(app).get(`/api/issues/${sourceIssueId}`).expect(200);
    expect(cleared.body.activeRecoveryAction).toBeNull();
    const rows = await db.select().from(activityLog).where(eq(activityLog.entityId, sourceIssueId));
    expect(rows).toEqual([expect.objectContaining({ actorType: "system", actorId: "recovery", action: "issue.recovery_action_resolved" })]);
    expect(await issueService(db).list(companyId, { touchedByUserId: userId })).toEqual([]);
  });

  it("keeps active recovery visible when a plain comment does not create a live path", async () => {
    const { companyId, managerId, sourceIssueId } = await seedCompany();
    await db
      .update(issues)
      .set({ assigneeAgentId: null, assigneeUserId: "board-user" })
      .where(eq(issues.id, sourceIssueId));
    const recoveryActionSvc = issueRecoveryActionService(db);
    const action = await recoveryActionSvc.upsertSourceScoped({
      companyId,
      sourceIssueId,
      kind: "issue_graph_liveness",
      ownerType: "agent",
      ownerAgentId: managerId,
      cause: "issue_graph_liveness",
      fingerprint: "graph-liveness:plain-comment",
      evidence: { latestIssueStatus: "in_progress" },
      nextAction: "Restore a live execution path.",
      wakePolicy: { type: "manual" },
    });
    const app = createApp();

    await request(app)
      .post(`/api/issues/${sourceIssueId}/comments`)
      .send({ body: "I am looking at this, but not changing the disposition." })
      .expect(201);

    expect(await recoveryActionSvc.getActiveForIssue(companyId, sourceIssueId)).toMatchObject({
      id: action.id,
      status: "active",
    });
    const detail = await request(app).get(`/api/issues/${sourceIssueId}`).expect(200);
    expect(detail.body.activeRecoveryAction).toMatchObject({ id: action.id });
  });

  it("folds stale recovery when a structured resume comment restores todo dispatch", async () => {
    const { companyId, managerId, sourceIssueId } = await seedCompany();
    await db
      .update(issues)
      .set({ status: "blocked", assigneeAgentId: null, assigneeUserId: "board-user" })
      .where(eq(issues.id, sourceIssueId));
    const recoveryActionSvc = issueRecoveryActionService(db);
    const action = await recoveryActionSvc.upsertSourceScoped({
      companyId,
      sourceIssueId,
      kind: "issue_graph_liveness",
      ownerType: "agent",
      ownerAgentId: managerId,
      cause: "issue_graph_liveness",
      fingerprint: "graph-liveness:resume-comment",
      evidence: { latestIssueStatus: "blocked" },
      nextAction: "Restore a live execution path.",
      wakePolicy: { type: "manual" },
    });
    const app = createApp();

    await request(app)
      .post(`/api/issues/${sourceIssueId}/comments`)
      .send({ body: "Resume this now.", resume: true })
      .expect(201);

    const [sourceIssue] = await db.select().from(issues).where(eq(issues.id, sourceIssueId));
    expect(sourceIssue?.status).toBe("todo");
    const [actionRow] = await db
      .select()
      .from(issueRecoveryActions)
      .where(eq(issueRecoveryActions.id, action.id));
    expect(actionRow).toMatchObject({
      status: "cancelled",
      outcome: "cancelled",
      resolutionNote: "Recovery action became stale because the source issue was manually moved from blocked to todo.",
    });
    expect(await recoveryActionSvc.getActiveForIssue(companyId, sourceIssueId)).toBeNull();

    const activityRows = await db
      .select()
      .from(activityLog)
      .where(eq(activityLog.entityId, sourceIssueId));
    expect(activityRows.find((row) => row.action === "issue.recovery_action_resolved")?.details).toMatchObject({
      source: "source_revalidation",
      trigger: "comment",
      recoveryActionId: action.id,
    });
  });

  it("rejects peer-agent source issue updates that would hide another owner's recovery action", async () => {
    const { companyId, managerId, coderId, sourceIssueId } = await seedCompany();
    await db
      .update(issues)
      .set({ status: "blocked", assigneeAgentId: null, assigneeUserId: "board-user" })
      .where(eq(issues.id, sourceIssueId));
    const recoveryActionSvc = issueRecoveryActionService(db);
    const action = await recoveryActionSvc.upsertSourceScoped({
      companyId,
      sourceIssueId,
      kind: "issue_graph_liveness",
      ownerType: "agent",
      ownerAgentId: managerId,
      cause: "issue_graph_liveness",
      fingerprint: "graph-liveness:peer-status-update",
      evidence: { latestIssueStatus: "blocked" },
      nextAction: "Restore a live execution path.",
      wakePolicy: { type: "manual" },
    });
    const app = createApp({
      type: "agent",
      agentId: coderId,
      companyId,
      runId: randomUUID(),
      source: "agent_jwt",
    });

    await request(app)
      .patch(`/api/issues/${sourceIssueId}`)
      .send({ status: "todo" })
      .expect(403);

    const [sourceIssue] = await db.select().from(issues).where(eq(issues.id, sourceIssueId));
    expect(sourceIssue?.status).toBe("blocked");
    const [actionRow] = await db
      .select()
      .from(issueRecoveryActions)
      .where(eq(issueRecoveryActions.id, action.id));
    expect(actionRow).toMatchObject({
      status: "active",
      outcome: null,
      resolvedAt: null,
    });
  });

  it("rejects peer-agent recovery action resolution on a board-owned source issue", async () => {
    const { companyId, managerId, coderId, sourceIssueId } = await seedCompany();
    await db
      .update(issues)
      .set({ status: "blocked", assigneeAgentId: null, assigneeUserId: "board-user" })
      .where(eq(issues.id, sourceIssueId));
    const recoveryActionSvc = issueRecoveryActionService(db);
    const action = await recoveryActionSvc.upsertSourceScoped({
      companyId,
      sourceIssueId,
      kind: "issue_graph_liveness",
      ownerType: "agent",
      ownerAgentId: managerId,
      cause: "issue_graph_liveness",
      fingerprint: "graph-liveness:peer-resolution",
      evidence: { latestIssueStatus: "blocked" },
      nextAction: "Restore a live execution path.",
      wakePolicy: { type: "manual" },
    });
    const app = createApp({
      type: "agent",
      agentId: coderId,
      companyId,
      runId: randomUUID(),
      source: "agent_jwt",
    });

    await request(app)
      .post(`/api/issues/${sourceIssueId}/recovery-actions/resolve`)
      .send({
        actionId: action.id,
        outcome: "restored",
        sourceIssueStatus: "done",
        resolutionNote: "Peer agent should not be able to clear this recovery.",
      })
      .expect(403);

    const [sourceIssue] = await db.select().from(issues).where(eq(issues.id, sourceIssueId));
    expect(sourceIssue?.status).toBe("blocked");
    const [actionRow] = await db
      .select()
      .from(issueRecoveryActions)
      .where(eq(issueRecoveryActions.id, action.id));
    expect(actionRow).toMatchObject({
      status: "active",
      outcome: null,
      resolvedAt: null,
    });
  });

  it("keeps the named recovery owner from completing a board-owned source issue", async () => {
    const { companyId, managerId, sourceIssueId } = await seedCompany();
    await db
      .update(issues)
      .set({ status: "blocked", assigneeAgentId: null, assigneeUserId: "board-user" })
      .where(eq(issues.id, sourceIssueId));
    const recoveryActionSvc = issueRecoveryActionService(db);
    const action = await recoveryActionSvc.upsertSourceScoped({
      companyId,
      sourceIssueId,
      kind: "issue_graph_liveness",
      ownerType: "agent",
      ownerAgentId: managerId,
      cause: "issue_graph_liveness",
      fingerprint: "graph-liveness:owner-resolution",
      evidence: { latestIssueStatus: "blocked" },
      nextAction: "Restore a live execution path.",
      wakePolicy: { type: "manual" },
    });
    const runId = randomUUID();
    const app = createApp({
      type: "agent",
      agentId: managerId,
      companyId,
      runId,
      source: "agent_jwt",
    });
    await seedHeartbeatRun({
      companyId,
      agentId: managerId,
      runId,
      issueId: sourceIssueId,
    });

    const resolved = await request(app)
      .post(`/api/issues/${sourceIssueId}/recovery-actions/resolve`)
      .send({
        actionId: action.id,
        outcome: "restored",
        sourceIssueStatus: "done",
        resolutionNote: "Recovery owner verified the work was intentionally completed.",
      })
      .expect(403);

    expect(resolved.body.details?.code).toBe("recovery_source_authority_required");
    const [sourceAfter, actionAfter] = await Promise.all([
      db.select().from(issues).where(eq(issues.id, sourceIssueId)).then((rows) => rows[0]),
      db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.id, action.id)).then((rows) => rows[0]),
    ]);
    expect(sourceAfter).toMatchObject({ status: "blocked", assigneeUserId: "board-user" });
    expect(actionAfter).toMatchObject({ status: "active", outcome: null });
  });

  it("rejects blocked recovery resolution when the source issue has no first-class blockers", async () => {
    const { companyId, managerId, sourceIssueId } = await seedCompany();
    const recoveryActionSvc = issueRecoveryActionService(db);
    const action = await recoveryActionSvc.upsertSourceScoped({
      companyId,
      sourceIssueId,
      kind: "issue_graph_liveness",
      ownerType: "agent",
      ownerAgentId: managerId,
      cause: "issue_graph_liveness",
      fingerprint: "graph-liveness:blocked-without-blocker",
      evidence: { latestIssueStatus: "in_progress" },
      nextAction: "Choose a disposition with a live continuation path.",
      wakePolicy: { type: "manual" },
    });
    const app = createApp();

    const rejected = await request(app)
      .post(`/api/issues/${sourceIssueId}/recovery-actions/resolve`)
      .send({
        actionId: action.id,
        outcome: "blocked",
        sourceIssueStatus: "blocked",
      })
      .expect(422);

    expect(rejected.body.error).toContain("requires an unresolved first-class blocker");

    const [sourceIssue] = await db.select().from(issues).where(eq(issues.id, sourceIssueId));
    expect(sourceIssue?.status).toBe("in_progress");

    const [actionRow] = await db
      .select()
      .from(issueRecoveryActions)
      .where(eq(issueRecoveryActions.id, action.id));
    expect(actionRow).toMatchObject({
      status: "active",
      outcome: null,
      resolvedAt: null,
    });
  });

  it("allows blocked recovery resolution when the source issue has an unresolved first-class blocker", async () => {
    const { companyId, managerId, sourceIssueId, prefix } = await seedCompany();
    const blockerIssueId = randomUUID();
    await db.insert(issues).values({
      id: blockerIssueId,
      companyId,
      title: "Unblock recovery disposition",
      status: "todo",
      priority: "medium",
      assigneeAgentId: managerId,
      issueNumber: 2,
      identifier: `${prefix}-2`,
    });
    await db.insert(issueRelations).values({
      companyId,
      issueId: blockerIssueId,
      relatedIssueId: sourceIssueId,
      type: "blocks",
    });
    const recoveryActionSvc = issueRecoveryActionService(db);
    const action = await recoveryActionSvc.upsertSourceScoped({
      companyId,
      sourceIssueId,
      kind: "issue_graph_liveness",
      ownerType: "agent",
      ownerAgentId: managerId,
      cause: "issue_graph_liveness",
      fingerprint: "graph-liveness:blocked-with-blocker",
      evidence: { latestIssueStatus: "in_progress" },
      nextAction: "Wait for the blocker before continuing.",
      wakePolicy: { type: "manual" },
    });
    const app = createApp();

    const resolved = await request(app)
      .post(`/api/issues/${sourceIssueId}/recovery-actions/resolve`)
      .send({
        actionId: action.id,
        outcome: "blocked",
        sourceIssueStatus: "blocked",
        resolutionNote: "The source issue is explicitly blocked by a follow-up.",
      })
      .expect(200);

    expect(resolved.body.issue).toMatchObject({
      id: sourceIssueId,
      status: "blocked",
      activeRecoveryAction: null,
    });
    expect(resolved.body.recoveryAction).toMatchObject({
      id: action.id,
      status: "resolved",
      outcome: "blocked",
      resolutionNote: "The source issue is explicitly blocked by a follow-up.",
    });
    expect(await recoveryActionSvc.getActiveForIssue(companyId, sourceIssueId)).toBeNull();
  });

  it("rejects false-positive recovery resolution without an explicit source issue status", async () => {
    const { companyId, managerId, sourceIssueId } = await seedCompany();
    const recoveryActionSvc = issueRecoveryActionService(db);
    const action = await recoveryActionSvc.upsertSourceScoped({
      companyId,
      sourceIssueId,
      kind: "issue_graph_liveness",
      ownerType: "agent",
      ownerAgentId: managerId,
      cause: "issue_graph_liveness",
      fingerprint: "graph-liveness:fingerprint",
      evidence: { latestIssueStatus: "in_progress" },
      nextAction: "Confirm whether the issue is actually stranded.",
      wakePolicy: { type: "manual" },
    });
    const app = createApp();

    await request(app)
      .post(`/api/issues/${sourceIssueId}/recovery-actions/resolve`)
      .send({
        actionId: action.id,
        outcome: "false_positive",
        resolutionNote: "The source issue still has a live execution path.",
      })
      .expect(400);

    const [sourceIssue] = await db.select().from(issues).where(eq(issues.id, sourceIssueId));
    expect(sourceIssue?.status).toBe("in_progress");

    const [actionRow] = await db
      .select()
      .from(issueRecoveryActions)
      .where(eq(issueRecoveryActions.id, action.id));
    expect(actionRow).toMatchObject({
      status: "active",
      outcome: null,
      resolutionNote: null,
    });
  });

  it("allows false-positive recovery resolution to restore a blocked source issue in the same request", async () => {
    const { companyId, managerId, sourceIssueId } = await seedCompany();
    await db.update(issues).set({ status: "blocked" }).where(eq(issues.id, sourceIssueId));
    const recoveryActionSvc = issueRecoveryActionService(db);
    const action = await recoveryActionSvc.upsertSourceScoped({
      companyId,
      sourceIssueId,
      kind: "issue_graph_liveness",
      ownerType: "agent",
      ownerAgentId: managerId,
      cause: "issue_graph_liveness",
      fingerprint: "graph-liveness:false-positive-unblock",
      evidence: { latestIssueStatus: "blocked" },
      nextAction: "Confirm whether the issue is actually stranded.",
      wakePolicy: { type: "manual" },
    });
    const app = createApp();

    const resolved = await request(app)
      .post(`/api/issues/${sourceIssueId}/recovery-actions/resolve`)
      .send({
        actionId: action.id,
        outcome: "false_positive",
        sourceIssueStatus: "in_review",
        resolutionNote: "Recovery signal was stale; return to review.",
      })
      .expect(200);

    expect(resolved.body.issue).toMatchObject({
      id: sourceIssueId,
      status: "in_review",
      activeRecoveryAction: null,
    });
    expect(resolved.body.recoveryAction).toMatchObject({
      id: action.id,
      status: "resolved",
      outcome: "false_positive",
      resolutionNote: "Recovery signal was stale; return to review.",
    });
  });

  it("enforces company scope when resolving recovery actions", async () => {
    const { companyId, managerId, sourceIssueId } = await seedCompany();
    const recoveryActionSvc = issueRecoveryActionService(db);
    const action = await recoveryActionSvc.upsertSourceScoped({
      companyId,
      sourceIssueId,
      kind: "missing_disposition",
      ownerType: "agent",
      ownerAgentId: managerId,
      cause: "successful_run_missing_issue_disposition",
      fingerprint: "missing-disposition:fingerprint",
      evidence: { sourceRunId: "run-1" },
      nextAction: "Choose a valid issue disposition.",
      wakePolicy: { type: "wake_owner" },
    });
    const app = createApp({
      type: "agent",
      agentId: randomUUID(),
      companyId: randomUUID(),
      runId: randomUUID(),
      source: "agent_jwt",
    });

    await request(app)
      .post(`/api/issues/${sourceIssueId}/recovery-actions/resolve`)
      .send({
        actionId: action.id,
        outcome: "restored",
        sourceIssueStatus: "done",
      })
      .expect(404);

    const [actionRow] = await db
      .select()
      .from(issueRecoveryActions)
      .where(eq(issueRecoveryActions.id, action.id));
    expect(actionRow?.status).toBe("active");
  });

  // STUDIO-0071: production, 19 Nov 2026. Two runs cut by a pause each left a hold that was settled `resolved` with
  // replay blocked: it kept every run of the task from starting, yet `activeRecoveryAction` was null, the task lists
  // showed nothing and the task stayed `todo`.
  async function seedSettledHoldOfCutRun() {
    const seeded = await seedCompany();
    const runId = randomUUID();
    await db.update(issues).set({ status: "todo" }).where(eq(issues.id, seeded.sourceIssueId));
    await db.insert(heartbeatRuns).values({ id: runId, companyId: seeded.companyId, agentId: seeded.coderId,
      invocationSource: "manual", status: "cancelled", errorCode: "agent_paused", runtimeMode: "legacy", executionStage: "settled",
      startedAt: new Date(Date.now() - 600_000), finishedAt: new Date(Date.now() - 300_000),
      contextSnapshot: { issueId: seeded.sourceIssueId },
      runnerProfileJson: { adapterDispatch: { adapterType: "codex_local" } },
      resultJson: { cancellation: { initiator: { type: "system" }, expected: true, reason: "Cancelled due to agent pause" },
        pauseStop: { holds: ["manual"], companyPauseReason: null } } });
    const [hold] = await db.insert(issueRecoveryActions).values({ companyId: seeded.companyId, sourceIssueId: seeded.sourceIssueId,
      kind: "active_run_watchdog", cause: "legacy_execution_requires_reconciliation", fingerprint: `legacy-execution:${runId}`,
      status: "resolved", outcome: "blocked", ownerType: "board", nextAction: "Reconcile the cut run before any continuation.",
      evidence: { runId, automaticRecovery: { policy: "preserve_without_replay_v1", runId, replay: "blocked", actionOutcome: "unknown" } },
    }).returning();
    // A second task of the same company that nothing holds.
    const freeIssueId = randomUUID();
    await db.insert(issues).values({ id: freeIssueId, companyId: seeded.companyId, title: "Free task", status: "todo",
      priority: "medium", assigneeAgentId: seeded.coderId, issueNumber: 2, identifier: `${seeded.prefix}-2` });
    return { ...seeded, runId, hold, freeIssueId };
  }
  const listRows = async (app: ReturnType<typeof createApp>, companyId: string, query: string) => {
    const response = await request(app).get(`/api/companies/${companyId}/issues${query}`).expect(200);
    const rows: Array<Record<string, any>> = Array.isArray(response.body) ? response.body : response.body.issues ?? response.body.items ?? response.body.data;
    return new Map(rows.map(row => [row.id as string, row]));
  };

  it("lists in the task's detail the settled hold that still blocks its execution", async () => {
    const { sourceIssueId, hold, runId } = await seedSettledHoldOfCutRun();
    const detail = await request(createApp()).get(`/api/issues/${sourceIssueId}`).expect(200);
    // Nothing else says the task is held.
    expect(detail.body.status).toBe("todo");
    expect(detail.body.activeRecoveryAction).toBeNull();
    expect(detail.body.executionHold).toMatchObject({ recoveryActionId: hold.id, runId,
      cause: "legacy_execution_requires_reconciliation", listedAsActiveAction: false });
    expect(typeof detail.body.executionHold.nextAction).toBe("string");
    expect(detail.body.executionHold.nextAction.length).toBeGreaterThan(0);
    // The same hold admission reports.
    expect(detail.body.executionBlocker).toMatchObject({ recoveryActionId: hold.id });
  });

  it("lists the same hold in the task lists, and nothing on a task that is not held", async () => {
    const { companyId, sourceIssueId, freeIssueId, hold, runId } = await seedSettledHoldOfCutRun();
    const app = createApp();
    for (const query of ["", "?view=compact", `?view=rows&ids=${sourceIssueId},${freeIssueId}`]) {
      const rows = await listRows(app, companyId, query);
      expect(rows.get(sourceIssueId)?.executionHold, query).toMatchObject({ recoveryActionId: hold.id, runId,
        cause: "legacy_execution_requires_reconciliation", listedAsActiveAction: false });
      expect(rows.get(sourceIssueId)?.activeRecoveryAction ?? null, query).toBeNull();
      expect(rows.get(freeIssueId), query).toBeDefined();
      expect(rows.get(freeIssueId)?.executionHold, query).toBeNull();
    }
  });

  it("stops listing the hold once it no longer blocks execution", async () => {
    const { companyId, sourceIssueId, hold } = await seedSettledHoldOfCutRun();
    // What a reconciliation writes on the hold: its replay is no longer blocked.
    await db.update(issueRecoveryActions).set({ evidence: sql`jsonb_set(${issueRecoveryActions.evidence}, '{automaticRecovery,replay}', '"allowed"'::jsonb)` })
      .where(eq(issueRecoveryActions.id, hold.id));
    const app = createApp();
    const detail = await request(app).get(`/api/issues/${sourceIssueId}`).expect(200);
    expect(detail.body.executionBlocker).toBeNull();
    expect(detail.body.executionHold).toBeNull();
    expect((await listRows(app, companyId, "?view=compact")).get(sourceIssueId)?.executionHold).toBeNull();
  });

  it("says when the hold is also the task's active recovery action", async () => {
    const { companyId, sourceIssueId, hold } = await seedSettledHoldOfCutRun();
    await db.update(issueRecoveryActions).set({ status: "active", outcome: null, resolvedAt: null }).where(eq(issueRecoveryActions.id, hold.id));
    const app = createApp();
    const detail = await request(app).get(`/api/issues/${sourceIssueId}`).expect(200);
    expect(detail.body.activeRecoveryAction).toMatchObject({ id: hold.id });
    expect(detail.body.executionHold).toMatchObject({ recoveryActionId: hold.id, listedAsActiveAction: true });
    expect((await listRows(app, companyId, "?view=compact")).get(sourceIssueId)?.executionHold)
      .toMatchObject({ recoveryActionId: hold.id, listedAsActiveAction: true });
  });

  it("still returns the task list, without the field, when the holds cannot be read", async () => {
    const { companyId, sourceIssueId, hold } = await seedSettledHoldOfCutRun();
    // A database whose grouped read of the holds fails, as a stub that does not know it.
    const failing = new Proxy(db, { get(target, property, receiver) {
      if (property === "selectDistinct") return () => { throw new Error("holds unavailable"); };
      const value = Reflect.get(target, property, receiver);
      return typeof value === "function" ? value.bind(target) : value;
    } });
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => { (req as any).actor = { type: "board", source: "local_implicit" }; next(); });
    app.use("/api", issueRoutes(failing as typeof db, {} as any, {}));
    app.use(errorHandler);
    for (const query of ["", "?view=compact", `?view=rows&ids=${sourceIssueId}`]) {
      const rows = await listRows(app, companyId, query);
      expect(rows.get(sourceIssueId), query).toBeDefined();
      // Absent, not null: the field was not read. Null would say that nothing holds the task.
      expect(Object.hasOwn(rows.get(sourceIssueId)!, "executionHold"), query).toBe(false);
    }
    // The detail does not use the grouped read.
    const detail = await request(app).get(`/api/issues/${sourceIssueId}`).expect(200);
    expect(detail.body.executionHold).toMatchObject({ recoveryActionId: hold.id, listedAsActiveAction: false });
  });

  /** `count` more tasks of the same company, each held like the first: a run cut by a pause, its hold settled. */
  async function seedMoreHeldTasks(seeded: { companyId: string; coderId: string; prefix: string }, count: number) {
    const holdByIssue = new Map<string, string>();
    for (let index = 0; index < count; index += 1) {
      const issueId = randomUUID();
      const runId = randomUUID();
      await db.insert(issues).values({ id: issueId, companyId: seeded.companyId, title: `Held task ${index}`, status: "todo",
        priority: "medium", assigneeAgentId: seeded.coderId, issueNumber: 10 + index, identifier: `${seeded.prefix}-${10 + index}` });
      await db.insert(heartbeatRuns).values({ id: runId, companyId: seeded.companyId, agentId: seeded.coderId,
        invocationSource: "manual", status: "cancelled", errorCode: "agent_paused", runtimeMode: "legacy", executionStage: "settled",
        startedAt: new Date(Date.now() - 600_000), finishedAt: new Date(Date.now() - 300_000),
        contextSnapshot: { issueId },
        runnerProfileJson: { adapterDispatch: { adapterType: "codex_local" } },
        resultJson: { cancellation: { initiator: { type: "system" }, expected: true, reason: "Cancelled due to agent pause" },
          pauseStop: { holds: ["manual"], companyPauseReason: null } } });
      const [hold] = await db.insert(issueRecoveryActions).values({ companyId: seeded.companyId, sourceIssueId: issueId,
        kind: "active_run_watchdog", cause: "legacy_execution_requires_reconciliation", fingerprint: `legacy-execution:${runId}`,
        status: "resolved", outcome: "blocked", ownerType: "board", nextAction: "Reconcile the cut run before any continuation.",
        evidence: { runId, automaticRecovery: { policy: "preserve_without_replay_v1", runId, replay: "blocked", actionOutcome: "unknown" } },
      }).returning();
      holdByIssue.set(issueId, hold!.id);
    }
    return holdByIssue;
  }
  /**
   * The database seen through a wrapper that calls `onQuery` each time a query starts and counts the queries that
   * are waiting for their answer at the same moment.
   */
  function observedDb(onQuery: (name: string) => void = () => {}) {
    const seen = { inFlight: 0, most: 0 };
    const wrap = (value: any): any => {
      if (value === null || (typeof value !== "object" && typeof value !== "function")) return value;
      return new Proxy(value, { get(target, property) {
        const member = Reflect.get(target, property, target);
        if (typeof member !== "function" || typeof property === "symbol" || property === "constructor") return member;
        if (property === "then") return (resolve: (rows: unknown) => unknown, reject: (error: unknown) => unknown) => {
          seen.inFlight += 1;
          seen.most = Math.max(seen.most, seen.inFlight);
          return (target as PromiseLike<unknown>).then(
            rows => { seen.inFlight -= 1; return rows; },
            error => { seen.inFlight -= 1; throw error; },
          ).then(resolve, reject);
        };
        return (...args: unknown[]) => {
          if (target === db) onQuery(property);
          return wrap(member.apply(target, args));
        };
      } });
    };
    return { db: wrap(db) as typeof db, seen };
  }

  it("confirms the holds of a list several at once, never more than the bound, each task keeping its own hold", async () => {
    const seeded = await seedSettledHoldOfCutRun();
    const holdByIssue = new Map([[seeded.sourceIssueId, seeded.hold.id], ...await seedMoreHeldTasks(seeded, 11)]);
    const issueIds = [...holdByIssue.keys(), seeded.freeIssueId];
    const observed = observedDb();
    const holds = await listExecutionHolds(observed.db, seeded.companyId, issueIds, () => null);
    expect(observed.seen.most).toBeGreaterThan(1);
    expect(observed.seen.most).toBeLessThanOrEqual(EXECUTION_HOLD_CONFIRMATIONS_AT_ONCE);
    expect(observed.seen.inFlight).toBe(0);
    expect(holds.size).toBe(12);
    for (const [issueId, holdId] of holdByIssue) expect(holds.get(issueId)?.recoveryActionId, issueId).toBe(holdId);
    // The same through the list route.
    const rows = await listRows(createApp(), seeded.companyId, `?view=rows&ids=${issueIds.join(",")}`);
    for (const [issueId, holdId] of holdByIssue) expect(rows.get(issueId)?.executionHold?.recoveryActionId, issueId).toBe(holdId);
    expect(rows.get(seeded.freeIssueId)?.executionHold).toBeNull();
  });

  it("fails the whole read of the holds when one confirmation fails, and the list then carries no field", async () => {
    const seeded = await seedSettledHoldOfCutRun();
    const holdByIssue = new Map([[seeded.sourceIssueId, seeded.hold.id], ...await seedMoreHeldTasks(seeded, 11)]);
    const issueIds = [...holdByIssue.keys(), seeded.freeIssueId];
    // The grouped read answers; one query of the confirmations that follow it fails, while others are in flight.
    let confirmationQueries: number | null = null;
    const failing = observedDb(name => {
      if (name === "selectDistinct") confirmationQueries = 0;
      else if (name === "select" && confirmationQueries !== null && (confirmationQueries += 1) === 7) {
        throw new Error("confirmation unavailable");
      }
    });
    await expect(listExecutionHolds(failing.db, seeded.companyId, issueIds, () => null)).rejects.toThrow("confirmation unavailable");
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => { (req as any).actor = { type: "board", source: "local_implicit" }; next(); });
    app.use("/api", issueRoutes(failing.db, {} as any, {}));
    app.use(errorHandler);
    confirmationQueries = null;
    const rows = await listRows(app, seeded.companyId, `?view=rows&ids=${issueIds.join(",")}`);
    expect(rows.size).toBe(issueIds.length);
    // No task says "nothing holds" (null) because its confirmation did not run.
    for (const issueId of issueIds) expect(Object.hasOwn(rows.get(issueId)!, "executionHold"), issueId).toBe(false);
  });
});
