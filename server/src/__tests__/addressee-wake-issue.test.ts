// STUDIO-0087: a card addressed to an agent may wake that agent on a task of its own (`addresseeWakeIssueId`) instead
// of the card's task. Two roles work together, each on its own task, as TR-2019 (the host) and TR-2466 (the guest):
// the host's card for the guest must wake the guest on the guest's task. The cases create the card as the worker
// router does (a plugin's createInteraction) and follow real heartbeat runs with a stand-in adapter.
import { randomUUID } from "node:crypto";
import { and, asc, eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  agentWakeupRequests, agents, authUsers, companies, companyMemberships, createDb, heartbeatRuns, issueComments, issueRelations,
  issueThreadInteractions, issues, EMBEDDED_POSTGRES_TEST_TIMEOUT_MS,
} from "@paperclipai/db";
import { createIssueThreadInteractionSchema, interactionResolverGovernanceSchema } from "@paperclipai/shared";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { drainHeartbeatRunsToQuiescence } from "./helpers/drain-heartbeat-runs.js";
import { registerServerAdapter, unregisterServerAdapter } from "../adapters/index.js";
import { heartbeatService } from "../services/heartbeat.js";
import { buildHostServices } from "../services/plugin-host-services.js";
import { issueThreadInteractionService } from "../services/issue-thread-interactions.js";
import { createLifecycleDriver } from "../services/agent-lifecycle-driver.js";
import {
  ADDRESSEE_WAKE_ON_BLOCKED_ISSUE_SETTING, addresseeWakeTarget, ownIssueInteractionNote, verifyOwnIssueInteractionWake,
} from "../services/addressee-wake-issue.js";
import { PAUSE_MISSED_WAKE_REASON } from "../services/pause-missed-wakes.js";

const adapterType = "codex_local";

describe("the task a card's wake goes to", () => {
  it("is the named task of the addressee, with the card's task kept in the context; otherwise the card's own task", () => {
    expect(addresseeWakeTarget("card-task", "own-task")).toEqual({ issueId: "own-task", context: { interactionIssueId: "card-task" } });
    expect(addresseeWakeTarget("card-task", undefined)).toEqual({ issueId: "card-task", context: {} });
    expect(addresseeWakeTarget("card-task", null)).toEqual({ issueId: "card-task", context: {} });
    expect(addresseeWakeTarget("card-task", "")).toEqual({ issueId: "card-task", context: {} });
    // Naming the card's own task changes nothing.
    expect(addresseeWakeTarget("card-task", "card-task")).toEqual({ issueId: "card-task", context: {} });
  });

  it("the creation field is optional: a card without it is valid as before, and a value that is not an id is refused", () => {
    const card = { kind: "request_confirmation", addresseeAgentId: randomUUID(), payload: { version: 1, prompt: "Confirm." } };
    expect(createIssueThreadInteractionSchema.safeParse(card).success).toBe(true);
    const named = createIssueThreadInteractionSchema.safeParse({ ...card, addresseeWakeIssueId: randomUUID() });
    expect(named.success).toBe(true);
    expect(createIssueThreadInteractionSchema.safeParse({ ...card, addresseeWakeIssueId: null }).success).toBe(true);
    expect(createIssueThreadInteractionSchema.safeParse({ ...card, addresseeWakeIssueId: "TR-2466" }).success).toBe(false);
    // What a server without this field does with it: a field the creation schema does not know is dropped, the card is
    // created as before. The worker router may send the field to a server that does not have this patch.
    const unknown = createIssueThreadInteractionSchema.safeParse({ ...card, aFieldThisServerDoesNotKnow: randomUUID() });
    expect(unknown.success).toBe(true);
    expect(unknown.success && "aFieldThisServerDoesNotKnow" in unknown.data).toBe(false);
  });
});

describe("the company setting that lets a card's wake pass the blockers of the addressee's task", () => {
  it("lives in the company's interactionResolverGovernance, is a boolean, and is absent by default", () => {
    expect(ADDRESSEE_WAKE_ON_BLOCKED_ISSUE_SETTING).toBe("addresseeWakeOnBlockedIssue");
    expect(interactionResolverGovernanceSchema.parse(undefined)).toEqual({});
    expect(interactionResolverGovernanceSchema.parse({ addresseeWakeOnBlockedIssue: { enabled: true } }))
      .toEqual({ addresseeWakeOnBlockedIssue: { enabled: true } });
    expect(interactionResolverGovernanceSchema.safeParse({ addresseeWakeOnBlockedIssue: { enabled: false } }).success).toBe(true);
    expect(interactionResolverGovernanceSchema.safeParse({ addresseeWakeOnBlockedIssue: { enabled: "yes" } }).success).toBe(false);
    expect(interactionResolverGovernanceSchema.safeParse({ addresseeWakeOnBlockedIssue: { enabled: true, other: 1 } }).success).toBe(false);
  });
});

const support = await getEmbeddedPostgresTestSupport();
vi.setConfig({ testTimeout: 120_000 });

