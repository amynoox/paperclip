import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  activityLog,
  agents,
  authUsers,
  companies,
  companyMemberships,
  createDb,
  heartbeatRunEvents,
  heartbeatRuns,
  issueComments,
  issueRecoveryActions,
  issueThreadInteractions,
  issues,
} from "@paperclipai/db";
import { createPostgresRunDispatchAdapter } from "../modules/run-dispatch/adapters/postgres.js";
import { registerServerAdapter, unregisterServerAdapter } from "../adapters/index.js";
import { heartbeatService } from "../services/heartbeat.js";
import { buildHostServices } from "../services/plugin-host-services.js";
import {
  ADAPTER_DECLARED_STOP_WAIT_MAX_MS,
  ADAPTER_DECLARED_WAIT_ERROR_CODES,
  ADAPTER_DECLARED_WAIT_MAX_MS,
  ADAPTER_DECLARED_WAIT_NO_TRANSIENT_RETRY_CODES,
  ROUTER_REFUSAL_ERROR_CODES,
  adapterDeclaredWaitMaxMs,
  routerRefusalOutcome,
} from "../services/recovery/adapter-declared-wait.js";
import { recoveryPostgresSupport, startRecoveryPostgres } from "./helpers/recovery-postgres.js";

const describePostgres = recoveryPostgresSupport.supported ? describe : describe.skip;
if (!recoveryPostgresSupport.supported) console.warn(`Skipping adapter-declared wait tests: ${recoveryPostgresSupport.reason}`);

