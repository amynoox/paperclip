/**
 * STUDIO-0063: an agent's comment on an issue waiting on unresolved blockers.
 *
 * Production 15 Nov 2026, TR-1258: the CTO set a blocker and commented on the Dev's task in one call; the
 * assignment wake was held, the comment wake started the Dev's run. The rule now, through the real routes:
 * - an agent's comment waits with the issue, at admission and at the claim gate (a comment queued while the
 *   assignee was busy, before the blocker was added); only the assignee is held, a person's comment, a card, a
 *   verified stall and an issue whose unresolved blockers are all cancelled keep their way in;
 * - nothing is recorded: the thread is the record. The assignee's admitted run that can act (issue ready, every
 *   unresolved blocker cancelled, or a stall/cancel handoff) carries every agent comment written after the start of
 *   its latest QUALIFIED run (admitted ready, engine process started, succeeded), the latest twenty named;
 * - a removed, deleted or cancelled-left blocker set wakes the assignee when the issue becomes ready.
 */
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { and, eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  activityLog,
  agentWakeupRequests,
  agents,
  authUsers,
  companies,
  companyMemberships,
  completionContracts,
  createDb,
  heartbeatRuns,
  issueComments,
  issueRecoveryActions,
  issues,
  nativeRunFinalizations,
  nativeRunResults,
  workAssessments,
} from "@paperclipai/db";
import { errorHandler } from "../middleware/index.js";
import { issueRoutes } from "../routes/issues.js";
import { registerServerAdapter, unregisterServerAdapter } from "../adapters/index.js";
import { heartbeatService } from "../services/heartbeat.js";
import { buildPaperclipWakePayload } from "../services/heartbeat/run-preparation.js";
import { issueService } from "../services/issues.js";
import { decisionService } from "../services/decisions.js";
import { commitNativeStatusDecision } from "../services/native-runtime/status-decision-committer.js";
import { NATIVE_STATUS_ARBITER_POLICY_VERSION, type NativeStatusDecision } from "../services/native-runtime/status-arbiter.js";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";

const support = await getEmbeddedPostgresTestSupport();
const ADAPTER = "codex_local";
type Outcome = "spawn-success" | "no-spawn" | "spawn-255" | `refuse:${string}`;

