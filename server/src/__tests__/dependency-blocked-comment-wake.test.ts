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
  agentWakeupRequests,
  agents,
  authUsers,
  companies,
  companyMemberships,
  createDb,
  heartbeatRuns,
  issueComments,
  issues,
} from "@paperclipai/db";
import { errorHandler } from "../middleware/index.js";
import { issueRoutes } from "../routes/issues.js";
import { registerServerAdapter, unregisterServerAdapter } from "../adapters/index.js";
import { heartbeatService } from "../services/heartbeat.js";
import { buildPaperclipWakePayload } from "../services/heartbeat/run-preparation.js";
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
        const outcome = nextOutcome.get(issueId) ?? "spawn-success";
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
    await setStatus(f, f.blocker2Id, "cancelled");
    await runWhere(f.devId, f.taskId, run => (run.contextSnapshot as any)?.cancelledBlockerIssueId === f.blocker2Id);
    await taskQuiet(f);
    const before = (await devRuns(f)).map(run => run.id);
    // The open one is done: only a cancelled blocker is left, so the dependency is handed back, with the comment.
    await setStatus(f, f.blockerId, "done");
    const handBack = await runWhere(f.devId, f.taskId, carrying(held), before);
    expect((handBack.contextSnapshot as any).cancelledBlockerIssueId).toBe(f.blocker2Id);
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
    // The next change of the task's dependencies (here, its blocker set written again) wakes the comment.
    const [comment] = await handBackComments();
    await request(app(f.companyId)).patch(`/api/issues/${f.taskId}`).send({ blockedByIssueIds: [f.blockerId, f.blocker2Id] }).expect(200);
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
    // A skipped issue_dependencies_blocked request written before that run started.
    await db.insert(agentWakeupRequests).values({ companyId: f.companyId, agentId: f.devId, source: "automation",
      triggerDetail: "system", reason: "issue_dependencies_blocked", status: "skipped", requestedByActorType: "agent",
      requestedByActorId: f.ctoId, requestedAt: new Date(settled.startedAt!.getTime() - 60_000), finishedAt: new Date(),
      payload: { issueId: f.taskId } });
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

  // v5, point 4: a run that passes the claim gate under a person's exception is bounded, so it does not settle the
  // comment held before it.
  it("marks a run passing the claim gate under an exception as bounded, so it never settles held comments", async () => {
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
    await request(app(f.companyId)).patch(`/api/issues/${f.taskId}`).send({ blockedByIssueIds: [f.blockerId] }).expect(200);
    await db.update(heartbeatRuns).set({ status: "succeeded", finishedAt: new Date() }).where(eq(heartbeatRuns.id, busyRunId));
    await db.update(agents).set({ status: "idle" }).where(eq(agents.id, f.devId));
    await heartbeat.resumeQueuedRuns();
    await heartbeat.drainActiveRunExecutions();
    // It passed the claim gate under the person's exception, succeeded with its engine started, and is marked bounded.
    const passed = (await runById(personRun!.id))!;
    expect(passed.status).toBe("succeeded");
    expect(passed.processStartedAt).not.toBeNull();
    expect(passed.contextSnapshot).toMatchObject({ dependencyBlockedInteraction: true });
    // So it is not a qualified run: the base did not move.
    const { readLatestQualifiedRunStart } = await import("../services/heartbeat/held-dependency-comments.js");
    expect(await readLatestQualifiedRunStart(db, { companyId: f.companyId, issueId: f.taskId, agentId: f.devId })).toBeNull();
  }, 120_000);

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
    expect(note!.body).toContain("A comment from CTO waits for");
    expect(note!.body).toContain("Dev");
    expect(note!.body).toContain("question card");
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
