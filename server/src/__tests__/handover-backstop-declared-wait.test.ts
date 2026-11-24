/**
 * STUDIO-0101: the hand-over backstop of STUDIO-0063 leaves alone an issue whose assignee's latest started run ended
 * in a wait the adapter declared, while that wait is within its bound.
 *
 * Production, 23 Nov 2026 (04:18 to 05:25 UTC): 32 runs failed `router_waiting_for_resources` on four tasks of the
 * same role. Each was started by this backstop, under its own doubling wait (30 s, 1 min, 2 min...): it does not read
 * the declared waits. The worker router kept every request and woke each task itself once a machine was free.
 * The rule now: within the bound of the declared wait (the stranded-work recovery's own reading: the closed list of
 * codes, the series, its bound), the backstop wakes nobody and looks again at the bound's end; past the bound, or
 * when the latest run is not such a wait, it wakes as before.
 */
import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { and, eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  agentWakeupRequests, agents, authUsers, companies, companyMemberships, createDb, heartbeatRuns, issueComments, issues,
} from "@paperclipai/db";
import { errorHandler } from "../middleware/index.js";
import { issueRoutes } from "../routes/issues.js";
import { registerServerAdapter, unregisterServerAdapter } from "../adapters/index.js";
import { heartbeatService } from "../services/heartbeat.js";
import { issueService } from "../services/issues.js";
import { ADAPTER_DECLARED_WAIT_MAX_MS } from "../services/recovery/adapter-declared-wait.js";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";

const support = await getEmbeddedPostgresTestSupport();
const ADAPTER = "codex_local";

