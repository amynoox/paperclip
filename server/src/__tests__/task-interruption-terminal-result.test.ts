import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { agents, companies, createDb, applyPendingMigrations, heartbeatRuns, issues,
  EMBEDDED_POSTGRES_TEST_TIMEOUT_MS } from "@paperclipai/db";
import { taskInterruptionPresentations } from "../services/task-interruption-presentation.js";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { resolveExternalTestDatabaseUrl } from "./helpers/external-test-database.js";
import { captureInterruptionQuery } from "./helpers/task-interruption-fixture.js";

const externalDatabaseUrl = resolveExternalTestDatabaseUrl("PAPERCLIP_TASK_INTERRUPTION_TEST_DATABASE_URL");
const support = externalDatabaseUrl ? { supported: true } : await getEmbeddedPostgresTestSupport();
vi.mock("../sentry.js", () => ({ captureTaskInterruptionFailure: vi.fn() }));

// A run's result_json can carry the whole stdout (hundreds of kilobytes to megabytes). Every `->` on it decompresses
// the whole value, so the list projection must not read it for a task whose presentation does not use it.
describe.skipIf(!support.supported)("task interruption list: a finished task's run result is not read", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  beforeAll(async () => {
    if (externalDatabaseUrl) await applyPendingMigrations(externalDatabaseUrl);
    database = externalDatabaseUrl ? { connectionString: externalDatabaseUrl, cleanup: async () => {} }
      : await startEmbeddedPostgresTestDatabase("interruption-terminal-");
    db = createDb(database.connectionString);
  }, EMBEDDED_POSTGRES_TEST_TIMEOUT_MS);
  afterAll(async () => { await db?.$client.end(); await database?.cleanup(); });

  const providerFailure = { schema: "paperclip.provider-failure.v1", provider: "anthropic", phase: "startup",
    category: "overloaded", message: "Provider is overloaded.", httpStatus: 529, retryability: "transient" };
  const stdout = "x".repeat(600_000);

  async function seed() {
    const companyId = randomUUID(), agentId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Finished tasks", issuePrefix: `F${companyId.slice(0, 7)}` });
    await db.insert(agents).values({ id: agentId, companyId, name: "Worker", adapterType: "process" });
    const tasks = await db.insert(issues).values([
      { companyId, title: "Done task", status: "done", assigneeAgentId: agentId },
      { companyId, title: "Cancelled task", status: "cancelled", assigneeAgentId: agentId },
      { companyId, title: "Open task", status: "in_progress", assigneeAgentId: agentId },
    ]).returning();
    const runIds = tasks.map(() => randomUUID());
    await db.insert(heartbeatRuns).values(tasks.map((task, index) => ({ id: runIds[index]!, companyId, agentId,
      issueId: task.id, scopeKind: "issue", status: "failed", errorCode: "adapter_failed",
      finishedAt: new Date(), resultJson: { stdout, providerFailure, stopReason: "provider_failure" } })));
    return { companyId, tasks, runIds };
  }

  it("projects no run result for done and cancelled tasks, and keeps it for an open task", async () => {
    const { companyId, tasks, runIds } = await seed();
    const query = await captureInterruptionQuery(db, taskInterruptionPresentations, companyId, tasks);
    const rows = await db.$client.unsafe(query.sql, query.params as never[]);
    const byTask = new Map(rows.map(row => [row.issue_id ?? row.requested_issue_id, row]));
    const [done, cancelled, open] = tasks.map(task => byTask.get(task.id));
    expect(rows).toHaveLength(3);
    for (const row of [done, cancelled]) {
      expect(row).toBeDefined();
      expect(row.interruption_result_json).toBeNull();
    }
    expect(open.interruption_result_json).toMatchObject({ stopReason: "provider_failure", providerFailure: { httpStatus: 529 } });
    expect(open.interruption_result_json).not.toHaveProperty("stdout");
    expect(runIds).toHaveLength(3);
  });

  it("keeps the presentation of finished tasks and the provider failure of an open task", async () => {
    const { companyId, tasks, runIds } = await seed();
    const presentations = await taskInterruptionPresentations(db, companyId, tasks);
    for (const index of [0, 1]) {
      expect(presentations.get(tasks[index]!.id)).toMatchObject({ state: "resolved", canRetry: false,
        observedRunId: runIds[index], sourceRunIds: [runIds[index]] });
      expect(presentations.get(tasks[index]!.id)).not.toHaveProperty("providerFailure");
    }
    expect(presentations.get(tasks[2]!.id)).toMatchObject({ observedRunId: runIds[2],
      providerFailure: { httpStatus: 529, message: "Provider is overloaded." } });
    const [stored] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, runIds[0]!));
    expect((stored?.resultJson as { stdout?: string })?.stdout).toHaveLength(600_000);
  });
});
