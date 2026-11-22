// Runtime auth tests must not send the fixture credentials to a real provider.
vi.mock("../services/subscription-refresh.js", () => ({ refreshSubscriptionConnection: vi.fn().mockResolvedValue(undefined) }));
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { and, eq } from "drizzle-orm";
import express from "express";
import request from "supertest";
import { activityLog, agentWakeupRequests, agents, companies, companyMemberships, connectionGrants, createDb, heartbeatRuns,
  issueRecoveryActions, issueThreadInteractions, issues, toolConnections } from "@paperclipai/db";
import { startEmbeddedPostgresTestDatabase } from "@paperclipai/db/test-embedded-postgres";
import { aiConnectionService } from "../services/ai-connections.js";
import { prepareManagedAiRuntime } from "../services/ai-connection-runtime.js";
import { connectionIntentService } from "../services/connection-intents.js";
import { connectionIntentDeliveryService } from "../services/connection-intent-delivery.js";
import { connectionContinuationPendingResponse } from "../services/satisfied-connection-intents.js";
import { issueRecoveryActionService } from "../services/issue-recovery-actions.js";
import { DELIVERY_QUEUES, subscribeDeliveryWork } from "../services/delivery-work-notifications.js";
import { connectionIntentBoardRoutes } from "../routes/connection-intents.js";

// STUDIO-0090: production, 22 Nov 2026. The roles' shared AI account lost its sign-in from 09:09 to 09:12 UTC. Each
// task whose run failed on it got its own repair card. The owner signed in again and closed one card: that task
// started again. TR-2419 did not: its card stayed pending until a person's comment, ten minutes later.
let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
let db: ReturnType<typeof createDb>;
let home: string;
let service: ReturnType<typeof aiConnectionService>;
const binding = { provider: "openai", method: "api_key", mode: "responsible_user" } as const;

beforeAll(async () => {
  home = await realpath(await mkdtemp(path.join(os.tmpdir(), "paperclip-ai-repair-")));
  vi.stubEnv("PAPERCLIP_HOME", home);
  vi.stubEnv("PAPERCLIP_INSTANCE_ID", "ai-repair-card-fixture");
  database = await startEmbeddedPostgresTestDatabase("paperclip-ai-repair-db-");
  db = createDb(database.connectionString);
  service = aiConnectionService(db);
}, 90000);
afterAll(async () => { await database?.cleanup(); vi.unstubAllEnvs(); if (home) await rm(home, { recursive: true, force: true }); });

