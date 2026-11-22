// STUDIO-0093: the worker router's wake on a blocked issue (STUDIO-0086) never merges with another wake. Merged, it
// lost its way past the blockers: another wake that joined its run replaced its reason, and its own request was not
// the one of a run it joined. Each case here plays one order of arrival on real heartbeat runs with a stand-in
// adapter: the router's wake keeps its own run, the other wake keeps its own rule.
import { randomUUID } from "node:crypto";
import { and, asc, eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  agentWakeupRequests, agents, authUsers, companies, companyMemberships, createDb, heartbeatRuns, issueComments, issueRelations,
  issues, plugins, EMBEDDED_POSTGRES_TEST_TIMEOUT_MS,
} from "@paperclipai/db";
import type { PaperclipPluginManifestV1 } from "@paperclipai/shared";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { drainHeartbeatRunsToQuiescence } from "./helpers/drain-heartbeat-runs.js";
import { registerServerAdapter, unregisterServerAdapter } from "../adapters/index.js";
import { heartbeatService } from "../services/heartbeat.js";
import { buildHostServices } from "../services/plugin-host-services.js";
import { carriesPluginBlockedWake } from "../modules/run-dispatch/index.js";
import { wakeMustNotJoinActiveRun } from "../modules/wake-queue/domain/context.js";

const MACHINE_LENT = "worker_router_machine_lent";
const LOAN_REQUESTED = "worker_router_loan_requested";
const LOAN_RETURNED = "worker_router_loan_returned";
const ROUTER_KEY = "amynoox.worker-router";
const adapterType = "codex_local";

describe("a plugin's wake on a blocked issue stays out of every merge: the rule", () => {
  const mark = { pluginId: "p1", reason: LOAN_REQUESTED };

  it("the mark is read whatever the wake reason has become, and only a mark that names a plugin counts", () => {
    expect(carriesPluginBlockedWake({ wakeReason: LOAN_REQUESTED, pluginBlockedWake: mark })).toBe(true);
    expect(carriesPluginBlockedWake({ wakeReason: "issue_commented", pluginBlockedWake: mark })).toBe(true);
    expect(carriesPluginBlockedWake({ wakeReason: "transient_failure_retry", retryOfRunId: "r1", pluginBlockedWake: mark })).toBe(true);
    expect(carriesPluginBlockedWake({ wakeReason: LOAN_REQUESTED })).toBe(false);
    expect(carriesPluginBlockedWake({ pluginBlockedWake: { reason: LOAN_REQUESTED } })).toBe(false);
    expect(carriesPluginBlockedWake({ pluginBlockedWake: true })).toBe(false);
    expect(carriesPluginBlockedWake(null)).toBe(false);
  });

  it("neither side joins the other: the marked run takes no wake, the marked wake joins no run", () => {
    const ordinary = { issueId: "i1", wakeReason: "issue_commented" };
    const marked = { issueId: "i1", wakeReason: LOAN_REQUESTED, pluginBlockedWake: mark };
    expect(wakeMustNotJoinActiveRun(marked, ordinary, false)).toBe(true);
    expect(wakeMustNotJoinActiveRun(ordinary, marked, false)).toBe(true);
    expect(wakeMustNotJoinActiveRun(marked, { ...marked, wakeReason: LOAN_RETURNED }, false)).toBe(true);
    // Two ordinary wakes still merge.
    expect(wakeMustNotJoinActiveRun(ordinary, { ...ordinary, wakeReason: "issue_assigned" }, false)).toBe(false);
  });
});

const support = await getEmbeddedPostgresTestSupport();
vi.setConfig({ testTimeout: 120_000 });