(support.supported ? describe : describe.skip)("a card that wakes its addressee on the addressee's own task, on the real run path", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  let heartbeat: ReturnType<typeof heartbeatService>;
  let plugin: ReturnType<typeof buildHostServices>;
  // Each launch of the stand-in engine, and what it is told to do (by issue; the default is a plain success).
  type Launch = { issueId: string; agentId: string; runId: string; context: Record<string, unknown> };
  const launches: Launch[] = [];
  const answers = new Map<string, Array<(launch: Launch) => Promise<Record<string, unknown>>>>();
  const SUCCESS = { exitCode: 0, signal: null, timedOut: false, resultJson: {} };

  beforeAll(async () => {
    database = await startEmbeddedPostgresTestDatabase("addressee-wake-issue-");
    db = createDb(database.connectionString);
    heartbeat = heartbeatService(db);
    plugin = buildHostServices(db, "worker-router-test", "worker-router-test",
      { forPlugin: () => ({ emit: vi.fn(), subscribe: vi.fn(), clear: vi.fn() }) } as never);
    registerServerAdapter({
      type: adapterType, supportsLocalAgentJwt: false,
      execute: async (input) => {
        const launch = { issueId: String(input.context.issueId), agentId: input.agent.id, runId: input.runId,
          context: input.context as Record<string, unknown> };
        launches.push(launch);
        const answer = answers.get(launch.issueId)?.shift();
        return (answer ? await answer(launch) : SUCCESS) as never;
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
    plugin?.dispose();
    unregisterServerAdapter(adapterType);
    await database?.cleanup();
  });

  // The host and the guest each have a task of their own. With `blocked`, the guest's task waits on a third task.
  // `blockedIssueWake` is the company's setting: a real company has NONE (off). The fixture turns it ON unless a case
  // says otherwise, because most cases below prove what happens once the Board has turned it on.
  async function seed(options: { blocked?: boolean; guestStatus?: string; guestIssueStatus?: string; blockedIssueWake?: unknown } = {}) {
    const companyId = randomUUID(), hostId = randomUUID(), guestId = randomUUID(), thirdId = randomUUID();
    const hostIssueId = randomUUID(), guestIssueId = randomUUID(), blockerId = randomUUID();
    const tag = companyId.replaceAll("-", "").slice(0, 6).toUpperCase();
    const setting = "blockedIssueWake" in options ? options.blockedIssueWake : { enabled: true };
    await db.insert(companies).values({ id: companyId, name: "Work in common", issuePrefix: `W${tag}`,
      requireBoardApprovalForNewAgents: false, defaultResponsibleUserId: "responsible-user",
      interactionResolverGovernance: (setting === undefined ? {} : { [ADDRESSEE_WAKE_ON_BLOCKED_ISSUE_SETTING]: setting }) as never });
    await db.insert(authUsers).values({ id: "responsible-user", name: "Fixture user", email: "responsible-user@example.test",
      createdAt: new Date(), updatedAt: new Date() }).onConflictDoNothing();
    await db.insert(companyMemberships).values({ companyId, principalType: "user", principalId: "responsible-user",
      status: "active", membershipRole: "member" }).onConflictDoNothing();
    const agent = (id: string, name: string, status = "idle") => ({ id, companyId, name, role: "engineer", status, adapterType,
      adapterConfig: {}, runtimeConfig: { heartbeat: { wakeOnDemand: true, maxConcurrentRuns: 1 } }, permissions: {} });
    await db.insert(agents).values([agent(hostId, "Super Dev Unity"), agent(guestId, "Game Tester", options.guestStatus), agent(thirdId, "Infra Manager")]);
    await db.insert(issues).values([
      { id: hostIssueId, companyId, identifier: `W${tag}-1`, title: "The host's task", status: "todo", priority: "medium", assigneeAgentId: hostId },
      { id: guestIssueId, companyId, identifier: `W${tag}-2`, title: "The guest's task", priority: "medium", assigneeAgentId: guestId,
        status: options.guestIssueStatus ?? (options.blocked ? "blocked" : "todo") },
      { id: blockerId, companyId, identifier: `W${tag}-3`, title: "What the guest's task waits on", status: "todo", priority: "medium", assigneeAgentId: thirdId },
    ]);
    if (options.blocked) await db.insert(issueRelations).values({ companyId, issueId: blockerId, relatedIssueId: guestIssueId, type: "blocks" });
    return { companyId, hostId, guestId, thirdId, hostIssueId, guestIssueId, blockerId, hostIdentifier: `W${tag}-1` };
  }
  type Fixture = Awaited<ReturnType<typeof seed>>;

  const cardBody = (addresseeAgentId: string | null, addresseeWakeIssueId?: string | null) => ({
    kind: "request_confirmation" as const, resolverPolicy: "anyone" as const, idempotencyKey: `question/${randomUUID()}`,
    title: "A question of the host", payload: { version: 1 as const, prompt: "Is the build you tested the one of this morning?" },
    ...(addresseeAgentId ? { addresseeAgentId } : {}),
    ...(addresseeWakeIssueId !== undefined ? { addresseeWakeIssueId } : {}),
  });
  /** The host's card for the guest, on the host's task, created as the worker router creates one. */
  const postCard = (f: Fixture, addresseeWakeIssueId?: string | null, issueId = f.hostIssueId) =>
    plugin.issues.createInteraction({ companyId: f.companyId, issueId, authorAgentId: f.hostId,
      interaction: cardBody(f.guestId, addresseeWakeIssueId) } as never) as Promise<{ id: string; status: string }>;

  const launchesOf = (issueId: string, agentId?: string) =>
    launches.filter((launch) => launch.issueId === issueId && (!agentId || launch.agentId === agentId));
  const cardOf = async (id: string) => (await db.select().from(issueThreadInteractions).where(eq(issueThreadInteractions.id, id)))[0]!;
  const issueOf = async (id: string) => (await db.select().from(issues).where(eq(issues.id, id)))[0]!;
  const wakesOf = (f: Fixture, agentId = f.guestId) => db.select().from(agentWakeupRequests)
    .where(and(eq(agentWakeupRequests.companyId, f.companyId), eq(agentWakeupRequests.agentId, agentId))).orderBy(asc(agentWakeupRequests.createdAt));
  const runsOf = (f: Fixture, issueId: string, agentId = f.guestId) => db.select().from(heartbeatRuns)
    .where(and(eq(heartbeatRuns.companyId, f.companyId), eq(heartbeatRuns.agentId, agentId)))
    .orderBy(asc(heartbeatRuns.createdAt)).then((rows) => rows.filter((run) => (run.contextSnapshot as Record<string, unknown> | null)?.issueId === issueId));
  const state = async (f: Fixture) => JSON.stringify({
    launches: launches.map((launch) => [launch.issueId === f.guestIssueId ? "guest task" : launch.issueId === f.hostIssueId ? "host task" : "other", launch.context.wakeReason]),
    runs: (await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.companyId, f.companyId))).map((run) => [run.status, run.errorCode]),
    wakes: (await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.companyId, f.companyId))).map((wake) => [wake.status, wake.reason, wake.error]),
  });
  /** The guest's run that was woken for that card, on that task. */
  async function wokenFor(f: Fixture, cardId: string, issueId = f.guestIssueId) {
    const forCard = () => launchesOf(issueId, f.guestId).filter((launch) => launch.context.interactionId === cardId);
    await vi.waitFor(async () => expect(forCard().length, await state(f)).toBeGreaterThanOrEqual(1), { timeout: 30_000, interval: 100 });
    await drainHeartbeatRunsToQuiescence(db, heartbeat);
    return forCard()[0]!;
  }
  /** Nothing ran for the guest on that task, and nothing waits to run there. */
  async function held(f: Fixture, issueId = f.guestIssueId) {
    await heartbeat.resumeQueuedRuns();
    await drainHeartbeatRunsToQuiescence(db, heartbeat);
    expect(launchesOf(issueId, f.guestId), await state(f)).toHaveLength(0);
    expect((await runsOf(f, issueId)).filter((run) => ["queued", "running", "succeeded", "failed"].includes(run.status)), await state(f)).toHaveLength(0);
  }
  /** A card's wake on the guest's task, written by a caller that is not the creation of a card. */
  const wakeAs = (f: Fixture, context: Record<string, unknown>, issueId = f.guestIssueId) => heartbeat.wakeup(f.guestId, {
    source: "automation", triggerDetail: "system", reason: "interaction_pending",
    payload: { issueId, mutation: "interaction", interactionId: context.interactionId },
    requestedByActorType: "agent", requestedByActorId: f.hostId,
    contextSnapshot: { issueId, taskId: issueId, wakeReason: "interaction_pending", source: "issue.interaction.created", ...context },
  });

  it("the wake goes to the named task of the addressee, and the run reads which card waits and on which task", async () => {
    const f = await seed();
    const card = await postCard(f, f.guestIssueId);
    const launch = await wokenFor(f, card.id);
    expect(launch.context).toMatchObject({ issueId: f.guestIssueId, wakeReason: "interaction_pending", interactionId: card.id,
      interactionIssueId: f.hostIssueId });
    // What the run reads, in the task text the server builds: the card's id and the task the card is on.
    const text = String(launch.context.paperclipTaskMarkdown ?? "");
    expect(text).toContain(`interaction ${card.id} on issue ${f.hostIdentifier}`);
    expect(text).toContain(`issue id ${f.hostIssueId}`);
    // The guest was not started on the host's task, and the wake request names the guest's task.
    expect(launchesOf(f.hostIssueId, f.guestId)).toHaveLength(0);
    const [wake] = (await wakesOf(f)).filter((row) => row.idempotencyKey === `interaction-pending:${card.id}`);
    expect(wake).toMatchObject({ reason: "interaction_pending", payload: expect.objectContaining({ issueId: f.guestIssueId, interactionId: card.id }) });
    // The card still waits for its answer, on the host's task.
    expect(await cardOf(card.id)).toMatchObject({ status: "pending", issueId: f.hostIssueId, addresseeAgentId: f.guestId });
  });

  it("without the field: today's behaviour, the addressee is woken on the card's task and reads no such line", async () => {
    const f = await seed();
    const card = await postCard(f);
    const launch = await wokenFor(f, card.id, f.hostIssueId);
    expect(launch.context).toMatchObject({ issueId: f.hostIssueId, wakeReason: "interaction_pending", interactionId: card.id });
    expect(launch.context.interactionIssueId).toBeUndefined();
    expect(String(launch.context.paperclipTaskMarkdown ?? "")).not.toContain("pending on another task");
    expect(launchesOf(f.guestIssueId)).toHaveLength(0);
    // A null field is the same.
    const g = await seed();
    const second = await postCard(g, null);
    expect((await wokenFor(g, second.id, g.hostIssueId)).context.interactionIssueId).toBeUndefined();
  });

  it("a task that is not the addressee's, a closed task, a task of another company: the card is refused and not created", async () => {
    const f = await seed();
    const other = await seed();
    const service = issueThreadInteractionService(db);
    const create = (wakeIssueId: string, addressee: string | null = f.guestId) =>
      service.create({ id: f.hostIssueId, companyId: f.companyId }, cardBody(addressee, wakeIssueId) as never, { agentId: f.hostId });
    // Assigned to another agent: the host's own task, and the third agent's.
    for (const issueId of [f.hostIssueId, f.blockerId]) {
      await expect(create(issueId)).rejects.toMatchObject({ status: 422, message: expect.stringContaining("assigned to the addressee agent") });
    }
    // Closed.
    for (const status of ["done", "cancelled"]) {
      await db.update(issues).set({ status }).where(eq(issues.id, f.guestIssueId));
      await expect(create(f.guestIssueId)).rejects.toMatchObject({ status: 422, message: expect.stringContaining("not done or cancelled") });
    }
    await db.update(issues).set({ status: "todo" }).where(eq(issues.id, f.guestIssueId));
    // Another company's task, and one that does not exist.
    for (const issueId of [other.guestIssueId, randomUUID()]) {
      await expect(create(issueId)).rejects.toMatchObject({ status: 422, message: expect.stringContaining("same company") });
    }
    // The field needs an addressee agent.
    await expect(create(f.guestIssueId, null)).rejects.toMatchObject({ status: 422, message: expect.stringContaining("requires addresseeAgentId") });
    // The same refusal through a plugin's entry.
    await expect(postCard(f, f.blockerId)).rejects.toMatchObject({ status: 422 });
    // No card was created, nobody was woken.
    expect(await db.select().from(issueThreadInteractions).where(eq(issueThreadInteractions.companyId, f.companyId))).toHaveLength(0);
    expect(await wakesOf(f)).toHaveLength(0);
    await held(f);
    // A task that is `backlog` or `blocked` is accepted: only a closed one is refused.
    await db.update(issues).set({ status: "backlog" }).where(eq(issues.id, f.guestIssueId));
    await expect(create(f.guestIssueId)).resolves.toMatchObject({ status: "pending" });
  });

  // The company's setting is OFF by default. Off, a card that names a blocked task of the addressee keeps today's gate:
  // the wake is held as any wake on a blocked task and the card stays pending.
  it.each([
    ["no setting at all, the state of a company after an install", undefined],
    ["the setting set to false", { enabled: false }],
    ["a value that is not exactly true", { enabled: "true" }],
    ["an empty setting", {}],
  ])("setting OFF (%s): the wake on the addressee's blocked task is refused as today, the card stays pending", async (_label, setting) => {
    const f = await seed({ blocked: true, blockedIssueWake: setting });
    const card = await postCard(f, f.guestIssueId);
    await new Promise((resolve) => setTimeout(resolve, 300));
    await held(f);
    expect(launchesOf(f.hostIssueId, f.guestId)).toHaveLength(0);
    expect(await cardOf(card.id)).toMatchObject({ status: "pending", issueId: f.hostIssueId, addresseeAgentId: f.guestId });
    expect(await issueOf(f.guestIssueId)).toMatchObject({ status: "blocked", assigneeAgentId: f.guestId });
    // The refused wake is recorded as any wake held for unresolved blockers, on the guest's task.
    const [wake] = (await wakesOf(f)).filter((row) => row.idempotencyKey === `interaction-pending:${card.id}`);
    expect(wake, await state(f)).toMatchObject({ status: "skipped", payload: expect.objectContaining({ issueId: f.guestIssueId }) });
    expect(String(wake!.reason ?? "") + String(wake!.error ?? "")).toContain("issue_dependencies_blocked");
    // The verification itself says no, although every part of the card is true.
    expect(await verifyOwnIssueInteractionWake(db, { companyId: f.companyId, issueId: f.guestIssueId, agentId: f.guestId,
      contextSnapshot: { wakeReason: "interaction_pending", interactionId: card.id, interactionIssueId: f.hostIssueId } })).toBe(false);
  });

  it("setting OFF: on a task that is NOT blocked, the card still wakes the addressee on its own task, with its line", async () => {
    const f = await seed({ blockedIssueWake: undefined });
    const card = await postCard(f, f.guestIssueId);
    const launch = await wokenFor(f, card.id);
    expect(launch.context).toMatchObject({ issueId: f.guestIssueId, wakeReason: "interaction_pending", interactionId: card.id, interactionIssueId: f.hostIssueId });
    expect(String(launch.context.paperclipTaskMarkdown ?? "")).toContain(`interaction ${card.id} on issue ${f.hostIdentifier}`);
  });

  it("setting OFF, at the start of the run: a wake admitted before a blocker came is cancelled for the blocker", async () => {
    const f = await seed({ blockedIssueWake: undefined });
    const busyIssueId = randomUUID();
    await db.insert(issues).values({ id: busyIssueId, companyId: f.companyId, title: "Other work of the guest", status: "todo", priority: "medium", assigneeAgentId: f.guestId });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    answers.set(busyIssueId, [async () => { await gate; return SUCCESS; }]);
    await heartbeat.wakeup(f.guestId, { source: "assignment", triggerDetail: "system", reason: "issue_assigned",
      payload: { issueId: busyIssueId, mutation: "update" }, requestedByActorType: "system", requestedByActorId: "test",
      contextSnapshot: { issueId: busyIssueId, taskId: busyIssueId, source: "issue.update" } });
    await vi.waitFor(() => expect(launchesOf(busyIssueId)).toHaveLength(1), { timeout: 30_000, interval: 100 });
    const card = await postCard(f, f.guestIssueId);
    await vi.waitFor(async () => expect((await runsOf(f, f.guestIssueId)).map((run) => run.status), await state(f)).toEqual(["queued"]), { timeout: 30_000, interval: 100 });
    await db.insert(issueRelations).values({ companyId: f.companyId, issueId: f.blockerId, relatedIssueId: f.guestIssueId, type: "blocks" });
    await db.update(issues).set({ status: "blocked" }).where(eq(issues.id, f.guestIssueId));
    release();
    await heartbeat.resumeQueuedRuns();
    await drainHeartbeatRunsToQuiescence(db, heartbeat);
    expect(launchesOf(f.guestIssueId), await state(f)).toHaveLength(0);
    expect((await runsOf(f, f.guestIssueId)).map((run) => [run.status, run.errorCode])).toEqual([["cancelled", "issue_dependencies_blocked"]]);
    expect(await cardOf(card.id)).toMatchObject({ status: "pending" });
  });

  it("setting ON: the addressee's task waits on a blocker, the card still wakes it there, in the bounded mode; no blocker is lifted, no status changes", async () => {
    const f = await seed({ blocked: true });
    const card = await postCard(f, f.guestIssueId);
    const launch = await wokenFor(f, card.id);
    expect(launch.context).toMatchObject({ issueId: f.guestIssueId, wakeReason: "interaction_pending", interactionId: card.id,
      interactionIssueId: f.hostIssueId, dependencyBlockedInteraction: true, unresolvedBlockerIssueIds: [f.blockerId] });
    expect(String(launch.context.paperclipTaskMarkdown ?? "")).toContain(`interaction ${card.id} on issue ${f.hostIdentifier}`);
    expect(launchesOf(f.guestIssueId, f.guestId)).toHaveLength(1);
    expect(await issueOf(f.guestIssueId)).toMatchObject({ status: "blocked", assigneeAgentId: f.guestId });
    expect(await issueOf(f.blockerId)).toMatchObject({ status: "todo", assigneeAgentId: f.thirdId });
    expect(await db.select().from(issueRelations).where(and(eq(issueRelations.issueId, f.blockerId), eq(issueRelations.relatedIssueId, f.guestIssueId)))).toHaveLength(1);
    expect(launchesOf(f.blockerId)).toHaveLength(0);
  });

  it("without the field, a card on the addressee's own blocked task is held as before", async () => {
    const f = await seed({ blocked: true });
    // The host posts its card on the guest's task itself: the guest is the assignee there, and the task waits.
    const card = await postCard(f, undefined, f.guestIssueId);
    await held(f);
    expect(await cardOf(card.id)).toMatchObject({ status: "pending" });
  });

  it("the answer: woken on its own task, the addressee answers the card of the other task", async () => {
    const f = await seed();
    let refusal: unknown = null;
    answers.set(f.guestIssueId, [async (launch) => {
      await issueThreadInteractionService(db).acceptInteraction(
        { id: f.hostIssueId, companyId: f.companyId, projectId: null, goalId: null }, String(launch.context.interactionId), {} as never, { agentId: f.guestId, runId: launch.runId })
        .catch((error: unknown) => { refusal = error; });
      return SUCCESS;
    }]);
    const card = await postCard(f, f.guestIssueId);
    await wokenFor(f, card.id);
    expect(refusal instanceof Error ? refusal.message : refusal).toBeNull();
    expect(await cardOf(card.id)).toMatchObject({ status: "accepted", issueId: f.hostIssueId, resolvedByAgentId: f.guestId });
  });

  it("the addressee is at work on its task when the card is posted: the wake waits, then starts when that run ends", async () => {
    const f = await seed();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    answers.set(f.guestIssueId, [async () => { await gate; return SUCCESS; }]);
    await heartbeat.wakeup(f.guestId, { source: "assignment", triggerDetail: "system", reason: "issue_assigned",
      payload: { issueId: f.guestIssueId, mutation: "update" }, requestedByActorType: "system", requestedByActorId: "test",
      contextSnapshot: { issueId: f.guestIssueId, taskId: f.guestIssueId, source: "issue.update" } });
    await vi.waitFor(() => expect(launchesOf(f.guestIssueId)).toHaveLength(1), { timeout: 30_000, interval: 100 });
    const card = await postCard(f, f.guestIssueId);
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(launchesOf(f.guestIssueId).filter((launch) => launch.context.interactionId === card.id)).toHaveLength(0);
    release();
    const launch = await wokenFor(f, card.id);
    expect(launch.context).toMatchObject({ interactionId: card.id, interactionIssueId: f.hostIssueId });
    expect(String(launch.context.paperclipTaskMarkdown ?? "")).toContain(`interaction ${card.id} on issue ${f.hostIdentifier}`);
  });

  it("another wake joins the card's waiting run: that run keeps the card, its reason and its line", async () => {
    const f = await seed();
    // The guest is at work on another task of its own; the card's wake waits, queued, on the guest's task.
    const busyIssueId = randomUUID();
    await db.insert(issues).values({ id: busyIssueId, companyId: f.companyId, title: "Other work of the guest", status: "todo", priority: "medium", assigneeAgentId: f.guestId });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    answers.set(busyIssueId, [async () => { await gate; return SUCCESS; }]);
    await heartbeat.wakeup(f.guestId, { source: "assignment", triggerDetail: "system", reason: "issue_assigned",
      payload: { issueId: busyIssueId, mutation: "update" }, requestedByActorType: "system", requestedByActorId: "test",
      contextSnapshot: { issueId: busyIssueId, taskId: busyIssueId, source: "issue.update" } });
    await vi.waitFor(() => expect(launchesOf(busyIssueId)).toHaveLength(1), { timeout: 30_000, interval: 100 });
    const card = await postCard(f, f.guestIssueId);
    await vi.waitFor(async () => expect((await runsOf(f, f.guestIssueId)).map((run) => run.status), await state(f)).toEqual(["queued"]), { timeout: 30_000, interval: 100 });
    // Another wake for the same task, with a reason of its own, while that run waits.
    await heartbeat.wakeup(f.guestId, { source: "assignment", triggerDetail: "system", reason: "issue_assigned",
      payload: { issueId: f.guestIssueId, mutation: "update" }, requestedByActorType: "system", requestedByActorId: "test",
      contextSnapshot: { issueId: f.guestIssueId, taskId: f.guestIssueId, wakeReason: "issue_assigned", source: "issue.update" } });
    // It joined the waiting run: there is still one run for the guest's task, queued.
    expect((await runsOf(f, f.guestIssueId)).map((run) => run.status)).toEqual(["queued"]);
    release();
    const launch = await wokenFor(f, card.id);
    // The queue keeps the card of a run that has not started: the later wake does not take its place.
    expect(launch.context).toMatchObject({ wakeReason: "interaction_pending", interactionId: card.id, interactionIssueId: f.hostIssueId });
    expect(String(launch.context.paperclipTaskMarkdown ?? "")).toContain(`interaction ${card.id} on issue ${f.hostIdentifier}`);
  });

  it("a paused addressee is not woken and the card stays pending; when the pause lifts, the wake goes to its task with the card", async () => {
    const f = await seed({ guestStatus: "paused" });
    const card = await postCard(f, f.guestIssueId);
    await new Promise((resolve) => setTimeout(resolve, 300));
    await held(f);
    expect(launchesOf(f.hostIssueId, f.guestId)).toHaveLength(0);
    expect(await cardOf(card.id)).toMatchObject({ status: "pending", addresseeAgentId: f.guestId });
    expect(await wakesOf(f)).toEqual([expect.objectContaining({ status: "skipped", reason: "agent.not_invokable",
      payload: expect.objectContaining({ issueId: f.guestIssueId, interactionId: card.id }) })]);
    // The pause lifts.
    await db.update(agents).set({ status: "idle" }).where(eq(agents.id, f.guestId));
    const [guest] = await db.select().from(agents).where(eq(agents.id, f.guestId));
    await createLifecycleDriver(db, {} as never).onReady(guest as never);
    const launch = await wokenFor(f, card.id);
    expect(launch.context).toMatchObject({ issueId: f.guestIssueId, wakeReason: "interaction_pending", interactionId: card.id,
      interactionIssueId: f.hostIssueId, source: "agent.pause_lifted" });
    expect(String(launch.context.paperclipTaskMarkdown ?? "")).toContain(`interaction ${card.id} on issue ${f.hostIdentifier}`);
    expect(launchesOf(f.hostIssueId, f.guestId)).toHaveLength(0);
  });

  it("when the pause lifts, a card answered meanwhile is not replayed as a card, and a card on the addressee's own task is replayed as before", async () => {
    const resume = async (f: Fixture) => {
      await db.update(agents).set({ status: "idle" }).where(eq(agents.id, f.guestId));
      const [guest] = await db.select().from(agents).where(eq(agents.id, f.guestId));
      await createLifecycleDriver(db, {} as never).onReady(guest as never);
      await vi.waitFor(async () => expect(launchesOf(f.guestIssueId, f.guestId).length, await state(f)).toBeGreaterThanOrEqual(1), { timeout: 30_000, interval: 100 });
      await drainHeartbeatRunsToQuiescence(db, heartbeat);
      return launchesOf(f.guestIssueId, f.guestId)[0]!;
    };
    // Answered during the pause: the guest is woken on its task for the lifted pause, with no card.
    const answered = await seed({ guestStatus: "paused" });
    const first = await postCard(answered, answered.guestIssueId);
    await new Promise((resolve) => setTimeout(resolve, 300));
    await db.update(issueThreadInteractions).set({ status: "accepted", resolvedAt: new Date() }).where(eq(issueThreadInteractions.id, first.id));
    const afterAnswer = await resume(answered);
    expect(afterAnswer.context).toMatchObject({ wakeReason: PAUSE_MISSED_WAKE_REASON, source: "agent.pause_lifted" });
    expect(afterAnswer.context.interactionId).toBeUndefined();
    expect(afterAnswer.context.interactionIssueId).toBeUndefined();
    // A card posted on the guest's own task, without the field: its lost wake is replayed as the lifted pause, as before.
    const ownTask = await seed({ guestStatus: "paused" });
    await postCard(ownTask, undefined, ownTask.guestIssueId);
    await new Promise((resolve) => setTimeout(resolve, 300));
    const asBefore = await resume(ownTask);
    expect(asBefore.context).toMatchObject({ wakeReason: PAUSE_MISSED_WAKE_REASON, source: "agent.pause_lifted" });
    expect(asBefore.context.interactionIssueId).toBeUndefined();
  });

  it("the gate of the blockers does not trust the context: a card answered, addressed to another, on another task, or a task of another agent, is held", async () => {
    // The card no longer waits.
    const answered = await seed({ blocked: true });
    const service = issueThreadInteractionService(db);
    const direct = (f: Fixture, addressee = f.guestId) =>
      service.create({ id: f.hostIssueId, companyId: f.companyId }, cardBody(addressee) as never, { agentId: f.hostId });
    const first = await direct(answered);
    await db.update(issueThreadInteractions).set({ status: "accepted", resolvedAt: new Date() }).where(eq(issueThreadInteractions.id, first.id));
    await wakeAs(answered, { interactionId: first.id, interactionIssueId: answered.hostIssueId }).catch(() => null);
    await held(answered);
    // The card is addressed to another agent.
    const elsewhere = await seed({ blocked: true });
    const second = await direct(elsewhere, elsewhere.thirdId);
    await wakeAs(elsewhere, { interactionId: second.id, interactionIssueId: elsewhere.hostIssueId }).catch(() => null);
    await held(elsewhere);
    // The context names a task the card is not on, or no task, or a card that does not exist.
    const wrongTask = await seed({ blocked: true });
    const third = await direct(wrongTask);
    await wakeAs(wrongTask, { interactionId: third.id, interactionIssueId: wrongTask.blockerId }).catch(() => null);
    await wakeAs(wrongTask, { interactionId: third.id }).catch(() => null);
    await wakeAs(wrongTask, { interactionId: randomUUID(), interactionIssueId: wrongTask.hostIssueId }).catch(() => null);
    await held(wrongTask);
    // The run's task is not the agent's: the guest woken on the third agent's blocked task.
    const notOwn = await seed({ blocked: true });
    await db.insert(issueRelations).values({ companyId: notOwn.companyId, issueId: notOwn.guestIssueId, relatedIssueId: notOwn.blockerId, type: "blocks" });
    await db.update(issues).set({ status: "blocked" }).where(eq(issues.id, notOwn.blockerId));
    const fourth = await direct(notOwn);
    await wakeAs(notOwn, { interactionId: fourth.id, interactionIssueId: notOwn.hostIssueId }, notOwn.blockerId).catch(() => null);
    await held(notOwn, notOwn.blockerId);
    // Control: the same wake, true in every part, starts.
    const genuine = await seed({ blocked: true });
    const fifth = await direct(genuine);
    await wakeAs(genuine, { interactionId: fifth.id, interactionIssueId: genuine.hostIssueId });
    expect((await wokenFor(genuine, fifth.id)).context).toMatchObject({ dependencyBlockedInteraction: true });
  });

  it("the verification itself: every part must be true in the database", async () => {
    const f = await seed({ blocked: true });
    const card = await issueThreadInteractionService(db).create({ id: f.hostIssueId, companyId: f.companyId }, cardBody(f.guestId) as never, { agentId: f.hostId });
    const context = { wakeReason: "interaction_pending", interactionId: card.id, interactionIssueId: f.hostIssueId };
    const verify = (patch: Record<string, unknown> = {}, who: { issueId?: string; agentId?: string; companyId?: string } = {}) =>
      verifyOwnIssueInteractionWake(db, { companyId: who.companyId ?? f.companyId, issueId: who.issueId ?? f.guestIssueId,
        agentId: who.agentId ?? f.guestId, contextSnapshot: { ...context, ...patch } });
    expect(await verify()).toBe(true);
    // The company's setting is read each time: turned off, the same wake no longer passes; turned on again, it does.
    const governance = (value: unknown) => db.update(companies).set({ interactionResolverGovernance: value as never }).where(eq(companies.id, f.companyId));
    for (const off of [{}, { [ADDRESSEE_WAKE_ON_BLOCKED_ISSUE_SETTING]: { enabled: false } }, { [ADDRESSEE_WAKE_ON_BLOCKED_ISSUE_SETTING]: { enabled: 1 } },
      { [ADDRESSEE_WAKE_ON_BLOCKED_ISSUE_SETTING]: true }, { unansweredAgentQuestion: { enabled: true } }]) {
      await governance(off);
      expect(await verify(), JSON.stringify(off)).toBe(false);
    }
    // What the run reads does not depend on the setting.
    expect(await ownIssueInteractionNote(db, { companyId: f.companyId, issueId: f.guestIssueId, agentId: f.guestId, contextSnapshot: context }))
      .toContain(`interaction ${card.id} on issue ${f.hostIdentifier}`);
    await governance({ [ADDRESSEE_WAKE_ON_BLOCKED_ISSUE_SETTING]: { enabled: true } });
    expect(await verify()).toBe(true);
    // A retry the server creates keeps the context and takes its own wake reason.
    expect(await verify({ wakeReason: "transient_failure_retry", retryOfRunId: randomUUID() })).toBe(true);
    expect(await verify({ wakeReason: "issue_commented" })).toBe(false);
    expect(await verify({ interactionIssueId: undefined })).toBe(false);
    expect(await verify({ interactionIssueId: f.guestIssueId })).toBe(false);
    expect(await verify({ interactionIssueId: f.blockerId })).toBe(false);
    expect(await verify({ interactionId: randomUUID() })).toBe(false);
    // A card that is on the run's own task is today's case: the ordinary gate, whatever the context says.
    const onOwnTask = await issueThreadInteractionService(db).create({ id: f.guestIssueId, companyId: f.companyId }, cardBody(f.guestId) as never, { agentId: f.hostId });
    expect(await verify({ interactionId: onOwnTask.id, interactionIssueId: f.guestIssueId })).toBe(false);
    // What the run reads names the card and its task, while the card waits.
    const note = () => ownIssueInteractionNote(db, { companyId: f.companyId, issueId: f.guestIssueId, agentId: f.guestId, contextSnapshot: context });
    expect(await note()).toContain(`interaction ${card.id} on issue ${f.hostIdentifier} (issue id ${f.hostIssueId})`);
    // Another agent, another task of the run, another company.
    expect(await verify({}, { agentId: f.thirdId })).toBe(false);
    expect(await verify({}, { issueId: f.blockerId })).toBe(false);
    expect(await verify({}, { companyId: randomUUID() })).toBe(false);
    // The run's task is given to another agent; then the card is answered.
    await db.update(issues).set({ assigneeAgentId: f.thirdId }).where(eq(issues.id, f.guestIssueId));
    expect(await verify()).toBe(false);
    await db.update(issues).set({ assigneeAgentId: f.guestId }).where(eq(issues.id, f.guestIssueId));
    expect(await verify()).toBe(true);
    await db.update(issueThreadInteractions).set({ status: "accepted", resolvedAt: new Date() }).where(eq(issueThreadInteractions.id, card.id));
    expect(await verify()).toBe(false);
    expect(await note()).toBe("");
  });

  it("at the start of the run: the card was answered while the wake waited, and the queued run is cancelled for the blocker", async () => {
    const f = await seed();
    // The guest is at work on another task of its own; the card's wake is admitted and waits behind that run.
    const busyIssueId = randomUUID();
    await db.insert(issues).values({ id: busyIssueId, companyId: f.companyId, title: "Other work of the guest", status: "todo", priority: "medium", assigneeAgentId: f.guestId });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    answers.set(busyIssueId, [async () => { await gate; return SUCCESS; }]);
    await heartbeat.wakeup(f.guestId, { source: "assignment", triggerDetail: "system", reason: "issue_assigned",
      payload: { issueId: busyIssueId, mutation: "update" }, requestedByActorType: "system", requestedByActorId: "test",
      contextSnapshot: { issueId: busyIssueId, taskId: busyIssueId, source: "issue.update" } });
    await vi.waitFor(() => expect(launchesOf(busyIssueId)).toHaveLength(1), { timeout: 30_000, interval: 100 });
    const card = await postCard(f, f.guestIssueId);
    await vi.waitFor(async () => expect((await runsOf(f, f.guestIssueId)).map((run) => run.status), await state(f)).toEqual(["queued"]), { timeout: 30_000, interval: 100 });
    // While it waits: the guest's task gets a blocker, and the card is answered.
    await db.insert(issueRelations).values({ companyId: f.companyId, issueId: f.blockerId, relatedIssueId: f.guestIssueId, type: "blocks" });
    await db.update(issues).set({ status: "blocked" }).where(eq(issues.id, f.guestIssueId));
    await db.update(issueThreadInteractions).set({ status: "accepted", resolvedAt: new Date() }).where(eq(issueThreadInteractions.id, card.id));
    release();
    await heartbeat.resumeQueuedRuns();
    await drainHeartbeatRunsToQuiescence(db, heartbeat);
    expect(launchesOf(f.guestIssueId), await state(f)).toHaveLength(0);
    expect((await runsOf(f, f.guestIssueId)).map((run) => [run.status, run.errorCode])).toEqual([["cancelled", "issue_dependencies_blocked"]]);
  });

  it("at the start of the run: the blocker came while the wake waited and the card still waits, the run starts in the bounded mode", async () => {
    const f = await seed();
    const busyIssueId = randomUUID();
    await db.insert(issues).values({ id: busyIssueId, companyId: f.companyId, title: "Other work of the guest", status: "todo", priority: "medium", assigneeAgentId: f.guestId });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    answers.set(busyIssueId, [async () => { await gate; return SUCCESS; }]);
    await heartbeat.wakeup(f.guestId, { source: "assignment", triggerDetail: "system", reason: "issue_assigned",
      payload: { issueId: busyIssueId, mutation: "update" }, requestedByActorType: "system", requestedByActorId: "test",
      contextSnapshot: { issueId: busyIssueId, taskId: busyIssueId, source: "issue.update" } });
    await vi.waitFor(() => expect(launchesOf(busyIssueId)).toHaveLength(1), { timeout: 30_000, interval: 100 });
    const card = await postCard(f, f.guestIssueId);
    await vi.waitFor(async () => expect((await runsOf(f, f.guestIssueId)).map((run) => run.status), await state(f)).toEqual(["queued"]), { timeout: 30_000, interval: 100 });
    await db.insert(issueRelations).values({ companyId: f.companyId, issueId: f.blockerId, relatedIssueId: f.guestIssueId, type: "blocks" });
    await db.update(issues).set({ status: "blocked" }).where(eq(issues.id, f.guestIssueId));
    release();
    const launch = await wokenFor(f, card.id);
    expect(launch.context).toMatchObject({ interactionId: card.id, interactionIssueId: f.hostIssueId, dependencyBlockedInteraction: true });
  });

  it("the run of such a wake fails on a lost link: the server's retry still starts on the blocked task", async () => {
    const f = await seed({ blocked: true });
    answers.set(f.guestIssueId, [async () => ({ exitCode: 1, signal: null, timedOut: false, errorCode: "router_provider_stop_unverified",
      errorMessage: "router provider stop unverified" })]);
    const card = await postCard(f, f.guestIssueId);
    await wokenFor(f, card.id);
    const [scheduled] = (await runsOf(f, f.guestIssueId)).filter((run) => run.status === "scheduled_retry");
    expect(scheduled, await state(f)).toBeDefined();
    expect(scheduled!.contextSnapshot).toMatchObject({ interactionId: card.id, interactionIssueId: f.hostIssueId });
    await db.update(heartbeatRuns).set({ scheduledRetryAt: new Date(Date.now() - 60_000) }).where(eq(heartbeatRuns.id, scheduled!.id));
    await heartbeat.promoteDueScheduledRetries();
    await heartbeat.resumeQueuedRuns();
    await vi.waitFor(async () => expect(launchesOf(f.guestIssueId, f.guestId).length, await state(f)).toBeGreaterThanOrEqual(2), { timeout: 30_000, interval: 100 });
    await drainHeartbeatRunsToQuiescence(db, heartbeat);
    expect(launchesOf(f.guestIssueId, f.guestId)[1]!.context).toMatchObject({ interactionId: card.id, interactionIssueId: f.hostIssueId, dependencyBlockedInteraction: true });
  });

  it("an agent's comment on the blocked task stays held while such a card waits", async () => {
    const f = await seed({ blocked: true });
    const card = await issueThreadInteractionService(db).create({ id: f.hostIssueId, companyId: f.companyId }, cardBody(f.guestId) as never, { agentId: f.hostId });
    const [comment] = await db.insert(issueComments).values({ companyId: f.companyId, issueId: f.guestIssueId, authorType: "agent", authorAgentId: f.hostId,
      body: "Lend me the machine." }).returning();
    await heartbeat.wakeup(f.guestId, { source: "automation", triggerDetail: "system", reason: "issue_commented",
      payload: { issueId: f.guestIssueId, commentId: comment!.id, mutation: "comment" }, requestedByActorType: "agent", requestedByActorId: f.hostId,
      contextSnapshot: { issueId: f.guestIssueId, taskId: f.guestIssueId, commentId: comment!.id, wakeCommentId: comment!.id,
        wakeReason: "issue_commented", source: "issue.comment" } }).catch(() => null);
    await held(f);
    expect(await cardOf(card.id)).toMatchObject({ status: "pending" });
  });
});
