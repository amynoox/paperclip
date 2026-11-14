import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { agentWakeupRequests, agents, companies, createDb, issueThreadInteractions, issues, EMBEDDED_POSTGRES_TEST_TIMEOUT_MS } from "@paperclipai/db";
import { startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { heartbeatService } from "../services/heartbeat.js";
import { issueThreadInteractionService } from "../services/issue-thread-interactions.js";
import { buildHostServices } from "../services/plugin-host-services.js";
import { createLifecycleDriver } from "../services/agent-lifecycle-driver.js";
import { PAUSE_MISSED_WAKE_REASON } from "../services/pause-missed-wakes.js";

// STUDIO-0038: production, 14 Nov 2026, TR-710. The worker router created a
// confirmation card addressed to the Quality Manager while it was paused; the
// server refused it ("addresseeAgentId must reference an invokable agent"),
// the router kept the notice queued, and nothing could be published until the
// agent was resumed for a moment. A paused addressee is now accepted: its wake
// is refused during the pause and replayed when the pause lifts (STUDIO-0028).
describe("card addressed to a paused agent", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  beforeAll(async () => {
    database = await startEmbeddedPostgresTestDatabase("paused-addressee-card-");
    db = createDb(database.connectionString);
  }, EMBEDDED_POSTGRES_TEST_TIMEOUT_MS);
  afterAll(async () => {
    await heartbeatService(db).drainActiveRunExecutions?.();
    await db?.$client.end();
    await database?.cleanup();
  });

  async function seed(qualityStatus = "paused", qualityReportsTo: string | null = null) {
    const companyId = randomUUID(), executor = randomUUID(), quality = randomUUID(), issueId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Router cards", defaultResponsibleUserId: "board", issuePrefix: `B${companyId.slice(0, 6)}` });
    await db.insert(agents).values({ id: executor, companyId, name: "Executor", adapterType: "process", status: "idle", permissions: {} });
    if (qualityReportsTo) {
      await db.insert(agents).values({ id: qualityReportsTo, companyId, name: "Manager", adapterType: "process", status: "terminated", permissions: {} });
    }
    await db.insert(agents).values({ id: quality, companyId, name: "Quality Manager", adapterType: "process", status: qualityStatus,
      reportsTo: qualityReportsTo, permissions: {} });
    await db.insert(issues).values({ id: issueId, companyId, title: "Routed task", status: "in_progress", assigneeAgentId: executor });
    return { companyId, executor, quality, issueId };
  }

  function card(addresseeAgentId: string) {
    return {
      kind: "request_confirmation" as const,
      addresseeAgentId,
      resolverPolicy: "anyone" as const,
      idempotencyKey: `review/${randomUUID()}`,
      title: "Review the delivery",
      payload: { version: 1 as const, prompt: "The executor delivered. Confirm the review." },
    };
  }

  // The wake the issue interaction route sends right after creating the card.
  async function routeWake(f: { issueId: string }, interactionId: string, addressee: string, actor: { type: "agent" | "user"; id: string }) {
    await heartbeatService(db).wakeup(addressee, {
      source: "automation", triggerDetail: "system", reason: "interaction_pending",
      payload: { issueId: f.issueId, interactionId, interactionKind: "request_confirmation", mutation: "interaction" },
      idempotencyKey: `interaction-pending:${interactionId}`,
      requestedByActorType: actor.type, requestedByActorId: actor.id,
      contextSnapshot: { issueId: f.issueId, taskId: f.issueId, interactionId, interactionKind: "request_confirmation",
        wakeReason: "interaction_pending", source: "issue.interaction.created" },
    }).catch(() => null);
  }

  async function wakesOf(f: { companyId: string }, agentId: string) {
    return db.select().from(agentWakeupRequests).where(and(eq(agentWakeupRequests.companyId, f.companyId),
      eq(agentWakeupRequests.agentId, agentId)));
  }

  async function resume(agentId: string) {
    await db.update(agents).set({ status: "idle" }).where(eq(agents.id, agentId));
    const [agent] = await db.select().from(agents).where(eq(agents.id, agentId));
    await createLifecycleDriver(db, {} as never).onReady(agent as never);
  }

  async function replayed(f: { companyId: string }, agentId: string) {
    return (await wakesOf(f, agentId)).filter(w => w.reason === PAUSE_MISSED_WAKE_REASON);
  }

  // The replayed wake must reach the addressee on a task it does not own: not
  // skipped, and not cancelled by dispatch as "issue assignee changed".
  async function expectDelivered(f: { companyId: string }, agentId: string) {
    await new Promise(resolve => setTimeout(resolve, 500));
    const wakes = await replayed(f, agentId);
    expect(wakes).toHaveLength(1);
    expect(wakes[0].status).not.toBe("skipped");
    expect(wakes[0].error ?? "").not.toContain("assignee changed");
    return wakes[0];
  }

  it("accepts a card from an agent, records the refused wake as skipped, and replays it with the card on resume", async () => {
    const f = await seed();
    const created = await issueThreadInteractionService(db).create({ id: f.issueId, companyId: f.companyId }, card(f.quality),
      { agentId: f.executor });
    expect(created).toMatchObject({ status: "pending", addresseeAgentId: f.quality });
    await routeWake(f, created.id, f.quality, { type: "agent", id: f.executor });
    const refused = await wakesOf(f, f.quality);
    expect(refused).toEqual([expect.objectContaining({ status: "skipped", reason: "agent.not_invokable",
      payload: expect.objectContaining({ interactionId: created.id }) })]);

    await resume(f.quality);
    await resume(f.quality);
    const wake = await expectDelivered(f, f.quality);
    expect(wake.payload).toMatchObject({ issueId: f.issueId, interactionId: created.id, missedWakeRequestId: refused[0].id });
    expect(wake.idempotencyKey).toBe(`pause-missed:${f.quality}:${f.issueId}:${refused[0].id}`);
  });

  it("accepts a card from a person, whose refused wake leaves no row, and still replays it with the card on resume", async () => {
    const f = await seed();
    const created = await issueThreadInteractionService(db).create({ id: f.issueId, companyId: f.companyId }, card(f.quality),
      { userId: "board" });
    expect(created).toMatchObject({ status: "pending", addresseeAgentId: f.quality });
    await routeWake(f, created.id, f.quality, { type: "user", id: "board" });
    expect(await wakesOf(f, f.quality)).toHaveLength(0);

    await resume(f.quality);
    await resume(f.quality);
    const wake = await expectDelivered(f, f.quality);
    expect(wake.payload).toMatchObject({ issueId: f.issueId, interactionId: created.id, missedWakeRequestId: null });
    expect(wake.idempotencyKey).toBe(`pause-missed:${f.quality}:${f.issueId}:${created.id}`);
  });

  it("accepts a plugin-created card for a paused addressee and wakes it with the card on resume", async () => {
    const f = await seed();
    const host = buildHostServices(db, "worker-router-test", "worker-router-test", {
      forPlugin: () => ({ emit: vi.fn(), subscribe: vi.fn(), clear: vi.fn() }),
    } as any);
    try {
      const created = await host.issues.createInteraction({ companyId: f.companyId, issueId: f.issueId, interaction: card(f.quality) } as any);
      expect(created).toMatchObject({ status: "pending", addresseeAgentId: f.quality });
      await new Promise(resolve => setTimeout(resolve, 300));
      await resume(f.quality);
      const wake = await expectDelivered(f, f.quality);
      expect(wake.payload).toMatchObject({ issueId: f.issueId, interactionId: created.id });
    } finally { host.dispose(); }
  });

  it("does not replay a card answered before the resume", async () => {
    const f = await seed();
    const created = await issueThreadInteractionService(db).create({ id: f.issueId, companyId: f.companyId }, card(f.quality),
      { userId: "board" });
    await db.update(issueThreadInteractions).set({ status: "accepted", resolvedAt: new Date() }).where(eq(issueThreadInteractions.id, created.id));
    await resume(f.quality);
    expect(await replayed(f, f.quality)).toHaveLength(0);
  });

  it.each(["terminated", "pending_approval"])("still refuses a %s addressee", async (status) => {
    const f = await seed(status);
    await expect(issueThreadInteractionService(db).create({ id: f.issueId, companyId: f.companyId }, card(f.quality),
      { agentId: f.executor })).rejects.toMatchObject({ status: 422, message: expect.stringContaining("invokable agent"),
      details: expect.objectContaining({ reason: status }) });
  });

  it("still refuses a paused addressee whose manager is terminated", async () => {
    const f = await seed("paused", randomUUID());
    await expect(issueThreadInteractionService(db).create({ id: f.issueId, companyId: f.companyId }, card(f.quality),
      { agentId: f.executor })).rejects.toMatchObject({ status: 422, details: expect.objectContaining({ reason: "manager_terminated" }) });
  });

  it("still refuses an addressee that is missing or in another company", async () => {
    const f = await seed();
    const other = await seed("idle");
    for (const addressee of [randomUUID(), other.quality]) {
      await expect(issueThreadInteractionService(db).create({ id: f.issueId, companyId: f.companyId }, card(addressee),
        { agentId: f.executor })).rejects.toMatchObject({ status: 422, message: expect.stringContaining("same company") });
    }
  });
});
