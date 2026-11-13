import { randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { agentWakeupRequests, agents, companies, createDb, issues, EMBEDDED_POSTGRES_TEST_TIMEOUT_MS } from "@paperclipai/db";
import { startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { buildHostServices } from "../services/plugin-host-services.js";

// STUDIO-0026: production, 13 Nov 2026, TR-702. The Worker Router created an
// "Executor run interrupted" confirmation card addressed to the CTO (not the
// issue assignee) at 23:30:30 UTC; no wake was ever recorded for the CTO, so
// the card waited unseen. A card created through the issue route wakes its
// addressee; the same card created by a plugin must do the same.
describe("plugin-created interaction addressee wake", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  beforeAll(async () => {
    database = await startEmbeddedPostgresTestDatabase("plugin-interaction-addressee-wake-");
    db = createDb(database.connectionString);
  }, EMBEDDED_POSTGRES_TEST_TIMEOUT_MS);
  afterAll(async () => { await db?.$client.end(); await database?.cleanup(); });

  async function seed() {
    const companyId = randomUUID(), executor = randomUUID(), manager = randomUUID(), issueId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Router cards", issuePrefix: `R${companyId.slice(0, 6)}` });
    await db.insert(agents).values([
      { id: executor, companyId, name: "Executor", adapterType: "process", status: "idle", permissions: {} },
      { id: manager, companyId, name: "Manager", adapterType: "process", status: "paused", permissions: {} },
    ]);
    await db.insert(issues).values({ id: issueId, companyId, title: "Routed task", status: "in_progress", assigneeAgentId: executor });
    return { companyId, executor, manager, issueId };
  }

  function services() {
    return buildHostServices(db, "worker-router-test", "worker-router-test", {
      forPlugin: () => ({ emit: vi.fn(), subscribe: vi.fn(), clear: vi.fn() }),
    } as any);
  }

  async function addresseeWakes(companyId: string, agentId: string) {
    return db.select().from(agentWakeupRequests).where(and(eq(agentWakeupRequests.companyId, companyId),
      eq(agentWakeupRequests.agentId, agentId), eq(agentWakeupRequests.reason, "interaction_pending")));
  }

  it("records an interaction_pending wake for the addressee of a plugin-created confirmation card", async () => {
    const f = await seed();
    const host = services();
    try {
      const card = await host.issues.createInteraction({
        companyId: f.companyId,
        issueId: f.issueId,
        interaction: {
          kind: "request_confirmation",
          addresseeAgentId: f.manager,
          resolverPolicy: "anyone",
          idempotencyKey: `interruption/${randomUUID()}/${randomUUID()}`,
          title: "Executor run interrupted",
          payload: { version: 1, prompt: "The executor was interrupted. Keep the current reservation or organize verification." },
        },
      } as any);
      expect(card.addresseeAgentId).toBe(f.manager);
      await expect.poll(async () => (await addresseeWakes(f.companyId, f.manager)).length, { timeout: 10_000 }).toBe(1);
      const [wake] = await addresseeWakes(f.companyId, f.manager);
      expect(wake.idempotencyKey).toBe(`interaction-pending:${card.id}`);
      expect(wake.payload).toMatchObject({ issueId: f.issueId, interactionId: card.id, interactionKind: "request_confirmation" });
      expect(await addresseeWakes(f.companyId, f.executor)).toHaveLength(0);
    } finally { host.dispose(); }
  });

  it("does not wake anyone for a plugin-created card without an agent addressee", async () => {
    const f = await seed();
    const host = services();
    try {
      await host.issues.createInteraction({
        companyId: f.companyId,
        issueId: f.issueId,
        interaction: {
          kind: "request_confirmation",
          resolverPolicy: "anyone",
          idempotencyKey: `plain/${randomUUID()}`,
          title: "Plain card",
          payload: { version: 1, prompt: "No addressee." },
        },
      } as any);
      await new Promise((resolve) => setTimeout(resolve, 300));
      const wakes = await db.select().from(agentWakeupRequests).where(and(eq(agentWakeupRequests.companyId, f.companyId),
        sql`${agentWakeupRequests.reason} = 'interaction_pending'`));
      expect(wakes).toHaveLength(0);
    } finally { host.dispose(); }
  });
});
