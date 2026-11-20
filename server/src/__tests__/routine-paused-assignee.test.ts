import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { agentWakeupRequests, agents, authUsers, companies, companyMemberships, createDb, heartbeatRuns, issues, projects,
  routineRuns } from "@paperclipai/db";
import { registerServerAdapter, unregisterServerAdapter } from "../adapters/index.js";
import { createLifecycleDriver } from "../services/agent-lifecycle-driver.js";
import { heartbeatService } from "../services/heartbeat.js";
import { routineService } from "../services/routines.js";
import { recoveryPostgresSupport, startRecoveryPostgres } from "./helpers/recovery-postgres.js";

const describePostgres = recoveryPostgresSupport.supported ? describe : describe.skip;

// STUDIO-0076 (L17): production, 18 Nov 2026. The routine "PR TheRanchers — remise et retrait QA" (Quality Manager)
// receives a webhook. At 13:19 and 17:15 five requests ended `failed`, "Agent is not invokable in its current state":
// the Quality Manager was paused. The task each request had just created was deleted with the failure, nothing was
// replayed, and the merge of a pull request was lost for the QA. A pause is not a failure of the request.
// Real path: the routine service with the real heartbeat service, a registered stand-in adapter that finishes the
// task, the webhook trigger fired as a delivery fires it, the lifecycle driver's own ready step for the resume.
describePostgres("a routine request while its assignee is paused", () => {
  let temporary: Awaited<ReturnType<typeof startRecoveryPostgres>>;
  let db: ReturnType<typeof createDb>;
  let heartbeat: ReturnType<typeof heartbeatService>;
  const adapterType = "codex_local";
  const oldHome = process.env.PAPERCLIP_HOME;
  let home: string;

  beforeAll(async () => {
    temporary = await startRecoveryPostgres("routine-paused-assignee-");
    db = createDb(temporary.connectionString);
    home = await mkdtemp(path.join(tmpdir(), "paperclip-routine-paused-"));
    process.env.PAPERCLIP_HOME = home;
    vi.stubEnv("PAPERCLIP_AGENT_JWT_SECRET", randomUUID().repeat(2));
    vi.stubEnv("PAPERCLIP_API_URL", "http://localhost:3100");
    heartbeat = heartbeatService(db);
    registerServerAdapter({
      type: adapterType, supportsLocalAgentJwt: false,
      execute: async input => {
        await db.update(issues).set({ status: "done" }).where(eq(issues.id, String(input.context.issueId)));
        return { exitCode: 0, signal: null, timedOut: false, resultJson: {} };
      },
      testEnvironment: async () => ({ adapterType, status: "pass", checks: [], testedAt: new Date().toISOString() }),
    });
  }, 240_000);
  afterAll(async () => {
    await heartbeat?.drainActiveRunExecutions();
    unregisterServerAdapter(adapterType);
    vi.unstubAllEnvs();
    await db?.$client.end({ timeout: 0 });
    await temporary?.cleanup();
    if (oldHome === undefined) delete process.env.PAPERCLIP_HOME; else process.env.PAPERCLIP_HOME = oldHome;
    if (home) await rm(home, { recursive: true, force: true });
  });

  /** A routine of the role with a webhook trigger, and what fires it. */
  async function seed(deps: Parameters<typeof routineService>[1] = {}) {
    const companyId = randomUUID(), agentId = randomUUID(), projectId = randomUUID();
    const userId = `routine-user-${companyId}`;
    await db.insert(authUsers).values({ id: userId, name: "Board user", email: `${userId}@example.test`, createdAt: new Date(), updatedAt: new Date() });
    await db.insert(companies).values({ id: companyId, name: "Routine pause", issuePrefix: `Q${companyId.replaceAll("-", "").slice(0, 6).toUpperCase()}`,
      defaultResponsibleUserId: userId, requireBoardApprovalForNewAgents: false });
    await db.insert(companyMemberships).values({ companyId, principalId: userId, principalType: "user", status: "active", membershipRole: "member" });
    await db.insert(agents).values({ id: agentId, companyId, name: "Quality Manager", role: "qa", status: "idle", adapterType,
      adapterConfig: {}, runtimeConfig: { heartbeat: { wakeOnDemand: true, maxConcurrentRuns: 1 } }, permissions: {} });
    await db.insert(projects).values({ id: projectId, companyId, name: "QA", status: "in_progress" });
    const svc = routineService(db, { heartbeat, ...deps });
    const routine = await svc.create(companyId, { projectId, goalId: null, parentIssueId: null, title: "Hand a merged pull request to the QA",
      description: "Take the merged pull request in.", assigneeAgentId: agentId, priority: "medium", status: "active",
      concurrencyPolicy: "coalesce_if_active", catchUpPolicy: "skip_missed", variables: [] }, {});
    const created = await svc.createTrigger(routine.id, { kind: "webhook", enabled: true, signingMode: "app_webhook", replayWindowSec: 300 }, {});
    const fire = (event: string) => svc.firePublicTrigger(created.trigger.publicId!, {
      authorizationHeader: `Bearer ${created.secretMaterial!.webhookSecret}`, payload: { event } });
    return { companyId, agentId, routine, fire };
  }
  type Seeded = Awaited<ReturnType<typeof seed>>;
  const pause = (f: Seeded, hold: "manual" | "budget" | "company_paused") => db.update(agents).set({
    status: "paused", pauseReason: hold, pausedAt: new Date(), lifecycleState: "paused", lifecycleHolds: [hold] }).where(eq(agents.id, f.agentId));
  const ready = (f: Seeded) => db.update(agents).set({ status: "idle", pauseReason: null, pausedAt: null, lifecycleState: "ready", lifecycleHolds: [] })
    .where(eq(agents.id, f.agentId));
  const tasksOf = (f: Seeded) => db.select().from(issues).where(eq(issues.companyId, f.companyId));
  const runsOf = (f: Seeded) => db.select().from(heartbeatRuns).where(and(eq(heartbeatRuns.companyId, f.companyId), eq(heartbeatRuns.agentId, f.agentId)));
  const requestsOf = (f: Seeded) => db.select().from(routineRuns).where(eq(routineRuns.routineId, f.routine.id));
  /** The request did not fail: its task exists, assigned to the role, and nothing ran. */
  async function expectTaskKept(f: Seeded, result: Awaited<ReturnType<Seeded["fire"]>>) {
    expect(result).toMatchObject({ status: "issue_created" });
    const tasks = await tasksOf(f);
    expect(tasks).toHaveLength(1);
    expect(tasks[0]).toMatchObject({ status: "todo", assigneeAgentId: f.agentId });
    expect("linkedIssueId" in result && result.linkedIssueId).toBe(tasks[0]!.id);
    expect(await runsOf(f)).toHaveLength(0);
    expect((await requestsOf(f)).map(request => request.status)).toEqual(["issue_created"]);
    return tasks[0]!;
  }
  async function expectStartedOnceAndDone(f: Seeded, taskId: string) {
    await expect.poll(async () => (await db.select().from(issues).where(eq(issues.id, taskId)))[0]?.status, { timeout: 30_000 }).toBe("done");
    await heartbeat.drainActiveRunExecutions();
    // One start of the task. (The stand-in adapter posts no comment, so the product may ask for one afterwards: that
    // follow-up of a finished run is not a start of the task.)
    expect((await runsOf(f)).filter(run => run.contextSnapshot?.issueId === taskId
      && run.contextSnapshot?.wakeReason !== "missing_issue_comment")).toHaveLength(1);
  }

  it("keeps the task of a webhook received during a person's pause, and wakes the assignee once at the resume", async () => {
    const f = await seed();
    await pause(f, "manual");
    const task = await expectTaskKept(f, await f.fire("pull_request.merged"));
    // The refused wake is written, for the task that still exists: the resume replays it (STUDIO-0028).
    const refused = (await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.companyId, f.companyId)))
      .filter(wake => wake.payload?.issueId === task.id);
    expect(refused.map(wake => [wake.status, wake.reason])).toEqual([["skipped", "agent.not_invokable"]]);
    await ready(f);
    const [agent] = await db.select().from(agents).where(eq(agents.id, f.agentId));
    await createLifecycleDriver(db, {} as never).onReady!(agent as never);
    await expectStartedOnceAndDone(f, task.id);
  }, 240_000);

  it("keeps the task of a webhook received during a budget pause or a company pause; the sweep starts it once the role can run", async () => {
    for (const hold of ["budget", "company_paused"] as const) {
      const f = await seed();
      await pause(f, hold);
      const task = await expectTaskKept(f, await f.fire("pull_request.merged"));
      // While the pause lasts the sweep neither starts nor blocks the task.
      await heartbeat.reconcileStrandedAssignedIssues({ companyId: f.companyId });
      expect((await db.select().from(issues).where(eq(issues.id, task.id)))[0]).toMatchObject({ status: "todo" });
      await ready(f);
      await heartbeat.reconcileStrandedAssignedIssues({ companyId: f.companyId });
      await expectStartedOnceAndDone(f, task.id);
    }
  }, 240_000);

  // The routine's concurrency rule looks at a live execution, and a paused role has none: each webhook of the pause
  // gets its own task, as each merged pull request is its own event. None fails, and each starts at the resume.
  it("keeps one task per webhook received during the pause, and starts each at the resume", async () => {
    const f = await seed();
    await pause(f, "manual");
    const first = await expectTaskKept(f, await f.fire("pull_request.merged"));
    const second = await f.fire("pull_request.merged");
    expect(second).toMatchObject({ status: "issue_created" });
    const tasks = await tasksOf(f);
    expect(tasks.map(task => task.status)).toEqual(["todo", "todo"]);
    expect((await requestsOf(f)).map(request => request.status)).toEqual(["issue_created", "issue_created"]);
    await ready(f);
    const [agent] = await db.select().from(agents).where(eq(agents.id, f.agentId));
    await createLifecycleDriver(db, {} as never).onReady!(agent as never);
    for (const task of tasks) await expectStartedOnceAndDone(f, task.id);
    expect(first.id).toBe(tasks.find(task => task.id === first.id)!.id);
  }, 240_000);

  it("keeps today's failure for an assignee that is terminated or pending approval", async () => {
    for (const status of ["terminated", "pending_approval"] as const) {
      const f = await seed();
      await db.update(agents).set({ status }).where(eq(agents.id, f.agentId));
      const outcome = await f.fire("pull_request.merged").then(result => result, error => error as Error);
      expect(outcome instanceof Error || (outcome as { status?: string }).status === "failed").toBe(true);
      expect(await tasksOf(f)).toHaveLength(0);
      expect(await runsOf(f)).toHaveLength(0);
    }
  }, 240_000);

  it("keeps today's failure when the wake is refused for another reason than a pause: the task is removed", async () => {
    // The role is not paused; the wake itself fails.
    const f = await seed({ heartbeat: { wakeup: async () => { throw new Error("the queue is unavailable"); } } });
    const result = await f.fire("pull_request.merged");
    expect(result).toMatchObject({ status: "failed", failureReason: "the queue is unavailable" });
    expect(await tasksOf(f)).toHaveLength(0);
  }, 240_000);
});