describe("the repair card of an AI account that works again", () => {
  type Scene = Awaited<ReturnType<typeof scene>>;
  /** A company, its owner, and one AI account its roles run on. */
  async function scene() {
    const companyId = randomUUID(), owner = `owner-${randomUUID()}`;
    await db.insert(companies).values({ id: companyId, name: "Shared account", issuePrefix: `S${companyId.slice(0, 6)}` });
    await db.insert(companyMemberships).values({ companyId, principalId: owner, principalType: "user", status: "active", membershipRole: "member" });
    const wakeup = vi.fn(async (agentId: string, opts: { idempotencyKey: string }) => {
      await db.insert(agentWakeupRequests).values({ companyId, agentId, source: "automation", status: "queued", idempotencyKey: opts.idempotencyKey });
      return null;
    });
    return { companyId, owner, wakeup, roles: [] as string[], account: null as null | Awaited<ReturnType<typeof service.save>> };
  }
  const accountInput = (s: Scene) => ({ provider: "openai" as const, method: "api_key" as const, ownership: "personal" as const,
    name: "Roles account", apiKey: "fixture", agentIds: s.roles, allAgents: false });
  /** A role on the account, with its task. */
  async function role(s: Scene, name: string, status = "in_progress") {
    const agentId = randomUUID(), issueId = randomUUID();
    await db.insert(agents).values({ id: agentId, companyId: s.companyId, name, adapterType: "codex_local", runtimeConfig: { aiConnection: binding } });
    await db.insert(issues).values({ id: issueId, companyId: s.companyId, title: `Task of ${name}`, status, assigneeAgentId: agentId });
    s.roles.push(agentId);
    return { agentId, issueId };
  }
  /** The one account all the roles of the scene run on; created once, after the roles. */
  async function account(s: Scene) {
    s.account = await service.save(s.companyId, s.owner, accountInput(s), "fixture-key-1");
  }
  type Role = Awaited<ReturnType<typeof role>>;
  /** A run of the role that the provider refused (`refresh_token_reused`): the account is marked, the task gets its card. */
  async function refusedByProvider(s: Scene, r: Role, extraContext: Record<string, unknown> = {}) {
    const runId = randomUUID();
    const runtime = await prepareManagedAiRuntime(db, { companyId: s.companyId, agentId: r.agentId, responsibleUserId: s.owner,
      adapterType: "codex_local", binding, config: {} });
    await db.insert(heartbeatRuns).values({ id: runId, companyId: s.companyId, agentId: r.agentId, status: "failed", errorCode: "refresh_token_reused",
      responsibleUserId: s.owner, finishedAt: new Date(),
      contextSnapshot: { issueId: r.issueId, aiConnection: { ...runtime.attribution, identity: runtime.identity }, ...extraContext } });
    await runtime.cleanup();
    return { runId, card: await cardOf(s, runId) };
  }
  /** A run of the role stopped before the engine because the account is marked (`configuration_incomplete`). */
  async function stoppedBeforeTheEngine(s: Scene, r: Role) {
    const runId = randomUUID();
    await db.insert(heartbeatRuns).values({ id: runId, companyId: s.companyId, agentId: r.agentId, status: "failed", errorCode: "configuration_incomplete",
      responsibleUserId: s.owner, finishedAt: new Date(), contextSnapshot: { issueId: r.issueId },
      resultJson: { configurationIncomplete: { reason: "ai_connection_unavailable", companyId: s.companyId, agentId: r.agentId,
        responsibleUserId: s.owner, connectionId: s.account!.connectionId } } });
    return { runId, card: await cardOf(s, runId) };
  }
  async function cardOf(s: Scene, runId: string) {
    const asked = await connectionIntentService(db).requestForRunAuthFailure(runId);
    expect(asked).toMatchObject({ state: "needs_user_action", service: "openai" });
    return asked!.interactionId!;
  }
  /** The owner signs in again: the product's own reconnection of the same account. */
  const reconnect = (s: Scene) => service.save(s.companyId, s.owner, { ...accountInput(s), connectionId: s.account!.connectionId }, "fixture-key-1");
  /** The owner closes one card, by the real route. */
  async function closeCard(s: Scene, cardId: string) {
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => { req.actor = { type: "board", source: "local_implicit", userId: s.owner, companyIds: [s.companyId] } as never; next(); });
    app.use("/api", connectionIntentBoardRoutes(db, { wakeup: s.wakeup } as never));
    const { errorHandler } = await import("../middleware/index.js");
    app.use(errorHandler);
    const response = await request(app).post(`/api/connection-intents/${cardId}/complete`).send({ connectionId: s.account!.connectionId });
    expect(response.status, JSON.stringify(response.body)).toBe(200);
  }
  /** What the connection queue runs: the reconciliation of pending cards, then the deliveries that are due. */
  const sweep = (s: Scene) => connectionIntentDeliveryService(db, { wakeup: s.wakeup } as never).sweepPending();
  const card = async (id: string) => (await db.select().from(issueThreadInteractions).where(eq(issueThreadInteractions.id, id)))[0];
  const task = async (id: string) => (await db.select().from(issues).where(eq(issues.id, id)))[0];
  const wakesFor = (s: Scene, agentId: string) => s.wakeup.mock.calls.filter(call => call[0] === agentId).map(call => call[1] as Record<string, any>);
  const grant = async (s: Scene) => (await db.select().from(connectionGrants).where(eq(connectionGrants.id, s.account!.grantId)))[0];
  /** The account looks usable again though nothing put it back in service after the failure. */
  async function healthyWithoutReconnection(s: Scene, updatedAt: Date) {
    await db.update(connectionGrants).set({ status: "active", updatedAt }).where(eq(connectionGrants.id, s.account!.grantId));
    await db.update(toolConnections).set({ healthStatus: "ok", healthMessage: null }).where(eq(toolConnections.id, s.account!.connectionId));
  }

  it("two roles on one account, one reconnection, one card closed by the person: the other task starts again by itself, once", async () => {
    const s = await scene();
    const first = await role(s, "CTO"), second = await role(s, "Feedback Manager");
    await account(s);
    const a = await refusedByProvider(s, first);
    expect((await grant(s)).status).toBe("needs_reauthorization");
    const b = await stoppedBeforeTheEngine(s, second);
    expect(b.card).not.toBe(a.card);
    // While the account is down, nothing is retired.
    await sweep(s);
    expect((await card(b.card)).status).toBe("pending");
    expect(s.wakeup).not.toHaveBeenCalled();

    await reconnect(s);
    await closeCard(s, a.card);
    expect(await card(a.card)).toMatchObject({ status: "accepted", resolvedByUserId: s.owner });
    expect(wakesFor(s, first.agentId).map(wake => wake.idempotencyKey)).toEqual([`connection-intent:${a.card}:accepted`]);
    expect(wakesFor(s, second.agentId)).toHaveLength(0);

    // The connection queue's own pass: the other card is retired by the system, and its task woken.
    for (let index = 0; index < 10; index += 1) await sweep(s);
    const retired = await card(b.card);
    // Retired, never accepted in the person's place.
    expect(retired).toMatchObject({ status: "expired", resolvedByUserId: null, resolvedByAgentId: null,
      result: { outcome: "expired", connectionId: s.account!.connectionId } });
    const wakes = wakesFor(s, second.agentId);
    expect(wakes.map(wake => wake.idempotencyKey)).toEqual([`connection-intent:${b.card}:expired`]);
    expect(wakes[0]).toMatchObject({ requestedByActorType: "system", requestedByActorId: "connection-reconciliation",
      payload: { issueId: second.issueId, interactionId: b.card, interactionKind: "connection_intent" },
      contextSnapshot: { issueId: second.issueId, source: "connection_intent.resolved", connectionIntentResolution: "existing_connection",
        responsibleUserId: s.owner, forceFreshSession: true } });
    expect(wakesFor(s, first.agentId)).toHaveLength(1);
    // The run that wake starts is not held by the card the system retired.
    expect(await connectionContinuationPendingResponse(db, await task(second.issueId), s.owner, null)).toBeNull();
    expect((await db.select().from(activityLog).where(and(eq(activityLog.companyId, s.companyId), eq(activityLog.entityId, second.issueId),
      eq(activityLog.action, "issue.thread_interaction_resolved")))).map(row => row.details)).toEqual([
      expect.objectContaining({ interactionId: b.card, status: "expired", resolutionSource: "existing_connection" })]);
  });

  it("without a reconnection nothing is retired, and a pending repair card still holds a continuation", async () => {
    const s = await scene();
    const r = await role(s, "CTO");
    await account(s);
    const failed = await refusedByProvider(s, r);
    for (let index = 0; index < 3; index += 1) await sweep(s);
    expect((await card(failed.card)).status).toBe("pending");
    expect(s.wakeup).not.toHaveBeenCalled();
    expect(await connectionContinuationPendingResponse(db, await task(r.issueId), s.owner, null)).toBe("interaction");
  });

  it("an account that looks healthy but was not put back in service after the failure: the card stays (no loop)", async () => {
    const s = await scene();
    const r = await role(s, "CTO");
    await account(s);
    const failed = await refusedByProvider(s, r);
    const [run] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, failed.runId));
    await healthyWithoutReconnection(s, new Date(run.finishedAt!.getTime() - 60_000));
    for (let index = 0; index < 3; index += 1) await sweep(s);
    expect((await card(failed.card)).status).toBe("pending");
    expect(s.wakeup).not.toHaveBeenCalled();
    // Still pending, it holds a continuation as any pending card does, though the account answers.
    expect(await connectionContinuationPendingResponse(db, await task(r.issueId), s.owner, null)).toBe("interaction");
    // The same account, put back in service after the failure: retired.
    await healthyWithoutReconnection(s, new Date(run.finishedAt!.getTime() + 60_000));
    await sweep(s);
    expect((await card(failed.card)).status).toBe("expired");
    expect(wakesFor(s, r.agentId)).toHaveLength(1);
  });

  it("a run the system restarted that fails again on the account keeps its card for the person: one automatic restart in a row", async () => {
    const s = await scene();
    const r = await role(s, "CTO");
    await account(s);
    const again = await refusedByProvider(s, r, { connectionIntentResolution: "existing_connection", source: "connection_intent.resolved" });
    await reconnect(s);
    for (let index = 0; index < 3; index += 1) await sweep(s);
    expect((await card(again.card)).status).toBe("pending");
    expect(s.wakeup).not.toHaveBeenCalled();
  });

  it.each([
    { label: "the task ran again since the failure", prepare: async (s: Scene, r: Role) => { await db.insert(heartbeatRuns).values({ companyId: s.companyId,
      agentId: r.agentId, status: "succeeded", responsibleUserId: s.owner, contextSnapshot: { issueId: r.issueId }, createdAt: new Date(Date.now() + 1000) }); } },
    { label: "a run of the task is alive", prepare: async (s: Scene, r: Role) => { await db.insert(heartbeatRuns).values({ companyId: s.companyId,
      agentId: r.agentId, status: "running", responsibleUserId: s.owner, contextSnapshot: { issueId: r.issueId }, createdAt: new Date(Date.now() + 1000) }); } },
    { label: "the task was given to another role", prepare: async (s: Scene, r: Role) => {
      const other = randomUUID();
      await db.insert(agents).values({ id: other, companyId: s.companyId, name: "Other role", adapterType: "codex_local" });
      await db.update(issues).set({ assigneeAgentId: other }).where(eq(issues.id, r.issueId)); } },
    { label: "the task is held by a person", prepare: async (s: Scene, r: Role) => {
      await db.update(issues).set({ assigneeUserId: s.owner }).where(eq(issues.id, r.issueId)); } },
    { label: "the task is done", prepare: async (s: Scene, r: Role) => { await db.update(issues).set({ status: "done" }).where(eq(issues.id, r.issueId)); } },
    { label: "the person addressed left the company", prepare: async (s: Scene) => { await db.update(companyMemberships).set({ status: "inactive" })
      .where(and(eq(companyMemberships.companyId, s.companyId), eq(companyMemberships.principalId, s.owner))); } },
    { label: "the person addressed is now only a viewer", prepare: async (s: Scene) => { await db.update(companyMemberships).set({ membershipRole: "viewer" })
      .where(and(eq(companyMemberships.companyId, s.companyId), eq(companyMemberships.principalId, s.owner))); } },
    { label: "the card's run did not fail on the account", prepare: async (s: Scene, r: Role) => { await db.update(heartbeatRuns).set({ errorCode: "process_lost" })
      .where(and(eq(heartbeatRuns.companyId, s.companyId), eq(heartbeatRuns.agentId, r.agentId))); } },
    { label: "the card's run did not fail", prepare: async (s: Scene, r: Role) => { await db.update(heartbeatRuns).set({ status: "succeeded", errorCode: null })
      .where(and(eq(heartbeatRuns.companyId, s.companyId), eq(heartbeatRuns.agentId, r.agentId))); } },
  ])("after the reconnection, the card is left alone when $label", async ({ prepare }) => {
    const s = await scene();
    const r = await role(s, "CTO");
    await account(s);
    const failed = await refusedByProvider(s, r);
    await reconnect(s);
    await prepare(s, r);
    for (let index = 0; index < 3; index += 1) await sweep(s);
    expect((await card(failed.card)).status).toBe("pending");
    expect(s.wakeup).not.toHaveBeenCalled();
  });

  it("a card the person declined is not touched", async () => {
    const s = await scene();
    const r = await role(s, "CTO");
    await account(s);
    const failed = await refusedByProvider(s, r);
    await connectionIntentService(db).decline(failed.card, s.owner, "Not now");
    await reconnect(s);
    for (let index = 0; index < 3; index += 1) await sweep(s);
    expect((await card(failed.card)).status).toBe("rejected");
    expect(wakesFor(s, r.agentId).filter(wake => String(wake.idempotencyKey).endsWith(":expired"))).toHaveLength(0);
  });

  it.each([
    { label: "an agent's setup card", extra: { agentSetup: true } },
    { label: "an access request", extra: { accessRequest: { connectionId: randomUUID(), connectionName: "Account",
      tools: [{ catalogEntryId: randomUUID(), toolName: "read", versionHash: "v1", permission: "allowed" }] } } },
    { label: "a card through an upstream app", extra: { upstreamService: { slug: "upstream", name: "Upstream" } } },
  ])("$label of the same account is not touched", async ({ extra }) => {
    const s = await scene();
    const r = await role(s, "CTO");
    await account(s);
    const failed = await refusedByProvider(s, r);
    const [plain] = await db.select().from(issueThreadInteractions).where(eq(issueThreadInteractions.id, failed.card));
    await db.update(issueThreadInteractions).set({ payload: { ...(plain.payload as object), ...extra } as never }).where(eq(issueThreadInteractions.id, failed.card));
    await reconnect(s);
    for (let index = 0; index < 3; index += 1) await sweep(s);
    expect((await card(failed.card)).status).toBe("pending");
    expect(s.wakeup).not.toHaveBeenCalled();
  });

  it("nothing passes from one company to another", async () => {
    const here = await scene(), there = await scene();
    const mine = await role(here, "CTO"), theirs = await role(there, "CTO");
    await account(here); await account(there);
    const a = await refusedByProvider(here, mine), b = await refusedByProvider(there, theirs);
    await reconnect(here);
    for (let index = 0; index < 3; index += 1) await sweep(here);
    expect((await card(a.card)).status).toBe("expired");
    expect((await card(b.card)).status).toBe("pending");
    expect((await grant(there)).status).toBe("needs_reauthorization");
    expect(there.wakeup).not.toHaveBeenCalled();
    expect(wakesFor(here, theirs.agentId)).toHaveLength(0);
  });

  /** The account's failure blocked the task, with the Board's recovery action on that run. */
  async function blockedByTheAccount(s: Scene, r: Role, runId: string) {
    await db.update(issues).set({ status: "blocked" }).where(eq(issues.id, r.issueId));
    await issueRecoveryActionService(db).upsertSourceScoped({ companyId: s.companyId, sourceIssueId: r.issueId,
      kind: "configuration_validation", cause: "configuration_incomplete", fingerprint: `account:${r.issueId}`,
      nextAction: "Connect your AI account", ownerType: "board", evidence: { latestRunId: runId } });
  }

  it("a task the account's failure blocked is reopened and woken once, in nobody's name", async () => {
    const s = await scene();
    const first = await role(s, "CTO"), second = await role(s, "Infra Manager");
    await account(s);
    await refusedByProvider(s, first);
    const stopped = await stoppedBeforeTheEngine(s, second);
    await blockedByTheAccount(s, second, stopped.runId);
    await sweep(s);
    expect((await card(stopped.card)).status).toBe("pending");
    await reconnect(s);
    for (let index = 0; index < 5; index += 1) await sweep(s);
    expect(await card(stopped.card)).toMatchObject({ status: "expired", resolvedByUserId: null });
    expect((await task(second.issueId)).status).toBe("in_progress");
    expect(wakesFor(s, second.agentId).map(wake => wake.idempotencyKey)).toEqual([`connection-intent:${stopped.card}:expired`]);
    const [action] = await db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.sourceIssueId, second.issueId));
    expect(action).toMatchObject({ status: "resolved", outcome: "restored" });
    const reopened = (await db.select().from(activityLog).where(and(eq(activityLog.companyId, s.companyId), eq(activityLog.entityId, second.issueId),
      eq(activityLog.action, "issue.updated")))).filter(row => (row.details as { source?: string }).source === "ai_connection_restored");
    expect(reopened).toEqual([expect.objectContaining({ actorType: "system", actorId: "connection-reconciliation" })]);
  });

  it.each([
    { label: "blocked for another reason (no recovery action of the account)", prepare: async (s: Scene, r: Role) => {
      await db.update(issues).set({ status: "blocked" }).where(eq(issues.id, r.issueId)); } },
    { label: "blocked by a recovery action on another run", prepare: async (s: Scene, r: Role) => { await blockedByTheAccount(s, r, randomUUID()); } },
  ])("a task $label keeps its card and stays blocked", async ({ prepare }) => {
    const s = await scene();
    const first = await role(s, "CTO"), second = await role(s, "Infra Manager");
    await account(s);
    await refusedByProvider(s, first);
    const stopped = await stoppedBeforeTheEngine(s, second);
    await prepare(s, second);
    await reconnect(s);
    for (let index = 0; index < 3; index += 1) await sweep(s);
    expect((await card(stopped.card)).status).toBe("pending");
    expect((await task(second.issueId)).status).toBe("blocked");
    expect(wakesFor(s, second.agentId)).toHaveLength(0);
  });

  it("a reconnection has the connection queue read the waiting cards at once", async () => {
    const s = await scene();
    const r = await role(s, "CTO");
    await account(s);
    await refusedByProvider(s, r);
    const signal = vi.fn();
    const unsubscribe = subscribeDeliveryWork(db, DELIVERY_QUEUES.connection, signal);
    try {
      await reconnect(s);
      await expect.poll(() => signal.mock.calls.length, { timeout: 10_000 }).toBeGreaterThan(0);
    } finally { unsubscribe(); }
  });
});
