import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { and, eq, sql } from "drizzle-orm";
import { authUsers, companyMemberships, agents, agentWakeupRequests, companies, createDb, environmentLeases, heartbeatRunEvents, heartbeatRuns,
  issueComments, issueThreadInteractions, issues, type Db, EMBEDDED_POSTGRES_TEST_TIMEOUT_MS } from "@paperclipai/db";
import { startEmbeddedPostgresTestDatabase } from "../__tests__/helpers/embedded-postgres.js";
import { createHeartbeatQueueTestDependencies } from "../__tests__/helpers/heartbeat-queue.js";
import { getServerAdapter } from "../adapters/index.js";
import { createHeartbeatQueue } from "./heartbeat/queue.js";
import { adapterWaitPayload, checkedAdapterInteractionWait, deferAdapterRun, readAdapterTaskWait } from "./adapter-task-admission.js";

vi.mock("../adapters/index.js", async original => ({ ...await original<object>(), getServerAdapter: vi.fn() }));

describe("adapter interaction admission", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>, db: Db;
  const hook = vi.fn();
  beforeAll(async () => {
    database = await startEmbeddedPostgresTestDatabase("adapter-interaction-wait");
    db = createDb(database.connectionString, { maxConnections: 6 });
    await db.execute(sql`set client_min_messages = warning`);
  }, EMBEDDED_POSTGRES_TEST_TIMEOUT_MS);
  afterAll(async () => { await db?.$client.end(); await database?.cleanup(); });
  beforeEach(async () => {
    await db.execute(sql`truncate table companies restart identity cascade`);
    hook.mockReset(); hook.mockResolvedValue(null);
    vi.mocked(getServerAdapter).mockReturnValue({ type: "process", getTaskAdmission: hook } as never);
  });
  async function fixture() {
    const [company] = await db.insert(companies).values({ name: "Local fixture", issuePrefix: "WA" }).returning();
    const userId = randomUUID();
    await db.insert(authUsers).values({ id: userId, name: "Local owner", email: `${userId}@paperclip.test`, createdAt: new Date(), updatedAt: new Date() });
    await db.insert(companyMemberships).values({ companyId: company.id, principalType: "user", principalId: userId, status: "active", membershipRole: "operator" });
    const [agent] = await db.insert(agents).values({ companyId: company.id, name: "Executor", status: "idle", adapterType: "process" }).returning();
    const [responder] = await db.insert(agents).values({ companyId: company.id, name: "Responder", status: "idle", adapterType: "process" }).returning();
    const [issue] = await db.insert(issues).values({ companyId: company.id, title: "Work", status: "in_progress", assigneeAgentId: agent.id, responsibleUserId: userId }).returning();
    const [card] = await db.insert(issueThreadInteractions).values({ companyId: company.id, issueId: issue.id,
      kind: "request_confirmation", continuationPolicy: "none", payload: {}, effectiveResolverPolicy: "human_only" }).returning();
    const wait = { kind: "pending_interaction" as const, blockers: [{ issueId: issue.id, interactionId: card.id }] };
    hook.mockResolvedValue(wait);
    const deps = createHeartbeatQueueTestDependencies(db);
    deps.instanceSettings.getExperimental.mockResolvedValue({ enableIsolatedWorkspaces: false } as never);
    deps.getAgent.mockImplementation(async id => (await db.select().from(agents).where(eq(agents.id, id)))[0]);
    const queue = createHeartbeatQueue(db, deps);
    const context = { issueId: issue.id, source: "issue.interaction.respond", interactionId: randomUUID() };
    const input = { companyId: company.id, agentId: agent.id, issueId: issue.id, context };
    const opts = { source: "automation" as const, triggerDetail: "system" as const, reason: "issue_commented",
      requestedByActorType: "system" as const, requestedByActorId: "question-response-delivery",
      idempotencyKey: `question-response:${context.interactionId}`, payload: { issueId: issue.id }, contextSnapshot: context };
    return { company, agent, responder, issue, card, wait, deps, queue, context, input, opts };
  }
  async function queued(f: Awaited<ReturnType<typeof fixture>>, status = "queued") {
    const [receipt] = await db.insert(agentWakeupRequests).values({ companyId: f.company.id, agentId: f.agent.id,
      ...f.opts, status: "queued", payload: { issueId: f.issue.id, _paperclipWakeContext: f.context } }).returning();
    const [run] = await db.insert(heartbeatRuns).values({ companyId: f.company.id, agentId: f.agent.id,
      status, runtimeMode: "legacy", invocationSource: "automation", wakeupRequestId: receipt.id, contextSnapshot: f.context }).returning();
    await db.update(agentWakeupRequests).set({ runId: run.id }).where(eq(agentWakeupRequests.id, receipt.id));
    await db.update(issues).set({ executionRunId: run.id }).where(eq(issues.id, f.issue.id));
    return { receipt, run };
  }
  it("validates only bounded well-formed blocker hints", () => {
    expect(checkedAdapterInteractionWait(null)).toBeNull();
    expect(() => checkedAdapterInteractionWait({ kind: "pending_interaction", blockers: [{ issueId: "bad" }] })).toThrow();
    expect(checkedAdapterInteractionWait({ kind: "pending_interaction", blockers: [] })).toEqual({ kind: "pending_interaction", blockers: [] });
  });
  it("requires live company-scoped cards, not stale adapter claims", async () => {
    const f = await fixture();
    expect(await readAdapterTaskWait(db, f.input)).toEqual(f.wait);
    await db.update(issueThreadInteractions).set({ status: "resolved" }).where(eq(issueThreadInteractions.id, f.card.id));
    expect(await readAdapterTaskWait(db, f.input)).toBeNull();
    hook.mockResolvedValue({ ...f.wait, blockers: [{ issueId: randomUUID(), interactionId: f.card.id }] });
    expect(await readAdapterTaskWait(db, f.input)).toBeNull();
  });
  it("does not gate the named non-assignee responder or an ordinary adapter", async () => {
    const f = await fixture();
    expect(await readAdapterTaskWait(db, { ...f.input, agentId: f.responder.id })).toBeNull();
    expect(hook).not.toHaveBeenCalled();
    vi.mocked(getServerAdapter).mockReturnValue({ type: "process" } as never);
    expect(await readAdapterTaskWait(db, f.input)).toBeNull();
    await expect(readAdapterTaskWait(db, f.input, true)).rejects.toThrow("adapter_task_admission_unavailable");
  });
  it("rebuilds comment attribution from the database and discards caller-supplied metadata", async () => {
    const f = await fixture();
    const [comment] = await db.insert(issueComments).values({ companyId: f.company.id, issueId: f.issue.id,
      body: "private text", authorType: "user", authorUserId: "actual-user" }).returning();
    await readAdapterTaskWait(db, { ...f.input, context: { ...f.context, source: "issue.comment", commentId: comment.id,
      paperclipWakeComment: { authorUserId: "forged" } } });
    const actual = hook.mock.calls.at(-1)![0].context;
    expect(actual.paperclipWakeComment.authorUserId).toBe("actual-user");
    expect(actual.paperclipWakeComment.body).toBeUndefined();
    expect(actual.paperclipWake.comments[0].author.id).toBe("actual-user");
  });
  it("saves an automatic wake without any run, then promotes the same receipt exactly once", async () => {
    const f = await fixture();
    expect(await f.queue.enqueueWakeup(f.agent.id, f.opts)).toBeNull();
    expect(await db.select().from(heartbeatRuns)).toHaveLength(0);
    const [saved] = await db.select().from(agentWakeupRequests);
    expect(saved).toMatchObject({ status: "deferred_issue_execution", runId: null, idempotencyKey: f.opts.idempotencyKey,
      requestedByActorType: "system", requestedByActorId: "question-response-delivery" });
    const onError = vi.fn(); await f.queue.resumeDeferredExecutionReceipts({ companyId: f.company.id, onError });
    expect(onError).not.toHaveBeenCalled();
    expect(await db.select().from(heartbeatRuns)).toHaveLength(0);
    await db.update(issueThreadInteractions).set({ status: "resolved" }).where(eq(issueThreadInteractions.id, f.card.id));
    await f.queue.resumeDeferredExecutionReceipts({ companyId: f.company.id });
    await f.queue.resumeDeferredExecutionReceipts({ companyId: f.company.id });
    const wakes = await db.select().from(agentWakeupRequests);
    expect(wakes).toHaveLength(1); expect(wakes[0].id).toBe(saved.id);
    expect(wakes[0].runId).not.toBeNull();
    expect(await db.select().from(heartbeatRuns)).toHaveLength(1);
  });
  it("preserves the same saved input when the agent is paused", async () => {
    const f = await fixture(); await f.queue.enqueueWakeup(f.agent.id, f.opts);
    await db.update(issueThreadInteractions).set({ status: "resolved" }).where(eq(issueThreadInteractions.id, f.card.id));
    await db.update(agents).set({ status: "paused" }).where(eq(agents.id, f.agent.id));
    f.deps.getAgentInvokability.mockResolvedValue({ invokable: false, reason: "paused" } as never);
    await f.queue.resumeDeferredExecutionReceipts({ companyId: f.company.id });
    const wakes = await db.select().from(agentWakeupRequests);
    expect(wakes).toHaveLength(1); expect(wakes[0].status).toBe("deferred_issue_execution");
    expect(await db.select().from(heartbeatRuns)).toHaveLength(0);
  });
  it("rechecks a saved wait inside admission after a stale clear preflight", async () => {
    const f = await fixture(); await f.queue.enqueueWakeup(f.agent.id, f.opts);
    const [before] = await db.select().from(agentWakeupRequests);
    hook.mockResolvedValueOnce(null).mockResolvedValue(f.wait);
    await f.queue.resumeDeferredExecutionReceipts({ companyId: f.company.id });
    expect(await db.select().from(heartbeatRuns)).toHaveLength(0);
    const wakes = await db.select().from(agentWakeupRequests);
    expect(wakes).toHaveLength(1); expect(wakes[0]).toMatchObject({ id: before.id, status: "deferred_issue_execution" });
  });
  it("rechecks queued claims before any reservation or provider work", async () => {
    const f = await fixture(), q = await queued(f);
    expect(await f.queue.claimQueuedRun(q.run)).toBeNull();
    expect((await db.select().from(heartbeatRuns))[0]).toMatchObject({ status: "cancelled", errorCode: "adapter_interaction_pending" });
    expect((await db.select().from(agentWakeupRequests))[0]).toMatchObject({ id: q.receipt.id, status: "deferred_issue_execution", runId: null });
    expect(f.deps.executeRun).not.toHaveBeenCalled();
  });
  it("does not replay saved work to a changed owner or unsupported adapter", async () => {
    const f = await fixture(); await f.queue.enqueueWakeup(f.agent.id, f.opts);
    await db.update(issueThreadInteractions).set({ status: "resolved" }).where(eq(issueThreadInteractions.id, f.card.id));
    await db.update(issues).set({ assigneeAgentId: f.responder.id }).where(eq(issues.id, f.issue.id));
    const onError = vi.fn(); await f.queue.resumeDeferredExecutionReceipts({ companyId: f.company.id, onError });
    expect(onError).toHaveBeenCalled(); expect(await db.select().from(heartbeatRuns)).toHaveLength(0);
    expect((await db.select().from(agentWakeupRequests))[0].status).toBe("deferred_issue_execution");
  });
  it.each(["queued", "running"])("requeues an unstarted %s attempt with original actor and accounting evidence", async status => {
    const f = await fixture(), q = await queued(f, status);
    expect(await deferAdapterRun(db, q.run, f.wait, true)).toBe(true);
    const [run] = await db.select().from(heartbeatRuns), [receipt] = await db.select().from(agentWakeupRequests);
    expect(run).toMatchObject({ status: "cancelled", errorCode: "adapter_interaction_pending", costAccountingPending: true,
      usageJson: { accountingProviderWorkStarted: false } });
    expect(receipt).toMatchObject({ id: q.receipt.id, status: "deferred_issue_execution", runId: null,
      idempotencyKey: f.opts.idempotencyKey, requestedByActorId: f.opts.requestedByActorId });
    expect(receipt.payload?._paperclipWakeContext).toEqual(f.context);
  });
  it("retains all coalesced inputs without borrowing another input's author", async () => {
    const f = await fixture(), q = await queued(f);
    const otherContext = { issueId: f.issue.id, commentId: randomUUID(), source: "issue.comment" };
    await db.insert(agentWakeupRequests).values({ companyId: f.company.id, agentId: f.agent.id, runId: q.run.id,
      source: "automation", status: "coalesced", requestedByActorType: "agent", requestedByActorId: f.responder.id,
      payload: { issueId: f.issue.id, _paperclipWakeContext: otherContext } });
    expect(await deferAdapterRun(db, q.run, f.wait)).toBe(true);
    const wakes = await db.select().from(agentWakeupRequests);
    expect(wakes).toHaveLength(2); expect(wakes.every(w => w.status === "deferred_issue_execution")).toBe(true);
    expect(wakes.find(w => w.requestedByActorId === f.responder.id)?.payload?._paperclipWakeContext).toEqual(otherContext);
  });
  it("preserves an attempt when an older coalesced receipt lacks its own context", async () => {
    const f = await fixture(), q = await queued(f);
    await db.insert(agentWakeupRequests).values({ companyId: f.company.id, agentId: f.agent.id, runId: q.run.id,
      source: "automation", status: "coalesced", requestedByActorType: "agent", requestedByActorId: f.responder.id,
      payload: { issueId: f.issue.id } });
    expect(await deferAdapterRun(db, q.run, f.wait)).toBe(false);
    expect((await db.select().from(heartbeatRuns))[0].status).toBe("queued");
    expect((await db.select().from(agentWakeupRequests)).every(w => w.runId === q.run.id)).toBe(true);
  });
  it.each(["pid", "provider_event", "native", "cancelled"])("refuses to treat %s evidence as an unstarted wait", async evidence => {
    const f = await fixture(), q = await queued(f, "running");
    if (evidence === "provider_event") await db.insert(heartbeatRunEvents).values({ companyId: f.company.id, runId: q.run.id,
      agentId: f.agent.id, seq: 1, eventType: "provider.event", stream: "system", level: "info" });
    const [run] = await db.update(heartbeatRuns).set(evidence === "pid" ? { processPid: 123 } : evidence === "native"
      ? { runtimeMode: "native" } : evidence === "cancelled" ? { status: "cancelled" } : { updatedAt: new Date() })
      .where(eq(heartbeatRuns.id, q.run.id)).returning();
    expect(await deferAdapterRun(db, run, f.wait, true)).toBe(false);
    expect((await db.select().from(agentWakeupRequests))[0].runId).toBe(run.id);
  });
  // STUDIO-0024: 13 Nov 2026, TR-617 kept hundreds of automatic adapter waits
  // while TR-626 held people's messages; every pass called the router once per
  // saved wait (refused router_control_scope_busy), oldest first, 50 at a time.
  async function saveWaits(f: Awaited<ReturnType<typeof fixture>>, issueId: string, count: number,
    actor: "system" | "user", ageMs: number) {
    const context = { issueId, source: "issue.comment" };
    const rows = Array.from({ length: count }, (_, n) => ({ companyId: f.company.id, agentId: f.agent.id,
      source: "automation", triggerDetail: "system", reason: "issue_commented", status: "deferred_issue_execution",
      requestedByActorType: actor, requestedByActorId: actor === "user" ? "board-user" : "monitor",
      updatedAt: new Date(Date.now() - ageMs + n), requestedAt: new Date(Date.now() - ageMs + n),
      payload: adapterWaitPayload({ issueId }, context, { kind: "pending_interaction", blockers: [] }) }));
    return db.insert(agentWakeupRequests).values(rows).returning();
  }
  it("asks the adapter once per task in a pass, whatever the number of saved waits", async () => {
    const f = await fixture();
    await saveWaits(f, f.issue.id, 7, "system", 60_000);
    hook.mockClear();
    await f.queue.resumeDeferredExecutionReceipts({ companyId: f.company.id });
    expect(hook).toHaveBeenCalledTimes(1);
    expect((await db.select().from(agentWakeupRequests)).every(w => w.status === "deferred_issue_execution")).toBe(true);
    hook.mockRejectedValue(new Error("router_control_scope_busy")); hook.mockClear();
    const onError = vi.fn(); await f.queue.resumeDeferredExecutionReceipts({ companyId: f.company.id, onError });
    expect(hook).toHaveBeenCalledTimes(1); expect(onError).toHaveBeenCalledTimes(1);
  });
  it("checks a person's saved message before a larger, older burst of automatic waits", async () => {
    const f = await fixture();
    const [other] = await db.insert(issues).values({ companyId: f.company.id, title: "Person waiting",
      status: "in_progress", assigneeAgentId: f.agent.id }).returning();
    await saveWaits(f, f.issue.id, 60, "system", 120_000);
    await saveWaits(f, other.id, 1, "user", 1_000);
    hook.mockClear();
    await f.queue.resumeDeferredExecutionReceipts({ companyId: f.company.id, onError: () => undefined });
    const askedIssues = hook.mock.calls.map(call => (call[0] as { issueId?: string }).issueId);
    expect(askedIssues[0]).toBe(other.id);
  });
  it("does not resume while environment cleanup remains held", async () => {
    const f = await fixture(), q = await queued(f, "running");
    await deferAdapterRun(db, q.run, f.wait, true);
    await db.insert(environmentLeases).values({ companyId: f.company.id, issueId: f.issue.id, heartbeatRunId: q.run.id,
      status: "pending_cleanup", provider: "fixture" });
    await db.update(issueThreadInteractions).set({ status: "resolved" }).where(eq(issueThreadInteractions.id, f.card.id));
    const onError = vi.fn(); await f.queue.resumeDeferredExecutionReceipts({ companyId: f.company.id, onError });
    expect(onError).not.toHaveBeenCalled();
    expect(await db.select().from(heartbeatRuns)).toHaveLength(1);
    expect((await db.select().from(agentWakeupRequests))[0].status).toBe("deferred_issue_execution");
  });
});
