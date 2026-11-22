// STUDIO-0086: a plugin's "verified" wake on an issue that still has unresolved blockers. A reason of the closed
// list, from a plugin that declares `issues.wakeup.blocked`, starts the assignee's run on the blocked issue; every
// other wake keeps today's refusal. The cases go through the plugin's door (plugin-host-services) and through the two
// doors of the queue (admission and the start of the run), on real heartbeat runs with a stand-in adapter.
import { randomUUID } from "node:crypto";
import { and, asc, eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  agentWakeupRequests, agents, authUsers, companies, companyMemberships, createDb, heartbeatRuns, issueComments, issueRelations,
  issues, plugins, EMBEDDED_POSTGRES_TEST_TIMEOUT_MS,
} from "@paperclipai/db";
import { PLUGIN_BLOCKED_ISSUE_WAKE_REASONS, PLUGIN_CAPABILITIES, type PaperclipPluginManifestV1 } from "@paperclipai/shared";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { drainHeartbeatRunsToQuiescence } from "./helpers/drain-heartbeat-runs.js";
import { registerServerAdapter, unregisterServerAdapter } from "../adapters/index.js";
import { heartbeatService } from "../services/heartbeat.js";
import { buildHostServices } from "../services/plugin-host-services.js";
import { PLUGIN_BLOCKED_ISSUE_WAKE_CAPABILITY, pluginBlockedWakeMark, verifyPluginBlockedWake } from "../services/plugin-blocked-wake.js";
import { readPluginBlockedWake } from "../modules/run-dispatch/domain/wake-context.js";

const LOAN_REQUESTED = "worker_router_loan_requested";
const LOAN_RETURNED = "worker_router_loan_returned";
const ORDINARY = "worker_router_group_ready";
const REFUSED = "Issue is blocked by unresolved blockers";
const adapterType = "codex_local";

describe("a plugin's wake on a blocked issue: the list, the capability, the mark", () => {
  it("the reasons are a closed list of two, and the capability is one a manifest may declare", () => {
    expect([...PLUGIN_BLOCKED_ISSUE_WAKE_REASONS]).toEqual([LOAN_REQUESTED, LOAN_RETURNED]);
    expect(PLUGIN_BLOCKED_ISSUE_WAKE_CAPABILITY).toBe("issues.wakeup.blocked");
    expect(PLUGIN_CAPABILITIES).toContain("issues.wakeup.blocked");
    expect(PLUGIN_CAPABILITIES).toContain("issues.wakeup");
  });

  it("the plugin's door writes the mark only for a listed reason and a plugin that declares the capability", () => {
    const capable = ["issues.wakeup", "issues.wakeup.blocked"];
    expect(pluginBlockedWakeMark({ pluginId: "p1", reason: LOAN_REQUESTED, capabilities: capable })).toEqual({ pluginId: "p1", reason: LOAN_REQUESTED });
    expect(pluginBlockedWakeMark({ pluginId: "p1", reason: LOAN_RETURNED, capabilities: capable })).toEqual({ pluginId: "p1", reason: LOAN_RETURNED });
    expect(pluginBlockedWakeMark({ pluginId: "p1", reason: ORDINARY, capabilities: capable })).toBeNull();
    expect(pluginBlockedWakeMark({ pluginId: "p1", reason: undefined, capabilities: capable })).toBeNull();
    expect(pluginBlockedWakeMark({ pluginId: "p1", reason: LOAN_REQUESTED, capabilities: ["issues.wakeup"] })).toBeNull();
    expect(pluginBlockedWakeMark({ pluginId: "p1", reason: LOAN_REQUESTED, capabilities: undefined })).toBeNull();
  });

  it("the mark is read only with a listed reason that is the reason of the wake; a server retry keeps it", () => {
    const list = PLUGIN_BLOCKED_ISSUE_WAKE_REASONS;
    const mark = { pluginId: "p1", reason: LOAN_REQUESTED };
    expect(readPluginBlockedWake({ wakeReason: LOAN_REQUESTED, pluginBlockedWake: mark }, list)).toEqual({ ...mark, serverRetry: false });
    // The wake is for another reason than the marked one.
    expect(readPluginBlockedWake({ wakeReason: "issue_commented", pluginBlockedWake: mark }, list)).toBeNull();
    // A reason outside the list, even when the wake has it.
    expect(readPluginBlockedWake({ wakeReason: ORDINARY, pluginBlockedWake: { pluginId: "p1", reason: ORDINARY } }, list)).toBeNull();
    expect(readPluginBlockedWake({ wakeReason: LOAN_REQUESTED, pluginBlockedWake: { reason: LOAN_REQUESTED } }, list)).toBeNull();
    expect(readPluginBlockedWake({ wakeReason: LOAN_REQUESTED }, list)).toBeNull();
    expect(readPluginBlockedWake(null, list)).toBeNull();
    // The retry the server creates after a resource wait keeps the context and takes its own wake reason.
    expect(readPluginBlockedWake({ wakeReason: "transient_failure_retry", retryOfRunId: "r1", pluginBlockedWake: mark }, list))
      .toEqual({ ...mark, serverRetry: true });
  });
});

