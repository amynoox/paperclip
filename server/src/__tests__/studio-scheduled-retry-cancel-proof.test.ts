import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { agents, companies, createDb, heartbeatRuns, issues } from "@paperclipai/db";
import { startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { heartbeatService } from "../services/heartbeat.js";
import { legacyExecutionNeedsReconciliation } from "../services/legacy-execution-recovery.js";

// STUDIO-0016: Stop on a legacy scheduled retry that never started must record
// the same "no provider work" proof as Stop on a queued run, so the task does
// not keep a no-replay reconciliation hold for a run that never ran.
describe("STUDIO-0016: Stop on a never-started scheduled retry", () => {
  let temporary: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  beforeAll(async () => {
    temporary = await startEmbeddedPostgresTestDatabase("studio-0016-");
    db = createDb(temporary.connectionString);
  });
  afterAll(async () => { await temporary?.cleanup(); });

  async function scheduledRetry(patch: Partial<typeof heartbeatRuns.$inferInsert> = {}) {
    const companyId = randomUUID(), agentId = randomUUID(), issueId = randomUUID(), runId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Studio", issuePrefix: `S${companyId.slice(0, 6)}` });
    await db.insert(agents).values({ id: agentId, companyId, name: "Infra", role: "engineer", status: "idle", adapterType: "process",
      runtimeConfig: { heartbeat: { wakeOnDemand: true } } });
    await db.insert(issues).values({ id: issueId, companyId, title: "Repair", status: "todo", assigneeAgentId: agentId });
    await db.insert(heartbeatRuns).values({ id: runId, companyId, agentId, status: "scheduled_retry", runtimeMode: "legacy",
      invocationSource: "automation", contextSnapshot: { issueId, wakeReason: "provider_limit_retry" },
      scheduledRetryAt: new Date(Date.now() + 30 * 60_000), scheduledRetryAttempt: 1, scheduledRetryReason: "ai_connection_pool_wait",
      ...patch });
    return { runId };
  }

  it("records bootstrap proof, so the cancelled retry needs no reconciliation", async () => {
    const { runId } = await scheduledRetry();
    await heartbeatService(db).cancelRun(runId, "Cancelled by a board operator", { resultJson: { cancelledByActorType: "user" } });
    const [run] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, runId));
    expect(run).toMatchObject({ status: "cancelled", startedAt: null,
      resultJson: { executionRecovery: { kind: "bootstrap", providerWorkStarted: false } } });
    expect(legacyExecutionNeedsReconciliation(run!)).toBe(false);
  });

  it("keeps the ordinary cancellation when the run had started", async () => {
    const { runId } = await scheduledRetry({ startedAt: new Date(Date.now() - 60_000) });
    await heartbeatService(db).cancelRun(runId, "Cancelled by a board operator", { resultJson: { cancelledByActorType: "user" } });
    const [run] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, runId));
    expect(run?.status).toBe("cancelled");
    expect((run?.resultJson as Record<string, unknown> | null)?.executionRecovery).toBeUndefined();
  });
});