(support.supported ? describe : describe.skip)("agent comments on a dependency-blocked issue (STUDIO-0063)", () => {
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  let heartbeat: ReturnType<typeof heartbeatService>;
  const dispatched: string[] = [];
  // Per-issue outcome of the NEXT run. By default the engine process starts (onSpawn, as claude_local and codex_local
  // report it) and the run succeeds.
  const nextOutcome = new Map<string, Outcome>();
  // Per-issue outcome of EVERY run until cleared (automatic recovery runs included).
  const stickyOutcome = new Map<string, Outcome>();
  // Per-issue outcomes of the next runs, in order (then the default).
  const outcomeQueue = new Map<string, Outcome[]>();
  // Per-issue gate: the run waits until released (an assignee busy on its dependency run).
  const holdOpen = new Map<string, Promise<void>>();

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-blocked-comment-");
    db = createDb(tempDb.connectionString);
    heartbeat = heartbeatService(db);
    await db.insert(authUsers).values({ id: "board-user", name: "Board", email: "board@example.test", emailVerified: true,
      createdAt: new Date(), updatedAt: new Date() });
    registerServerAdapter({
      type: ADAPTER, supportsLocalAgentJwt: false,
      execute: async (input) => {
        dispatched.push(input.runId);
        const issueId = String((input.context as any)?.issueId ?? "");
        const outcome = stickyOutcome.get(issueId) ?? outcomeQueue.get(issueId)?.shift() ?? nextOutcome.get(issueId) ?? "spawn-success";
        nextOutcome.delete(issueId);
        // The worker router refuses before any reservation: no process is started.
        if (outcome.startsWith("refuse:")) {
          return { exitCode: 1, signal: null, timedOut: false, errorCode: outcome.slice("refuse:".length), errorMessage: "Refused by the worker router" };
        }
        // The engine process starts: a real, already ended process (its stop is provable), as the adapters report it.
        if (outcome !== "no-spawn") {
          const engine = spawnSync(process.execPath, ["-e", ""]);
          await input.onSpawn?.({ pid: engine.pid!, processGroupId: null, startedAt: new Date().toISOString() });
        }
        const gate = holdOpen.get(issueId);
        if (gate) await gate;
        // A cut SSH link after the process started: ssh exits 255.
        if (outcome === "spawn-255") return { exitCode: 255, signal: null, timedOut: false, errorMessage: "ssh: connection closed" };
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

  async function seed(options: { blocked?: boolean; devMaxConcurrent?: number } = {}) {
    const companyId = randomUUID(), devId = randomUUID(), ctoId = randomUUID(), qaId = randomUUID(), dev2Id = randomUUID();
    const taskId = randomUUID(), blockerId = randomUUID(), blocker2Id = randomUUID(), ctoTaskId = randomUUID(), ctoRunId = randomUUID();
    const prefix = `B${companyId.replaceAll("-", "").slice(0, 5).toUpperCase()}`;
    await db.insert(companies).values({ id: companyId, name: "Blocked comment", issuePrefix: prefix,
      requireBoardApprovalForNewAgents: false, defaultResponsibleUserId: "board-user" });
    await db.insert(companyMemberships).values({ companyId, principalType: "user", principalId: "board-user", status: "active", membershipRole: "operator" });
    await db.insert(agents).values([
      { id: devId, companyId, name: "Dev", role: "engineer", status: "idle", adapterType: ADAPTER, adapterConfig: {}, permissions: {},
        runtimeConfig: { heartbeat: { wakeOnDemand: true, maxConcurrentRuns: options.devMaxConcurrent ?? 2 } } },
      { id: ctoId, companyId, name: "CTO", role: "cto", status: "running", adapterType: ADAPTER, adapterConfig: {}, permissions: {},
        runtimeConfig: { heartbeat: { wakeOnDemand: true } } },
      { id: qaId, companyId, name: "QA", role: "qa", status: "idle", adapterType: ADAPTER, adapterConfig: {}, permissions: {},
        runtimeConfig: { heartbeat: { wakeOnDemand: true } } },
      { id: dev2Id, companyId, name: "Dev2", role: "engineer", status: "idle", adapterType: ADAPTER, adapterConfig: {}, permissions: {},
        runtimeConfig: { heartbeat: { wakeOnDemand: true } } },
    ]);
    await db.insert(issues).values([
      { id: blockerId, companyId, title: "Blocker", status: "todo", issueNumber: 1, identifier: `${prefix}-1`, responsibleUserId: "board-user" },
      { id: taskId, companyId, title: "Dev task", status: "todo", assigneeAgentId: devId, issueNumber: 2, identifier: `${prefix}-2`, responsibleUserId: "board-user" },
      { id: ctoTaskId, companyId, title: "CTO task", status: "in_progress", assigneeAgentId: ctoId, issueNumber: 3, identifier: `${prefix}-3`, responsibleUserId: "board-user" },
      { id: blocker2Id, companyId, title: "Blocker 2", status: "todo", issueNumber: 4, identifier: `${prefix}-4`, responsibleUserId: "board-user" },
    ]);
    // The CTO writes from its own live run on its own task.
    await db.insert(heartbeatRuns).values({ id: ctoRunId, companyId, agentId: ctoId, invocationSource: "assignment",
      status: "running", startedAt: new Date(), contextSnapshot: { issueId: ctoTaskId } });
    if (options.blocked !== false) {
      await request(app(companyId)).patch(`/api/issues/${taskId}`).send({ blockedByIssueIds: [blockerId] }).expect(200);
    }
    return { companyId, devId, ctoId, qaId, dev2Id, taskId, blockerId, blocker2Id, ctoTaskId, ctoRunId };
  }
  type Fixture = Awaited<ReturnType<typeof seed>>;

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

  const agentRuns = (agentId: string, taskId: string) => db.select().from(heartbeatRuns)
    .where(and(eq(heartbeatRuns.agentId, agentId), sql`${heartbeatRuns.contextSnapshot}->>'issueId' = ${taskId}`));
  const devRuns = (f: { devId: string; taskId: string }) => agentRuns(f.devId, f.taskId);
  const runById = async (id: string) => (await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, id)))[0];
  const commentIdOf = async (taskId: string, body: string) =>
    (await db.select({ id: issueComments.id }).from(issueComments).where(and(eq(issueComments.issueId, taskId), eq(issueComments.body, body))))[0]!.id;
  // The admission's own skip of a comment wake (the gate's behaviour on fb1ad740 too; nothing reads it back).
  const admissionHeld = (f: { devId: string }, commentId: string) => db.select({ status: agentWakeupRequests.status, reason: agentWakeupRequests.reason })
    .from(agentWakeupRequests).where(and(eq(agentWakeupRequests.agentId, f.devId), sql`${agentWakeupRequests.payload}->>'commentId' = ${commentId}`));
  const cto = (f: Fixture, runId = f.ctoRunId) => app(f.companyId, { agentId: f.ctoId, runId });
  const ctoComment = async (f: Fixture, body: string, runId = f.ctoRunId) => {
    await request(cto(f, runId)).post(`/api/issues/${f.taskId}/comments`).send({ body }).expect(201);
    return commentIdOf(f.taskId, body);
  };
  // No Dev run queued or running (the route sends its wakes after answering).
  const devAtRest = async (f: Fixture) => {
    await heartbeat.drainActiveRunExecutions();
    await expect.poll(async () => (await devRuns(f)).filter(run => ["queued", "running"].includes(run.status)).length,
      { timeout: 20_000 }).toBe(0);
  };
  // The Dev's work on the task is over: no queued, running or scheduled run, no pending wake, the task's execution
  // lock released (a comment merged into a live or pending run reaches that run and is not held).
  const taskQuiet = async (f: Fixture) => {
    const pending = async () => (await devRuns(f)).filter(run => ["queued", "running", "scheduled_retry"].includes(run.status)).length
      + (await db.select().from(agentWakeupRequests).where(and(eq(agentWakeupRequests.agentId, f.devId),
        sql`${agentWakeupRequests.status} in ('queued', 'deferred_issue_execution')`))).length
      + ((await db.select({ lock: issues.executionRunId }).from(issues).where(eq(issues.id, f.taskId)))[0]?.lock ? 1 : 0);
    for (let attempt = 0; attempt < 120 && (await pending()) > 0; attempt += 1) {
      await db.update(heartbeatRuns).set({ scheduledRetryAt: new Date(Date.now() - 1000) })
        .where(and(eq(heartbeatRuns.agentId, f.devId), eq(heartbeatRuns.status, "scheduled_retry")));
      await heartbeat.promoteDueScheduledRetries(new Date());
      await heartbeat.resumeQueuedRuns();
      await heartbeat.drainActiveRunExecutions();
      await new Promise(resolve => setTimeout(resolve, 250));
    }
    expect(await pending()).toBe(0);
  };
  // An agent comment written while the Dev's task is blocked and quiet: held at admission, no Dev run.
  const heldComment = async (f: Fixture, body: string) => {
    await taskQuiet(f);
    const id = await ctoComment(f, body);
    await expect.poll(() => admissionHeld(f, id), { timeout: 20_000 }).toEqual([{ status: "skipped", reason: "issue_dependencies_blocked" }]);
    return id;
  };
  // The first run of the agent on the task (after skipRunIds) whose context matches; waited until it ends.
  const runWhere = async (agentId: string, taskId: string, predicate: (run: typeof heartbeatRuns.$inferSelect) => boolean, skipRunIds: string[] = []) => {
    let found: typeof heartbeatRuns.$inferSelect | undefined;
    await expect.poll(async () => {
      found = (await agentRuns(agentId, taskId)).find(run => !skipRunIds.includes(run.id) && predicate(run));
      return Boolean(found);
    }, { timeout: 20_000 }).toBe(true);
    await heartbeat.drainActiveRunExecutions();
    return (await runById(found!.id))!;
  };
  const handedOver = (run: typeof heartbeatRuns.$inferSelect) => ((run.contextSnapshot as any)?.heldDependencyCommentIds ?? []) as string[];
  const carrying = (commentId: string) => (run: typeof heartbeatRuns.$inferSelect) => handedOver(run).includes(commentId);
  const packetOf = (f: { companyId: string }, agentId: string, run: typeof heartbeatRuns.$inferSelect) =>
    buildPaperclipWakePayload({ db, companyId: f.companyId, agentId, runId: run.id,
      contextSnapshot: run.contextSnapshot as Record<string, unknown> });
  const setStatus = (f: { companyId: string }, issueId: string, status: string) =>
    request(app(f.companyId)).patch(`/api/issues/${issueId}`).send({ status }).expect(200);

  it("holds the CTO's comment written with the blocker in one call (TR-1258), then hands it over when the blocker is done", async () => {
    const f = await seed({ blocked: false });
    const body = "Mission attributed; admission held until the group is ready.";
    await request(cto(f)).patch(`/api/issues/${f.taskId}`).send({ blockedByIssueIds: [f.blockerId], comment: body }).expect(200);
    await heartbeat.drainActiveRunExecutions();
    const commentId = await commentIdOf(f.taskId, body);
    await expect.poll(() => admissionHeld(f, commentId), { timeout: 20_000 }).toEqual([{ status: "skipped", reason: "issue_dependencies_blocked" }]);
    expect(await devRuns(f)).toEqual([]);
    await setStatus(f, f.blockerId, "done");
    const resolved = await runWhere(f.devId, f.taskId, run => (run.contextSnapshot as any)?.wakeReason === "issue_blockers_resolved");
    expect(handedOver(resolved)).toEqual([commentId]);
    expect(JSON.stringify(await packetOf(f, f.devId, resolved))).toContain(body);
  }, 120_000);

  it("holds at the claim gate the CTO comments merged in one queued run, records nothing, and hands both over", async () => {
    const f = await seed({ blocked: false, devMaxConcurrent: 1 });
    const busyRunId = randomUUID();
    await db.insert(heartbeatRuns).values({ id: busyRunId, companyId: f.companyId, agentId: f.devId, invocationSource: "assignment",
      status: "running", startedAt: new Date(), contextSnapshot: { issueId: randomUUID() } });
    await db.update(agents).set({ status: "running" }).where(eq(agents.id, f.devId));
    const first = await ctoComment(f, "Please look at the build log.");
    await expect.poll(async () => (await devRuns(f))[0]?.status, { timeout: 20_000 }).toBe("queued");
    const second = await ctoComment(f, "And the test report.");
    await expect.poll(async () => JSON.stringify((await devRuns(f))[0]?.contextSnapshot ?? {}), { timeout: 20_000 }).toContain(second);
    const [queued] = await devRuns(f);
    const requestsBefore = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.agentId, f.devId));
    await request(app(f.companyId)).patch(`/api/issues/${f.taskId}`).send({ blockedByIssueIds: [f.blockerId] }).expect(200);
    await db.update(heartbeatRuns).set({ status: "succeeded", finishedAt: new Date() }).where(eq(heartbeatRuns.id, busyRunId));
    await db.update(agents).set({ status: "idle" }).where(eq(agents.id, f.devId));
    await heartbeat.resumeQueuedRuns();
    await heartbeat.drainActiveRunExecutions();
    expect(await runById(queued!.id)).toMatchObject({ status: "cancelled", errorCode: "issue_dependencies_blocked" });
    expect(dispatched).not.toContain(queued!.id);
    // Nothing is recorded for the comments (a cut here could lose nothing): no request names them.
    const requestsAfter = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.agentId, f.devId));
    expect(requestsAfter.filter(row => JSON.stringify(row.payload ?? {}).includes("commentIds"))).toEqual([]);
    expect(requestsAfter.length).toBe(requestsBefore.length);
    await setStatus(f, f.blockerId, "done");
    const resolved = await runWhere(f.devId, f.taskId, run => (run.contextSnapshot as any)?.wakeReason === "issue_blockers_resolved");
    expect(handedOver(resolved)).toEqual([first, second]);
    const packet = JSON.stringify(await packetOf(f, f.devId, resolved));
    expect(packet).toContain("Please look at the build log.");
    expect(packet).toContain("And the test report.");
  }, 120_000);

  it("keeps a person's exception for a queued run that merged a person's comment with an agent's", async () => {
    const f = await seed({ blocked: false, devMaxConcurrent: 1 });
    const busyRunId = randomUUID();
    await db.insert(heartbeatRuns).values({ id: busyRunId, companyId: f.companyId, agentId: f.devId, invocationSource: "assignment",
      status: "running", startedAt: new Date(), contextSnapshot: { issueId: randomUUID() } });
    await db.update(agents).set({ status: "running" }).where(eq(agents.id, f.devId));
    await ctoComment(f, "Agent first.");
    await expect.poll(async () => (await devRuns(f))[0]?.status, { timeout: 20_000 }).toBe("queued");
    await request(app(f.companyId)).post(`/api/issues/${f.taskId}/comments`).send({ body: "Person second." }).expect(201);
    const personId = await commentIdOf(f.taskId, "Person second.");
    await expect.poll(async () => JSON.stringify((await devRuns(f))[0]?.contextSnapshot ?? {}), { timeout: 20_000 }).toContain(personId);
    const [queued] = await devRuns(f);
    await request(app(f.companyId)).patch(`/api/issues/${f.taskId}`).send({ blockedByIssueIds: [f.blockerId] }).expect(200);
    await db.update(heartbeatRuns).set({ status: "succeeded", finishedAt: new Date() }).where(eq(heartbeatRuns.id, busyRunId));
    await db.update(agents).set({ status: "idle" }).where(eq(agents.id, f.devId));
    await heartbeat.resumeQueuedRuns();
    await heartbeat.drainActiveRunExecutions();
    expect((await runById(queued!.id))!.status).not.toBe("cancelled");
    expect(dispatched).toContain(queued!.id);
  }, 120_000);

  // Second review, point 1: a run of ANOTHER role that carried the comment must not count as handed over to the Dev.
  it("hands the comment to the Dev at the lift even after a non-assignee's run carried it", async () => {
    const f = await seed();
    const [comment] = await db.insert(issueComments).values({ companyId: f.companyId, issueId: f.taskId, authorType: "agent",
      authorAgentId: f.ctoId, body: "QA, can you check the fixture? Dev, this changes your task." }).returning();
    const commentWake = (agentId: string) => heartbeat.wakeup(agentId, {
      source: "automation", triggerDetail: "system", reason: "issue_commented",
      payload: { issueId: f.taskId, commentId: comment!.id }, requestedByActorType: "agent", requestedByActorId: f.ctoId,
      contextSnapshot: { issueId: f.taskId, taskId: f.taskId, wakeReason: "issue_commented", commentId: comment!.id,
        wakeCommentId: comment!.id, source: "issue.comment" },
    });
    // A non-assignee passes as before (only the assignee is held); a mention never wakes in this fork.
    const qaRun = await commentWake(f.qaId);
    expect(qaRun).not.toBeNull();
    expect(qaRun!.contextSnapshot).toMatchObject({ dependencyBlockedInteraction: true });
    await heartbeat.drainActiveRunExecutions();
    expect((await runById(qaRun!.id))!.status).toBe("succeeded");
    // The same wake for the blocked assignee is held (at admission, or at the claim gate behind QA's run).
    expect(await commentWake(f.devId)).toBeNull();
    await heartbeat.drainActiveRunExecutions();
    for (const run of (await devRuns(f)).filter(row => JSON.stringify(row.contextSnapshot).includes(comment!.id))) {
      expect(run).toMatchObject({ status: "cancelled", errorCode: "issue_dependencies_blocked" });
    }
    await setStatus(f, f.blockerId, "done");
    const resolved = await runWhere(f.devId, f.taskId, run => (run.contextSnapshot as any)?.wakeReason === "issue_blockers_resolved");
    expect(handedOver(resolved)).toEqual([comment!.id]);
  }, 120_000);

  // Second review, point 2: one blocker cancelled, the other then done. Cancelled blockers stay unresolved, so no
  // blockers-resolved wake comes; the dependency is handed back to the Dev, whose run carries the held comment.
  it("hands the dependency back, with the held comment, when the remaining blockers are all cancelled", async () => {
    const f = await seed({ blocked: false });
    await request(app(f.companyId)).patch(`/api/issues/${f.taskId}`).send({ blockedByIssueIds: [f.blockerId, f.blocker2Id] }).expect(200);
    // Held while both blockers are open.
    const held = await heldComment(f, "Written while both blockers are open.");
    // One blocker cancelled through the route: STUDIO-0029's hand-off run carries the held comment (and settles it).
    await setStatus(f, f.blocker2Id, "cancelled");
    const handOff = await runWhere(f.devId, f.taskId, run => (run.contextSnapshot as any)?.cancelledBlockerIssueId === f.blocker2Id);
    expect(handedOver(handOff)).toEqual([held]);
    await taskQuiet(f);
    const before = (await devRuns(f)).map(run => run.id);
    // The open one is done: only a cancelled blocker is left (never ready, no blockers-resolved wake), so the
    // dependency is handed back. The comment, already handed over by a run that reached its engine, is not repeated.
    await setStatus(f, f.blockerId, "done");
    const handBack = await runWhere(f.devId, f.taskId,
      run => JSON.stringify(run.contextSnapshot).includes("issue.cancelled_dependency_handoff"), before);
    expect((handBack.contextSnapshot as any).cancelledBlockerIssueId).toBe(f.blocker2Id);
    expect(handedOver(handBack)).toEqual([]);
    const notes = await db.select({ body: issueComments.body }).from(issueComments)
      .where(and(eq(issueComments.issueId, f.taskId), eq(issueComments.authorType, "system")));
    expect(notes.some(row => row.body.includes("every blocker this task still waits on is cancelled"))).toBe(true);
  }, 120_000);

  // v5, point 3: nothing is held as soon as ONE unresolved blocker is cancelled (studio.21 there, a bounded run).
  it("holds nothing once one unresolved blocker is cancelled: the comment runs bounded, as in studio.21", async () => {
    const f = await seed({ blocked: false });
    await request(app(f.companyId)).patch(`/api/issues/${f.taskId}`).send({ blockedByIssueIds: [f.blockerId, f.blocker2Id] }).expect(200);
    await setStatus(f, f.blocker2Id, "cancelled");
    await runWhere(f.devId, f.taskId, run => (run.contextSnapshot as any)?.cancelledBlockerIssueId === f.blocker2Id);
    await taskQuiet(f);
    const comment = await ctoComment(f, "One blocker cancelled, one open.");
    const run = await runWhere(f.devId, f.taskId, row => JSON.stringify(row.contextSnapshot).includes(comment));
    expect(run.contextSnapshot).toMatchObject({ dependencyBlockedInteraction: true });
    expect((await admissionHeld(f, comment)).filter(row => row.status === "skipped")).toEqual([]);
  }, 120_000);

  // v5, point 5: the hand-back comment is written, its wake fails (a cut between the two); the next dependency change
  // finds the comment without its wake and wakes it.
  it("wakes again a hand-back comment left without its wake", async () => {
    const f = await seed({ blocked: false });
    await request(app(f.companyId)).patch(`/api/issues/${f.taskId}`).send({ blockedByIssueIds: [f.blockerId, f.blocker2Id] }).expect(200);
    await setStatus(f, f.blocker2Id, "cancelled");
    await runWhere(f.devId, f.taskId, run => (run.contextSnapshot as any)?.cancelledBlockerIssueId === f.blocker2Id);
    await taskQuiet(f);
    await db.execute(sql.raw(`
      create or replace function studio_test_fail_handback_wake() returns trigger language plpgsql as $$
      begin
        if new.payload->>'issueId' = '${f.taskId}' and new.payload ? 'cancelledBlockerIssueId' and new.reason = 'issue_commented'
          and coalesce(new.payload->>'mutation', '') = 'comment' and new.requested_by_actor_id = 'cancelled_blocker_handoff'
          and new.payload->>'commentId' in (select id::text from issue_comments where body like '%cancelled-blockers-left:%') then
          raise exception 'injected: hand-back wake lost';
        end if;
        return new;
      end $$;
      drop trigger if exists studio_test_fail_handback_wake on agent_wakeup_requests;
      create trigger studio_test_fail_handback_wake before insert on agent_wakeup_requests
        for each row execute function studio_test_fail_handback_wake();`));
    const handBackComments = () => db.select({ id: issueComments.id }).from(issueComments)
      .where(and(eq(issueComments.issueId, f.taskId), sql`${issueComments.body} like '%cancelled-blockers-left:%'`));
    try {
      await setStatus(f, f.blockerId, "done");
      await expect.poll(async () => (await handBackComments()).length, { timeout: 20_000 }).toBe(1);
      await heartbeat.drainActiveRunExecutions();
      await new Promise(resolve => setTimeout(resolve, 500));
      const [lost] = await handBackComments();
      expect((await devRuns(f)).filter(run => JSON.stringify(run.contextSnapshot).includes(lost!.id))).toEqual([]);
    } finally {
      await db.execute(sql.raw(`drop trigger if exists studio_test_fail_handback_wake on agent_wakeup_requests;`));
    }
    // The next change of the task's dependencies (here the done blocker is taken off the list) wakes the comment.
    const [comment] = await handBackComments();
    await request(app(f.companyId)).patch(`/api/issues/${f.taskId}`).send({ blockedByIssueIds: [f.blocker2Id] }).expect(200);
    const woken = await runWhere(f.devId, f.taskId, run => JSON.stringify(run.contextSnapshot).includes(comment!.id));
    expect((woken.contextSnapshot as any).cancelledBlockerIssueId).toBe(f.blocker2Id);
    expect(await handBackComments()).toHaveLength(1);
  }, 120_000);

  // Second review, point 3: a partial removal leaving only done blockers makes the issue ready; so does deleting the
  // blocker. Both statuses that hold work (`todo` and `blocked`).
  for (const status of ["todo", "blocked"] as const) {
    it(`wakes the assignee with the held comment when a partial removal makes a ${status} issue ready`, async () => {
      const f = await seed({ blocked: false });
      await request(app(f.companyId)).patch(`/api/issues/${f.taskId}`)
        .send({ blockedByIssueIds: [f.blockerId, f.blocker2Id], ...(status === "blocked" ? { status: "blocked" } : {}) }).expect(200);
      await setStatus(f, f.blockerId, "done");
      await heartbeat.drainActiveRunExecutions();
      const held = await heldComment(f, `Held on a ${status} issue.`);
      const before = (await devRuns(f)).map(run => run.id);
      // The open blocker is removed; the done one stays: the issue is ready, the list is not empty.
      await request(app(f.companyId)).patch(`/api/issues/${f.taskId}`).send({ blockedByIssueIds: [f.blockerId] }).expect(200);
      const run = await runWhere(f.devId, f.taskId, carrying(held), before);
      expect((run.contextSnapshot as any).wakeReason).toBe("issue_blockers_resolved");
    }, 120_000);
  }

  it("wakes the assignee with the held comment when its blocker issue is deleted", async () => {
    const f = await seed();
    const held = await heldComment(f, "Held until the blocker goes away.");
    await request(app(f.companyId)).delete(`/api/issues/${f.blockerId}`).expect(200);
    const run = await runWhere(f.devId, f.taskId, carrying(held));
    expect((run.contextSnapshot as any).source).toBe("issue.blocker_deleted");
  }, 120_000);

  // Second review, point 9: the wake key carries the edit's time, so two removals give two wakes.
  it("wakes once for each removal that makes the issue ready", async () => {
    const f = await seed();
    const firstHeld = await heldComment(f, "Before the first removal.");
    await request(app(f.companyId)).patch(`/api/issues/${f.taskId}`).send({ blockedByIssueIds: [] }).expect(200);
    const first = await runWhere(f.devId, f.taskId, carrying(firstHeld));
    await request(app(f.companyId)).patch(`/api/issues/${f.taskId}`).send({ blockedByIssueIds: [f.blocker2Id] }).expect(200);
    const secondHeld = await heldComment(f, "Before the second removal.");
    await request(app(f.companyId)).patch(`/api/issues/${f.taskId}`).send({ blockedByIssueIds: [] }).expect(200);
    const second = await runWhere(f.devId, f.taskId, carrying(secondHeld), [first.id]);
    expect([first, second].map(run => (run.contextSnapshot as any).source)).toEqual(["issue.blockers_edited", "issue.blockers_edited"]);
    // The first run succeeded with its engine started: the first comment is not handed over again.
    expect(handedOver(second)).toEqual([secondHeld]);
  }, 120_000);

  // Proof of delivery (pilot's choice B): a run counts only if its engine process started AND it succeeded.
  it("hands the comment over again after a run without a started engine, a run cut after its start, or a router refusal", async () => {
    for (const outcome of ["no-spawn", "spawn-255", "refuse:router_group_participant_reserved"] as const) {
      const f = await seed();
      const held = await heldComment(f, `Held, then a ${outcome} run.`);
      nextOutcome.set(f.taskId, outcome);
      await setStatus(f, f.blockerId, "done");
      const carrier = await runWhere(f.devId, f.taskId, carrying(held));
      expect(carrier.status).toBe(outcome === "no-spawn" ? "succeeded" : "failed");
      if (outcome === "no-spawn") expect(carrier.processStartedAt).toBeNull();
      if (outcome === "spawn-255") expect(carrier.processStartedAt).not.toBeNull();
      // The Dev's next started run on the task (a recovery run, or the run of another agent comment) carries it again.
      await devAtRest(f);
      await ctoComment(f, `A note after the ${outcome} run.`);
      // A cut run is retried later (transient retry): let it fall due now.
      let again: typeof heartbeatRuns.$inferSelect | undefined;
      for (let attempt = 0; attempt < 80 && !again; attempt += 1) {
        await db.update(heartbeatRuns).set({ scheduledRetryAt: new Date(Date.now() - 1000) })
          .where(and(eq(heartbeatRuns.agentId, f.devId), eq(heartbeatRuns.status, "scheduled_retry")));
        await heartbeat.promoteDueScheduledRetries(new Date());
        await heartbeat.resumeQueuedRuns();
        again = (await devRuns(f)).filter(run => run.id !== carrier.id && run.startedAt && run.createdAt >= carrier.createdAt)
          .sort((x, y) => x.createdAt.getTime() - y.createdAt.getTime())[0];
        if (!again) await new Promise(resolve => setTimeout(resolve, 250));
      }
      expect(again, JSON.stringify({ runs: (await devRuns(f)).map(run => ({ s: run.status, e: run.errorCode,
        st: Boolean(run.startedAt), r: (run.contextSnapshot as any)?.wakeReason })),
        wakes: await db.select({ s: agentWakeupRequests.status, r: agentWakeupRequests.reason, e: agentWakeupRequests.error })
          .from(agentWakeupRequests).where(eq(agentWakeupRequests.agentId, f.devId)) })).toBeDefined();
      expect(handedOver(again!)).toEqual([held]);
      await devAtRest(f);
      expect((await runById(again!.id))!.status).toBe("succeeded");
      // That run qualified: no later run carries it any more.
      await ctoComment(f, `A later note after the ${outcome} run.`);
      let later: typeof heartbeatRuns.$inferSelect[] = [];
      for (let attempt = 0; attempt < 80 && later.length === 0; attempt += 1) {
        await heartbeat.resumeQueuedRuns();
        await heartbeat.drainActiveRunExecutions();
        later = (await devRuns(f)).filter(run => run.startedAt && run.createdAt > again!.createdAt);
        if (later.length === 0) await new Promise(resolve => setTimeout(resolve, 250));
      }
      expect(later.length).toBeGreaterThan(0);
      for (const run of later) expect(handedOver(run)).not.toContain(held);
    }
  }, 240_000);

  it("hands the whole agent thread to the new assignee after a reassignment during the wait", async () => {
    const f = await seed();
    const held = await heldComment(f, "For whoever owns this task.");
    await request(app(f.companyId)).patch(`/api/issues/${f.taskId}`).send({ assigneeAgentId: f.dev2Id }).expect(200);
    await heartbeat.drainActiveRunExecutions();
    await setStatus(f, f.blockerId, "done");
    const run = await runWhere(f.dev2Id, f.taskId, carrying(held));
    expect(handedOver(run)).toEqual([held]);
  }, 120_000);

  it("does not let a person's bounded run settle the agents' held comments", async () => {
    const f = await seed();
    const held = await heldComment(f, "Held before the person.");
    await request(app(f.companyId)).post(`/api/issues/${f.taskId}/comments`).send({ body: "Person meanwhile." }).expect(201);
    const personRun = await runWhere(f.devId, f.taskId, () => true);
    expect(personRun.contextSnapshot).toMatchObject({ dependencyBlockedInteraction: true });
    expect(handedOver(personRun)).toEqual([]);
    expect(personRun.status).toBe("succeeded");
    await setStatus(f, f.blockerId, "done");
    const resolved = await runWhere(f.devId, f.taskId, run => (run.contextSnapshot as any)?.wakeReason === "issue_blockers_resolved");
    expect(handedOver(resolved)).toEqual([held]);
  }, 120_000);

  it("hands over at the next run a comment written while the assignee's dependency run is running", async () => {
    const f = await seed();
    let release!: () => void;
    holdOpen.set(f.taskId, new Promise<void>(resolve => { release = resolve; }));
    await setStatus(f, f.blockerId, "done");
    await expect.poll(async () => (await devRuns(f)).find(run => run.status === "running")?.id, { timeout: 20_000 }).toBeDefined();
    const [running] = (await devRuns(f)).filter(run => run.status === "running");
    const during = await ctoComment(f, "Written while the dependency run runs.");
    holdOpen.delete(f.taskId);
    release();
    await heartbeat.drainActiveRunExecutions();
    await heartbeat.resumeQueuedRuns();
    const next = await runWhere(f.devId, f.taskId, run => JSON.stringify(run.contextSnapshot).includes(during), [running!.id]);
    expect(next.status).toBe("succeeded");
  }, 120_000);

  it("names the latest twenty comments written through the route and counts the older ones", async () => {
    const f = await seed();
    const ids: string[] = [];
    // Each comment from a separate CTO run (the route limits how much one run writes on another task).
    for (let i = 1; i <= 22; i += 1) {
      const runId = randomUUID();
      await db.insert(heartbeatRuns).values({ id: runId, companyId: f.companyId, agentId: f.ctoId, invocationSource: "assignment",
        status: "running", startedAt: new Date(), contextSnapshot: { issueId: f.ctoTaskId } });
      ids.push(await ctoComment(f, `Held note ${String(i).padStart(2, "0")}.`, runId));
    }
    // The route sends a comment's wake after answering: every comment is held before the lift (a wake admitted after
    // it would be the lift run's own wake comment, shown as such and not counted as held).
    for (const id of ids) {
      await expect.poll(() => admissionHeld(f, id), { timeout: 20_000 }).toEqual([{ status: "skipped", reason: "issue_dependencies_blocked" }]);
    }
    await setStatus(f, f.blockerId, "done");
    const resolved = await runWhere(f.devId, f.taskId, run => (run.contextSnapshot as any)?.wakeReason === "issue_blockers_resolved");
    expect(handedOver(resolved)).toEqual(ids.slice(2));
    expect((resolved.contextSnapshot as any).heldDependencyOlderCount).toBe(2);
    const packet = await packetOf(f, f.devId, resolved) as any;
    expect(packet.heldDependencyComments).toMatchObject({ heldCount: 22, shownCount: 20, olderInThreadCount: 2 });
    expect(packet.commentIds).toEqual(ids.slice(2));
    expect(packet.truncated).toBe(true);
    expect(packet.fallbackFetchNeeded).toBe(true);
  }, 240_000);

  // The safety net for a `blocked` issue made ready without a route: the stranded-dependency backstop
  // (reconcileResolvedDependencyWakeBackstop, recovery/service.ts) wakes it; that run carries the held comment.
  it("hands the held comment over through the dependency backstop when the blocker became done without a route", async () => {
    const f = await seed({ blocked: false });
    await request(app(f.companyId)).patch(`/api/issues/${f.taskId}`).send({ blockedByIssueIds: [f.blockerId], status: "blocked" }).expect(200);
    const held = await heldComment(f, "Backstop note.");
    await db.update(issues).set({ status: "done", completedAt: new Date() }).where(eq(issues.id, f.blockerId));
    await heartbeat.reconcileResolvedDependencyWakes({ companyId: f.companyId, issueId: f.taskId });
    const run = await runWhere(f.devId, f.taskId, carrying(held));
    expect((run.contextSnapshot as any).wakeReason).toBe("issue_blockers_resolved");
  }, 120_000);

  // Third review, point 6 (kept by the owner): one system note per series says that an agent's comment waits, and how
  // to get an answer before. It wakes nobody.
  // v5, point 1: no atomic trace of a hold, no handover (and no cost): an issue never blocked is unchanged.
  it("adds nothing to the runs of an issue that was never blocked, even after a failed run", async () => {
    const f = await seed({ blocked: false });
    await ctoComment(f, "First note on an open task.");
    await taskQuiet(f);
    nextOutcome.set(f.taskId, "spawn-255");
    await ctoComment(f, "Second note; this run is cut.");
    await taskQuiet(f);
    await ctoComment(f, "Third note.");
    await taskQuiet(f);
    const runs = await devRuns(f);
    expect(runs.length).toBeGreaterThanOrEqual(3);
    expect(runs.some(run => run.status === "failed")).toBe(true);
    for (const run of runs) expect((run.contextSnapshot as any)?.heldDependencyCommentIds).toBeUndefined();
  }, 120_000);

  // v5, point 1: a trace older than the base (a hold from before the change was installed) is ignored.
  it("ignores a hold trace older than the assignee's latest qualified run", async () => {
    const f = await seed({ blocked: false });
    await ctoComment(f, "Settled by the next run.");
    const settled = await runWhere(f.devId, f.taskId, () => true);
    expect(settled.status).toBe("succeeded");
    await taskQuiet(f);
    // An agent comment after that run: it would be handed over if the old trace counted.
    await ctoComment(f, "After the settled run.");
    await taskQuiet(f);
    // A marked skipped issue_dependencies_blocked request written before that run started.
    await db.insert(agentWakeupRequests).values({ companyId: f.companyId, agentId: f.devId, source: "automation",
      triggerDetail: "system", reason: "issue_dependencies_blocked", status: "skipped", requestedByActorType: "agent",
      requestedByActorId: f.ctoId, requestedAt: new Date(settled.startedAt!.getTime() - 60_000),
      finishedAt: new Date(settled.startedAt!.getTime() - 60_000), updatedAt: new Date(settled.startedAt!.getTime() - 60_000),
      createdAt: new Date(settled.startedAt!.getTime() - 60_000), payload: { issueId: f.taskId, heldDependencyTrace: true } });
    // A Board wake of the Dev on the ready task goes through the real admission, which decides the handover.
    const run = await heartbeat.wakeup(f.devId, {
      source: "on_demand", triggerDetail: "manual", reason: "issue_status_changed",
      payload: { issueId: f.taskId }, contextSnapshot: { issueId: f.taskId, taskId: f.taskId },
    });
    expect(run).not.toBeNull();
    await heartbeat.drainActiveRunExecutions();
    expect((run!.contextSnapshot as any)?.heldDependencyCommentIds).toBeUndefined();
  }, 120_000);

  // v5, point 1: the first run after a reassignment gets the agent comments written before, with its own text.
  it("hands the agent thread to a new assignee with the reassignment text", async () => {
    const f = await seed({ blocked: false });
    const before = await ctoComment(f, "Written to the first owner.");
    await taskQuiet(f);
    await request(app(f.companyId)).patch(`/api/issues/${f.taskId}`).send({ assigneeAgentId: f.dev2Id }).expect(200);
    const run = await runWhere(f.dev2Id, f.taskId, row => handedOver(row).length > 0);
    expect(handedOver(run)).toContain(before);
    expect((run.contextSnapshot as any).heldDependencyReason).toBe("reassignment");
    const packet = await packetOf(f, f.dev2Id, run) as any;
    expect(packet.heldDependencyComments.note).toContain("before you took it over");
  }, 120_000);

  // v5, point 4, and the cold review: a run that passes the claim gate under a person's exception runs bounded, and
  // its hand-over base is its ADMISSION time (before the blocker), never its start: a comment held after the blocker
  // was added stays after the base.
  it("marks a run passing the claim gate under an exception as bounded, with its admission as hand-over base", async () => {
    const f = await seed({ blocked: false, devMaxConcurrent: 1 });
    const busyRunId = randomUUID();
    await db.insert(heartbeatRuns).values({ id: busyRunId, companyId: f.companyId, agentId: f.devId, invocationSource: "assignment",
      status: "running", startedAt: new Date(), contextSnapshot: { issueId: randomUUID() } });
    await db.update(agents).set({ status: "running" }).where(eq(agents.id, f.devId));
    // A person's comment admitted while the task is ready: queued behind the busy run, then the blocker comes.
    await request(app(f.companyId)).post(`/api/issues/${f.taskId}/comments`).send({ body: "Person, before the blocker." }).expect(201);
    await expect.poll(async () => (await devRuns(f))[0]?.status, { timeout: 20_000 }).toBe("queued");
    const [personRun] = await devRuns(f);
    expect((personRun!.contextSnapshot as any).dependencyBlockedInteraction).toBeUndefined();
    await new Promise(resolve => setTimeout(resolve, 50));
    const blockedAt = new Date();
    await request(app(f.companyId)).patch(`/api/issues/${f.taskId}`).send({ blockedByIssueIds: [f.blockerId] }).expect(200);
    await new Promise(resolve => setTimeout(resolve, 1500));
    await db.update(heartbeatRuns).set({ status: "succeeded", finishedAt: new Date() }).where(eq(heartbeatRuns.id, busyRunId));
    await db.update(agents).set({ status: "idle" }).where(eq(agents.id, f.devId));
    await heartbeat.resumeQueuedRuns();
    await heartbeat.drainActiveRunExecutions();
    const passed = (await runById(personRun!.id))!;
    expect(passed.status).toBe("succeeded");
    expect(passed.processStartedAt).not.toBeNull();
    expect(passed.contextSnapshot).toMatchObject({ dependencyBlockedInteraction: true });
    expect(passed.startedAt!.getTime()).toBeGreaterThan(blockedAt.getTime());
    const { readHandOverBase } = await import("../services/heartbeat/held-dependency-comments.js");
    const base = await readHandOverBase(db, { companyId: f.companyId, issueId: f.taskId, agentId: f.devId });
    expect(base.since).not.toBeNull();
    expect(base.since!.getTime()).toBeLessThan(blockedAt.getTime());
  }, 120_000);

  // v6, A: the periodic hand-over backstop. A writer that bypasses the routes (here the exact service write a plugin's
  // setBlockedBy makes: issueService.update outside any transaction) wakes nobody; one backstop pass hands it over.
  it("hands the held comment over through one backstop pass after a direct service write (the plugin's setBlockedBy)", async () => {
    const f = await seed();
    const held = await heldComment(f, "Held, then the blocker removed by a plugin.");
    await taskQuiet(f);
    await issueService(db).update(f.taskId, { blockedByIssueIds: [], actorAgentId: null, actorUserId: null } as never);
    await new Promise(resolve => setTimeout(resolve, 1000));
    await heartbeat.drainActiveRunExecutions();
    expect((await devRuns(f)).filter(carrying(held))).toEqual([]);
    expect(await heartbeat.reconcileHeldCommentHandover({ companyId: f.companyId, issueId: f.taskId })).toBe("woken");
    const run = await runWhere(f.devId, f.taskId, carrying(held));
    expect((run.contextSnapshot as any).source).toBe("issue.held_comment_handover_backstop");
    // Settled by that qualified run: the next pass finds nothing to do.
    await taskQuiet(f);
    expect(await heartbeat.reconcileHeldCommentHandover({ companyId: f.companyId, issueId: f.taskId })).toBe("no_trace");
  }, 120_000);

  // v6, B8: the runner's set_dependencies makes the same service write inside its own transaction.
  it("hands the held comment over through the backstop after the runner's set_dependencies write", async () => {
    const f = await seed();
    const held = await heldComment(f, "Held, then the blocker removed by the runner tool.");
    await taskQuiet(f);
    await db.transaction(async tx => {
      await issueService(tx as never).update(f.taskId, { blockedByIssueIds: [], actorAgentId: f.ctoId, actorRunId: f.ctoRunId } as never, tx);
    });
    await new Promise(resolve => setTimeout(resolve, 1000));
    expect((await devRuns(f)).filter(carrying(held))).toEqual([]);
    expect(await heartbeat.reconcileHeldCommentHandover({ companyId: f.companyId, issueId: f.taskId })).toBe("woken");
    await runWhere(f.devId, f.taskId, carrying(held));
  }, 120_000);

  // v6, A: a hand-over run that fails before the engine leaves the issue eligible; the next pass wakes it again.
  it("wakes again on the next backstop pass when the hand-over run fails before the engine", async () => {
    const f = await seed();
    const held = await heldComment(f, "Held, handed over by a refused run first.");
    await taskQuiet(f);
    await issueService(db).update(f.taskId, { blockedByIssueIds: [] } as never);
    // Every run of the task is refused for now (the server's own recovery runs too).
    stickyOutcome.set(f.taskId, "refuse:router_group_participant_reserved");
    expect(await heartbeat.reconcileHeldCommentHandover({ companyId: f.companyId, issueId: f.taskId })).toBe("woken");
    const refused = await runWhere(f.devId, f.taskId, carrying(held));
    expect(refused.status).toBe("failed");
    await taskQuiet(f);
    expect((await devRuns(f)).filter(run => run.status === "succeeded")).toEqual([]);
    // Still eligible: no qualified run after the hold. No key prevents a second wake; only a short wait does, which
    // doubles between two backstop wakes of the same issue (never a loop).
    stickyOutcome.delete(f.taskId);
    const before = (await devRuns(f)).map(run => run.id);
    const scope = { companyId: f.companyId, issueId: f.taskId };
    const firstWake = (await db.select().from(agentWakeupRequests).where(and(eq(agentWakeupRequests.agentId, f.devId),
      sql`${agentWakeupRequests.idempotencyKey} like 'held-handover-backstop:%'`)))[0]!;
    const at = (ms: number) => new Date(firstWake.requestedAt.getTime() + ms);
    let outcome = await heartbeat.reconcileHeldCommentHandover({ ...scope, now: at(5_000) });
    // The server's own recovery may have given the refused issue to the Board (an active recovery action): the
    // backstop then leaves it until that action is resolved.
    if (outcome === "recovery_action") {
      await db.update(issueRecoveryActions).set({ status: "resolved", outcome: "restored", resolvedAt: new Date() })
        .where(eq(issueRecoveryActions.sourceIssueId, f.taskId));
      await db.update(issues).set({ status: "todo" }).where(eq(issues.id, f.taskId));
      outcome = await heartbeat.reconcileHeldCommentHandover({ ...scope, now: at(5_000) });
    }
    expect(outcome).toBe("waiting");
    expect(await heartbeat.reconcileHeldCommentHandover({ ...scope, now: at(31_000) })).toBe("woken");
    const again = await runWhere(f.devId, f.taskId, carrying(held), before);
    expect(again.status).toBe("succeeded");
    expect((again.contextSnapshot as any).source).toBe("issue.held_comment_handover_backstop");
    await taskQuiet(f);
    expect(await heartbeat.reconcileHeldCommentHandover({ ...scope, now: at(3_600_000) })).toBe("no_trace");
  }, 180_000);

  // Cold review: a second automatic hold under the same blockers is coalesced into the first request (only its
  // `updatedAt` moves): it is still a trace after the base.
  it("sees a coalesced automatic hold as a trace after the base", async () => {
    const f = await seed();
    const systemWake = () => heartbeat.wakeup(f.devId, {
      source: "automation", triggerDetail: "system", reason: "issue_status_changed", requestedByActorType: "system",
      requestedByActorId: "test", payload: { issueId: f.taskId }, contextSnapshot: { issueId: f.taskId, taskId: f.taskId },
    });
    const holds = () => db.select().from(agentWakeupRequests).where(and(eq(agentWakeupRequests.agentId, f.devId),
      eq(agentWakeupRequests.status, "skipped"), eq(agentWakeupRequests.reason, "issue_dependencies_blocked")));
    await taskQuiet(f);
    expect(await systemWake()).toBeNull();
    const [firstHold] = await holds();
    // Ready through the route: a qualified run moves the base past that hold.
    await request(app(f.companyId)).patch(`/api/issues/${f.taskId}`).send({ blockedByIssueIds: [] }).expect(200);
    await runWhere(f.devId, f.taskId, run => (run.contextSnapshot as any)?.wakeReason === "issue_blockers_resolved");
    await taskQuiet(f);
    expect(await heartbeat.reconcileHeldCommentHandover({ companyId: f.companyId, issueId: f.taskId })).toBe("no_trace");
    // Blocked again by the same blocker, held again: the same request row, only updated.
    await request(app(f.companyId)).patch(`/api/issues/${f.taskId}`).send({ blockedByIssueIds: [f.blockerId] }).expect(200);
    await taskQuiet(f);
    expect(await systemWake()).toBeNull();
    const after = await holds();
    expect(after.map(row => row.id)).toEqual([firstHold!.id]);
    expect(after[0]!.coalescedCount).toBeGreaterThan(firstHold!.coalescedCount);
    // The blocker goes without a wake: the backstop sees the coalesced hold.
    await issueService(db).update(f.taskId, { blockedByIssueIds: [] } as never);
    expect(await heartbeat.reconcileHeldCommentHandover({ companyId: f.companyId, issueId: f.taskId })).toBe("woken");
    await taskQuiet(f);
  }, 180_000);

  // Cold review: a reassignment written by a service (no activity) while a comment is held for the previous assignee.
  it("hands the held comment to a new assignee that a service write put on the issue, through the backstop", async () => {
    const f = await seed();
    const held = await heldComment(f, "Held for the first owner, then the issue moves silently.");
    await taskQuiet(f);
    await issueService(db).update(f.taskId, { assigneeAgentId: f.dev2Id } as never);
    await issueService(db).update(f.taskId, { blockedByIssueIds: [] } as never);
    await new Promise(resolve => setTimeout(resolve, 1000));
    expect((await agentRuns(f.dev2Id, f.taskId)).filter(carrying(held))).toEqual([]);
    expect(await heartbeat.reconcileHeldCommentHandover({ companyId: f.companyId, issueId: f.taskId })).toBe("woken");
    const run = await runWhere(f.dev2Id, f.taskId, carrying(held));
    expect(run.status).toBe("succeeded");
  }, 120_000);

  // Cold review (point 8, the started case): a ready wake that reaches a bounded run ALREADY RUNNING does not turn it
  // into a qualified run; the held comment is still handed over afterwards.
  it("still hands the held comment over when the blocker is done while a bounded run of the assignee is running", async () => {
    const f = await seed();
    const held = await heldComment(f, "Held while a person's bounded run is about to start.");
    await taskQuiet(f);
    let release!: () => void;
    holdOpen.set(f.taskId, new Promise<void>(resolve => { release = resolve; }));
    await request(app(f.companyId)).post(`/api/issues/${f.taskId}/comments`).send({ body: "Person, while blocked." }).expect(201);
    await expect.poll(async () => (await devRuns(f)).find(run => run.status === "running")?.id, { timeout: 20_000 }).toBeDefined();
    const bounded = (await devRuns(f)).find(run => run.status === "running")!;
    expect(bounded.contextSnapshot).toMatchObject({ dependencyBlockedInteraction: true });
    expect(handedOver(bounded)).toEqual([]);
    await setStatus(f, f.blockerId, "done");
    await new Promise(resolve => setTimeout(resolve, 1000));
    holdOpen.delete(f.taskId);
    release();
    await taskQuiet(f);
    // The bounded run did not carry the comment, whatever a later wake merged into its row.
    expect(handedOver((await runById(bounded.id))!)).toEqual([]);
    let carriers = (await devRuns(f)).filter(run => run.id !== bounded.id && run.status === "succeeded" && carrying(held)(run));
    if (carriers.length === 0) {
      // No follow-up run was queued behind the bounded one: the backstop hands it over.
      expect(await heartbeat.reconcileHeldCommentHandover({ companyId: f.companyId, issueId: f.taskId })).toBe("woken");
      await runWhere(f.devId, f.taskId, run => run.id !== bounded.id && carrying(held)(run));
      await taskQuiet(f);
      carriers = (await devRuns(f)).filter(run => run.id !== bounded.id && run.status === "succeeded" && carrying(held)(run));
    }
    expect(carriers.length).toBeGreaterThan(0);
    expect(await heartbeat.reconcileHeldCommentHandover({ companyId: f.companyId, issueId: f.taskId })).toBe("no_trace");
  }, 180_000);

  // v6, A: the cost of one backstop pass for one issue, with history. No age bound on the traces.
  it("measures one backstop pass with thousands of old wake requests and runs for the assignee", async () => {
    const f = await seed({ blocked: false });
    const old = new Date(Date.now() - 86_400_000);
    for (let batch = 0; batch < 10; batch += 1) {
      await db.insert(agentWakeupRequests).values(Array.from({ length: 1000 }, () => ({ companyId: f.companyId, agentId: f.devId,
        source: "automation", triggerDetail: "system", reason: "issue_dependencies_blocked", status: "skipped",
        requestedByActorType: "agent", requestedAt: old, finishedAt: old, payload: { issueId: randomUUID() } })));
      await db.insert(heartbeatRuns).values(Array.from({ length: 500 }, () => ({ companyId: f.companyId, agentId: f.devId,
        invocationSource: "automation" as const, status: "succeeded", startedAt: old, finishedAt: old, processStartedAt: old,
        createdAt: old, contextSnapshot: { issueId: randomUUID() } })));
    }
    const timings: number[] = [];
    for (let pass = 0; pass < 20; pass += 1) {
      const start = performance.now();
      expect(await heartbeat.reconcileHeldCommentHandover({ companyId: f.companyId, issueId: f.taskId })).toBe("no_trace");
      timings.push(performance.now() - start);
    }
    timings.sort((a, b) => a - b);
    const median = timings[10]!, worst = timings[19]!;
    console.log(`BACKSTOP_COST median_ms=${median.toFixed(1)} worst_ms=${worst.toFixed(1)} requests=10000 runs=5000`);
    expect(median).toBeLessThan(500);
  }, 180_000);

  // v6, B1: every blocker edit goes through the function, on a `blocked` issue too.
  it("wakes a blocked issue whose blocker list is emptied, with the held comment", async () => {
    const f = await seed({ blocked: false });
    await request(app(f.companyId)).patch(`/api/issues/${f.taskId}`).send({ blockedByIssueIds: [f.blockerId], status: "blocked" }).expect(200);
    const held = await heldComment(f, "Held on a blocked issue, list emptied.");
    await request(app(f.companyId)).patch(`/api/issues/${f.taskId}`).send({ blockedByIssueIds: [] }).expect(200);
    await runWhere(f.devId, f.taskId, carrying(held));
  }, 120_000);

  it("hands a blocked issue back when its blockers are replaced by cancelled ones only", async () => {
    const f = await seed({ blocked: false });
    await request(app(f.companyId)).patch(`/api/issues/${f.taskId}`).send({ blockedByIssueIds: [f.blockerId], status: "blocked" }).expect(200);
    const held = await heldComment(f, "Held, then only a cancelled blocker left.");
    await db.update(issues).set({ status: "cancelled", cancelledAt: new Date() }).where(eq(issues.id, f.blocker2Id));
    await request(app(f.companyId)).patch(`/api/issues/${f.taskId}`).send({ blockedByIssueIds: [f.blocker2Id] }).expect(200);
    const run = await runWhere(f.devId, f.taskId, carrying(held));
    expect((run.contextSnapshot as any).cancelledBlockerIssueId).toBe(f.blocker2Id);
  }, 120_000);

  // v6, B2 (regression of v5): a person's comment in the same PATCH as a blocker removal is not dropped.
  it("keeps a person's comment written in the same PATCH as the blocker removal", async () => {
    const f = await seed();
    const held = await heldComment(f, "Held before the person's PATCH.");
    await request(app(f.companyId)).patch(`/api/issues/${f.taskId}`)
      .send({ blockedByIssueIds: [], comment: "Person: unblocked, go ahead." }).expect(200);
    const personComment = await commentIdOf(f.taskId, "Person: unblocked, go ahead.");
    const run = await runWhere(f.devId, f.taskId, row => JSON.stringify(row.contextSnapshot).includes(personComment));
    expect(handedOver(run)).toContain(held);
  }, 120_000);

  // v6, B6: a "ready" wake merged into a bounded run still queued turns it into a run of the ready issue.
  it("drops the bounded mode when a ready wake merges into a queued bounded run", async () => {
    const f = await seed({ devMaxConcurrent: 1 });
    const busyRunId = randomUUID();
    await db.insert(heartbeatRuns).values({ id: busyRunId, companyId: f.companyId, agentId: f.devId, invocationSource: "assignment",
      status: "running", startedAt: new Date(), contextSnapshot: { issueId: randomUUID() } });
    await db.update(agents).set({ status: "running" }).where(eq(agents.id, f.devId));
    await request(app(f.companyId)).post(`/api/issues/${f.taskId}/comments`).send({ body: "Person, while blocked." }).expect(201);
    await expect.poll(async () => (await devRuns(f))[0]?.status, { timeout: 20_000 }).toBe("queued");
    const [bounded] = await devRuns(f);
    expect(bounded!.contextSnapshot).toMatchObject({ dependencyBlockedInteraction: true });
    await setStatus(f, f.blockerId, "done");
    await expect.poll(async () => JSON.stringify((await runById(bounded!.id))?.contextSnapshot ?? {}), { timeout: 20_000 })
      .toContain("issue_blockers_resolved");
    expect(((await runById(bounded!.id))!.contextSnapshot as any).dependencyBlockedInteraction).toBeUndefined();
    await db.update(heartbeatRuns).set({ status: "succeeded", finishedAt: new Date() }).where(eq(heartbeatRuns.id, busyRunId));
    await db.update(agents).set({ status: "idle" }).where(eq(agents.id, f.devId));
    await heartbeat.resumeQueuedRuns();
    await heartbeat.drainActiveRunExecutions();
  }, 120_000);

  // v6, B3: the decision cards' effects go through the one function after commit.
  const decide = async (f: Fixture, effect: Record<string, unknown>) => {
    const runId = randomUUID();
    await db.insert(heartbeatRuns).values({ id: runId, companyId: f.companyId, agentId: f.ctoId, status: "running",
      responsibleUserId: "board-user", contextSnapshot: { issueId: f.ctoTaskId } });
    const service = decisionService(db, { wakeOriginAgent: async () => {} });
    const created = await service.create({
      companyId: f.companyId,
      actor: { type: "agent" as const, companyId: f.companyId, agentId: f.ctoId, runId, source: "agent_jwt" as const,
        onBehalfOfUserId: "board-user", onBehalfOfMemberships: [{ companyId: f.companyId, membershipRole: "operator", status: "active" }] },
      agentId: f.ctoId, runId, title: "Decide?", body: "Body",
      options: [{ id: "yes", label: "Yes", effects: [effect] }],
    } as never);
    const result = await service.decide({ id: created.id, optionId: "yes", decidedByUserId: "board-user",
      userActor: { type: "board" as const, userId: "board-user", companyIds: [f.companyId], source: "session" as const,
        memberships: [{ companyId: f.companyId, membershipRole: "operator", status: "active" }] } } as never);
    expect((result as any).executions[0], JSON.stringify((result as any).executions[0])).toMatchObject({ status: "executed" });
  };

  it("hands the held comment over when a resolve_blocker decision makes the issue ready", async () => {
    const f = await seed();
    const held = await heldComment(f, "Held until a decision removes the blocker.");
    await taskQuiet(f);
    await decide(f, { type: "resolve_blocker", targetIssueId: f.taskId, staleness: "lenient", removeBlockedByIssueIds: [f.blockerId] });
    const run = await runWhere(f.devId, f.taskId, carrying(held));
    expect((run.contextSnapshot as any).source).toBe("issue.blockers_edited");
  }, 120_000);

  it("hands the held comment over when an update_issue_status decision finishes the blocker", async () => {
    const f = await seed();
    const held = await heldComment(f, "Held until a decision finishes the blocker.");
    await taskQuiet(f);
    await decide(f, { type: "update_issue_status", targetIssueId: f.blockerId, staleness: "lenient", status: "done" });
    const run = await runWhere(f.devId, f.taskId, carrying(held));
    expect((run.contextSnapshot as any).wakeReason).toBe("issue_blockers_resolved");
  }, 120_000);

  it("hands the dependency back when a cancel_issue_tree decision cancels the blocker", async () => {
    const f = await seed();
    const held = await heldComment(f, "Held until a decision cancels the blocker.");
    await taskQuiet(f);
    await decide(f, { type: "cancel_issue_tree", targetIssueId: f.blockerId, staleness: "lenient", reasonComment: "cleanup" });
    const run = await runWhere(f.devId, f.taskId, carrying(held));
    expect((run.contextSnapshot as any).cancelledBlockerIssueId).toBe(f.blockerId);
  }, 120_000);

  // v6, B3: a native status decision that makes a blocker done or cancelled goes through the function after commit.
  const nativeDecision = async (f: Fixture, status: "done" | "cancelled") => {
    const runId = randomUUID(), contractId = randomUUID(), resultId = randomUUID(), assessmentId = randomUUID();
    await db.update(issues).set({ status: "in_progress", assigneeAgentId: f.qaId, workMode: "standard" }).where(eq(issues.id, f.blockerId));
    const [prior] = await db.select().from(issues).where(eq(issues.id, f.blockerId));
    await db.insert(completionContracts).values({ id: contractId, companyId: f.companyId, issueId: f.blockerId, revision: 1,
      schemaVersion: "paperclip.completion-contract.v1", policyVersion: "dependency-wake-test", risk: "standard",
      completionAuthority: "server_arbiter", incompleteCriteriaPolicy: "preserve_non_terminal",
      contractJson: { revision: "1", objective: "Finish", criteria: [] }, canonicalSha256: `contract-${contractId}`,
      createdByActorType: "system", createdByActorId: "test" });
    await db.insert(heartbeatRuns).values({ id: runId, companyId: f.companyId, agentId: f.qaId, status: "running", runtimeMode: "native",
      nativeIssueId: f.blockerId, completionContractId: contractId, completionContractSha256: `contract-${contractId}`,
      contextSnapshot: { issueId: f.blockerId } });
    await db.insert(nativeRunResults).values({ id: resultId, companyId: f.companyId, issueId: f.blockerId, runId,
      completionContractId: contractId, serverFingerprint: `fp-${resultId}`, schemaStatus: "accepted", resultJson: {},
      canonicalSha256: `sha-${resultId}` });
    await db.insert(workAssessments).values({ id: assessmentId, companyId: f.companyId, issueId: f.blockerId, runId, contractId, resultId,
      triggerKind: "native_result", triggerActorCompanyId: f.companyId, priorIssueStatus: "in_progress",
      priorStatusVersion: prior!.statusVersion, policyVersion: "dependency-wake-test", assessmentJson: {},
      inputDigest: `assessment-${assessmentId}` });
    await db.insert(nativeRunFinalizations).values({ runId, companyId: f.companyId, issueId: f.blockerId, phase: "arbitrating", resultId });
    const decision: NativeStatusDecision = { policyVersion: NATIVE_STATUS_ARBITER_POLICY_VERSION, statusAction: status,
      toStatus: status, reasonCode: "dependency_wake_test", unblockDescriptor: null, effects: [] };
    const committed = await commitNativeStatusDecision({ db, companyId: f.companyId, issueId: f.blockerId, runId, assessmentId,
      priorStatus: "in_progress", priorStatusVersion: prior!.statusVersion, priorDecisionId: prior!.lastStatusDecisionId, decision });
    expect((await db.select().from(issues).where(eq(issues.id, f.blockerId)))[0]?.status).toBe(status);
    return { runId, decisionId: committed.decision.id };
  };

  it("adds no second wake when a native decision finishes the blocker: its own dependency wake stays the only one", async () => {
    const f = await seed();
    await heldComment(f, "Held until the blocker's native run is done.");
    await taskQuiet(f);
    await nativeDecision(f, "done");
    // The decision's own transaction queued the dependent's wake (delivered by the native effects dispatcher, as
    // before); the function, called after commit, finds it and adds none.
    await new Promise(resolve => setTimeout(resolve, 1000));
    const wakes = await db.select().from(agentWakeupRequests).where(and(eq(agentWakeupRequests.agentId, f.devId),
      eq(agentWakeupRequests.reason, "issue_blockers_resolved")));
    expect(wakes).toHaveLength(1);
    expect(wakes[0]!.requestedByActorId).toBe("native-status-committer");
    // That wake is live: the backstop leaves the issue alone.
    expect(await heartbeat.reconcileHeldCommentHandover({ companyId: f.companyId, issueId: f.taskId })).toBe("live_path");
  }, 120_000);

  // Bench, studio.22 candidate: the blocker is also a CHILD of the dependent (its parent). Each wired path gives the
  // parent's assignee exactly ONE wake request for the finished or cancelled child, and the held comment reaches it.
  const childBlocksParent = async () => {
    const f = await seed();
    await db.update(issues).set({ parentId: f.taskId }).where(eq(issues.id, f.blockerId));
    return f;
  };
  // The parent's wake requests about its blocker, as "reason:actor". Apart: the delivery rows of the native wake
  // dispatcher and the backstop's own wake.
  const blockerWakes = async (f: Fixture) => (await db.select().from(agentWakeupRequests).where(and(
    eq(agentWakeupRequests.agentId, f.devId), sql`${agentWakeupRequests.payload}->>'issueId' = ${f.taskId}`,
    sql`${agentWakeupRequests.reason} in ('issue_children_completed', 'issue_blockers_resolved', 'issue_commented')`)))
    .filter(row => !String(row.requestedByActorId ?? "").startsWith("native-status-wake-dispatch:"))
    .filter(row => row.requestedByActorId !== "held_comment_handover_backstop")
    .filter(row => row.reason !== "issue_commented" || Boolean((row.payload as any)?.cancelledBlockerIssueId))
    .map(row => `${row.reason}:${row.requestedByActorId}`).sort();

  it("gives the parent one wake when a native decision finishes a child that blocks it, and that wake hands the comment over", async () => {
    const f = await childBlocksParent();
    const held = await heldComment(f, "Held until the child that blocks this task is done (native).");
    await taskQuiet(f);
    await nativeDecision(f, "done");
    await new Promise(resolve => setTimeout(resolve, 1000));
    // The decision's own transaction woke the parent, with `issue_children_completed`; nothing is added after commit.
    expect(await blockerWakes(f)).toEqual(["issue_children_completed:native-status-committer"]);
    // That wake, delivered by the native wake dispatcher, is admitted with the hand-over.
    await heartbeat.dispatchPendingNativeStatusWakeups({ companyId: f.companyId });
    const run = await runWhere(f.devId, f.taskId, carrying(held));
    expect((run.contextSnapshot as any).wakeReason).toBe("issue_children_completed");
    expect(run.status).toBe("succeeded");
    expect(await blockerWakes(f)).toEqual(["issue_children_completed:native-status-committer"]);
  }, 120_000);

  it("hands the comment over through the backstop when the native decision's own wake is not delivered", async () => {
    const f = await childBlocksParent();
    const held = await heldComment(f, "Held; the native wake of the parent is lost.");
    await taskQuiet(f);
    await nativeDecision(f, "done");
    const scope = { companyId: f.companyId, issueId: f.taskId };
    expect(await heartbeat.reconcileHeldCommentHandover(scope)).toBe("live_path");
    await db.update(agentWakeupRequests).set({ status: "failed", finishedAt: new Date() }).where(and(
      eq(agentWakeupRequests.agentId, f.devId), eq(agentWakeupRequests.requestedByActorId, "native-status-committer")));
    expect(await heartbeat.reconcileHeldCommentHandover(scope)).toBe("woken");
    const run = await runWhere(f.devId, f.taskId, carrying(held));
    expect((run.contextSnapshot as any).source).toBe("issue.held_comment_handover_backstop");
    expect(await blockerWakes(f)).toEqual(["issue_children_completed:native-status-committer"]);
  }, 120_000);

  it("gives the parent one wake, the hand-back, when a native decision cancels the child that blocks it", async () => {
    const f = await childBlocksParent();
    const held = await heldComment(f, "Held until the child that blocks this task is cancelled (native).");
    await taskQuiet(f);
    await nativeDecision(f, "cancelled");
    const run = await runWhere(f.devId, f.taskId, run => (run.contextSnapshot as any)?.cancelledBlockerIssueId === f.blockerId);
    expect(handedOver(run)).toEqual([held]);
    await taskQuiet(f);
    expect(await blockerWakes(f)).toEqual(["issue_commented:cancelled_blocker_handoff"]);
  }, 120_000);

  it("gives the parent one wake when the route makes the child that blocks it done", async () => {
    const f = await childBlocksParent();
    const held = await heldComment(f, "Held until the child that blocks this task is done (route).");
    await taskQuiet(f);
    await setStatus(f, f.blockerId, "done");
    const run = await runWhere(f.devId, f.taskId, carrying(held));
    expect(run.status).toBe("succeeded");
    await taskQuiet(f);
    expect(await blockerWakes(f)).toHaveLength(1);
  }, 120_000);

  // The route keeps one wake per agent and issue in a request, as before this change. When it cancels a child that
  // blocks its parent, the parent's `issue_children_completed` wake takes the slot of the STUDIO-0029 hand-back wake,
  // and the dependency gate holds it (the cancelled blocker stays unresolved): on fb1ad740 the parent's assignee is
  // then never woken. Here the route still sends ONE request, and the backstop hands the dependency back.
  it("sends one request when the route cancels the child that blocks its parent, and the backstop hands it back", async () => {
    const f = await childBlocksParent();
    const held = await heldComment(f, "Held until the child that blocks this task is cancelled (route).");
    await taskQuiet(f);
    const before = (await db.select({ id: agentWakeupRequests.id }).from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.agentId, f.devId))).map(row => row.id);
    await setStatus(f, f.blockerId, "cancelled");
    await new Promise(resolve => setTimeout(resolve, 1500));
    await taskQuiet(f);
    const sent = (await db.select().from(agentWakeupRequests).where(and(eq(agentWakeupRequests.agentId, f.devId),
      sql`${agentWakeupRequests.payload}->>'issueId' = ${f.taskId}`))).filter(row => !before.includes(row.id));
    expect(sent.map(row => ({ status: row.status, reason: row.reason }))).toEqual([{ status: "skipped", reason: "issue_dependencies_blocked" }]);
    expect((await devRuns(f)).filter(carrying(held))).toEqual([]);
    expect(await heartbeat.reconcileHeldCommentHandover({ companyId: f.companyId, issueId: f.taskId })).toBe("handed_back");
    const run = await runWhere(f.devId, f.taskId, carrying(held));
    expect((run.contextSnapshot as any).cancelledBlockerIssueId).toBe(f.blockerId);
    expect(run.status).toBe("succeeded");
  }, 120_000);

  for (const [name, effect] of [
    ["update_issue_status", (f: Fixture) => ({ type: "update_issue_status", targetIssueId: f.blockerId, staleness: "lenient", status: "done" })],
    ["cancel_issue_tree", (f: Fixture) => ({ type: "cancel_issue_tree", targetIssueId: f.blockerId, staleness: "lenient", reasonComment: "cleanup" })],
  ] as const) {
    it(`gives the parent one wake when a ${name} decision ends the child that blocks it`, async () => {
      const f = await childBlocksParent();
      const held = await heldComment(f, `Held until a ${name} decision ends the child that blocks this task.`);
      await taskQuiet(f);
      await decide(f, effect(f));
      const run = await runWhere(f.devId, f.taskId, carrying(held));
      expect(run.status).toBe("succeeded");
      await taskQuiet(f);
      expect(await blockerWakes(f)).toHaveLength(1);
    }, 120_000);
  }

  // The pilot's silence: D waits on A and B, a comment is held, A is cancelled by a native decision, then B is done.
  it("hands the dependency back when a native decision cancels a blocker, then again when only cancelled ones are left", async () => {
    const f = await seed({ blocked: false });
    await request(app(f.companyId)).patch(`/api/issues/${f.taskId}`).send({ blockedByIssueIds: [f.blockerId, f.blocker2Id] }).expect(200);
    const held = await heldComment(f, "Held while both blockers are open (native).");
    await taskQuiet(f);
    await nativeDecision(f, "cancelled");
    // STUDIO-0029's hand-back for the cancelled blocker, as the route does it.
    const first = await runWhere(f.devId, f.taskId, run => (run.contextSnapshot as any)?.cancelledBlockerIssueId === f.blockerId);
    expect(handedOver(first)).toEqual([held]);
    await taskQuiet(f);
    const before = (await devRuns(f)).map(run => run.id);
    // B is done: D waits only on the cancelled A, is never ready, and is handed back (the comment is not repeated).
    await setStatus(f, f.blocker2Id, "done");
    const second = await runWhere(f.devId, f.taskId,
      run => JSON.stringify(run.contextSnapshot).includes("issue.cancelled_dependency_handoff"), before);
    expect((second.contextSnapshot as any).cancelledBlockerIssueId).toBe(f.blockerId);
    expect(handedOver(second)).toEqual([]);
  }, 180_000);

  it("notes once per series that an agent's comment waits, and the note wakes nobody", async () => {
    const f = await seed();
    await devAtRest(f);
    const notes = () => db.select({ body: issueComments.body }).from(issueComments).where(and(
      eq(issueComments.issueId, f.taskId), eq(issueComments.authorType, "system"),
      sql`${issueComments.body} like '%held-dependency-comment-notice%'`));
    const companyWakes = () => db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.companyId, f.companyId));
    const taskRuns = () => db.select().from(heartbeatRuns).where(and(eq(heartbeatRuns.companyId, f.companyId),
      sql`${heartbeatRuns.contextSnapshot}->>'issueId' = ${f.taskId}`));
    const wakesBefore = (await companyWakes()).length;
    await heldComment(f, "First held note.");
    await heldComment(f, "Second held note.");
    const [note, ...more] = await notes();
    expect(more).toEqual([]);
    // The note says that the comment waits, and nothing else: no advice to put a question card, which the worker
    // router refuses when the assignee is a routed role.
    expect(note!.body).toMatch(/^A comment from CTO waits for \S+ to resolve before it reaches Dev\.\n\n<!-- held-dependency-comment-notice -->\n<!-- held-dependency-comment-notice-for:[0-9a-f-]+ -->$/);
    expect(note!.body).not.toContain("question card");
    expect(note!.body).not.toContain("For an answer before");
    // Only the two held comment wakes were recorded (the gate's own skips); no wake and no run for anyone else.
    const wakesAfter = await companyWakes();
    expect(wakesAfter.length - wakesBefore).toBe(2);
    expect(wakesAfter.slice(-2).every(row => row.status === "skipped" && row.reason === "issue_dependencies_blocked")).toBe(true);
    expect(await taskRuns()).toEqual([]);
    // The lift: the Dev's qualified run settles the series; a new hold starts a new series and a new note.
    await setStatus(f, f.blockerId, "done");
    await runWhere(f.devId, f.taskId, run => (run.contextSnapshot as any)?.wakeReason === "issue_blockers_resolved");
    await request(app(f.companyId)).patch(`/api/issues/${f.taskId}`).send({ blockedByIssueIds: [f.blocker2Id] }).expect(200);
    const third = await heldComment(f, "Held in the next series.");
    expect(await notes()).toHaveLength(2);
    // The second lift hands over the second series only (the first was settled by the qualified run).
    const lifts = (await devRuns(f)).map(run => run.id);
    await setStatus(f, f.blocker2Id, "done");
    const secondLift = await runWhere(f.devId, f.taskId, run => (run.contextSnapshot as any)?.wakeReason === "issue_blockers_resolved", lifts);
    expect(handedOver(secondLift)).toEqual([third]);
  }, 180_000);

  // Cold review (B5): the hand-back comment's deduplication ignores a wake that failed, was skipped or was cancelled,
  // and the new wake is not swallowed by the comment's fixed key. A delivered wake is not repeated.
  it("wakes the hand-back comment again when its earlier wake failed, was skipped or was cancelled, not when it was delivered", async () => {
    const f = await seed({ blocked: false });
    await request(app(f.companyId)).patch(`/api/issues/${f.taskId}`).send({ blockedByIssueIds: [f.blockerId, f.blocker2Id] }).expect(200);
    await setStatus(f, f.blocker2Id, "cancelled");
    await runWhere(f.devId, f.taskId, run => (run.contextSnapshot as any)?.cancelledBlockerIssueId === f.blocker2Id);
    await taskQuiet(f);
    const handBackComments = () => db.select({ id: issueComments.id }).from(issueComments)
      .where(and(eq(issueComments.issueId, f.taskId), sql`${issueComments.body} like '%cancelled-blockers-left:%'`));
    await setStatus(f, f.blockerId, "done");
    await expect.poll(async () => (await handBackComments()).length, { timeout: 20_000 }).toBe(1);
    const [comment] = await handBackComments();
    await runWhere(f.devId, f.taskId, run => JSON.stringify(run.contextSnapshot).includes(comment!.id));
    const runsOnComment = async () => (await devRuns(f)).filter(run => JSON.stringify(run.contextSnapshot).includes(comment!.id)).length;
    // Each edit changes the blocker set and leaves the same cancelled blocker as the only unresolved one.
    const edit = async (ids: string[]) => {
      await request(app(f.companyId)).patch(`/api/issues/${f.taskId}`).send({ blockedByIssueIds: ids }).expect(200);
      await new Promise(resolve => setTimeout(resolve, 1000));
      await taskQuiet(f);
    };
    await taskQuiet(f);
    expect(await runsOnComment()).toBe(1);
    await edit([f.blocker2Id]);
    expect(await runsOnComment()).toBe(1);
    let expected = 1;
    for (const [status, ids] of [["failed", [f.blockerId, f.blocker2Id]], ["skipped", [f.blocker2Id]],
      ["cancelled", [f.blockerId, f.blocker2Id]]] as const) {
      await db.update(agentWakeupRequests).set({ status }).where(and(eq(agentWakeupRequests.agentId, f.devId),
        sql`${agentWakeupRequests.payload}->>'commentId' = ${comment!.id}`));
      await edit([...ids]);
      expected += 1;
      expect(await runsOnComment()).toBe(expected);
      expect(await handBackComments()).toHaveLength(1);
    }
  }, 240_000);

  // Cold review (P7): a PATCH that writes the same blocker set again is no change for the one function: it sends no
  // edit wake. (The restored-blocked path of before this change keeps its own rule for a `blocked` issue.)
  it("sends no edit wake when a PATCH writes the same blocker set again", async () => {
    const f = await seed();
    const held = await heldComment(f, "Held before the lift.");
    await setStatus(f, f.blockerId, "done");
    await runWhere(f.devId, f.taskId, carrying(held));
    await taskQuiet(f);
    const patch = async (ids: string[]) => {
      await request(app(f.companyId)).patch(`/api/issues/${f.taskId}`).send({ blockedByIssueIds: ids }).expect(200);
      await new Promise(resolve => setTimeout(resolve, 1000));
      await taskQuiet(f);
    };
    // The edit wakes the function sent for the task, whatever became of them.
    const editWakes = async () => (await db.select({ id: agentWakeupRequests.id }).from(agentWakeupRequests).where(and(
      eq(agentWakeupRequests.agentId, f.devId), sql`${agentWakeupRequests.payload}->>'issueId' = ${f.taskId}`,
      sql`${agentWakeupRequests.payload}->>'mutation' = 'blockers_edited'`))).length;
    await patch([f.blockerId]);
    expect(await editWakes()).toBe(0);
    // A real change (the list emptied) is one wake; the same empty list written twice more adds none.
    await patch([]);
    expect(await editWakes()).toBe(1);
    await patch([]);
    await patch([]);
    expect(await editWakes()).toBe(1);
  }, 120_000);

  // Third review, point 6, under concurrency: several comments held at the same moment write ONE note (the lock on
  // the issue row), and each keeps its own hold trace.
  it("writes one note when several agent comments are held at the same moment", async () => {
    const f = await seed();
    await taskQuiet(f);
    const bodies = [1, 2, 3, 4, 5].map(n => `Concurrent held comment ${n}.`);
    await Promise.all(bodies.map(body => request(cto(f)).post(`/api/issues/${f.taskId}/comments`).send({ body }).expect(201)));
    for (const body of bodies) {
      const id = await commentIdOf(f.taskId, body);
      await expect.poll(() => admissionHeld(f, id), { timeout: 20_000 }).toEqual([{ status: "skipped", reason: "issue_dependencies_blocked" }]);
    }
    await heartbeat.drainActiveRunExecutions();
    await new Promise(resolve => setTimeout(resolve, 500));
    const notes = await db.select({ id: issueComments.id }).from(issueComments).where(and(
      eq(issueComments.issueId, f.taskId), eq(issueComments.authorType, "system"),
      sql`${issueComments.body} like '%held-dependency-comment-notice%'`));
    expect(notes).toHaveLength(1);
    expect(await devRuns(f)).toEqual([]);
  }, 120_000);

  // Cold review (P6, B4): the wake of one dependent fails; the other dependents are still woken, and the lost one is
  // the backstop's.
  it("still wakes the other dependents when the wake of one fails, and the backstop takes the lost one", async () => {
    const { wakeDependentsAfterDependencyChange } = await import("../services/dependency-change-wakes.js");
    const f = await seed();
    const task2Id = randomUUID();
    const [task] = await db.select({ identifier: issues.identifier }).from(issues).where(eq(issues.id, f.taskId));
    await db.insert(issues).values({ id: task2Id, companyId: f.companyId, title: "Dev2 task", status: "todo", assigneeAgentId: f.dev2Id,
      issueNumber: 5, identifier: task!.identifier!.replace(/-2$/, "-5"), responsibleUserId: "board-user" });
    await request(app(f.companyId)).patch(`/api/issues/${task2Id}`).send({ blockedByIssueIds: [f.blockerId] }).expect(200);
    const held = await heldComment(f, "Held; the lift's wake will be lost.");
    // The blocker becomes done outside the routes; the function is called as a writer would, with a sender whose
    // first wake (the Dev's) fails.
    await db.update(issues).set({ status: "done", completedAt: new Date() }).where(eq(issues.id, f.blockerId));
    const attempts: string[] = [];
    await wakeDependentsAfterDependencyChange(db, {
      companyId: f.companyId, dependentIssueIds: [f.taskId, task2Id], kind: "blocker_done",
      changedBlocker: { id: f.blockerId, identifier: null }, actor: { type: "system", id: null }, at: new Date(),
      wake: async (agentId, wake) => {
        attempts.push(agentId);
        if (agentId === f.devId) throw new Error("injected: wake lost");
        await heartbeat.wakeup(agentId, wake as never);
      },
    });
    expect(attempts).toEqual([f.devId, f.dev2Id]);
    const other = await runWhere(f.dev2Id, task2Id, run => (run.contextSnapshot as any)?.wakeReason === "issue_blockers_resolved");
    expect(other.status).toBe("succeeded");
    await heartbeat.drainActiveRunExecutions();
    expect(await devRuns(f)).toEqual([]);
    expect(await heartbeat.reconcileHeldCommentHandover({ companyId: f.companyId, issueId: f.taskId })).toBe("woken");
    const run = await runWhere(f.devId, f.taskId, carrying(held));
    expect(run.status).toBe("succeeded");
  }, 120_000);

  // Cold review (B7): a case handoff moves the issue with a service write and its own `issue.reassigned` activity (no
  // `issue.updated`). The same two writes here (not the handoff service itself): the new assignee's first run gets the
  // agents' thread with the reassignment text; without the activity it gets nothing.
  it("takes a case handoff's issue.reassigned activity as a reassignment trace", async () => {
    for (const withActivity of [false, true]) {
      const f = await seed({ blocked: false });
      // Written straight into the thread: the first owner never runs, so no run of its own holds the task.
      const [comment] = await db.insert(issueComments).values({ companyId: f.companyId, issueId: f.taskId, authorType: "agent",
        authorAgentId: f.ctoId, body: `Written to the first owner (${withActivity}).` }).returning();
      const before = comment!.id;
      await issueService(db).update(f.taskId, { assigneeAgentId: f.dev2Id, assigneeUserId: null, status: "todo" } as never);
      if (withActivity) {
        await db.insert(activityLog).values({ companyId: f.companyId, actorType: "agent", actorId: f.ctoId, agentId: f.ctoId,
          action: "issue.reassigned", entityType: "issue", entityId: f.taskId,
          details: { previousAssigneeAgentId: f.devId, previousAssigneeUserId: null, assigneeAgentId: f.dev2Id,
            assigneeUserId: null, changed: true } });
      }
      const admitted = await heartbeat.wakeup(f.dev2Id, {
        source: "assignment", triggerDetail: "system", reason: "issue_assigned",
        payload: { issueId: f.taskId, mutation: "update" }, requestedByActorType: "system", requestedByActorId: "case_handoff",
        contextSnapshot: { issueId: f.taskId, taskId: f.taskId, wakeReason: "issue_assigned", source: "issue.update" },
      });
      expect(admitted).not.toBeNull();
      await heartbeat.drainActiveRunExecutions();
      const run = (await runById(admitted!.id))!;
      expect(run.status).toBe("succeeded");
      expect(handedOver(run)).toEqual(withActivity ? [before] : []);
      expect((run.contextSnapshot as any).heldDependencyReason).toBe(withActivity ? "reassignment" : undefined);
    }
  }, 120_000);

  // Final instruction, 1: the holds of before this change (studio.21 held assignments and automatic wakes, never an
  // agent's comment) carry no mark. On a ready issue they bring neither a backstop wake nor a hand-over. The same
  // rows WITH the mark are traces (the control).
  it("counts no unmarked hold of before this change: no backstop wake and no hand-over on a ready issue", async () => {
    for (const marked of [false, true]) {
      const f = await seed({ blocked: false });
      const [comment] = await db.insert(issueComments).values({ companyId: f.companyId, issueId: f.taskId, authorType: "agent",
        authorAgentId: f.ctoId, body: `An agent comment written before (${marked}).` }).returning();
      const at = new Date(Date.now() - 5_000);
      const mark = marked ? { heldDependencyTrace: true } : {};
      // As the admission and the claim gate write them: a skipped request, and a run cancelled before it started.
      await db.insert(agentWakeupRequests).values({ companyId: f.companyId, agentId: f.devId, source: "assignment",
        triggerDetail: "system", reason: "issue_dependencies_blocked", status: "skipped", requestedByActorType: "system",
        requestedAt: at, finishedAt: at, updatedAt: at, createdAt: at,
        payload: { issueId: f.taskId, unresolvedBlockerIssueIds: [f.blockerId], ...mark } });
      await db.insert(heartbeatRuns).values({ companyId: f.companyId, agentId: f.devId, invocationSource: "assignment",
        status: "cancelled", errorCode: "issue_dependencies_blocked", finishedAt: at, createdAt: at, updatedAt: at,
        contextSnapshot: { issueId: f.taskId },
        resultJson: { stopReason: "issue_dependencies_blocked", timeoutSource: "dependency_gate", ...mark } });
      const scope = { companyId: f.companyId, issueId: f.taskId };
      if (!marked) {
        expect(await heartbeat.reconcileHeldCommentHandover(scope)).toBe("no_trace");
        // A Board wake of the Dev on the ready task goes through the real admission, which decides the hand-over.
        const admitted = await heartbeat.wakeup(f.devId, {
          source: "on_demand", triggerDetail: "manual", reason: "issue_status_changed",
          payload: { issueId: f.taskId }, contextSnapshot: { issueId: f.taskId, taskId: f.taskId },
        });
        expect(admitted).not.toBeNull();
        await heartbeat.drainActiveRunExecutions();
        const run = (await runById(admitted!.id))!;
        expect(run.status).toBe("succeeded");
        expect((run.contextSnapshot as any).heldDependencyCommentIds).toBeUndefined();
        expect((run.contextSnapshot as any).heldDependencyReason).toBeUndefined();
        expect(await heartbeat.reconcileHeldCommentHandover(scope)).toBe("no_trace");
      } else {
        expect(await heartbeat.reconcileHeldCommentHandover(scope)).toBe("woken");
        const run = await runWhere(f.devId, f.taskId, carrying(comment!.id));
        expect((run.contextSnapshot as any).source).toBe("issue.held_comment_handover_backstop");
      }
    }
  }, 120_000);

  // Final instruction, 1: every writer of a dependency hold marks it. The admission's request and the claim gate's
  // cancelled run are read by the cases above; here the retry gate refuses a scheduled retry because of a new blocker.
  it("marks a scheduled retry the dependency gate refuses, and hands its comment over at the lift", async () => {
    const f = await seed({ blocked: false });
    nextOutcome.set(f.taskId, "spawn-255");
    const comment = await ctoComment(f, "Woke a run that was cut; a new blocker then refuses its retry.");
    await expect.poll(async () => (await devRuns(f)).some(run => run.status === "scheduled_retry"), { timeout: 20_000 }).toBe(true);
    await request(app(f.companyId)).patch(`/api/issues/${f.taskId}`).send({ blockedByIssueIds: [f.blockerId] }).expect(200);
    await taskQuiet(f);
    const refused = (await devRuns(f)).filter(run => run.status === "cancelled" && run.errorCode === "issue_dependencies_blocked");
    expect(refused.length).toBeGreaterThan(0);
    // Refused by the retry gate (not the claim gate, whose receipt names `dependency_gate`), and marked.
    expect(refused.some(run => (run.resultJson as any)?.timeoutSource !== "dependency_gate")).toBe(true);
    for (const run of refused) expect((run.resultJson as any)?.heldDependencyTrace).toBe(true);
    const before = (await devRuns(f)).map(run => run.id);
    await setStatus(f, f.blockerId, "done");
    const lift = await runWhere(f.devId, f.taskId, run => (run.contextSnapshot as any)?.wakeReason === "issue_blockers_resolved", before);
    expect(handedOver(lift)).toEqual([comment]);
  }, 120_000);

  // Final review, the blocker: a run the server inserts with a fresh context passes no admission and is shown nothing.
  // It must not become the hand-over base. Here the runs that carry the hand-over (the lift, then the first
  // disposition repair) do not qualify, because their engine start is not recorded; the server's second repair run,
  // inserted with a fresh context, succeeds with its engine started. The comment is still handed over afterwards.
  it("still hands the comment over after a run inserted with a fresh context succeeded", async () => {
    const f = await seed();
    const held = await heldComment(f, "Held; a run without an admission must not settle it.");
    // Past the clock margin (10 s): a run that starts later settles this hold outright if it becomes the base.
    await new Promise(resolve => setTimeout(resolve, 11_000));
    outcomeQueue.set(f.taskId, ["no-spawn", "no-spawn"]);
    await setStatus(f, f.blockerId, "done");
    const first = await runWhere(f.devId, f.taskId, carrying(held));
    expect(first.processStartedAt).toBeNull();
    const isFresh = (run: typeof heartbeatRuns.$inferSelect) => run.status === "succeeded" && run.processStartedAt !== null
      && (run.contextSnapshot as any)?.heldDependencyHandoverAt === undefined;
    await taskQuiet(f);
    await new Promise(resolve => setTimeout(resolve, 1000));
    await taskQuiet(f);
    const left = outcomeQueue.get(f.taskId)?.length ?? 0;
    outcomeQueue.delete(f.taskId);
    const runs = (await devRuns(f)).sort((x, y) => x.createdAt.getTime() - y.createdAt.getTime());
    const seen = JSON.stringify({ left, runs: runs.map(run => ({ s: run.status, r: (run.contextSnapshot as any)?.wakeReason,
      at: (run.contextSnapshot as any)?.heldDependencyHandoverAt ?? null, ids: handedOver(run).length,
      started: Boolean(run.processStartedAt), retryOf: Boolean(run.retryOfRunId) })) });
    expect(runs.filter(isFresh).length, seen).toBeGreaterThan(0);
    // The fresh run carried nothing, and no run that carried the comment has a recorded engine start.
    for (const run of runs.filter(isFresh)) expect(handedOver(run), seen).toEqual([]);
    expect(runs.filter(run => run.processStartedAt !== null && handedOver(run).includes(held)), seen).toEqual([]);
    // Not settled by the fresh run: the backstop wakes, and that run carries the comment.
    const scope = { companyId: f.companyId, issueId: f.taskId };
    let outcome = await heartbeat.reconcileHeldCommentHandover(scope);
    if (outcome === "recovery_action") {
      await db.update(issueRecoveryActions).set({ status: "resolved", outcome: "restored", resolvedAt: new Date() })
        .where(eq(issueRecoveryActions.sourceIssueId, f.taskId));
      outcome = await heartbeat.reconcileHeldCommentHandover(scope);
    }
    expect(outcome, seen).toBe("woken");
    const again = await runWhere(f.devId, f.taskId, run => carrying(held)(run) && run.processStartedAt !== null);
    expect(again.status).toBe("succeeded");
    expect((again.contextSnapshot as any).source).toBe("issue.held_comment_handover_backstop");
  }, 180_000);

  // Final review, point 2: Dev -> Dev2 -> Dev by writers that log no activity. The Dev has a base on the issue; the
  // comment was held for Dev2. Holds of any agent since the Dev's base count.
  it("hands over to a returning assignee the comment held for another assignee in between", async () => {
    const f = await seed({ blocked: false });
    const note = await ctoComment(f, "A first note; the Dev's run settles it.");
    const settled = await runWhere(f.devId, f.taskId, run => JSON.stringify(run.contextSnapshot).includes(note));
    expect(settled.status).toBe("succeeded");
    expect(settled.processStartedAt).not.toBeNull();
    expect((settled.contextSnapshot as any).heldDependencyHandoverAt).toEqual(expect.any(String));
    await taskQuiet(f);
    // Moved to Dev2 by a service write, blocked, and a comment held for Dev2.
    await issueService(db).update(f.taskId, { assigneeAgentId: f.dev2Id, status: "todo" } as never);
    await request(app(f.companyId)).patch(`/api/issues/${f.taskId}`).send({ blockedByIssueIds: [f.blockerId] }).expect(200);
    await taskQuiet(f);
    const held = await ctoComment(f, "Held for the second owner.");
    await expect.poll(() => db.select({ status: agentWakeupRequests.status, reason: agentWakeupRequests.reason })
      .from(agentWakeupRequests).where(and(eq(agentWakeupRequests.agentId, f.dev2Id),
        sql`${agentWakeupRequests.payload}->>'commentId' = ${held}`)), { timeout: 20_000 })
      .toEqual([{ status: "skipped", reason: "issue_dependencies_blocked" }]);
    // Back to the Dev, and the blocker removed, by service writes: nobody is woken.
    await issueService(db).update(f.taskId, { assigneeAgentId: f.devId } as never);
    await issueService(db).update(f.taskId, { blockedByIssueIds: [] } as never);
    await new Promise(resolve => setTimeout(resolve, 1000));
    await taskQuiet(f);
    expect((await devRuns(f)).filter(carrying(held))).toEqual([]);
    const scope = { companyId: f.companyId, issueId: f.taskId };
    let outcome = await heartbeat.reconcileHeldCommentHandover(scope);
    if (outcome === "recovery_action") {
      await db.update(issueRecoveryActions).set({ status: "resolved", outcome: "restored", resolvedAt: new Date() })
        .where(eq(issueRecoveryActions.sourceIssueId, f.taskId));
      outcome = await heartbeat.reconcileHeldCommentHandover(scope);
    }
    expect(outcome).toBe("woken");
    const run = await runWhere(f.devId, f.taskId, carrying(held));
    expect(run.status).toBe("succeeded");
  }, 180_000);

  // Final review, point 4: the wait between two backstop wakes is counted from the backstop's own attempt rows,
  // written before the wake. It holds when the admission returns without writing a request, and when it throws.
  it("keeps the backstop's wait when its wake writes no request, or throws", async () => {
    const { reconcileHeldCommentHandover } = await import("../services/recovery/held-comment-handover-backstop.js");
    const f = await seed();
    await heldComment(f, "Held; the backstop's wake writes nothing.");
    await taskQuiet(f);
    await issueService(db).update(f.taskId, { blockedByIssueIds: [] } as never);
    let calls = 0;
    const silent = async () => { calls += 1; return null; };
    const throwing = async () => { calls += 1; throw new Error("injected: the admission failed"); };
    const t0 = Date.now();
    const pass = (afterMs: number, wake: () => Promise<unknown>) => reconcileHeldCommentHandover(db, {
      companyId: f.companyId, issueId: f.taskId, now: new Date(t0 + afterMs), wake });
    expect(await pass(0, silent)).toBe("woken");
    expect(await pass(5_000, silent)).toBe("waiting");
    expect(calls).toBe(1);
    await expect(pass(31_000, throwing)).rejects.toThrow("injected: the admission failed");
    expect(calls).toBe(2);
    // The second attempt was recorded before its wake threw: the next wait (one minute) runs from it.
    expect(await pass(40_000, silent)).toBe("waiting");
    expect(await pass(90_000, silent)).toBe("waiting");
    expect(calls).toBe(2);
    expect(await pass(92_000, silent)).toBe("woken");
    expect(calls).toBe(3);
    // No wake request was written: the three attempt rows alone carried the wait.
    const rows = await db.select({ reason: agentWakeupRequests.reason, status: agentWakeupRequests.status })
      .from(agentWakeupRequests).where(and(eq(agentWakeupRequests.agentId, f.devId),
        sql`${agentWakeupRequests.payload}->>'issueId' = ${f.taskId}`,
        sql`${agentWakeupRequests.reason} <> 'issue_dependencies_blocked'`));
    expect(rows).toEqual(Array.from({ length: 3 }, () => ({ reason: "held_comment_handover_backstop_attempt", status: "skipped" })));
  }, 120_000);

  it("keeps a person's comment as a bounded interaction run on the blocked issue", async () => {
    const f = await seed();
    await request(app(f.companyId)).post(`/api/issues/${f.taskId}/comments`).send({ body: "Explain the dependency." }).expect(201);
    await expect.poll(async () => (await devRuns(f)).length, { timeout: 20_000 }).toBe(1);
    await heartbeat.drainActiveRunExecutions();
    const runs = await devRuns(f);
    expect(runs).toHaveLength(1);
    expect(runs[0]!.contextSnapshot).toMatchObject({ wakeReason: "issue_commented", dependencyBlockedInteraction: true });
  }, 120_000);

  it("reaches the blocked assignee through a card on the asker's own task, addressed to the assignee", async () => {
    const f = await seed();
    const created = await request(cto(f)).post(`/api/issues/${f.ctoTaskId}/interactions`).send({
      kind: "ask_user_questions", addresseeAgentId: f.devId, resolverPolicy: "anyone",
      payload: { version: 1, questions: [{ id: "q", prompt: "Is WIN-01 free?", selectionMode: "single",
        options: [{ id: "y", label: "Yes" }, { id: "n", label: "No" }] }] },
    });
    expect(created.status, JSON.stringify(created.body)).toBeLessThan(300);
    const cardWakes = () => db.select({ status: agentWakeupRequests.status, reason: agentWakeupRequests.reason }).from(agentWakeupRequests)
      .where(and(eq(agentWakeupRequests.agentId, f.devId), sql`${agentWakeupRequests.payload}->>'issueId' = ${f.ctoTaskId}`));
    await expect.poll(async () => (await cardWakes()).length, { timeout: 20_000 }).toBeGreaterThan(0);
    expect((await cardWakes()).every((wake) => wake.status !== "skipped" && wake.reason !== "issue_dependencies_blocked")).toBe(true);
    expect(await devRuns(f)).toEqual([]);
    const refused = await request(cto(f)).post(`/api/issues/${f.taskId}/interactions`).send({
      kind: "ask_user_questions", addresseeAgentId: f.devId, resolverPolicy: "anyone",
      payload: { version: 1, questions: [{ id: "q", prompt: "?", selectionMode: "single", options: [{ id: "y", label: "Yes" }] }] },
    });
    expect(refused.status).toBe(422);
  }, 120_000);

  it("still wakes the assignee for an agent's comment when the issue is not blocked", async () => {
    const f = await seed({ blocked: false });
    await ctoComment(f, "A note on an open task.");
    await expect.poll(async () => (await devRuns(f)).length, { timeout: 20_000 }).toBe(1);
    await heartbeat.drainActiveRunExecutions();
  }, 120_000);
});