// STUDIO-0042: production, 14 Nov 2026, TR-746 (also TR-740, TR-743). The
// assignee's run waited for a worker machine and ended `failed` with
// `router_waiting_for_resources`; the worker router kept the request and would
// wake the assignee (`worker_router_group_ready`) on release. Stranded-work
// recovery saw no live path, requeued `assignment_recovery` runs that failed
// the same way, then moved the issue to `blocked` (04:26:25), and the router
// never serves a blocked issue. While such a declared wait is within its bound,
// recovery must neither requeue nor block.
describePostgres("stranded-work recovery and adapter-declared waits", () => {
  let temporary: Awaited<ReturnType<typeof startRecoveryPostgres>>;
  let db: ReturnType<typeof createDb>;
  let heartbeat: ReturnType<typeof heartbeatService>;
  const adapterType = "codex_local";
  const dispatched = new Set<string>();
  // Per-issue adapter outcome; default finishes the task.
  const modes = new Map<string, "wait" | "wait-transient" | "other-transient" | "stop-transient" | "unsettled-transient" | "stop-plain">();
  // STUDIO-0059: per-issue router refusal code (worst case: declared with a transient error family).
  const refusals = new Map<string, string>();
  const oldHome = process.env.PAPERCLIP_HOME;
  let home: string;
  const WAIT = "router_waiting_for_resources";
  const ENDED = "router_group_participant_ended";
  const CLOSED = "router_group_participant_closed";
  const MISMATCH = "router_group_participant_mismatch";
  const RESERVED = "router_group_participant_reserved";
  const TICKET_BLOCKED = "router_ticket_blocked";
  const READMISSION = "router_readmission_not_drained";
  // A cut link to the worker machine (router 0.30.10): the cut run, then the next run.
  const STOP = "router_provider_stop_unverified";
  const UNSETTLED = "router_previous_dispatch_unsettled";

  beforeAll(async () => {
    temporary = await startRecoveryPostgres("recovery-adapter-wait-");
    db = createDb(temporary.connectionString);
    home = await mkdtemp(path.join(tmpdir(), "paperclip-adapter-wait-"));
    process.env.PAPERCLIP_HOME = home;
    heartbeat = heartbeatService(db);
    registerServerAdapter({
      type: adapterType, supportsLocalAgentJwt: false,
      execute: async input => {
        dispatched.add(input.runId);
        const refusal = refusals.get(String(input.context.issueId));
        if (refusal) {
          return { exitCode: 1, signal: null, timedOut: false, errorCode: refusal, errorMessage: "Refused by the worker router", errorFamily: "transient_upstream" as const };
        }
        const mode = modes.get(String(input.context.issueId));
        if (mode) {
          return {
            exitCode: 1, signal: null, timedOut: false,
            errorCode: mode === "other-transient" ? "codex_transient_upstream" : mode === "stop-transient" || mode === "stop-plain" ? STOP : mode === "unsettled-transient" ? UNSETTLED : WAIT,
            errorMessage: mode === "other-transient" ? "upstream unavailable" : "Waiting for a worker machine",
            ...(mode === "wait" || mode === "stop-plain" ? {} : { errorFamily: "transient_upstream" as const }),
          };
        }
        await db.update(issues).set({ status: "done" }).where(eq(issues.id, String(input.context.issueId)));
        return { exitCode: 0, signal: null, timedOut: false, resultJson: {} };
      },
      testEnvironment: async () => ({ adapterType, status: "pass", checks: [], testedAt: new Date().toISOString() }),
    });
  }, 240_000);

  afterAll(async () => {
    await heartbeat?.drainActiveRunExecutions();
    unregisterServerAdapter(adapterType);
    await db?.$client.end({ timeout: 0 });
    await temporary?.cleanup();
    if (oldHome === undefined) delete process.env.PAPERCLIP_HOME; else process.env.PAPERCLIP_HOME = oldHome;
    if (home) await rm(home, { recursive: true, force: true });
  });

  type PriorRun = { minutesAgo: number; errorCode: string | null; status?: string; retry?: boolean; durationMinutes?: number };

  async function seed(status: "todo" | "in_progress" | "in_review" | "backlog" | "blocked", prior: PriorRun[],
    opts?: { review?: boolean; reviewer?: boolean }) {
    const companyId = randomUUID(), agentId = randomUUID(), issueId = randomUUID(), reviewerId = randomUUID();
    const userId = `wait-user-${companyId}`;
    await db.insert(authUsers).values({ id: userId, name: "Board user", email: `${userId}@example.test`, createdAt: new Date(), updatedAt: new Date() });
    await db.insert(companies).values({ id: companyId, name: "Adapter wait fixture", issuePrefix: `W${companyId.slice(0, 6)}` });
    await db.insert(companyMemberships).values({ companyId, principalId: userId, principalType: "user", status: "active", membershipRole: "member" });
    await db.insert(agents).values({ id: agentId, companyId, name: "Executor", adapterType, status: "idle", adapterConfig: {} });
    if (opts?.reviewer) await db.insert(agents).values({ id: reviewerId, companyId, name: "Reviewer", adapterType, status: "idle", adapterConfig: {} });
    const runIds: string[] = [];
    for (const run of prior) {
      const createdAt = new Date(Date.now() - run.minutesAgo * 60_000);
      const [row] = await db.insert(heartbeatRuns).values({
        companyId, agentId, invocationSource: "assignment", triggerDetail: "system",
        status: run.status ?? "failed",
        errorCode: run.errorCode,
        error: run.errorCode === WAIT ? "Waiting for a worker machine" : run.errorCode ? "run failed before issue advanced" : null,
        createdAt, startedAt: createdAt, updatedAt: new Date(createdAt.getTime() + (run.durationMinutes ?? 7) * 60_000),
        finishedAt: new Date(createdAt.getTime() + (run.durationMinutes ?? 7) * 60_000),
        resultJson: { executionRecovery: { kind: "bootstrap", providerWorkStarted: false } },
        contextSnapshot: {
          issueId, taskId: issueId,
          wakeReason: run.retry ? "issue_assignment_recovery" : "issue_assigned",
          ...(run.retry ? { retryReason: "assignment_recovery" } : {}),
        },
      }).returning();
      runIds.push(row.id);
    }
    await db.insert(issues).values({
      id: issueId, companyId, title: "Routed task", status, assigneeAgentId: agentId, responsibleUserId: userId, issueNumber: 1,
      checkoutRunId: status === "in_progress" ? runIds[runIds.length - 1] ?? null : null,
      startedAt: status === "in_progress" ? new Date() : null,
      // STUDIO-0059: an execution-review stage whose current participant is the assignee (TR-1318).
      ...(opts?.review || opts?.reviewer ? {
        executionState: {
          status: "pending", currentStageId: randomUUID(), currentStageIndex: 0, currentStageType: "review",
          currentParticipant: { type: "agent", agentId: opts?.reviewer ? reviewerId : agentId, userId: null },
          returnAssignee: { type: "agent", agentId, userId: null },
          reviewRequest: null, completedStageIds: [], lastDecisionId: null, lastDecisionOutcome: null,
        },
      } : {}),
    });
    return { companyId, agentId, issueId, runIds, reviewerId };
  }

  const issueOf = async (issueId: string) => (await db.select().from(issues).where(eq(issues.id, issueId)))[0];
  const runsOf = (f: { companyId: string; agentId: string }) => db.select().from(heartbeatRuns)
    .where(and(eq(heartbeatRuns.companyId, f.companyId), eq(heartbeatRuns.agentId, f.agentId)));
  const commentsOf = (issueId: string) => db.select().from(issueComments).where(eq(issueComments.issueId, issueId));
  const actionsOf = (issueId: string) => db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.sourceIssueId, issueId));

  it("declares the router's waits (machine, stop, blocked ticket) and its four group refusals, none retried", () => {
    expect(ROUTER_REFUSAL_ERROR_CODES).toEqual([ENDED, CLOSED, MISMATCH, RESERVED]);
    // Only the dependency wait joins the bounded waits; the group refusals are never a wait.
    expect(ADAPTER_DECLARED_WAIT_ERROR_CODES).toEqual([WAIT, STOP, UNSETTLED, READMISSION, TICKET_BLOCKED]);
    expect(adapterDeclaredWaitMaxMs(TICKET_BLOCKED)).toBe(12 * 60 * 60_000);
    // Unsettled receipts: the stop kind and its bound.
    expect(adapterDeclaredWaitMaxMs(READMISSION)).toBe(12 * 60 * 60_000);
    expect(routerRefusalOutcome(RESERVED, "in_review")).toBe("block");
    expect(routerRefusalOutcome(MISMATCH, "todo")).toBe("block");
    expect(routerRefusalOutcome(CLOSED, "in_progress")).toBe("block");
    expect(routerRefusalOutcome(CLOSED, "in_review")).toBe("note");
    expect(routerRefusalOutcome(ENDED, "todo")).toBe("block");
    expect(routerRefusalOutcome(ENDED, "in_progress")).toBe("block");
    expect(routerRefusalOutcome(ENDED, "in_review")).toBe("note");
    expect(routerRefusalOutcome(TICKET_BLOCKED, "todo")).toBeNull();
    expect(routerRefusalOutcome("process_lost", "todo")).toBeNull();
    expect(ADAPTER_DECLARED_WAIT_MAX_MS).toBe(12 * 60 * 60_000);
    // STUDIO-0077: the stop series gets the bound of a machine wait (it was 1 h).
    expect(ADAPTER_DECLARED_STOP_WAIT_MAX_MS).toBe(12 * 60 * 60_000);
    expect(adapterDeclaredWaitMaxMs(WAIT)).toBe(12 * 60 * 60_000);
    expect(adapterDeclaredWaitMaxMs(STOP)).toBe(12 * 60 * 60_000);
    expect(adapterDeclaredWaitMaxMs(UNSETTLED)).toBe(12 * 60 * 60_000);
    // The cut run keeps its transient retry (the retried run waits for the link itself).
    expect(ADAPTER_DECLARED_WAIT_NO_TRANSIENT_RETRY_CODES).toEqual([WAIT, UNSETTLED, READMISSION, TICKET_BLOCKED, ...ROUTER_REFUSAL_ERROR_CODES]);
  });

  // Production, 14 Nov 2026: the responsible coordinates on its executor's
  // issue during the wait (Quality Manager run 2252fdcb, succeeded, between two
  // runs of the tester). The issue's latest run is then not the assignee's.
  it("keeps the wait when another agent's run on the issue came after the assignee's waiting run", async () => {
    for (const [status, code] of [["in_progress", WAIT], ["in_progress", UNSETTLED], ["todo", WAIT]] as const) {
      const f = await seed(status, [{ minutesAgo: 40, errorCode: code }, { minutesAgo: 20, errorCode: code, retry: true }]);
      const otherAgentId = randomUUID();
      await db.insert(agents).values({ id: otherAgentId, companyId: f.companyId, name: "Responsible", adapterType, status: "idle", adapterConfig: {} });
      const at = new Date(Date.now() - 5 * 60_000);
      await db.insert(heartbeatRuns).values({
        companyId: f.companyId, agentId: otherAgentId, invocationSource: "on_demand", triggerDetail: "system", status: "succeeded", livenessState: "advanced",
        createdAt: at, startedAt: at, updatedAt: new Date(at.getTime() + 2 * 60_000), finishedAt: new Date(at.getTime() + 2 * 60_000),
        contextSnapshot: { issueId: f.issueId, taskId: f.issueId, wakeReason: "issue_commented" },
      });
      for (let sweep = 0; sweep < 2; sweep += 1) await heartbeat.reconcileStrandedAssignedIssues({ companyId: f.companyId });
      await heartbeat.drainActiveRunExecutions();
      expect((await issueOf(f.issueId)).status).toBe(status);
      expect((await runsOf(f)).map(run => run.id).sort()).toEqual([...f.runIds].sort());
      expect(await actionsOf(f.issueId)).toHaveLength(0);
      expect(await nonWaitComments(f.issueId)).toHaveLength(0);
    }
  }, 180_000);

  // Office line cut, 14 Nov 2026, 06:01 and 06:27 (TR-731, TR-743): the cut run
  // ended `router_provider_stop_unverified`, each retry
  // `router_previous_dispatch_unsettled`, and recovery blocked the issue after
  // its retries, so the router's `worker_router_dispatch_settled` wake (sent
  // once it proves the stop) could never reach it.
  it("neither requeues nor blocks after a cut link within 1 h, and the router's settled wake starts a run", async () => {
    const cut = await seed("todo", [{ minutesAgo: 20, errorCode: STOP }, { minutesAgo: 8, errorCode: UNSETTLED, retry: true }]);
    const fresh = await seed("in_progress", [{ minutesAgo: 3, errorCode: STOP }]);
    const deadlines: number[] = [];
    for (let sweep = 0; sweep < 2; sweep += 1) {
      for (const f of [cut, fresh]) {
        await heartbeat.reconcileStrandedAssignedIssues({ companyId: f.companyId, onDeferredDeadline: at => deadlines.push(at) });
      }
    }
    await heartbeat.drainActiveRunExecutions();
    for (const [f, status] of [[cut, "todo"], [fresh, "in_progress"]] as const) {
      expect((await issueOf(f.issueId)).status).toBe(status);
      expect((await runsOf(f)).map(run => run.id).sort()).toEqual([...f.runIds].sort());
      expect(await nonWaitComments(f.issueId)).toHaveLength(0);
      expect(await actionsOf(f.issueId)).toHaveLength(0);
    }
    // STUDIO-0045: the bound runs from the END of the first waiting run.
    const cutStart = (await runsOf(cut)).find(run => run.id === cut.runIds[0])!.finishedAt!.getTime();
    expect(deadlines).toContain(cutStart + ADAPTER_DECLARED_STOP_WAIT_MAX_MS);

    const host = buildHostServices(db, "worker-router-test", "worker-router-test", {
      forPlugin: () => ({ emit: vi.fn(), subscribe: vi.fn(), clear: vi.fn() }),
    } as any);
    try {
      const woken = await host.issues.requestWakeup({
        companyId: cut.companyId, issueId: cut.issueId, reason: "worker_router_dispatch_settled",
        idempotencyKey: `router-settled/${randomUUID()}`,
      } as any);
      expect(woken.queued).toBe(true);
      await expect.poll(async () => (await runsOf(cut)).find(run => run.id === woken.runId)?.status, { timeout: 30_000 }).toBe("succeeded");
      expect((await issueOf(cut.issueId)).status).toBe("done");
    } finally { host.dispose(); }
  }, 180_000);

  // The router sends no wake when its proof fails (machine silent, engine
  // alive, no trace from an older launcher): it opens its own incident ticket
  // at 10 minutes, and past the bound (12 h since STUDIO-0077) normal escalation takes over.
  it("applies normal escalation once an unproven stop has outlasted its bound, and keeps 12 h when the latest run waits for a machine", async () => {
    const spent = await seed("todo", [{ minutesAgo: ADAPTER_DECLARED_STOP_WAIT_MAX_MS / 60_000 + 12, errorCode: STOP }, { minutesAgo: 10, errorCode: UNSETTLED, retry: true }]);
    await heartbeat.reconcileStrandedAssignedIssues({ companyId: spent.companyId });
    expect((await issueOf(spent.issueId)).status).toBe("blocked");
    expect((await actionsOf(spent.issueId))[0]).toMatchObject({ kind: "stranded_assigned_issue", status: "active" });

    // Once settled, the next run waits for a machine: the latest code decides, 12 h.
    const machine = await seed("todo", [{ minutesAgo: 72, errorCode: STOP }, { minutesAgo: 10, errorCode: WAIT, retry: true }]);
    await heartbeat.reconcileStrandedAssignedIssues({ companyId: machine.companyId });
    expect((await issueOf(machine.issueId)).status).toBe("todo");
    expect(await actionsOf(machine.issueId)).toHaveLength(0);
    await heartbeat.drainActiveRunExecutions();
  }, 180_000);

  // STUDIO-0077: production, 19 Nov 2026. A cut of the link lasted more than an hour. Past the 1 h bound recovery
  // requeued; each requeued run waited ten minutes for the proof and failed router_previous_dispatch_unsettled, eleven
  // times in a row, 630 s each; the issue was then blocked. A cut must not block an issue: the stop series is held
  // 12 h, like a machine wait.
  it("holds an unproven stop beyond one hour: neither requeued nor blocked while the cut lasts, for each code of the stop series", async () => {
    // The cut run, then eleven runs that each waited for its proof: more than two hours in all.
    const elevenUnsettled = Array.from({ length: 11 }, (_, index) => ({ minutesAgo: 122 - 11 * index, durationMinutes: 10.5, errorCode: UNSETTLED, retry: true }));
    const production = await seed("in_progress", [{ minutesAgo: 130, errorCode: STOP }, ...elevenUnsettled]);
    const stopOnly = await seed("todo", [{ minutesAgo: 185, errorCode: STOP }]);
    const readmission = await seed("todo", [{ minutesAgo: 240, errorCode: READMISSION }, { minutesAgo: 20, errorCode: READMISSION, retry: true }]);
    const deadlines: number[] = [];
    for (let sweep = 0; sweep < 2; sweep += 1) {
      for (const f of [production, stopOnly, readmission]) {
        const result = await heartbeat.reconcileStrandedAssignedIssues({ companyId: f.companyId, onDeferredDeadline: at => deadlines.push(at) });
        expect(result.dispatchRequeued + result.continuationRequeued + result.escalated).toBe(0);
      }
    }
    await heartbeat.drainActiveRunExecutions();
    for (const [f, status] of [[production, "in_progress"], [stopOnly, "todo"], [readmission, "todo"]] as const) {
      expect((await issueOf(f.issueId)).status).toBe(status);
      expect(await actionsOf(f.issueId)).toHaveLength(0);
      expect((await runsOf(f)).map(run => run.id).sort()).toEqual([...f.runIds].sort());
      // One note for the whole series, which names the bound.
      const notes = await waitNotes(f.issueId);
      expect(notes).toHaveLength(1);
      expect(notes[0]!.body).toContain("past 12 h");
    }
    // The held issue is looked at again at the end of the bound: twelve hours after the first run of the series ended.
    expect(deadlines).toHaveLength(6);
    expect(deadlines.every(at => at > Date.now() + 7 * 60 * 60_000)).toBe(true);
    // Past twelve hours the normal path takes over, as before.
    const spent = await seed("todo", [{ minutesAgo: 12 * 60 + 15, errorCode: STOP }, { minutesAgo: 10, errorCode: UNSETTLED, retry: true }]);
    await heartbeat.reconcileStrandedAssignedIssues({ companyId: spent.companyId });
    expect((await issueOf(spent.issueId)).status).toBe("blocked");
    await heartbeat.drainActiveRunExecutions();
  }, 180_000);

  it("neither requeues nor blocks an assigned issue while its machine wait is within the bound", async () => {
    // As in production: first run and an assignment_recovery retry, both waiting.
    const todo = await seed("todo", [{ minutesAgo: 40, errorCode: WAIT }, { minutesAgo: 10, errorCode: WAIT, retry: true }]);
    // First waiting run only: without the gate recovery would requeue it.
    const fresh = await seed("todo", [{ minutesAgo: 8, errorCode: WAIT }]);
    const working = await seed("in_progress", [{ minutesAgo: 30, errorCode: WAIT }, { minutesAgo: 9, errorCode: WAIT, retry: true }]);
    // The series starts after the last non-waiting run: a failure 5 h ago does
    // not count, the wait began 3 h ago.
    const series = await seed("todo", [
      { minutesAgo: 300, errorCode: WAIT }, { minutesAgo: 290, errorCode: "process_lost" },
      { minutesAgo: 180, errorCode: WAIT }, { minutesAgo: 10, errorCode: WAIT, retry: true },
    ]);
    const deadlines: number[] = [];
    for (let sweep = 0; sweep < 2; sweep += 1) {
      for (const f of [todo, fresh, working, series]) {
        await heartbeat.reconcileStrandedAssignedIssues({ companyId: f.companyId, onDeferredDeadline: at => deadlines.push(at) });
      }
    }
    await heartbeat.drainActiveRunExecutions();
    for (const [f, status] of [[todo, "todo"], [fresh, "todo"], [working, "in_progress"], [series, "todo"]] as const) {
      expect((await issueOf(f.issueId)).status).toBe(status);
      expect((await runsOf(f)).map(run => run.id).sort()).toEqual([...f.runIds].sort());
      expect(await nonWaitComments(f.issueId)).toHaveLength(0);
      expect(await actionsOf(f.issueId)).toHaveLength(0);
    }
    // The sweep re-checks at the bound, counted from the first waiting run of the series.
    const seriesStart = (await runsOf(series)).find(run => run.id === series.runIds[2])!.finishedAt!.getTime();
    expect(deadlines).toContain(seriesStart + ADAPTER_DECLARED_WAIT_MAX_MS);
  }, 180_000);

  it("starts a run when the router wakes the assignee during the wait", async () => {
    const f = await seed("todo", [{ minutesAgo: 40, errorCode: WAIT }, { minutesAgo: 10, errorCode: WAIT, retry: true }]);
    await heartbeat.reconcileStrandedAssignedIssues({ companyId: f.companyId });
    await heartbeat.drainActiveRunExecutions();
    expect((await issueOf(f.issueId)).status).toBe("todo");
    expect(await runsOf(f)).toHaveLength(2);

    const host = buildHostServices(db, "worker-router-test", "worker-router-test", {
      forPlugin: () => ({ emit: vi.fn(), subscribe: vi.fn(), clear: vi.fn() }),
    } as any);
    try {
      const woken = await host.issues.requestWakeup({
        companyId: f.companyId, issueId: f.issueId, reason: "worker_router_group_ready",
        idempotencyKey: `router-ready/${randomUUID()}`,
      } as any);
      expect(woken.queued).toBe(true);
      await expect.poll(() => dispatched.has(woken.runId!), { timeout: 30_000 }).toBe(true);
      await expect.poll(async () => (await runsOf(f)).find(run => run.id === woken.runId)?.status, { timeout: 30_000 }).toBe("succeeded");
      const run = (await runsOf(f)).find(row => row.id === woken.runId)!;
      expect(run.contextSnapshot).toMatchObject({ issueId: f.issueId, wakeReason: "worker_router_group_ready" });
      expect((await issueOf(f.issueId)).status).toBe("done");
    } finally { host.dispose(); }
  }, 180_000);

  it("applies normal escalation once the wait has outlasted the bound", async () => {
    const bound = ADAPTER_DECLARED_WAIT_MAX_MS / 60_000;
    // Retry spent, wait older than the bound: blocked as before.
    const spent = await seed("todo", [{ minutesAgo: bound + 12, errorCode: WAIT }, { minutesAgo: 10, errorCode: WAIT, retry: true }]);
    await heartbeat.reconcileStrandedAssignedIssues({ companyId: spent.companyId });
    expect((await issueOf(spent.issueId)).status).toBe("blocked");
    const [action] = await actionsOf(spent.issueId);
    expect(action).toMatchObject({ kind: "stranded_assigned_issue", status: "active" });
    expect((await commentsOf(spent.issueId))[0]?.body).toContain("no live execution path");

    // No retry yet, wait older than the bound: one recovery run as before.
    const first = await seed("todo", [{ minutesAgo: bound + 8, errorCode: WAIT }]);
    const result = await heartbeat.reconcileStrandedAssignedIssues({ companyId: first.companyId });
    expect(result.dispatchRequeued).toBe(1);
    expect((await runsOf(first)).find(run => !first.runIds.includes(run.id))).toMatchObject({ retryOfRunId: first.runIds[0] });
    await heartbeat.drainActiveRunExecutions();
  }, 180_000);

  it("keeps the current behaviour for a run that failed under another code", async () => {
    const other = await seed("todo", [{ minutesAgo: 40, errorCode: "process_lost" }, { minutesAgo: 10, errorCode: "process_lost", retry: true }]);
    await heartbeat.reconcileStrandedAssignedIssues({ companyId: other.companyId });
    expect((await issueOf(other.issueId)).status).toBe("blocked");
    expect(await actionsOf(other.issueId)).toHaveLength(1);

    // An earlier wait does not cover a latest run that failed otherwise.
    const after = await seed("todo", [{ minutesAgo: 40, errorCode: WAIT }, { minutesAgo: 10, errorCode: "process_lost", retry: true }]);
    await heartbeat.reconcileStrandedAssignedIssues({ companyId: after.companyId });
    expect((await issueOf(after.issueId)).status).toBe("blocked");

    const firstOther = await seed("todo", [{ minutesAgo: 8, errorCode: "process_lost" }]);
    const result = await heartbeat.reconcileStrandedAssignedIssues({ companyId: firstOther.companyId });
    expect(result.dispatchRequeued).toBe(1);
    await heartbeat.drainActiveRunExecutions();
  }, 180_000);

  async function boardWake(f: { agentId: string; issueId: string }) {
    const run = await heartbeat.wakeup(f.agentId, {
      source: "on_demand", triggerDetail: "manual", reason: "issue_status_changed",
      payload: { issueId: f.issueId }, contextSnapshot: { issueId: f.issueId },
    });
    expect(run).not.toBeNull();
    return run!;
  }

  async function boardReturnedToTodo(f: { companyId: string; issueId: string }, minutesAgo: number) {
    await db.insert(activityLog).values({
      companyId: f.companyId, actorType: "user", actorId: "board-user", action: "issue.updated", entityType: "issue",
      entityId: f.issueId, details: { status: "todo", _previous: { status: "blocked" } },
      createdAt: new Date(Date.now() - minutesAgo * 60_000),
    });
  }

  it("schedules no transient retry for a run that ended in a declared wait, and keeps it for another transient code", async () => {
    const waiting = await seed("todo", []);
    const other = await seed("todo", []);
    const stopped = await seed("todo", []);
    const unsettled = await seed("todo", []);
    modes.set(waiting.issueId, "wait-transient");
    modes.set(other.issueId, "other-transient");
    modes.set(stopped.issueId, "stop-transient");
    modes.set(unsettled.issueId, "unsettled-transient");
    const waitRun = await boardWake(waiting);
    const otherRun = await boardWake(other);
    const stopRun = await boardWake(stopped);
    const unsettledRun = await boardWake(unsettled);
    await heartbeat.drainActiveRunExecutions();
    await expect.poll(async () => (await runsOf(stopped)).find(run => run.id === stopRun.id)?.status, { timeout: 30_000 }).toBe("failed");
    await expect.poll(async () => (await runsOf(unsettled)).find(run => run.id === unsettledRun.id)?.status, { timeout: 30_000 }).toBe("failed");
    // The cut run keeps its transient retry; the unsettled one gets none.
    expect((await runsOf(stopped)).find(run => run.id === stopRun.id)).toMatchObject({ errorCode: STOP });
    expect((await runsOf(stopped)).filter(run => run.retryOfRunId === stopRun.id)).toEqual([
      expect.objectContaining({ status: "scheduled_retry", scheduledRetryReason: "transient_failure" }),
    ]);
    expect((await runsOf(unsettled)).find(run => run.id === unsettledRun.id)).toMatchObject({ errorCode: UNSETTLED });
    expect((await runsOf(unsettled)).filter(run => run.retryOfRunId === unsettledRun.id)).toHaveLength(0);
    await expect.poll(async () => (await runsOf(waiting)).find(run => run.id === waitRun.id)?.status, { timeout: 30_000 }).toBe("failed");
    await expect.poll(async () => (await runsOf(other)).find(run => run.id === otherRun.id)?.status, { timeout: 30_000 }).toBe("failed");
    expect((await runsOf(waiting)).find(run => run.id === waitRun.id)).toMatchObject({ errorCode: WAIT });
    expect((await runsOf(waiting)).filter(run => run.retryOfRunId === waitRun.id)).toHaveLength(0);
    expect((await runsOf(other)).filter(run => run.retryOfRunId === otherRun.id)).toEqual([
      expect.objectContaining({ status: "scheduled_retry", scheduledRetryReason: "transient_failure" }),
    ]);
  }, 180_000);

  // STUDIO-0059: production 15-16 Nov 2026. TR-1261: three runs refused (`router_control_failed`, today
  // `router_group_participant_reserved`), retried, then blocked by recovery. TR-1318: `in_review`, woken by comments,
  // refused `_ended` twice, `_closed` after a retry, then blocked by recovery at 02:26:35. A refusal before any
  // reservation is never retried. A code only a gesture lifts blocks AT ONCE, naming the code and the gesture; a
  // finished participant's refusal leaves the issue as it is, with one note per series.
  // A comment wake, as TR-1318 was woken (a real comment row; the run claims it).
  async function commentWake(f: { companyId: string; agentId: string; issueId: string }) {
    const [comment] = await db.insert(issueComments).values({
      companyId: f.companyId, issueId: f.issueId, authorType: "user", authorUserId: `wait-user-${f.companyId}`,
      body: "Can you confirm the result?",
    }).returning();
    const run = await heartbeat.wakeup(f.agentId, {
      source: "automation", triggerDetail: "system", reason: "issue_commented",
      payload: { issueId: f.issueId, commentId: comment!.id },
      contextSnapshot: { issueId: f.issueId, taskId: f.issueId, wakeReason: "issue_commented", commentId: comment!.id, wakeCommentId: comment!.id },
    });
    expect(run).not.toBeNull();
    await heartbeat.drainActiveRunExecutions();
    await expect.poll(async () => {
      const row = (await runsOf(f)).find(r => r.id === run!.id);
      return `${row?.status}:${row?.errorCode}`;
    }, { timeout: 30_000 }).toMatch(/^failed:/);
    return run!;
  }
  // STUDIO-0059: a declared wait posts one note per series; other comments are counted apart.
  const nonWaitComments = async (issueId: string) => (await commentsOf(issueId)).filter(row => !row.body.includes("The worker router held this run"));
  const waitNotes = async (issueId: string) => (await commentsOf(issueId)).filter(row => row.body.includes("The worker router held this run"));
  const routerNotices = async (issueId: string) => (await commentsOf(issueId)).filter(row => row.body.includes("The worker router refused this run"));

  it("blocks at once, with the code and the gesture, a run the router refused for a code only a gesture lifts", async () => {
    const fixtures: Array<{ code: string; gesture: string; f: Awaited<ReturnType<typeof seed>>; runId: string }> = [];
    for (const [code, status, gesture] of [
      [RESERVED, "todo", "Replace the already-reserved participant"],
      // The gesture puts the issue back where the assignee is queued again (`todo`; `in_progress` wakes nobody).
      [MISMATCH, "todo", "Correct the `worker-router` block"],
      [CLOSED, "in_progress", "Remove the finished or cancelled participant"],
      [CLOSED, "todo", "Remove the finished or cancelled participant"],
      // Nothing changes without a retry: a finished participant whose issue still has work to do is blocked now too.
      [ENDED, "todo", "move the issue to review or done"],
      [ENDED, "in_progress", "move the issue to review or done"],
    ] as const) {
      const f = await seed(status, []);
      refusals.set(f.issueId, code);
      fixtures.push({ code, gesture, f, runId: (await boardWake(f)).id });
    }
    await heartbeat.drainActiveRunExecutions();
    for (const { code, gesture, f, runId } of fixtures) {
      await expect.poll(async () => (await runsOf(f)).find(run => run.id === runId)?.status, { timeout: 30_000 }).toBe("failed");
      expect((await runsOf(f)).find(run => run.id === runId)).toMatchObject({ errorCode: code });
      // Released by the run's own end: no retry, no recovery run, blocked now (no sweep yet).
      expect((await runsOf(f)).map(run => run.id)).toEqual([runId]);
      await expect.poll(async () => (await issueOf(f.issueId)).status, { timeout: 30_000 }).toBe("blocked");
      const [notice] = await routerNotices(f.issueId);
      expect(notice?.body).toContain(`\`${code}\``);
      expect(JSON.stringify(notice?.metadata)).toContain(gesture);
      if (code !== ENDED) expect(JSON.stringify(notice?.metadata)).toContain("then move this issue back to `todo`.");
      expect(await actionsOf(f.issueId)).toEqual([expect.objectContaining({ kind: "stranded_assigned_issue", status: "active" })]);
    }
    // Further sweeps add nothing.
    for (let sweep = 0; sweep < 2; sweep += 1) {
      for (const { f } of fixtures) await heartbeat.reconcileStrandedAssignedIssues({ companyId: f.companyId });
    }
    await heartbeat.drainActiveRunExecutions();
    for (const { f, runId } of fixtures) {
      expect((await runsOf(f)).map(run => run.id)).toEqual([runId]);
      expect(await routerNotices(f.issueId)).toHaveLength(1);
      expect(await actionsOf(f.issueId)).toHaveLength(1);
    }
  }, 180_000);

  it("the stranded-work sweep blocks with the same notice a refused run whose release did not", async () => {
    const reserved = await seed("todo", [{ minutesAgo: 5, errorCode: RESERVED }]);
    const closed = await seed("in_progress", [{ minutesAgo: 5, errorCode: CLOSED }]);
    const ended = await seed("todo", [{ minutesAgo: 5, errorCode: ENDED }]);
    const codeOf = new Map([[reserved, RESERVED], [closed, CLOSED], [ended, ENDED]]);
    // Even a refusal minutes old: no bound, no requeue.
    for (const f of [reserved, closed, ended]) {
      const result = await heartbeat.reconcileStrandedAssignedIssues({ companyId: f.companyId });
      expect(result.dispatchRequeued + result.continuationRequeued).toBe(0);
      expect((await issueOf(f.issueId)).status).toBe("blocked");
      expect((await routerNotices(f.issueId))[0]?.body).toContain(codeOf.get(f)!);
      expect(await actionsOf(f.issueId)).toHaveLength(1);
      expect((await runsOf(f)).map(run => run.id).sort()).toEqual([...f.runIds].sort());
    }
    await heartbeat.drainActiveRunExecutions();
  }, 180_000);

  // TR-1318 replayed: an `in_review` issue whose review participant is its assignee, woken by a comment.
  it("keeps an in-review issue in review when the router refuses its participant as ended, then closed (TR-1318)", async () => {
    for (const review of [true, false]) {
      const f = await seed("in_review", [], { review });
      refusals.set(f.issueId, ENDED);
      const commented = () => commentWake(f);
      const ended = await commented();
      for (let sweep = 0; sweep < 2; sweep += 1) await heartbeat.reconcileStrandedAssignedIssues({ companyId: f.companyId });
      await heartbeat.drainActiveRunExecutions();
      expect((await issueOf(f.issueId)).status).toBe("in_review");
      expect(await actionsOf(f.issueId)).toHaveLength(0);
      expect((await runsOf(f)).map(run => run.id)).toEqual([ended.id]);
      const [note] = await routerNotices(f.issueId);
      expect(note).toMatchObject({ authorType: "system" });
      expect(note!.body).toContain(ENDED);
      // Refused again in the same series (production: twice): still one note, nothing requeued.
      const endedAgain = await commented();
      await heartbeat.reconcileStrandedAssignedIssues({ companyId: f.companyId });
      await heartbeat.drainActiveRunExecutions();
      expect((await routerNotices(f.issueId)).map(row => row.body.includes(ENDED))).toEqual([true]);
      expect((await runsOf(f)).map(run => run.id).sort()).toEqual([ended.id, endedAgain.id].sort());

      refusals.set(f.issueId, CLOSED);
      const closed = await commented();
      for (let sweep = 0; sweep < 2; sweep += 1) await heartbeat.reconcileStrandedAssignedIssues({ companyId: f.companyId });
      await heartbeat.drainActiveRunExecutions();
      expect((await issueOf(f.issueId)).status).toBe("in_review");
      expect(await actionsOf(f.issueId)).toHaveLength(0);
      expect((await runsOf(f)).map(run => run.id).sort()).toEqual([ended.id, endedAgain.id, closed.id].sort());
      const notes = await routerNotices(f.issueId);
      expect(notes).toHaveLength(2);
      expect(notes.some(row => row.body.includes(CLOSED))).toBe(true);
    }
  }, 240_000);

  it("blocks at once a review participant refused for a code only a gesture lifts", async () => {
    for (const code of [RESERVED, MISMATCH]) {
      const f = await seed("in_review", [], { review: true });
      refusals.set(f.issueId, code);
      const run = await commentWake(f);
      // A comment wake is not the review path's run, so its release leaves it; the sweep blocks it at once (no
      // bound), and no review recovery is requeued.
      await heartbeat.reconcileStrandedAssignedIssues({ companyId: f.companyId });
      await heartbeat.drainActiveRunExecutions();
      expect((await issueOf(f.issueId)).status).toBe("blocked");
      expect((await runsOf(f)).map(row => row.id)).toEqual([run.id]);
      expect((await routerNotices(f.issueId))[0]?.body).toContain(code);
      expect(await actionsOf(f.issueId)).toHaveLength(1);
    }
  }, 180_000);

  it("reads the review participant's own run when the reviewer is another agent than the assignee", async () => {
    // The refusal and the wait are on the REVIEWER's run (the gate serves the pending participant).
    const blocked = await seed("in_review", [], { reviewer: true });
    const refused = { ...blocked, agentId: blocked.reviewerId };
    refusals.set(blocked.issueId, RESERVED);
    const refusedRun = await commentWake(refused);
    await heartbeat.reconcileStrandedAssignedIssues({ companyId: blocked.companyId });
    await heartbeat.drainActiveRunExecutions();
    expect((await issueOf(blocked.issueId)).status).toBe("blocked");
    expect((await routerNotices(blocked.issueId))[0]?.body).toContain(RESERVED);
    expect((await runsOf(refused)).map(run => run.id)).toEqual([refusedRun.id]);
    expect(await runsOf(blocked)).toEqual([]);

    const held = await seed("in_review", [], { reviewer: true });
    const waiting = { ...held, agentId: held.reviewerId };
    refusals.set(held.issueId, TICKET_BLOCKED);
    const waitRun = await commentWake(waiting);
    for (let sweep = 0; sweep < 2; sweep += 1) await heartbeat.reconcileStrandedAssignedIssues({ companyId: held.companyId });
    await heartbeat.drainActiveRunExecutions();
    expect((await issueOf(held.issueId)).status).toBe("in_review");
    expect((await runsOf(waiting)).map(run => run.id)).toEqual([waitRun.id]);
    expect(await runsOf(held)).toEqual([]);
    expect(await actionsOf(held.issueId)).toHaveLength(0);
    expect((await waitNotes(held.issueId)).map(row => row.body.includes(TICKET_BLOCKED))).toEqual([true]);
  }, 180_000);

  it("leaves a refusal on a backlog or blocked issue alone (a status that calls for no run, or is already visible)", async () => {
    for (const status of ["backlog", "blocked"] as const) {
      const f = await seed(status, [{ minutesAgo: 5, errorCode: CLOSED }]);
      await heartbeat.reconcileStrandedAssignedIssues({ companyId: f.companyId });
      expect((await issueOf(f.issueId)).status).toBe(status);
      expect(await nonWaitComments(f.issueId)).toHaveLength(0);
      expect(await actionsOf(f.issueId)).toHaveLength(0);
      expect((await runsOf(f)).map(run => run.id)).toEqual(f.runIds);
    }
  }, 180_000);

  // The second review's verified defect (TR-1318): on an `in_review` issue with a pending reviewer, a declared wait
  // fell into the review path, which requeued a review recovery run, refused again, then blocked at its release.
  it("holds a declared wait of the review participant like the assignee's, with one note, then the normal path", async () => {
    for (const code of [TICKET_BLOCKED, READMISSION]) {
      const f = await seed("in_review", [], { review: true });
      refusals.set(f.issueId, code);
      const run = await commentWake(f);
      for (let sweep = 0; sweep < 2; sweep += 1) await heartbeat.reconcileStrandedAssignedIssues({ companyId: f.companyId });
      await heartbeat.drainActiveRunExecutions();
      expect((await issueOf(f.issueId)).status).toBe("in_review");
      expect((await runsOf(f)).map(row => row.id)).toEqual([run.id]);
      expect(await actionsOf(f.issueId)).toHaveLength(0);
      const notes = await waitNotes(f.issueId);
      expect(notes).toHaveLength(1);
      expect(notes[0]!.body).toContain(code);
      refusals.delete(f.issueId);
    }
    // Past its bound, the review path takes over again.
    const old = await seed("in_review", [
      { minutesAgo: ADAPTER_DECLARED_STOP_WAIT_MAX_MS / 60_000 + 30, errorCode: READMISSION },
      { minutesAgo: 10, errorCode: READMISSION, retry: true },
    ], { review: true });
    await heartbeat.reconcileStrandedAssignedIssues({ companyId: old.companyId });
    await heartbeat.drainActiveRunExecutions();
    const moved = (await issueOf(old.issueId)).status === "blocked" || (await runsOf(old)).length > old.runIds.length;
    expect(moved).toBe(true);
  }, 240_000);

  it("posts one note per series for a blocked-ticket wait on an issue at work", async () => {
    const f = await seed("todo", [{ minutesAgo: 20, durationMinutes: 1, errorCode: TICKET_BLOCKED }, { minutesAgo: 5, durationMinutes: 1, errorCode: TICKET_BLOCKED, retry: true }]);
    for (let sweep = 0; sweep < 2; sweep += 1) await heartbeat.reconcileStrandedAssignedIssues({ companyId: f.companyId });
    expect((await issueOf(f.issueId)).status).toBe("todo");
    expect((await waitNotes(f.issueId)).map(row => row.body.includes(TICKET_BLOCKED))).toEqual([true]);
    await heartbeat.drainActiveRunExecutions();
  }, 180_000);

  it("does not block again on a refusal older than the Board's return of the issue", async () => {
    const f = await seed("todo", [{ minutesAgo: 10, errorCode: RESERVED }]);
    // The Board fixed the group and returned the issue to todo, without a wake.
    await boardReturnedToTodo(f, 5);
    await heartbeat.reconcileStrandedAssignedIssues({ companyId: f.companyId });
    await heartbeat.drainActiveRunExecutions();
    expect((await issueOf(f.issueId)).status).not.toBe("blocked");
    expect(await routerNotices(f.issueId)).toHaveLength(0);
    expect(await actionsOf(f.issueId)).toHaveLength(0);
    // The normal path follows: the assignee is served again.
    expect((await runsOf(f)).length).toBeGreaterThan(f.runIds.length);
  }, 180_000);

  it("counts each kind of wait in its own series: a wait after another kind gets its own bound", async () => {
    const bound = ADAPTER_DECLARED_WAIT_MAX_MS / 60_000;
    // A machine wait older than 12 h, then an unproven stop 5 min ago: the stop bound counts from the stop.
    const stop = await seed("todo", [{ minutesAgo: bound + 30, errorCode: WAIT }, { minutesAgo: 5, durationMinutes: 1, errorCode: STOP, retry: true }]);
    // A machine wait older than 12 h, then a blocked ticket 5 min ago: the dependency wait counts from itself.
    const ticket = await seed("todo", [{ minutesAgo: bound + 30, errorCode: WAIT }, { minutesAgo: 5, durationMinutes: 1, errorCode: TICKET_BLOCKED, retry: true }]);
    for (const f of [stop, ticket]) {
      await heartbeat.reconcileStrandedAssignedIssues({ companyId: f.companyId });
      expect((await issueOf(f.issueId)).status).toBe("todo");
      expect(await actionsOf(f.issueId)).toHaveLength(0);
      expect((await runsOf(f)).map(run => run.id).sort()).toEqual([...f.runIds].sort());
    }
    // The blocked ticket's own series past its bound: normal recovery, as for any wait.
    const old = await seed("todo", [{ minutesAgo: bound + 12, errorCode: TICKET_BLOCKED }, { minutesAgo: 10, errorCode: TICKET_BLOCKED, retry: true }]);
    await heartbeat.reconcileStrandedAssignedIssues({ companyId: old.companyId });
    expect((await issueOf(old.issueId)).status).toBe("blocked");
    await heartbeat.drainActiveRunExecutions();
  }, 180_000);

  it("schedules no transient retry for a blocked-ticket refusal and keeps it held within its bound", async () => {
    const f = await seed("todo", []);
    refusals.set(f.issueId, TICKET_BLOCKED);
    const run = await boardWake(f);
    await heartbeat.drainActiveRunExecutions();
    await expect.poll(async () => (await runsOf(f)).find(row => row.id === run.id)?.status, { timeout: 30_000 }).toBe("failed");
    const leftStatus = (await issueOf(f.issueId)).status;
    expect(leftStatus).not.toBe("blocked");
    for (let sweep = 0; sweep < 2; sweep += 1) await heartbeat.reconcileStrandedAssignedIssues({ companyId: f.companyId });
    await heartbeat.drainActiveRunExecutions();
    expect((await runsOf(f)).map(row => row.id)).toEqual([run.id]);
    expect((await issueOf(f.issueId)).status).toBe(leftStatus);
    expect(await actionsOf(f.issueId)).toHaveLength(0);
    expect((await waitNotes(f.issueId)).map(row => row.body.includes(TICKET_BLOCKED))).toEqual([true]);
  }, 180_000);

  it("does not re-block an issue the Board returned to todo whose new run ends waiting (production race)", async () => {
    const f = await seed("todo", [{ minutesAgo: 40, errorCode: WAIT }, { minutesAgo: 20, errorCode: WAIT, retry: true }]);
    modes.set(f.issueId, "wait");
    await boardReturnedToTodo(f, 1);
    const run = await boardWake(f);
    // The sweep right after the Board's gesture, while the run is just queued.
    await heartbeat.reconcileStrandedAssignedIssues({ companyId: f.companyId });
    expect((await issueOf(f.issueId)).status).not.toBe("blocked");
    await heartbeat.drainActiveRunExecutions();
    await expect.poll(async () => (await runsOf(f)).find(row => row.id === run.id)?.status, { timeout: 30_000 }).toBe("failed");
    // The run checked the task out; it ended waiting for a machine.
    const afterRun = (await issueOf(f.issueId)).status;
    expect(["todo", "in_progress"]).toContain(afterRun);
    // And the sweep once that run has ended.
    await heartbeat.reconcileStrandedAssignedIssues({ companyId: f.companyId });
    await heartbeat.reconcileStrandedAssignedIssues({ companyId: f.companyId });
    await heartbeat.drainActiveRunExecutions();
    expect((await issueOf(f.issueId)).status).toBe(afterRun);
    expect((await runsOf(f)).map(row => row.id).sort()).toEqual([...f.runIds, run.id].sort());
    expect(await nonWaitComments(f.issueId)).toHaveLength(0);
    expect(await actionsOf(f.issueId)).toHaveLength(0);
  }, 180_000);

  it("restarts the bound when the Board returns the issue", async () => {
    const bound = ADAPTER_DECLARED_WAIT_MAX_MS / 60_000;
    const history = (): PriorRun[] => [
      { minutesAgo: bound + 60, errorCode: WAIT }, { minutesAgo: bound + 30, errorCode: WAIT, retry: true },
      { minutesAgo: 3, errorCode: WAIT },
    ];
    const statusChanged = await seed("todo", history());
    await boardReturnedToTodo(statusChanged, 5);
    const restored = await seed("todo", history());
    await db.insert(issueRecoveryActions).values({
      companyId: restored.companyId, sourceIssueId: restored.issueId, kind: "stranded_assigned_issue", status: "resolved",
      ownerType: "board", cause: "stranded_assigned_issue", fingerprint: `restored-${randomUUID()}`, nextAction: "Restore the task",
      previousOwnerAgentId: restored.agentId, returnOwnerAgentId: restored.agentId,
      outcome: "restored", resolvedAt: new Date(Date.now() - 5 * 60_000),
    });
    for (const f of [statusChanged, restored]) {
      await heartbeat.reconcileStrandedAssignedIssues({ companyId: f.companyId });
      await heartbeat.drainActiveRunExecutions();
      expect((await issueOf(f.issueId)).status).toBe("todo");
      expect((await runsOf(f)).map(run => run.id).sort()).toEqual([...f.runIds].sort());
      expect(await nonWaitComments(f.issueId)).toHaveLength(0);
    }
    expect(await actionsOf(statusChanged.issueId)).toHaveLength(0);

    // Without a Board return the same history is past the bound: normal recovery.
    const unreturned = await seed("todo", history());
    const result = await heartbeat.reconcileStrandedAssignedIssues({ companyId: unreturned.companyId });
    expect(result.dispatchRequeued + result.escalated).toBe(1);
    await heartbeat.drainActiveRunExecutions();
  }, 180_000);

  // STUDIO-0045, production TR-834 (14 Nov 2026): run ae12db9b created 12:03:16
  // and cut 12:40:24; counted from its creation, the 1 h bound of an unproven
  // stop ran out 23 min after the cut. The bound now runs from the cut.
  it("counts the bound from the end of a long run cut late", async () => {
    const f = await seed("in_progress", [{ minutesAgo: 70, durationMinutes: 50, errorCode: STOP }]);
    const deadlines: number[] = [];
    await heartbeat.reconcileStrandedAssignedIssues({ companyId: f.companyId, onDeferredDeadline: at => deadlines.push(at) });
    await heartbeat.drainActiveRunExecutions();
    expect((await issueOf(f.issueId)).status).toBe("in_progress");
    expect((await runsOf(f)).map(run => run.id)).toEqual(f.runIds);
    expect(await actionsOf(f.issueId)).toHaveLength(0);
    const cut = (await runsOf(f))[0]!.finishedAt!.getTime();
    expect(deadlines).toContain(cut + ADAPTER_DECLARED_STOP_WAIT_MAX_MS);
  }, 180_000);

  // STUDIO-0046, contract with the worker router (14 Nov 2026, TR-834): a run
  // cut under router_provider_stop_unverified declares no errorFamily; the
  // server retries it on the code alone, the router's "executor interrupted"
  // card (continuation policy none) does not cancel that retry, and the retry
  // waits for the responsible's run on the same ticket so the router sees it alone.
  it("retries an unproven stop on the code alone, without an error family", async () => {
    const f = await seed("todo", []);
    modes.set(f.issueId, "stop-plain");
    const run = await boardWake(f);
    await heartbeat.drainActiveRunExecutions();
    await expect.poll(async () => (await runsOf(f)).find(row => row.id === run.id)?.status, { timeout: 30_000 }).toBe("failed");
    expect((await runsOf(f)).find(row => row.id === run.id)).toMatchObject({ errorCode: STOP });
    expect((await runsOf(f)).find(row => row.id === run.id)?.resultJson?.errorFamily).toBeUndefined();
    expect((await runsOf(f)).filter(row => row.retryOfRunId === run.id)).toEqual([
      expect.objectContaining({ status: "scheduled_retry", scheduledRetryReason: "transient_failure" }),
    ]);
  }, 180_000);

  type CardShape = "router" | "router-redirected" | "router-redirected-elsewhere" | "router-other-run" | "oauth" | "native-question"
    | "wake-assignee" | "none";
  async function dueStopRetry(card: CardShape, opts: { sourceCode?: string; liveStatus?: "running" | "queued";
    liveAgent?: "responsible" | "assignee"; chain?: boolean; recutCode?: string } = {}) {
    const f = await seed("in_progress", [{ minutesAgo: 2, durationMinutes: 1, errorCode: opts.sourceCode ?? STOP }]);
    await db.update(issues).set({ checkoutRunId: null }).where(eq(issues.id, f.issueId));
    // chain: the first retry was cut again; the due retry is the retry of that
    // retry, and the router's card still names the first cut run.
    const [recut] = opts.chain ? await db.insert(heartbeatRuns).values({
      companyId: f.companyId, agentId: f.agentId, invocationSource: "automation", triggerDetail: "system", status: "failed",
      runtimeMode: "legacy", retryOfRunId: f.runIds[0], errorCode: opts.recutCode ?? STOP, scheduledRetryAttempt: 1, scheduledRetryReason: "transient_failure",
      startedAt: new Date(Date.now() - 50_000), finishedAt: new Date(Date.now() - 40_000),
      contextSnapshot: { issueId: f.issueId, taskId: f.issueId, wakeReason: "transient_failure_retry", retryReason: "transient_failure" },
    }).returning() : [];
    const [retry] = await db.insert(heartbeatRuns).values({
      companyId: f.companyId, agentId: f.agentId, invocationSource: "automation", triggerDetail: "system", status: "scheduled_retry",
      runtimeMode: "legacy", retryOfRunId: recut?.id ?? f.runIds[0], scheduledRetryAt: new Date(Date.now() - 1_000), scheduledRetryAttempt: recut ? 2 : 1,
      scheduledRetryReason: "transient_failure", resultJson: { conversationContinuation: "continue_conversation_v1" },
      contextSnapshot: { issueId: f.issueId, taskId: f.issueId, wakeReason: "transient_failure_retry", retryReason: "transient_failure" },
    }).returning();
    const [responsible] = await db.insert(agents).values({ companyId: f.companyId, name: "Responsible", adapterType, status: "running", adapterConfig: {} }).returning();
    const confirm = { version: 1, prompt: "The executor was interrupted. Keep the current reservation while resuming on the same worker?" };
    const cards: Record<Exclude<CardShape, "none">, Record<string, unknown>> = {
      // The worker router's card for this very cut run (production key shape).
      router: { kind: "request_confirmation", continuationPolicy: "none", addresseeAgentId: responsible.id,
        idempotencyKey: `interruption/${randomUUID()}/${f.runIds[0]}`, payload: confirm },
      // The same card when the manager changed since the reservation.
      "router-redirected": { kind: "request_confirmation", continuationPolicy: "none", addresseeAgentId: responsible.id,
        idempotencyKey: `interruption/${randomUUID()}/${f.runIds[0]}/to/${responsible.id}`, payload: confirm },
      "router-redirected-elsewhere": { kind: "request_confirmation", continuationPolicy: "none", addresseeAgentId: responsible.id,
        idempotencyKey: `interruption/${randomUUID()}/${f.runIds[0]}/to/${randomUUID()}`, payload: confirm },
      "router-other-run": { kind: "request_confirmation", continuationPolicy: "none", addresseeAgentId: responsible.id,
        idempotencyKey: `interruption/${randomUUID()}/${randomUUID()}`, payload: confirm },
      // "Connect your account to continue" (tool-access OAuth): policy none, addressed to a person.
      oauth: { kind: "request_confirmation", continuationPolicy: "none", addresseeUserId: "connection-owner",
        idempotencyKey: `oauth-connect/${randomUUID()}`, payload: { version: 1, prompt: "Connect your Sentry account to continue." } },
      // A native question (native question bridge): policy none, created by the agent's run.
      "native-question": { kind: "ask_user_questions", continuationPolicy: "none", addresseeUserId: "connection-owner",
        createdByAgentId: f.agentId, idempotencyKey: `native-question/${randomUUID()}`, payload: { version: 1, questions: [] } },
      "wake-assignee": { kind: "request_confirmation", continuationPolicy: "wake_assignee", addresseeAgentId: responsible.id, payload: confirm },
    };
    if (card !== "none") await db.insert(issueThreadInteractions).values({ companyId: f.companyId, issueId: f.issueId, status: "pending", ...cards[card] } as never);
    const [live] = await db.insert(heartbeatRuns).values({ companyId: f.companyId,
      agentId: opts.liveAgent === "assignee" ? f.agentId : responsible.id, invocationSource: "automation",
      triggerDetail: "system", status: opts.liveStatus ?? "running", startedAt: opts.liveStatus === "queued" ? null : new Date(),
      contextSnapshot: { issueId: f.issueId, taskId: f.issueId, wakeReason: "interaction_pending" } }).returning();
    return { f, retry, live };
  }

  it("holds the retry behind the responsible's run, does not let the router's card cancel it, then promotes it", async () => {
    const { f, retry, live } = await dueStopRetry("router");
    const dispatch = createPostgresRunDispatchAdapter(db);
    expect(await dispatch.promoteOrCancelDueRetry({ companyId: f.companyId, runId: retry.id, now: new Date() })).toMatchObject({ outcome: "not_promoted" });
    const held = (await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, retry.id)))[0]!;
    expect(held).toMatchObject({ status: "scheduled_retry", resultJson: expect.objectContaining({ liveRunWait: expect.objectContaining({ runId: live.id }) }) });
    expect(held.scheduledRetryAt!.getTime()).toBeGreaterThan(Date.now());
    await db.update(heartbeatRuns).set({ status: "succeeded", finishedAt: new Date() }).where(eq(heartbeatRuns.id, live.id));
    expect(await dispatch.promoteOrCancelDueRetry({ companyId: f.companyId, runId: retry.id, now: new Date(Date.now() + 20_000) }))
      .toMatchObject({ outcome: "promoted" });
    // The gate before dispatch does not cancel it for the router's card either.
    expect(await dispatch.cancelStaleQueuedRun({ companyId: f.companyId, runId: retry.id, expectedStatus: "queued", now: new Date(Date.now() + 21_000) }))
      .toMatchObject({ outcome: "not_stale" });
  }, 180_000);

  // STUDIO-0046 follow-ups: the card keyed `/to/<addressee>` after a manager
  // change, and the first cut's card while the retry of a re-cut retry is due.
  it.each([["router-redirected", false], ["router", true]] as const)(
    "does not let the router's %s card cancel the retry (retry of a re-cut retry: %s)", async (card, chain) => {
      const { f, retry, live } = await dueStopRetry(card, { chain });
      const dispatch = createPostgresRunDispatchAdapter(db);
      expect(await dispatch.promoteOrCancelDueRetry({ companyId: f.companyId, runId: retry.id, now: new Date() })).toMatchObject({ outcome: "not_promoted" });
      await db.update(heartbeatRuns).set({ status: "succeeded", finishedAt: new Date() }).where(eq(heartbeatRuns.id, live.id));
      expect(await dispatch.promoteOrCancelDueRetry({ companyId: f.companyId, runId: retry.id, now: new Date(Date.now() + 20_000) }))
        .toMatchObject({ outcome: "promoted" });
      expect(await dispatch.cancelStaleQueuedRun({ companyId: f.companyId, runId: retry.id, expectedStatus: "queued", now: new Date(Date.now() + 21_000) }))
        .toMatchObject({ outcome: "not_stale" });
    }, 180_000);

  it("keeps cancelling the retry for the first cut's card when the chain is broken by another code", async () => {
    const { f, retry } = await dueStopRetry("router", { chain: true, recutCode: "process_lost" });
    expect(await createPostgresRunDispatchAdapter(db).promoteOrCancelDueRetry({ companyId: f.companyId, runId: retry.id, now: new Date() }))
      .toMatchObject({ outcome: "gate_suppressed", errorCode: "issue_waiting_for_response" });
  }, 180_000);

  it.each(["oauth", "native-question", "router-other-run", "router-redirected-elsewhere"] as const)(
    "keeps cancelling the retry for a pending %s card", async (card) => {
      const { f, retry } = await dueStopRetry(card);
      expect(await createPostgresRunDispatchAdapter(db).promoteOrCancelDueRetry({ companyId: f.companyId, runId: retry.id, now: new Date() }))
        .toMatchObject({ outcome: "gate_suppressed", errorCode: "issue_waiting_for_response" });
    }, 180_000);

  it("holds the retry behind another agent's queued run, but not behind a queued run of its own agent", async () => {
    const other = await dueStopRetry("none", { liveStatus: "queued" });
    const dispatch = createPostgresRunDispatchAdapter(db);
    expect(await dispatch.promoteOrCancelDueRetry({ companyId: other.f.companyId, runId: other.retry.id, now: new Date() }))
      .toMatchObject({ outcome: "not_promoted" });
    expect((await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, other.retry.id)))[0]!.resultJson?.liveRunWait)
      .toMatchObject({ runId: other.live.id });
    // A queued run of the retry's own agent may wait for the lock the retry holds.
    const own = await dueStopRetry("none", { liveStatus: "queued", liveAgent: "assignee" });
    expect(await dispatch.promoteOrCancelDueRetry({ companyId: own.f.companyId, runId: own.retry.id, now: new Date() }))
      .toMatchObject({ outcome: "promoted" });
  }, 180_000);

  it("does not hold the retry of a run cut under another code", async () => {
    const other = await dueStopRetry("none", { sourceCode: "process_lost" });
    expect(await createPostgresRunDispatchAdapter(db).promoteOrCancelDueRetry({ companyId: other.f.companyId, runId: other.retry.id, now: new Date() }))
      .toMatchObject({ outcome: "promoted" });
    expect((await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, other.retry.id)))[0]!.resultJson?.liveRunWait).toBeUndefined();
  }, 180_000);

  it("keeps the declared wait when a retry of the cut run was cancelled before it started", async () => {
    const f = await seed("in_progress", [{ minutesAgo: 20, durationMinutes: 1, errorCode: STOP }]);
    await db.insert(heartbeatRuns).values({ companyId: f.companyId, agentId: f.agentId, invocationSource: "automation", triggerDetail: "system",
      status: "cancelled", errorCode: "issue_waiting_for_response", retryOfRunId: f.runIds[0], finishedAt: new Date(Date.now() - 18 * 60_000),
      scheduledRetryReason: "transient_failure", contextSnapshot: { issueId: f.issueId, taskId: f.issueId, wakeReason: "transient_failure_retry" } });
    await heartbeat.reconcileStrandedAssignedIssues({ companyId: f.companyId });
    await heartbeat.drainActiveRunExecutions();
    expect((await issueOf(f.issueId)).status).toBe("in_progress");
    expect(await actionsOf(f.issueId)).toHaveLength(0);
    expect((await runsOf(f)).filter(run => run.status !== "cancelled" && !f.runIds.includes(run.id))).toHaveLength(0);
  }, 180_000);

  it("counts the bound from the creation of a waiting run that has no end recorded", async () => {
    const f = await seed("in_progress", [{ minutesAgo: 30, errorCode: STOP }]);
    await db.update(heartbeatRuns).set({ finishedAt: null }).where(eq(heartbeatRuns.id, f.runIds[0]));
    const deadlines: number[] = [];
    await heartbeat.reconcileStrandedAssignedIssues({ companyId: f.companyId, onDeferredDeadline: at => deadlines.push(at) });
    expect((await issueOf(f.issueId)).status).toBe("in_progress");
    const created = (await runsOf(f))[0]!.createdAt.getTime();
    expect(deadlines).toContain(created + ADAPTER_DECLARED_STOP_WAIT_MAX_MS);
  }, 180_000);

  it("still cancels the retry for a card that will resume the conversation", async () => {
    const { f, retry } = await dueStopRetry("wake-assignee");
    expect(await createPostgresRunDispatchAdapter(db).promoteOrCancelDueRetry({ companyId: f.companyId, runId: retry.id, now: new Date() }))
      .toMatchObject({ outcome: "gate_suppressed", errorCode: "issue_waiting_for_response" });
  }, 180_000);

  // STUDIO-0046 under the real due-retry sweep: the retry is scheduled by the
  // server itself from a real run end (as in production, with its dispatch
  // notification), and the sweep is driven through the same two entry points
  // the deadline worker calls (promoteDueScheduledRetries at the due time, then
  // nextScheduledRetryAt to plan its next pass). Another role's run on the task
  // (an addressee answering a card or a commenter: production shows such runs
  // overlapping other agents' runs on the same task) is live when it falls due.
  it("holds the retry under the real due-retry sweep while another role runs on the task, and keeps the 10 min bound", async () => {
    const f = await seed("in_progress", []);
    modes.set(f.issueId, "stop-plain");
    const cut = await boardWake(f);
    await heartbeat.drainActiveRunExecutions();
    await expect.poll(async () => (await runsOf(f)).find(row => row.id === cut.id)?.status, { timeout: 30_000 }).toBe("failed");
    const retry = (await runsOf(f)).find(row => row.retryOfRunId === cut.id)!;
    expect(retry).toMatchObject({ status: "scheduled_retry", scheduledRetryReason: "transient_failure" });
    const [responsible] = await db.insert(agents).values({ companyId: f.companyId, name: "Responsible", adapterType, status: "running", adapterConfig: {} }).returning();
    const [live] = await db.insert(heartbeatRuns).values({ companyId: f.companyId, agentId: responsible.id, invocationSource: "automation",
      triggerDetail: "system", status: "running", startedAt: new Date(), contextSnapshot: { issueId: f.issueId, taskId: f.issueId, wakeReason: "interaction_pending" } }).returning();
    const row = async () => (await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, retry.id)))[0]!;

    // First pass of the sweep at the due time: held, pushed back 15 s, traced.
    const due = new Date(retry.scheduledRetryAt!.getTime() + 1_000);
    expect((await heartbeat.promoteDueScheduledRetries(due)).runIds).not.toContain(retry.id);
    const held = await row();
    expect(held).toMatchObject({ status: "scheduled_retry", resultJson: expect.objectContaining({
      liveRunWait: expect.objectContaining({ runId: live.id, since: due.toISOString() }) }) });
    expect(held.scheduledRetryAt!.getTime()).toBe(due.getTime() + 15_000);
    const events = await db.select().from(heartbeatRunEvents).where(eq(heartbeatRunEvents.runId, retry.id));
    expect(events.map(event => event.message)).toContain("Scheduled retry is waiting for another run of the task to finish, so the worker router sees it alone");
    // Second pass at exactly the pushed-back deadline (the time the worker
    // plans from nextScheduledRetryAt), the other run still live: held again,
    // same start, one event only.
    const second = new Date(held.scheduledRetryAt!.getTime());
    expect((await heartbeat.promoteDueScheduledRetries(second)).runIds).not.toContain(retry.id);
    expect((await row()).resultJson?.liveRunWait).toMatchObject({ since: due.toISOString() });
    expect((await db.select().from(heartbeatRunEvents).where(eq(heartbeatRunEvents.runId, retry.id)))
      .filter(event => event.message?.startsWith("Scheduled retry is waiting for another run"))).toHaveLength(1);

    // Past the 10 min bound, counted from the first hold: promoted although the other run is still live.
    const pastBound = new Date(due.getTime() + 10 * 60_000 + 20_000);
    expect((await heartbeat.promoteDueScheduledRetries(pastBound)).runIds).toContain(retry.id);
    await db.update(heartbeatRuns).set({ status: "succeeded", finishedAt: new Date() }).where(eq(heartbeatRuns.id, live.id));
    await heartbeat.drainActiveRunExecutions();
  }, 180_000);
});