(support.supported ? describe : describe.skip)("the hand-over backstop and a wait the adapter declared (STUDIO-0101)", () => {
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  let heartbeat: ReturnType<typeof heartbeatService>;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-backstop-declared-wait-");
    db = createDb(tempDb.connectionString);
    heartbeat = heartbeatService(db);
    await db.insert(authUsers).values({ id: "board-user", name: "Board", email: "board@example.test", emailVerified: true,
      createdAt: new Date(), updatedAt: new Date() });
    // The run the backstop starts: its engine starts and the run succeeds (a qualified run).
    registerServerAdapter({
      type: ADAPTER, supportsLocalAgentJwt: false,
      execute: async (input) => {
        const { spawnSync } = await import("node:child_process");
        const engine = spawnSync(process.execPath, ["-e", ""]);
        await input.onSpawn?.({ pid: engine.pid!, processGroupId: null, startedAt: new Date().toISOString() });
        return { exitCode: 0, signal: null, timedOut: false, resultJson: {} };
      },
      testEnvironment: async () => ({ adapterType: ADAPTER, status: "pass", checks: [], testedAt: new Date().toISOString() }),
    });
  }, 90_000);
  afterAll(async () => {
    await heartbeat?.drainActiveRunExecutions();
    unregisterServerAdapter(ADAPTER);
    await db?.$client.end();
    await tempDb?.cleanup();
  });

  function app(companyId: string, agentActor?: { agentId: string; runId: string }) {
    const testApp = express();
    testApp.use(express.json());
    testApp.use((req, _res, next) => {
      (req as any).actor = { type: agentActor ? "agent" : "board", ...(agentActor ? { ...agentActor, companyId } : {}),
        source: "session", userId: "board-user", companyIds: [companyId],
        memberships: [{ companyId, status: "active", membershipRole: "operator" }], isInstanceAdmin: false };
      next();
    });
    testApp.use("/api", issueRoutes(db, {} as any, {}));
    testApp.use(errorHandler);
    return testApp;
  }

  /**
   * A Dev's task held behind a blocker, with a comment of the CTO held at admission (the hold trace the backstop
   * reads), then its blocker removed by a direct service write that wakes nobody (a plugin's setBlockedBy): the
   * backstop is the one that would wake the Dev.
   */
  async function heldTask() {
    const companyId = randomUUID(), devId = randomUUID(), ctoId = randomUUID();
    const taskId = randomUUID(), blockerId = randomUUID(), ctoTaskId = randomUUID(), ctoRunId = randomUUID();
    const prefix = `W${companyId.replaceAll("-", "").slice(0, 5).toUpperCase()}`;
    await db.insert(companies).values({ id: companyId, name: "Declared wait", issuePrefix: prefix,
      requireBoardApprovalForNewAgents: false, defaultResponsibleUserId: "board-user" });
    await db.insert(companyMemberships).values({ companyId, principalType: "user", principalId: "board-user", status: "active", membershipRole: "operator" });
    await db.insert(agents).values([
      { id: devId, companyId, name: "Dev", role: "engineer", status: "idle", adapterType: ADAPTER, adapterConfig: {}, permissions: {},
        runtimeConfig: { heartbeat: { wakeOnDemand: true, maxConcurrentRuns: 2 } } },
      { id: ctoId, companyId, name: "CTO", role: "cto", status: "running", adapterType: ADAPTER, adapterConfig: {}, permissions: {},
        runtimeConfig: { heartbeat: { wakeOnDemand: true } } },
    ]);
    await db.insert(issues).values([
      { id: blockerId, companyId, title: "Blocker", status: "todo", issueNumber: 1, identifier: `${prefix}-1`, responsibleUserId: "board-user" },
      { id: taskId, companyId, title: "Dev task", status: "todo", assigneeAgentId: devId, issueNumber: 2, identifier: `${prefix}-2`, responsibleUserId: "board-user" },
      { id: ctoTaskId, companyId, title: "CTO task", status: "in_progress", assigneeAgentId: ctoId, issueNumber: 3, identifier: `${prefix}-3`, responsibleUserId: "board-user" },
    ]);
    await db.insert(heartbeatRuns).values({ id: ctoRunId, companyId, agentId: ctoId, invocationSource: "assignment",
      status: "running", startedAt: new Date(), contextSnapshot: { issueId: ctoTaskId } });
    await request(app(companyId)).patch(`/api/issues/${taskId}`).send({ blockedByIssueIds: [blockerId] }).expect(200);
    const body = `Held for ${taskId}.`;
    await request(app(companyId, { agentId: ctoId, runId: ctoRunId })).post(`/api/issues/${taskId}/comments`).send({ body }).expect(201);
    const [comment] = await db.select({ id: issueComments.id }).from(issueComments).where(and(eq(issueComments.issueId, taskId), eq(issueComments.body, body)));
    await expect.poll(async () => (await db.select({ status: agentWakeupRequests.status, reason: agentWakeupRequests.reason })
      .from(agentWakeupRequests).where(and(eq(agentWakeupRequests.agentId, devId), sql`${agentWakeupRequests.payload}->>'commentId' = ${comment!.id}`))),
    { timeout: 20_000 }).toEqual([{ status: "skipped", reason: "issue_dependencies_blocked" }]);
    await issueService(db).update(taskId, { blockedByIssueIds: [], actorAgentId: null, actorUserId: null } as never);
    await heartbeat.drainActiveRunExecutions();
    return { companyId, devId, taskId, commentId: comment!.id };
  }
  type Task = Awaited<ReturnType<typeof heldTask>>;

  /** A run of the Dev on the task, ended at `endedAt` under `errorCode` (as the adapter's failure leaves it). */
  const endedRun = async (t: Task, errorCode: string, endedAt: Date) => {
    const [run] = await db.insert(heartbeatRuns).values({ companyId: t.companyId, agentId: t.devId, invocationSource: "assignment",
      status: "failed", errorCode, error: `refused: ${errorCode}`, startedAt: new Date(endedAt.getTime() - 1000), finishedAt: endedAt,
      createdAt: new Date(endedAt.getTime() - 2000), contextSnapshot: { issueId: t.taskId } }).returning();
    return run!;
  };
  const backstopWakes = (t: Task) => db.select().from(agentWakeupRequests).where(and(eq(agentWakeupRequests.agentId, t.devId),
    sql`${agentWakeupRequests.idempotencyKey} like 'held-handover-backstop:%'`));
  const pass = async (t: Task, now: Date) => {
    const deadlines: number[] = [];
    const outcome = await heartbeat.reconcileHeldCommentHandover({ companyId: t.companyId, issueId: t.taskId, now,
      onDeferredDeadline: at => deadlines.push(at) });
    return { outcome, deadlines };
  };
  const HOUR = 60 * 60_000;

  it("within the bound of a declared wait (no machine free), the backstop wakes nobody and looks again at the bound's end", async () => {
    const t = await heldTask();
    const ended = new Date(Date.now() - 60_000);
    await endedRun(t, "router_waiting_for_resources", ended);
    const bound = ended.getTime() + ADAPTER_DECLARED_WAIT_MAX_MS;
    for (const after of [30_000, 5 * 60_000, 11 * HOUR]) {
      expect(await pass(t, new Date(ended.getTime() + after))).toEqual({ outcome: "declared_wait", deadlines: [bound] });
    }
    expect(await backstopWakes(t)).toEqual([]);
  }, 120_000);

  it("past the bound (the negative control), the backstop wakes the assignee as before, with the held comment", async () => {
    const t = await heldTask();
    const ended = new Date(Date.now() - 60_000);
    await endedRun(t, "router_waiting_for_resources", ended);
    const past = new Date(ended.getTime() + ADAPTER_DECLARED_WAIT_MAX_MS + 1000);
    expect((await pass(t, past)).outcome).toBe("woken");
    expect(await backstopWakes(t)).toHaveLength(1);
    let run: typeof heartbeatRuns.$inferSelect | undefined;
    await expect.poll(async () => {
      run = (await db.select().from(heartbeatRuns).where(and(eq(heartbeatRuns.agentId, t.devId),
        sql`${heartbeatRuns.contextSnapshot}->>'source' = 'issue.held_comment_handover_backstop'`)))[0];
      return Boolean(run);
    }, { timeout: 20_000 }).toBe(true);
    await heartbeat.drainActiveRunExecutions();
    const [settled] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, run!.id));
    expect(((settled!.contextSnapshot as any)?.heldDependencyCommentIds ?? [])).toContain(t.commentId);
    expect(settled!.status).toBe("succeeded");
  }, 120_000);

  it("a later run that is not a declared wait: the backstop wakes as before", async () => {
    const t = await heldTask();
    const ended = new Date(Date.now() - 10 * 60_000);
    await endedRun(t, "router_waiting_for_resources", ended);
    // The assignee's latest started run failed under a code that is not a wait (an adapter failure).
    await endedRun(t, "adapter_failed", new Date(ended.getTime() + 60_000));
    expect((await pass(t, new Date(ended.getTime() + 2 * 60_000))).outcome).toBe("woken");
    expect(await backstopWakes(t)).toHaveLength(1);
  }, 120_000);

  it("a refusal that is not a wait (a code outside the closed list): the backstop wakes as before", async () => {
    const t = await heldTask();
    const ended = new Date(Date.now() - 60_000);
    await endedRun(t, "router_group_participant_reserved", ended);
    expect((await pass(t, new Date(ended.getTime() + 30_000))).outcome).toBe("woken");
    expect(await backstopWakes(t)).toHaveLength(1);
  }, 120_000);
});