const support = await getEmbeddedPostgresTestSupport();
vi.setConfig({ testTimeout: 120_000 });

(support.supported ? describe : describe.skip)("a plugin's wake on an issue with unresolved blockers, on the real run path", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  let heartbeat: ReturnType<typeof heartbeatService>;
  // Each launch of the stand-in engine, and what it is told to answer (by issue; the default is a plain success).
  type Launch = { issueId: string; runId: string; context: Record<string, unknown> };
  const launches: Launch[] = [];
  const answers = new Map<string, Array<() => Promise<Record<string, unknown>>>>();
  const SUCCESS = { exitCode: 0, signal: null, timedOut: false, resultJson: {} };

  beforeAll(async () => {
    database = await startEmbeddedPostgresTestDatabase("plugin-blocked-wake-");
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
    await drainHeartbeatRunsToQuiescence(db, heartbeat);
    launches.length = 0;
    answers.clear();
  });
  afterAll(async () => {
    unregisterServerAdapter(adapterType);
    await database?.cleanup();
  });

  const manifest = (capabilities: string[]): PaperclipPluginManifestV1 => ({
    id: "studio.worker-router-fixture", apiVersion: 1, version: "0.1.0", displayName: "Fixture router", description: "Fixture",
    author: "Tests", categories: ["connector"], capabilities, entrypoints: { worker: "worker.js" },
  } as unknown as PaperclipPluginManifestV1);
  const CAPABLE = ["issues.wakeup", "issues.wakeup.blocked"];

  async function seed(options: { capabilities?: string[]; pluginStatus?: string; issueStatus?: string } = {}) {
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
    // The issue of the role that holds the machine waits on the maintenance issue, as TR-2019 waits on TR-2061.
    await db.insert(issues).values([
      { id: blockerId, companyId, title: "Maintenance on the machine", status: "todo", priority: "medium", assigneeAgentId: otherAgentId },
      { id: issueId, companyId, title: "Work that holds the machine", status: options.issueStatus ?? "blocked", priority: "medium", assigneeAgentId: agentId },
    ]);
    await db.insert(issueRelations).values({ companyId, issueId: blockerId, relatedIssueId: issueId, type: "blocks" });
    const pluginKey = `studio.worker-router-fixture.${companyId}`;
    const declared = manifest(options.capabilities ?? CAPABLE);
    const [plugin] = await db.insert(plugins).values({ pluginKey, packageName: pluginKey, version: "0.1.0",
      status: (options.pluginStatus ?? "ready") as never, manifestJson: declared }).returning();
    const services = buildHostServices(db, plugin!.id, pluginKey, { forPlugin: () => ({ emit: async () => {}, subscribe: () => {} }) } as never,
      undefined, { manifest: declared });
    return { companyId, agentId, otherAgentId, blockerId, issueId, pluginId: plugin!.id, pluginKey, services };
  }
  type Fixture = Awaited<ReturnType<typeof seed>>;
  const launchesOf = (issueId: string) => launches.filter((launch) => launch.issueId === issueId);
  const runsOf = (f: Fixture, issueId = f.issueId) => db.select().from(heartbeatRuns)
    .where(and(eq(heartbeatRuns.companyId, f.companyId), eq(heartbeatRuns.agentId, f.agentId)))
    .orderBy(asc(heartbeatRuns.createdAt)).then((rows) => rows.filter((run) => (run.contextSnapshot as Record<string, unknown> | null)?.issueId === issueId));
  const issueOf = async (id: string) => (await db.select().from(issues).where(eq(issues.id, id)))[0]!;
  const state = async (f: Fixture) => JSON.stringify({
    runs: (await runsOf(f)).map((run) => [run.status, run.errorCode]),
    wakes: (await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.companyId, f.companyId))).map((wake) => [wake.status, wake.reason, wake.error]),
  });
  /** The wake started a run of the assignee on the issue, and that run ended. */
  async function started(f: Fixture, count = 1) {
    await vi.waitFor(async () => expect(launchesOf(f.issueId).length, await state(f)).toBeGreaterThanOrEqual(count), { timeout: 30_000, interval: 100 });
    await drainHeartbeatRunsToQuiescence(db, heartbeat);
    return launchesOf(f.issueId);
  }
  /** Nothing ran for the issue, and nothing waits to run. */
  async function held(f: Fixture) {
    await heartbeat.resumeQueuedRuns();
    await drainHeartbeatRunsToQuiescence(db, heartbeat);
    expect(launchesOf(f.issueId), await state(f)).toHaveLength(0);
    expect((await runsOf(f)).filter((run) => ["queued", "running", "succeeded", "failed"].includes(run.status)), await state(f)).toHaveLength(0);
  }
  /** A wake written as the plugin's door writes it, by a caller that is not that door. */
  const wakeAs = (f: Fixture, patch: { reason?: string; mark?: unknown; actorType?: string; actorId?: string } = {}) => {
    const reason = patch.reason ?? LOAN_REQUESTED;
    return heartbeat.wakeup(f.agentId, {
      source: "assignment", triggerDetail: "system", reason,
      payload: { issueId: f.issueId, mutation: "plugin_wakeup", pluginId: f.pluginId, pluginKey: f.pluginKey },
      requestedByActorType: (patch.actorType ?? "system") as never, requestedByActorId: patch.actorId ?? f.pluginId,
      contextSnapshot: { issueId: f.issueId, taskId: f.issueId, wakeReason: reason, source: "plugin.issue.requestWakeup", pluginId: f.pluginId,
        pluginKey: f.pluginKey, pluginBlockedWake: patch.mark === undefined ? { pluginId: f.pluginId, reason } : patch.mark },
    });
  };

  it.each([LOAN_REQUESTED, LOAN_RETURNED])("the router's wake `%s` starts the assignee's run on the blocked issue, in the bounded mode", async (reason) => {
    const f = await seed();
    await f.services.issues.requestWakeup({ issueId: f.issueId, companyId: f.companyId, reason });
    const [launch] = await started(f);
    expect(launch!.context).toMatchObject({ wakeReason: reason, dependencyBlockedInteraction: true,
      pluginBlockedWake: { pluginId: f.pluginId, reason }, unresolvedBlockerIssueIds: [f.blockerId] });
    const [run] = await runsOf(f);
    expect(run).toMatchObject({ status: "succeeded", agentId: f.agentId });
    // The issue still waits on its blocker, and its blocker is untouched.
    expect(await issueOf(f.issueId)).toMatchObject({ status: "blocked", assigneeAgentId: f.agentId });
    expect(await issueOf(f.blockerId)).toMatchObject({ status: "todo" });
    expect(launchesOf(f.issueId)).toHaveLength(1);
  });

  it("the same through the batch form: one run on the blocked issue", async () => {
    const f = await seed();
    await f.services.issues.requestWakeups({ issueIds: [f.issueId], companyId: f.companyId, reason: LOAN_REQUESTED });
    const [launch] = await started(f);
    expect(launch!.context).toMatchObject({ wakeReason: LOAN_REQUESTED, dependencyBlockedInteraction: true, pluginBlockedWake: { pluginId: f.pluginId, reason: LOAN_REQUESTED } });
  });

  it("another reason is refused at the plugin's door, also for a plugin that declares the capability", async () => {
    const f = await seed();
    for (const reason of [ORDINARY, "plugin_issue_wakeup_requested", "mission_advance", undefined]) {
      await expect(f.services.issues.requestWakeup({ issueId: f.issueId, companyId: f.companyId, reason }), String(reason)).rejects.toThrow(REFUSED);
      await expect(f.services.issues.requestWakeups({ issueIds: [f.issueId], companyId: f.companyId, reason }), String(reason)).rejects.toThrow(REFUSED);
    }
    await held(f);
  });

  it("a plugin that does not declare the capability is refused at the plugin's door, also for a listed reason", async () => {
    const f = await seed({ capabilities: ["issues.wakeup"] });
    for (const reason of PLUGIN_BLOCKED_ISSUE_WAKE_REASONS) {
      await expect(f.services.issues.requestWakeup({ issueId: f.issueId, companyId: f.companyId, reason })).rejects.toThrow(REFUSED);
      await expect(f.services.issues.requestWakeups({ issueIds: [f.issueId], companyId: f.companyId, reason })).rejects.toThrow(REFUSED);
    }
    await held(f);
  });

  it.each(["backlog", "done", "cancelled"])("an issue that is `%s` stays refused, with the listed reason and the capability", async (status) => {
    const f = await seed({ issueStatus: status });
    await expect(f.services.issues.requestWakeup({ issueId: f.issueId, companyId: f.companyId, reason: LOAN_REQUESTED }))
      .rejects.toThrow(`Issue is not wakeable in status: ${status}`);
    await expect(f.services.issues.requestWakeups({ issueIds: [f.issueId], companyId: f.companyId, reason: LOAN_REQUESTED }))
      .rejects.toThrow(`Issue is not wakeable in status: ${status}`);
    await held(f);
  });

  it("the doors of the queue do not trust the mark: the same wake written by another caller is held", async () => {
    // The plugin on the server does not declare the capability.
    const noCapability = await seed({ capabilities: ["issues.wakeup"] });
    await wakeAs(noCapability);
    await held(noCapability);
    // The plugin is not ready.
    const notReady = await seed({ pluginStatus: "error" });
    await wakeAs(notReady);
    await held(notReady);
    // The requester is an agent, or a person, or another plugin.
    const forged = await seed();
    await wakeAs(forged, { actorType: "agent", actorId: forged.otherAgentId });
    await wakeAs(forged, { actorType: "user", actorId: "some-user" });
    await wakeAs(forged, { actorId: randomUUID() });
    await held(forged);
    // A reason outside the list, on the wake and in the mark; and a mark for a plugin that does not exist.
    const otherReason = await seed();
    await wakeAs(otherReason, { reason: ORDINARY });
    await wakeAs(otherReason, { mark: { pluginId: randomUUID(), reason: LOAN_REQUESTED } });
    await held(otherReason);
    // The same wake with nothing forged runs: the fixture was not the reason of the refusals above.
    const genuine = await seed();
    await wakeAs(genuine);
    await started(genuine);
  });

  it("an agent's comment on the blocked issue stays held, with the router's plugin installed", async () => {
    const f = await seed();
    const [comment] = await db.insert(issueComments).values({ companyId: f.companyId, issueId: f.issueId, authorType: "agent",
      authorAgentId: f.otherAgentId, body: "I need the machine: are you ready?" }).returning();
    await heartbeat.wakeup(f.agentId, {
      source: "automation", triggerDetail: "system", reason: "issue_commented", payload: { issueId: f.issueId, commentId: comment!.id },
      requestedByActorType: "agent", requestedByActorId: f.otherAgentId,
      contextSnapshot: { issueId: f.issueId, taskId: f.issueId, wakeReason: "issue_commented", commentId: comment!.id, wakeCommentId: comment!.id },
    });
    await held(f);
    // The router's own wake, after it, starts the run: the comment did not open the way, the wake did.
    await f.services.issues.requestWakeup({ issueId: f.issueId, companyId: f.companyId, reason: LOAN_REQUESTED });
    await started(f);
  });

  // The start of the run has its own door: a wake admitted while the issue had no blocker meets it when the blocker
  // is set before the run starts. The assignee is kept busy on another issue meanwhile.
  async function queuedBehindAnotherRun(f: Fixture) {
    await db.delete(issueRelations).where(eq(issueRelations.relatedIssueId, f.issueId));
    await db.update(issues).set({ status: "todo" }).where(eq(issues.id, f.issueId));
    const busyIssueId = randomUUID();
    await db.insert(issues).values({ id: busyIssueId, companyId: f.companyId, title: "Other work", status: "todo", priority: "medium", assigneeAgentId: f.agentId });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    answers.set(busyIssueId, [async () => { await gate; return SUCCESS; }]);
    await heartbeat.wakeup(f.agentId, { source: "assignment", triggerDetail: "system", reason: "issue_assigned",
      payload: { issueId: busyIssueId, mutation: "update" }, requestedByActorType: "system", requestedByActorId: "test",
      contextSnapshot: { issueId: busyIssueId, taskId: busyIssueId, source: "issue.update" } });
    await vi.waitFor(() => expect(launchesOf(busyIssueId)).toHaveLength(1), { timeout: 30_000, interval: 100 });
    // The router's wake is admitted on an issue that has no blocker yet, and waits behind the run at work.
    await f.services.issues.requestWakeup({ issueId: f.issueId, companyId: f.companyId, reason: LOAN_REQUESTED });
    expect(launchesOf(f.issueId)).toHaveLength(0);
    // The blocker is set while the wake waits.
    await db.insert(issueRelations).values({ companyId: f.companyId, issueId: f.blockerId, relatedIssueId: f.issueId, type: "blocks" });
    await db.update(issues).set({ status: "blocked" }).where(eq(issues.id, f.issueId));
    return release;
  }

  it("at the start of the run: a wake queued before the blocker was set still starts, in the bounded mode", async () => {
    const f = await seed();
    const release = await queuedBehindAnotherRun(f);
    release();
    const [launch] = await started(f);
    expect(launch!.context).toMatchObject({ wakeReason: LOAN_REQUESTED, dependencyBlockedInteraction: true, pluginBlockedWake: { pluginId: f.pluginId, reason: LOAN_REQUESTED } });
  });

  it("at the start of the run: the plugin lost the capability meanwhile, and the queued run is cancelled for the blocker", async () => {
    const f = await seed();
    const release = await queuedBehindAnotherRun(f);
    await db.update(plugins).set({ manifestJson: manifest(["issues.wakeup"]) }).where(eq(plugins.id, f.pluginId));
    release();
    await heartbeat.resumeQueuedRuns();
    await drainHeartbeatRunsToQuiescence(db, heartbeat);
    expect(launchesOf(f.issueId), await state(f)).toHaveLength(0);
    expect((await runsOf(f)).map((run) => [run.status, run.errorCode])).toEqual([["cancelled", "issue_dependencies_blocked"]]);
  });

  it("the run of such a wake fails on a lost link: the server's retry still starts on the blocked issue", async () => {
    const f = await seed();
    answers.set(f.issueId, [async () => ({ exitCode: 1, signal: null, timedOut: false, errorCode: "router_provider_stop_unverified",
      errorMessage: "router provider stop unverified" })]);
    await f.services.issues.requestWakeup({ issueId: f.issueId, companyId: f.companyId, reason: LOAN_REQUESTED });
    await started(f);
    const [scheduled] = (await runsOf(f)).filter((run) => run.status === "scheduled_retry");
    expect(scheduled, await state(f)).toBeDefined();
    expect(scheduled!.contextSnapshot).toMatchObject({ pluginBlockedWake: { pluginId: f.pluginId, reason: LOAN_REQUESTED } });
    await db.update(heartbeatRuns).set({ scheduledRetryAt: new Date(Date.now() - 60_000) }).where(eq(heartbeatRuns.id, scheduled!.id));
    await heartbeat.promoteDueScheduledRetries();
    await heartbeat.resumeQueuedRuns();
    const again = await started(f, 2);
    expect(again).toHaveLength(2);
    expect(again[1]!.runId).toBe(scheduled!.id);
    expect(again[1]!.context).toMatchObject({ dependencyBlockedInteraction: true, pluginBlockedWake: { pluginId: f.pluginId, reason: LOAN_REQUESTED } });
  });

  it("the verification itself: the requester of the wake request, the plugin's state, the server's own retry", async () => {
    const f = await seed();
    const context = { issueId: f.issueId, wakeReason: LOAN_REQUESTED, pluginBlockedWake: { pluginId: f.pluginId, reason: LOAN_REQUESTED } };
    const given = (patch: Record<string, unknown> = {}) => verifyPluginBlockedWake(db, { contextSnapshot: context,
      requestedByActorType: "system", requestedByActorId: f.pluginId, ...patch });
    expect(await given()).toBe(true);
    expect(await given({ requestedByActorType: "agent" })).toBe(false);
    expect(await given({ requestedByActorId: f.otherAgentId })).toBe(false);
    expect(await given({ requestedByActorId: null })).toBe(false);
    // By the wake request of a run: the requester is read from it.
    const [byPlugin] = await db.insert(agentWakeupRequests).values({ companyId: f.companyId, agentId: f.agentId, source: "assignment",
      triggerDetail: "system", reason: LOAN_REQUESTED, payload: {}, status: "queued", requestedByActorType: "system", requestedByActorId: f.pluginId }).returning();
    const [byAgent] = await db.insert(agentWakeupRequests).values({ companyId: f.companyId, agentId: f.agentId, source: "automation",
      triggerDetail: "system", reason: LOAN_REQUESTED, payload: {}, status: "queued", requestedByActorType: "agent", requestedByActorId: f.otherAgentId }).returning();
    expect(await verifyPluginBlockedWake(db, { contextSnapshot: context, wakeupRequestId: byPlugin!.id })).toBe(true);
    expect(await verifyPluginBlockedWake(db, { contextSnapshot: context, wakeupRequestId: byAgent!.id })).toBe(false);
    expect(await verifyPluginBlockedWake(db, { contextSnapshot: context, wakeupRequestId: randomUUID() })).toBe(false);
    // The server's own retry has no request of its own: the mark and the plugin's state decide.
    const retry = { ...context, wakeReason: "transient_failure_retry", retryOfRunId: randomUUID() };
    expect(await verifyPluginBlockedWake(db, { contextSnapshot: retry })).toBe(true);
    await db.update(plugins).set({ status: "disabled" }).where(eq(plugins.id, f.pluginId));
    expect(await verifyPluginBlockedWake(db, { contextSnapshot: retry })).toBe(false);
    expect(await given()).toBe(false);
  });
});