(support.supported ? describe : describe.skip)("a plugin's wake on a blocked issue stays out of every merge, on the real run path", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  let heartbeat: ReturnType<typeof heartbeatService>;
  type Launch = { issueId: string; runId: string; context: Record<string, unknown> };
  const launches: Launch[] = [];
  const answers = new Map<string, Array<() => Promise<Record<string, unknown>>>>();
  const SUCCESS = { exitCode: 0, signal: null, timedOut: false, resultJson: {} };
  // The runs a case holds at work. A case that fails before it lets them go must not leave them hanging for the next.
  const held: Array<() => void> = [];

  beforeAll(async () => {
    database = await startEmbeddedPostgresTestDatabase("plugin-blocked-wake-own-run-");
    db = createDb(database.connectionString);
    heartbeat = heartbeatService(db);
    registerServerAdapter({
      type: adapterType, supportsLocalAgentJwt: false,
      execute: async (input) => {
        const issueId = String(input.context.issueId);
        launches.push({ issueId, runId: input.runId, context: input.context as Record<string, unknown> });
        const answer = answers.get(issueId)?.shift();
        return (answer ? await answer() : SUCCESS) as never;
      },
      testEnvironment: async () => ({ adapterType, status: "pass", checks: [], testedAt: new Date().toISOString() }),
    });
  }, EMBEDDED_POSTGRES_TEST_TIMEOUT_MS);
  afterEach(async () => {
    for (const release of held.splice(0)) release();
    await drainHeartbeatRunsToQuiescence(db, heartbeat);
    launches.length = 0;
    answers.clear();
  });
  afterAll(async () => {
    unregisterServerAdapter(adapterType);
    await database?.cleanup();
  });

  // The issue of the role that holds the machine waits on the maintenance issue, as TR-2019 waits on TR-2061.
  async function seed() {
    const companyId = randomUUID(), agentId = randomUUID(), otherAgentId = randomUUID(), blockerId = randomUUID(), issueId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Blocked wake", issuePrefix: `B${companyId.replaceAll("-", "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false, defaultResponsibleUserId: "responsible-user" });
    await db.insert(authUsers).values({ id: "responsible-user", name: "Fixture user", email: "responsible-user@example.test",
      createdAt: new Date(), updatedAt: new Date() }).onConflictDoNothing();
    await db.insert(companyMemberships).values({ companyId, principalType: "user", principalId: "responsible-user",
      status: "active", membershipRole: "member" }).onConflictDoNothing();
    await db.insert(agents).values([
      { id: agentId, companyId, name: "Super Dev Unity", role: "engineer", status: "idle", adapterType, adapterConfig: {},
        runtimeConfig: { heartbeat: { wakeOnDemand: true, maxConcurrentRuns: 1 } }, permissions: {} },
      { id: otherAgentId, companyId, name: "Infra Manager", role: "engineer", status: "idle", adapterType, adapterConfig: {},
        runtimeConfig: { heartbeat: { wakeOnDemand: true, maxConcurrentRuns: 1 } }, permissions: {} },
    ]);
    await db.insert(issues).values([
      { id: blockerId, companyId, title: "Maintenance on the machine", status: "todo", priority: "medium", assigneeAgentId: otherAgentId },
      { id: issueId, companyId, title: "Work that holds the machine", status: "blocked", priority: "medium", assigneeAgentId: agentId },
    ]);
    await db.insert(issueRelations).values({ companyId, issueId: blockerId, relatedIssueId: issueId, type: "blocks" });
    const declared = { id: ROUTER_KEY, apiVersion: 1, version: "0.1.0", displayName: "Fixture router", description: "Fixture",
      author: "Tests", categories: ["connector"], capabilities: ["issues.wakeup"], entrypoints: { worker: "worker.js" },
      blockedIssueWakeups: true } as unknown as PaperclipPluginManifestV1;
    const [plugin] = await db.insert(plugins).values({ pluginKey: ROUTER_KEY, packageName: ROUTER_KEY, version: "0.1.0", status: "ready", manifestJson: declared })
      .onConflictDoUpdate({ target: plugins.pluginKey, set: { status: "ready", manifestJson: declared } }).returning();
    const services = buildHostServices(db, plugin!.id, ROUTER_KEY, { forPlugin: () => ({ emit: async () => {}, subscribe: () => {} }) } as never,
      undefined, { manifest: declared });
    return { companyId, agentId, otherAgentId, blockerId, issueId, pluginId: plugin!.id, services };
  }
  type Fixture = Awaited<ReturnType<typeof seed>>;
  const launchesOf = (issueId: string) => launches.filter((launch) => launch.issueId === issueId);
  const runsOf = (f: Fixture) => db.select().from(heartbeatRuns)
    .where(and(eq(heartbeatRuns.companyId, f.companyId), eq(heartbeatRuns.agentId, f.agentId)))
    .orderBy(asc(heartbeatRuns.createdAt)).then((rows) => rows.filter((run) => (run.contextSnapshot as Record<string, unknown> | null)?.issueId === f.issueId));
  const wakesOf = (f: Fixture) => db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.companyId, f.companyId))
    .orderBy(asc(agentWakeupRequests.requestedAt));
  const state = async (f: Fixture) => JSON.stringify({
    launches: launchesOf(f.issueId).map((launch) => launch.context.wakeReason),
    runs: (await runsOf(f)).map((run) => [run.status, run.errorCode, (run.contextSnapshot as Record<string, unknown>).wakeReason]),
    wakes: (await wakesOf(f)).map((wake) => [wake.status, wake.reason, wake.error]),
  });
  /** The comment a context was woken for, if any. The thread itself is read by every run of the issue; this is the wake. */
  const wokenFor = (context: unknown) => {
    const c = (context ?? {}) as Record<string, unknown>;
    return [c.wakeCommentId ?? null, c.commentId ?? null, c.wakeCommentIds ?? null, c.paperclipWakeComment ?? null];
  };
  const NO_COMMENT = [null, null, null, null];
  /** What each launch of the issue was told: its reason, the router's mark, the bounded mode. */
  const story = (f: Fixture) => launchesOf(f.issueId).map((launch) => [launch.context.wakeReason ?? null,
    carriesPluginBlockedWake(launch.context), launch.context.dependencyBlockedInteraction === true]);
  async function settled(f: Fixture, count: number) {
    await vi.waitFor(async () => expect(launchesOf(f.issueId).length, await state(f)).toBeGreaterThanOrEqual(count), { timeout: 30_000, interval: 100 });
    await drainHeartbeatRunsToQuiescence(db, heartbeat);
    await heartbeat.resumeQueuedRuns();
    await drainHeartbeatRunsToQuiescence(db, heartbeat);
  }
  const gated = () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    held.push(release);
    return { release, answer: async () => { await gate; return SUCCESS; } };
  };
  /** The assignee is at work on another issue: what is admitted for the blocked issue waits its turn as a queued run. */
  async function busyElsewhere(f: Fixture) {
    const busyIssueId = randomUUID();
    await db.insert(issues).values({ id: busyIssueId, companyId: f.companyId, title: "Other work", status: "todo", priority: "medium", assigneeAgentId: f.agentId });
    const { release, answer } = gated();
    answers.set(busyIssueId, [answer]);
    await heartbeat.wakeup(f.agentId, { source: "assignment", triggerDetail: "system", reason: "issue_assigned",
      payload: { issueId: busyIssueId, mutation: "update" }, requestedByActorType: "system", requestedByActorId: "test",
      contextSnapshot: { issueId: busyIssueId, taskId: busyIssueId, source: "issue.update" } });
    await vi.waitFor(() => expect(launchesOf(busyIssueId)).toHaveLength(1), { timeout: 30_000, interval: 100 });
    return release;
  }
  const unblock = async (f: Fixture) => {
    await db.delete(issueRelations).where(eq(issueRelations.relatedIssueId, f.issueId));
    await db.update(issues).set({ status: "todo" }).where(eq(issues.id, f.issueId));
  };
  const block = async (f: Fixture) => {
    await db.insert(issueRelations).values({ companyId: f.companyId, issueId: f.blockerId, relatedIssueId: f.issueId, type: "blocks" });
    await db.update(issues).set({ status: "blocked" }).where(eq(issues.id, f.issueId));
  };
  /** An ordinary wake of the assignee on the issue, asked for by another role. */
  const ordinaryWake = (f: Fixture) => heartbeat.wakeup(f.agentId, { source: "assignment", triggerDetail: "system", reason: "issue_assigned",
    payload: { issueId: f.issueId, mutation: "update" }, requestedByActorType: "agent", requestedByActorId: f.otherAgentId,
    contextSnapshot: { issueId: f.issueId, taskId: f.issueId, wakeReason: "issue_assigned", source: "issue.update" } });
  /** A comment on the issue and its wake, by another role or by a person. */
  async function comment(f: Fixture, by: "agent" | "user") {
    const [row] = await db.insert(issueComments).values({ companyId: f.companyId, issueId: f.issueId, body: "I need the machine: are you ready?",
      ...(by === "agent" ? { authorType: "agent", authorAgentId: f.otherAgentId } : { authorType: "user", authorUserId: "responsible-user" }) }).returning();
    await heartbeat.wakeup(f.agentId, {
      source: "automation", triggerDetail: "system", reason: "issue_commented", payload: { issueId: f.issueId, commentId: row!.id },
      requestedByActorType: by, requestedByActorId: by === "agent" ? f.otherAgentId : "responsible-user",
      contextSnapshot: { issueId: f.issueId, taskId: f.issueId, wakeReason: "issue_commented", commentId: row!.id, wakeCommentId: row!.id },
    });
    return row!.id;
  }
  const routerWake = (f: Fixture, reason = LOAN_REQUESTED) => f.services.issues.requestWakeup({ issueId: f.issueId, companyId: f.companyId, reason });
  /** An ordinary run of the assignee at work on the issue, started while the issue had no blocker; the blocker is set meanwhile. */
  async function ordinaryRunAtWork(f: Fixture) {
    await unblock(f);
    const { release, answer } = gated();
    answers.set(f.issueId, [answer]);
    await ordinaryWake(f);
    await vi.waitFor(() => expect(launchesOf(f.issueId)).toHaveLength(1), { timeout: 30_000, interval: 100 });
    await block(f);
    return release;
  }

  it("another role comments while the router's run waits to start: the run starts with the router's reason alone, and the role's comment stays held", async () => {
    const f = await seed();
    const release = await busyElsewhere(f);
    await routerWake(f);
    expect((await runsOf(f)).map((run) => run.status), await state(f)).toEqual(["queued"]);
    const commentId = await comment(f, "agent");
    // The router's run is as it was asked for: nothing of the comment is in it.
    const [queued] = await runsOf(f);
    expect(queued!.contextSnapshot).toMatchObject({ wakeReason: LOAN_REQUESTED, pluginBlockedWake: { pluginId: f.pluginId, reason: LOAN_REQUESTED } });
    expect(wokenFor(queued!.contextSnapshot)).toEqual(NO_COMMENT);
    release();
    await settled(f, 1);
    expect(story(f), await state(f)).toEqual([[LOAN_REQUESTED, true, true]]);
    expect(wokenFor(launchesOf(f.issueId)[0]!.context)).toEqual(NO_COMMENT);
    expect((await runsOf(f)).filter((run) => run.status === "succeeded"), await state(f)).toHaveLength(1);
  });

  it("a person comments while the router's run waits to start: two runs, the router's first and intact, then the comment's", async () => {
    const f = await seed();
    const release = await busyElsewhere(f);
    await routerWake(f);
    const commentId = await comment(f, "user");
    release();
    await settled(f, 2);
    expect(story(f), await state(f)).toEqual([[LOAN_REQUESTED, true, true], ["issue_commented", false, true]]);
    expect(wokenFor(launchesOf(f.issueId)[0]!.context)).toEqual(NO_COMMENT);
    expect(launchesOf(f.issueId)[1]!.context).toMatchObject({ wakeCommentId: commentId });
  });

  it("the router's wake arrives while a run another role asked for waits to start: that run meets the blocker by its own rule, and the router's wake starts after it with its own request", async () => {
    const f = await seed();
    await unblock(f);
    const release = await busyElsewhere(f);
    await ordinaryWake(f);
    expect((await runsOf(f)).map((run) => run.status), await state(f)).toEqual(["queued"]);
    await block(f);
    await routerWake(f);
    // The waiting run did not take the mark.
    const [queued] = await runsOf(f);
    expect(carriesPluginBlockedWake(queued!.contextSnapshot)).toBe(false);
    release();
    // The waiting run is cancelled at its start, for the blocker: it never ran, so no end of run promotes what waits
    // behind it. The server's periodic pass over waiting wakes takes the router's wake up.
    await vi.waitFor(async () => expect((await runsOf(f)).map((run) => run.errorCode), await state(f)).toEqual(["issue_dependencies_blocked"]),
      { timeout: 30_000, interval: 100 });
    expect(launchesOf(f.issueId), await state(f)).toHaveLength(0);
    await heartbeat.resumeQueuedRuns();
    await settled(f, 1);
    expect(story(f), await state(f)).toEqual([[LOAN_REQUESTED, true, true]]);
    expect((await runsOf(f)).map((run) => [run.status, run.errorCode]), await state(f)).toEqual([
      ["cancelled", "issue_dependencies_blocked"], ["succeeded", null]]);
  });

  it("two wakes wait behind a run at work, a role's comment first and the router's wake second: the router's wake is its own request and starts", async () => {
    const f = await seed();
    const release = await ordinaryRunAtWork(f);
    const commentId = await comment(f, "agent");
    await routerWake(f);
    release();
    await settled(f, 2);
    expect(story(f), await state(f)).toEqual([["issue_assigned", false, false], [LOAN_REQUESTED, true, true]]);
    expect(wokenFor(launchesOf(f.issueId)[1]!.context)).toEqual(NO_COMMENT);
    expect(commentId).toBeTruthy();
  });

  it("two wakes wait behind a run at work, the router's wake first and a role's comment second: the comment does not join it, and the router's wake starts", async () => {
    const f = await seed();
    const release = await ordinaryRunAtWork(f);
    await routerWake(f);
    const commentId = await comment(f, "agent");
    release();
    await settled(f, 2);
    expect(story(f), await state(f)).toEqual([["issue_assigned", false, false], [LOAN_REQUESTED, true, true]]);
    expect(wokenFor(launchesOf(f.issueId)[1]!.context)).toEqual(NO_COMMENT);
    expect(commentId).toBeTruthy();
  });

  it("two wakes of the router in a row: two runs, each with its own reason", async () => {
    const f = await seed();
    const release = await busyElsewhere(f);
    await routerWake(f, LOAN_REQUESTED);
    await routerWake(f, LOAN_RETURNED);
    release();
    await settled(f, 2);
    expect(story(f), await state(f)).toEqual([[LOAN_REQUESTED, true, true], [LOAN_RETURNED, true, true]]);
  });

  it("the blocker is lifted while the router's run waits to start: the router's run starts with its own reason, and the wake for the lifted blocker starts after it", async () => {
    const f = await seed();
    const release = await busyElsewhere(f);
    await routerWake(f, MACHINE_LENT);
    await db.update(issues).set({ status: "done" }).where(eq(issues.id, f.blockerId));
    await db.update(issues).set({ status: "todo" }).where(eq(issues.id, f.issueId));
    await heartbeat.wakeup(f.agentId, { source: "automation", triggerDetail: "system", reason: "issue_blockers_resolved",
      payload: { issueId: f.issueId, resolvedBlockerIssueId: f.blockerId }, requestedByActorType: "system", requestedByActorId: "test",
      contextSnapshot: { issueId: f.issueId, taskId: f.issueId, wakeReason: "issue_blockers_resolved", source: "issue.blockers_resolved" } });
    release();
    await settled(f, 2);
    // (The stand-in engine sets no disposition on an issue that can now be worked: the server's own follow-up run comes after.)
    expect(story(f).slice(0, 2).map(([reason, marked]) => [reason, marked]), await state(f)).toEqual([[MACHINE_LENT, true], ["issue_blockers_resolved", false]]);
  });

  it("a comment wake left waiting for the issue is not taken into the router's new run", async () => {
    const f = await seed();
    const [row] = await db.insert(issueComments).values({ companyId: f.companyId, issueId: f.issueId, body: "A note for later",
      authorType: "user", authorUserId: "responsible-user" }).returning();
    await db.insert(agentWakeupRequests).values({ companyId: f.companyId, agentId: f.agentId, source: "automation", triggerDetail: "system",
      reason: "issue_commented", status: "deferred_issue_execution", requestedByActorType: "user", requestedByActorId: "responsible-user",
      payload: { issueId: f.issueId, commentId: row!.id, interactionOrigin: { actorId: "responsible-user", actorType: "user" },
        _paperclipWakeContext: { issueId: f.issueId, taskId: f.issueId, taskKey: f.issueId, wakeReason: "issue_commented", wakeSource: "automation",
          commentId: row!.id, wakeCommentId: row!.id, wakeCommentIds: [row!.id], wakeTriggerDetail: "system" } } });
    await routerWake(f);
    await settled(f, 2);
    expect(story(f)[0], await state(f)).toEqual([LOAN_REQUESTED, true, true]);
    expect(wokenFor(launchesOf(f.issueId)[0]!.context)).toEqual(NO_COMMENT);
    // The comment is not lost: its own wake starts after the router's run.
    expect(story(f)[1], await state(f)).toEqual(["issue_commented", false, true]);
    expect(launchesOf(f.issueId)[1]!.context).toMatchObject({ wakeCommentId: row!.id });
  });
});
