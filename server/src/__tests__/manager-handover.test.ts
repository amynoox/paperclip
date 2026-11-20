import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import express from "express";
import request from "supertest";
import { and, eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  activityLog,
  agentWakeupRequests,
  agents,
  authUsers,
  companies,
  companyMemberships,
  createDb,
  environmentLeases,
  heartbeatRuns,
  issueComments,
  issueRecoveryActions,
  issues,
  principalPermissionGrants,
} from "@paperclipai/db";
import { registerServerAdapter, unregisterServerAdapter } from "../adapters/index.js";
import { errorHandler } from "../middleware/index.js";
import { issueRoutes } from "../routes/issues.js";
import { heartbeatService } from "../services/heartbeat.js";
import { issueRecoveryActionService } from "../services/issue-recovery-actions.js";
import { ROUTER_REFUSAL_ERROR_CODES, routerRefusalHandoverNote, routerRefusalOutcome } from "../services/recovery/adapter-declared-wait.js";
import {
  BOARD_BLOCK_MANAGER_NOTICE_TITLE,
  MANAGER_HANDOVER_ACTIVITY_ACTION,
  MANAGER_HANDOVER_MAX_PER_SERIES,
  MANAGER_HANDOVER_WAKE_REASON,
  handIssueToManager,
  wakeManagerOfBlockedIssue,
} from "../services/recovery/manager-handover.js";
import { recoveryPostgresSupport, startRecoveryPostgres } from "./helpers/recovery-postgres.js";

const describePostgres = recoveryPostgresSupport.supported ? describe : describe.skip;
if (!recoveryPostgresSupport.supported) console.warn(`Skipping manager hand-over tests: ${recoveryPostgresSupport.reason}`);

// STUDIO-0083. Production, 20 Nov 2026, 03:33, TR-2030: the CTO's run on TR-1587 was refused
// `router_group_participant_ended`; the ticket was blocked with a Board action, the manager was not woken and
// believed it could not settle it; a person had to. Also TR-1261 (15 Nov, `_reserved`), TR-1552, TR-1814, TR-1815.
// A refused ticket at work now goes to the direct manager of its role; a block that still needs the Board wakes
// that manager once; and a recovery action settled by another role says so on the ticket.
describePostgres("a ticket the worker router refuses goes to the role's direct manager", () => {
  let temporary: Awaited<ReturnType<typeof startRecoveryPostgres>>;
  let db: ReturnType<typeof createDb>;
  let heartbeat: ReturnType<typeof heartbeatService>;
  const adapterType = "codex_local";
  // Per-issue refusal of the worker router for the role's runs; the manager's runs end well and change nothing.
  const refusals = new Map<string, string>();
  const launched: Array<{ agentId: string; issueId: string; wakeReason: string | null }> = [];
  const oldHome = process.env.PAPERCLIP_HOME;
  let home: string;
  const ENDED = "router_group_participant_ended";
  const CLOSED = "router_group_participant_closed";
  const MISMATCH = "router_group_participant_mismatch";
  const RESERVED = "router_group_participant_reserved";
  const BLOCK_INVALID = "router_request_block_invalid";
  const SYSTEM_UNKNOWN = "router_request_system_unknown";
  const ATTEMPT_USED = "router_attempt_already_used";
  const TICKET_COMPLETED = "router_ticket_already_completed";
  const STOP = "router_provider_stop_unverified";
  const UNSETTLED = "router_previous_dispatch_unsettled";
  const REFUSAL_MESSAGE = "router group participant reserved: participant TR-1077 (3f0c5a52-3f5e-4a3a-9a53-3a8f0a5d1c11) already holds a reservation.";

  beforeAll(async () => {
    temporary = await startRecoveryPostgres("manager-handover-");
    db = createDb(temporary.connectionString);
    home = await mkdtemp(path.join(tmpdir(), "paperclip-manager-handover-"));
    process.env.PAPERCLIP_HOME = home;
    heartbeat = heartbeatService(db);
    registerServerAdapter({
      type: adapterType, supportsLocalAgentJwt: false,
      execute: async (input) => {
        const issueId = String(input.context.issueId);
        launched.push({ agentId: input.agent.id, issueId, wakeReason: typeof input.context.wakeReason === "string" ? input.context.wakeReason : null });
        const [issue] = await db.select().from(issues).where(eq(issues.id, issueId));
        const refusal = refusals.get(issueId);
        // The router refuses the ROLE the ticket names; the manager's run is not a routed run of that role.
        if (refusal && issue && refusedRoles.get(issueId) === input.agent.id) {
          return { exitCode: 1, signal: null, timedOut: false, errorCode: refusal, errorMessage: REFUSAL_MESSAGE };
        }
        // Any other run (the manager's) is at work until the test lets it end: what the server did is read
        // while the manager has decided nothing yet.
        if (holdRuns) await new Promise<void>((resolve) => held.push(resolve));
        return { exitCode: 0, signal: null, timedOut: false, resultJson: {} };
      },
      testEnvironment: async () => ({ adapterType, status: "pass", checks: [], testedAt: new Date().toISOString() }),
    });
  }, 240_000);
  const refusedRoles = new Map<string, string>();
  let holdRuns = true;
  const held: Array<() => void> = [];
  const endHeldRuns = async () => {
    holdRuns = false;
    for (const resolve of held.splice(0)) resolve();
    await heartbeat.drainActiveRunExecutions();
  };
  afterEach(async () => {
    await endHeldRuns();
    holdRuns = true;
  });

  afterAll(async () => {
    await heartbeat?.drainActiveRunExecutions();
    unregisterServerAdapter(adapterType);
    await db?.$client.end({ timeout: 0 });
    await temporary?.cleanup();
    if (oldHome === undefined) delete process.env.PAPERCLIP_HOME; else process.env.PAPERCLIP_HOME = oldHome;
    if (home) await rm(home, { recursive: true, force: true });
  });

  type PriorRun = { minutesAgo: number; errorCode: string | null; status?: string; error?: string; durationMinutes?: number; retry?: boolean };
  type Fixture = { companyId: string; userId: string; ceoId: string; managerId: string; agentId: string; issueId: string; runIds: string[] };

  /** CEO, then CTO (the manager), then the role the ticket is assigned to. */
  async function seed(status: "todo" | "in_progress" | "in_review" | "blocked", prior: PriorRun[],
    opts: { manager?: false | "paused"; review?: boolean } = {}): Promise<Fixture> {
    const companyId = randomUUID(), ceoId = randomUUID(), managerId = randomUUID(), agentId = randomUUID(), issueId = randomUUID();
    const userId = `handover-user-${companyId}`;
    await db.insert(authUsers).values({ id: userId, name: "Board user", email: `${userId}@example.test`, createdAt: new Date(), updatedAt: new Date() });
    await db.insert(companies).values({ id: companyId, name: "Hand-over fixture", issuePrefix: `H${companyId.slice(0, 6)}` });
    await db.insert(companyMemberships).values({ companyId, principalId: userId, principalType: "user", status: "active", membershipRole: "member" });
    await db.insert(agents).values({ id: ceoId, companyId, name: "CEO", role: "ceo", adapterType, status: "idle", adapterConfig: {} });
    await db.insert(agents).values({
      id: managerId, companyId, name: "CTO", role: "cto", adapterType, adapterConfig: {}, reportsTo: ceoId,
      status: opts.manager === "paused" ? "paused" : "idle",
      ...(opts.manager === "paused" ? { pauseReason: "manual", pausedAt: new Date() } : {}),
    });
    await db.insert(agents).values({
      id: agentId, companyId, name: "Dev Unity", adapterType, status: "idle", adapterConfig: {},
      reportsTo: opts.manager === false ? null : managerId,
    });
    for (const id of [ceoId, managerId, agentId]) {
      await db.insert(companyMemberships).values({ companyId, principalId: id, principalType: "agent", status: "active", membershipRole: "member" });
    }
    const runIds: string[] = [];
    for (const run of prior) runIds.push(await priorRun({ companyId, agentId, issueId }, run));
    await db.insert(issues).values({
      id: issueId, companyId, title: "Routed task", status, assigneeAgentId: agentId, responsibleUserId: userId, issueNumber: 1,
      identifier: `H${companyId.slice(0, 6)}-1`,
      checkoutRunId: status === "in_progress" ? runIds[runIds.length - 1] ?? null : null,
      startedAt: status === "in_progress" ? new Date() : null,
      ...(opts.review ? {
        executionState: {
          status: "pending", currentStageId: randomUUID(), currentStageIndex: 0, currentStageType: "review",
          currentParticipant: { type: "agent", agentId, userId: null },
          returnAssignee: { type: "agent", agentId, userId: null },
          reviewRequest: null, completedStageIds: [], lastDecisionId: null, lastDecisionOutcome: null,
        },
      } : {}),
    });
    refusedRoles.set(issueId, agentId);
    return { companyId, userId, ceoId, managerId, agentId, issueId, runIds };
  }

  async function priorRun(f: { companyId: string; agentId: string; issueId: string }, run: PriorRun) {
    const createdAt = new Date(Date.now() - run.minutesAgo * 60_000);
    const end = new Date(createdAt.getTime() + (run.durationMinutes ?? 1) * 60_000);
    const [row] = await db.insert(heartbeatRuns).values({
      companyId: f.companyId, agentId: f.agentId, invocationSource: "assignment", triggerDetail: "system",
      status: run.status ?? "failed", errorCode: run.errorCode,
      error: run.error ?? (run.errorCode ? REFUSAL_MESSAGE : null),
      createdAt, startedAt: createdAt, updatedAt: end, finishedAt: end,
      resultJson: { executionRecovery: { kind: "bootstrap", providerWorkStarted: false } },
      contextSnapshot: {
        issueId: f.issueId, taskId: f.issueId,
        wakeReason: run.retry ? "issue_assignment_recovery" : "issue_assigned",
        ...(run.retry ? { retryReason: "assignment_recovery" } : {}),
      },
    }).returning();
    return row!.id;
  }

  const issueOf = async (issueId: string) => (await db.select().from(issues).where(eq(issues.id, issueId)))[0]!;
  const runsOf = (companyId: string, agentId: string) => db.select().from(heartbeatRuns)
    .where(and(eq(heartbeatRuns.companyId, companyId), eq(heartbeatRuns.agentId, agentId)));
  const commentsOf = (issueId: string) => db.select().from(issueComments).where(eq(issueComments.issueId, issueId));
  const actionsOf = (issueId: string) => db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.sourceIssueId, issueId));
  const handoversOf = async (issueId: string) => (await db.select().from(activityLog)
    .where(and(eq(activityLog.entityId, issueId), eq(activityLog.action, MANAGER_HANDOVER_ACTIVITY_ACTION))))
    .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
  const handoverNotices = async (issueId: string) => (await commentsOf(issueId))
    .filter((row) => row.authorType === "system" && row.body.includes("Handed to CTO for review"));
  const blockNotices = async (issueId: string) => (await commentsOf(issueId))
    .filter((row) => row.authorType === "system" && row.body.includes("Moving the issue to `blocked`"));
  const wakesOf = (companyId: string, agentId: string, reason: string) => db.select().from(agentWakeupRequests)
    .where(and(eq(agentWakeupRequests.companyId, companyId), eq(agentWakeupRequests.agentId, agentId), eq(agentWakeupRequests.reason, reason)));
  const sweep = (f: { companyId: string }) => heartbeat.reconcileStrandedAssignedIssues({ companyId: f.companyId });
  const managerLaunches = (f: Fixture, managerId = f.managerId) => launched.filter((launch) => launch.issueId === f.issueId && launch.agentId === managerId);

  async function expectHanded(f: Fixture, code: string, from: "todo" | "in_progress") {
    const issue = await issueOf(f.issueId);
    expect(issue).toMatchObject({ status: "in_review", assigneeAgentId: f.managerId, assigneeUserId: null });
    expect(await actionsOf(f.issueId)).toHaveLength(0);
    expect(await blockNotices(f.issueId)).toHaveLength(0);
    const handovers = await handoversOf(f.issueId);
    expect(handovers[handovers.length - 1]!.details).toMatchObject({
      cause: "router_refusal", code, fromAgentId: f.agentId, toAgentId: f.managerId, previousStatus: from, status: "in_review",
    });
  }

  it("names the eight refusals, none of them retried, and has a note for each", () => {
    expect(ROUTER_REFUSAL_ERROR_CODES).toEqual([ENDED, CLOSED, MISMATCH, RESERVED, BLOCK_INVALID, SYSTEM_UNKNOWN, ATTEMPT_USED, TICKET_COMPLETED]);
    for (const code of [MISMATCH, RESERVED, BLOCK_INVALID, SYSTEM_UNKNOWN, ATTEMPT_USED, TICKET_COMPLETED]) {
      for (const status of ["todo", "in_progress", "in_review"]) expect(routerRefusalOutcome(code, status)).toBe("block");
    }
    for (const code of ROUTER_REFUSAL_ERROR_CODES) {
      const note = routerRefusalHandoverNote(code, REFUSAL_MESSAGE)!;
      expect(note.body).toContain(`(\`${code}\`)`);
      expect(note.body).toContain("Handed to {manager} for review: ");
      expect(note.nextAction.endsWith(".")).toBe(true);
    }
    expect(routerRefusalHandoverNote("timeout", null)).toBeNull();
    // The two refusals with a fixed meaning say it; the others quote the run's own message.
    expect(routerRefusalHandoverNote(ENDED, REFUSAL_MESSAGE)!.body).toBe(
      "The worker router refused this run before reserving any machine (`router_group_participant_ended`): this participant finished its part of the coordinated session and returned its machine. "
      + "This role gets no other run of its own on this ticket while the other participants are at work; afterwards only the whole group can be reserved again, if none of its tickets was closed. "
      + "Handed to {manager} for review: close it; or, to make it work again, end the failed attempt and declare a new attempt of the session in the coordination ticket.",
    );
    expect(routerRefusalHandoverNote(CLOSED, null)!.body).toBe(
      "The worker router refused this run before reserving any machine (`router_group_participant_closed`): another participant of this ticket's group is done or cancelled, so the group cannot be reserved again as it is. "
      + "Handed to {manager} for review: close it; or, to make the session work again, declare a new attempt in the coordination ticket with participant tickets that are all open.",
    );
    expect(routerRefusalHandoverNote(RESERVED, REFUSAL_MESSAGE)!.body).toBe(
      "The worker router refused this run before reserving any machine (`router_group_participant_reserved`): "
      + "router group participant reserved: participant TR-1077 (3f0c5a52-3f5e-4a3a-9a53-3a8f0a5d1c11) already holds a reservation. "
      + "Asking again cannot pass. Handed to {manager} for review: in the participants list of the coordination ticket, replace that ticket by a new sub-ticket of the coordination ticket, "
      + "assigned to the same role and never run; the new ticket must not run before the list names it. The list uses internal ticket ids.",
    );
    // Without a message the note falls back on the meaning of the code.
    expect(routerRefusalHandoverNote(BLOCK_INVALID, "  ")!.body).toContain("): the `worker-router` block of this ticket's description cannot be read. Asking again cannot pass.");
  });

  // The release of the refused run itself: no sweep is needed.
  it.each([
    [ENDED, "todo"], [ENDED, "in_progress"], [CLOSED, "todo"], [CLOSED, "in_progress"],
  ] as const)("TR-2030: a run refused %s on a ticket %s hands the ticket to the manager at once, with no Board action", async (code, status) => {
    const f = await seed(status, []);
    refusals.set(f.issueId, code);
    const run = await heartbeat.wakeup(f.agentId, {
      source: "on_demand", triggerDetail: "manual", reason: "issue_status_changed",
      payload: { issueId: f.issueId }, contextSnapshot: { issueId: f.issueId },
    });
    await expect.poll(async () => (await issueOf(f.issueId)).status, { timeout: 30_000 }).toBe("in_review");
    // A run that starts takes a `todo` ticket to `in_progress`: that is the status the hand-over finds.
    await expectHanded(f, code, "in_progress");
    // The role's refused run is not retried.
    expect((await runsOf(f.companyId, f.agentId)).map((row) => `${row.id}:${row.status}:${row.errorCode}`)).toEqual([`${run!.id}:failed:${code}`]);
    const [notice] = await handoverNotices(f.issueId);
    expect(notice!.body).toBe(routerRefusalHandoverNote(code, REFUSAL_MESSAGE)!.body.replace("{manager}", "CTO"));
    expect(notice!.presentation).toMatchObject({ kind: "system_notice", tone: "warning" });
    expect(JSON.stringify(notice!.metadata)).toContain(routerRefusalHandoverNote(code, REFUSAL_MESSAGE)!.nextAction);
    // The manager is woken once, on this ticket, and its run starts.
    await expect.poll(async () => (await wakesOf(f.companyId, f.managerId, MANAGER_HANDOVER_WAKE_REASON)).length, { timeout: 30_000 }).toBe(1);
    const wakes = await wakesOf(f.companyId, f.managerId, MANAGER_HANDOVER_WAKE_REASON);
    expect(wakes[0]!.idempotencyKey).toBe(`manager-handover:${f.issueId}:${run!.id}`);
    // The hand-over is made while the refused run is still being released: the queue keeps the manager's wake as a
    // hand-over wake (STUDIO-0066) and its periodic pass admits it. The pass is run here as the server runs it.
    await expect.poll(async () => {
      await heartbeat.resumeQueuedRuns();
      return managerLaunches(f).map((launch) => launch.wakeReason);
    }, { timeout: 30_000, interval: 1_000 }).toEqual([MANAGER_HANDOVER_WAKE_REASON]);
    // The kept wake and its admission are two rows of the queue for one run of the manager; further passes start nothing.
    await heartbeat.resumeQueuedRuns();
    await heartbeat.resumeQueuedRuns();
    expect(managerLaunches(f)).toHaveLength(1);
    expect(await runsOf(f.companyId, f.managerId)).toHaveLength(1);
    // Further sweeps change nothing: the ticket is the manager's, in review.
    await sweep(f); await sweep(f);
    expect(await handoversOf(f.issueId)).toHaveLength(1);
    expect(await handoverNotices(f.issueId)).toHaveLength(1);
    expect(await actionsOf(f.issueId)).toHaveLength(0);
  }, 180_000);

  it.each([RESERVED, MISMATCH, BLOCK_INVALID, SYSTEM_UNKNOWN, ATTEMPT_USED, TICKET_COMPLETED] as const)(
    "the sweep hands a ticket at work whose latest run was refused %s, and the note quotes the run's message", async (code) => {
      const f = await seed("todo", [{ minutesAgo: 6, errorCode: code }]);
      const result = await sweep(f);
      expect(result.issueIds).toContain(f.issueId);
      await expectHanded(f, code, "todo");
      const [notice] = await handoverNotices(f.issueId);
      expect(notice!.body).toContain(`(\`${code}\`): router group participant reserved: participant TR-1077`);
      expect(notice!.body).toContain("Asking again cannot pass. Handed to CTO for review: ");
      expect(await wakesOf(f.companyId, f.managerId, MANAGER_HANDOVER_WAKE_REASON)).toHaveLength(1);
      expect(await runsOf(f.companyId, f.agentId)).toHaveLength(1);
    }, 180_000);

  it("a role without a manager is blocked as before, with the Board action", async () => {
    const f = await seed("todo", [{ minutesAgo: 6, errorCode: ENDED }], { manager: false });
    await sweep(f);
    expect(await issueOf(f.issueId)).toMatchObject({ status: "blocked", assigneeAgentId: f.agentId });
    expect(await actionsOf(f.issueId)).toEqual([expect.objectContaining({ kind: "stranded_assigned_issue", status: "active", ownerType: "board" })]);
    expect(await blockNotices(f.issueId)).toHaveLength(1);
    expect(await handoversOf(f.issueId)).toHaveLength(0);
  }, 180_000);

  it("a manager that is not invokable does not receive the ticket: blocked as before", async () => {
    const f = await seed("in_progress", [{ minutesAgo: 6, errorCode: CLOSED }], { manager: "paused" });
    await sweep(f);
    expect(await issueOf(f.issueId)).toMatchObject({ status: "blocked", assigneeAgentId: f.agentId });
    expect(await actionsOf(f.issueId)).toHaveLength(1);
    expect(await handoversOf(f.issueId)).toHaveLength(0);
    expect(await wakesOf(f.companyId, f.managerId, MANAGER_HANDOVER_WAKE_REASON)).toHaveLength(0);
  }, 180_000);

  it("a ticket in review is not handed: TR-1318 keeps its note, and a refusal a gesture lifts keeps its block", async () => {
    const ended = await seed("in_review", [{ minutesAgo: 6, errorCode: ENDED }], { review: true });
    await sweep(ended);
    expect(await issueOf(ended.issueId)).toMatchObject({ status: "in_review", assigneeAgentId: ended.agentId });
    expect(await actionsOf(ended.issueId)).toHaveLength(0);
    expect(await handoversOf(ended.issueId)).toHaveLength(0);
    const reserved = await seed("in_review", [{ minutesAgo: 6, errorCode: RESERVED }], { review: true });
    await sweep(reserved);
    expect(await issueOf(reserved.issueId)).toMatchObject({ status: "blocked", assigneeAgentId: reserved.agentId });
    expect(await actionsOf(reserved.issueId)).toHaveLength(1);
    expect(await handoversOf(reserved.issueId)).toHaveLength(0);
  }, 180_000);

  it("a ticket that still holds an environment lease of another run is not handed: blocked as before", async () => {
    const f = await seed("todo", [{ minutesAgo: 30, errorCode: null, status: "succeeded" }, { minutesAgo: 6, errorCode: ENDED }]);
    await db.insert(environmentLeases).values({ companyId: f.companyId, issueId: f.issueId, heartbeatRunId: f.runIds[0]!, status: "active", provider: "ssh" });
    await sweep(f);
    expect(await issueOf(f.issueId)).toMatchObject({ status: "blocked", assigneeAgentId: f.agentId });
    expect(await handoversOf(f.issueId)).toHaveLength(0);
    // The lease of the refused run itself does not hold the ticket: its own end releases it.
    const own = await seed("todo", [{ minutesAgo: 6, errorCode: ENDED }]);
    await db.insert(environmentLeases).values({ companyId: own.companyId, issueId: own.issueId, heartbeatRunId: own.runIds[0]!, status: "active", provider: "ssh" });
    await sweep(own);
    await expectHanded(own, ENDED, "todo");
    // A released lease holds nothing.
    const released = await seed("todo", [{ minutesAgo: 30, errorCode: null, status: "succeeded" }, { minutesAgo: 6, errorCode: ENDED }]);
    await db.insert(environmentLeases).values({
      companyId: released.companyId, issueId: released.issueId, heartbeatRunId: released.runIds[0]!, status: "released", releasedAt: new Date(), provider: "ssh",
    });
    await sweep(released);
    await expectHanded(released, ENDED, "todo");
  }, 180_000);

  it("the hand-over itself refuses a ticket with a run queued or running, a changed assignee, or a ticket not at work", async () => {
    const note = routerRefusalHandoverNote(ENDED, null)!;
    const call = (f: Fixture, runId: string) => handIssueToManager(db, { enqueueWakeup: async () => null }, {
      issue: { id: f.issueId, companyId: f.companyId }, fromAgentId: f.agentId, cause: "router_refusal", code: ENDED,
      sourceRun: { id: runId, status: "failed", agentId: f.agentId }, note,
    });
    const live = await seed("todo", [{ minutesAgo: 6, errorCode: ENDED }]);
    await db.insert(heartbeatRuns).values({
      companyId: live.companyId, agentId: live.ceoId, invocationSource: "on_demand", triggerDetail: "system", status: "queued",
      contextSnapshot: { issueId: live.issueId, taskId: live.issueId },
    });
    expect(await call(live, live.runIds[0]!)).toEqual({ handed: false, reason: "still_held" });
    const moved = await seed("todo", [{ minutesAgo: 6, errorCode: ENDED }]);
    await db.update(issues).set({ assigneeAgentId: moved.ceoId }).where(eq(issues.id, moved.issueId));
    expect(await call(moved, moved.runIds[0]!)).toEqual({ handed: false, reason: "assignee_changed" });
    const blocked = await seed("blocked", [{ minutesAgo: 6, errorCode: ENDED }]);
    expect(await call(blocked, blocked.runIds[0]!)).toEqual({ handed: false, reason: "issue_not_at_work" });
    const locked = await seed("in_progress", [{ minutesAgo: 6, errorCode: ENDED }]);
    const [lock] = await db.insert(heartbeatRuns).values({
      companyId: locked.companyId, agentId: locked.agentId, invocationSource: "on_demand", triggerDetail: "system", status: "running",
      startedAt: new Date(), contextSnapshot: {},
    }).returning();
    await db.update(issues).set({ executionRunId: lock!.id }).where(eq(issues.id, locked.issueId));
    expect(await call(locked, locked.runIds[0]!)).toEqual({ handed: false, reason: "still_held" });
    for (const f of [live, moved, blocked, locked]) expect(await handoversOf(f.issueId)).toHaveLength(0);
    // The same ticket, nothing held: handed, and the same run never causes a second hand-over.
    await db.update(heartbeatRuns).set({ status: "failed", finishedAt: new Date() }).where(eq(heartbeatRuns.id, lock!.id));
    expect(await call(locked, locked.runIds[0]!)).toMatchObject({ handed: true, managerAgentId: locked.managerId, managerName: "CTO" });
    await db.update(issues).set({ assigneeAgentId: locked.agentId, status: "todo" }).where(eq(issues.id, locked.issueId));
    expect(await call(locked, locked.runIds[0]!)).toEqual({ handed: false, reason: "run_already_handed" });
  }, 180_000);

  // The manager gives the ticket back to the role in the run it was woken for, and that run ends.
  async function giveBack(f: Fixture) {
    await db.update(issues).set({ assigneeAgentId: f.agentId, status: "todo", updatedAt: new Date() }).where(eq(issues.id, f.issueId));
    await endHeldRuns();
    holdRuns = true;
  }
  // The role is served again and the router refuses it again: by the server's own path if it restarts the role,
  // else by a refused run written here.
  async function refusedOnceMore(f: Fixture) {
    const before = (await runsOf(f.companyId, f.agentId)).length;
    await sweep(f);
    await new Promise((resolve) => setTimeout(resolve, 2_000));
    if ((await runsOf(f.companyId, f.agentId)).length === before) {
      await priorRun(f, { minutesAgo: 0, errorCode: refusals.get(f.issueId)!, durationMinutes: 0 });
      await sweep(f);
    }
  }

  // The to-and-fro of TR-2069, kept away: the manager gives the ticket back, the router refuses again.
  it("given back by the manager: the old refusal is not read again; a new refusal hands it once more, a third one is the Board's", async () => {
    const f = await seed("todo", [{ minutesAgo: 30, errorCode: ENDED }]);
    refusals.set(f.issueId, ENDED);
    await sweep(f);
    await expectHanded(f, ENDED, "todo");
    expect((await handoversOf(f.issueId))[0]!.details).toMatchObject({ sourceRunId: f.runIds[0], handoverInSeries: 1 });

    // 1. Given back. The refusal that caused the hand-over is older than it: it hands nothing again. A NEW refusal
    //    does: handed a second time, under its own run, and the note says it is the last.
    await giveBack(f);
    await refusedOnceMore(f);
    await expect.poll(async () => (await handoversOf(f.issueId)).length, { timeout: 60_000 }).toBe(2);
    await expectHanded(f, ENDED, (await handoversOf(f.issueId))[1]!.details!.previousStatus as "todo" | "in_progress");
    const second = (await handoversOf(f.issueId))[1]!.details as Record<string, unknown>;
    expect(second).toMatchObject({ handoverInSeries: 2 });
    expect(second.sourceRunId).not.toBe(f.runIds[0]);
    const notices = await handoverNotices(f.issueId);
    expect(notices).toHaveLength(2);
    expect(notices.filter((notice) => notice.body.includes("it will not be handed a third time"))).toHaveLength(1);
    await expect.poll(async () => (await wakesOf(f.companyId, f.managerId, MANAGER_HANDOVER_WAKE_REASON)).length, { timeout: 30_000 }).toBe(2);
    expect(await actionsOf(f.issueId)).toHaveLength(0);

    // 2. Given back again, refused again: the series is spent, today's block with its Board action.
    expect(MANAGER_HANDOVER_MAX_PER_SERIES).toBe(2);
    await giveBack(f);
    await refusedOnceMore(f);
    await expect.poll(async () => (await issueOf(f.issueId)).status, { timeout: 60_000 }).toBe("blocked");
    expect(await issueOf(f.issueId)).toMatchObject({ assigneeAgentId: f.agentId });
    expect(await handoversOf(f.issueId)).toHaveLength(2);
    expect(await actionsOf(f.issueId)).toEqual([expect.objectContaining({ kind: "stranded_assigned_issue", status: "active", ownerType: "board" })]);
    expect(await blockNotices(f.issueId)).toHaveLength(1);
  }, 240_000);

  // The sweep itself must not read again the refusal that caused the hand-over: given back in progress, the role's
  // latest run on the ticket is still that refused run.
  it("given back in progress, the sweep neither hands the ticket again nor blocks it on the refusal already handed", async () => {
    const f = await seed("in_progress", [{ minutesAgo: 30, errorCode: CLOSED }]);
    refusals.delete(f.issueId);
    await sweep(f);
    await expectHanded(f, CLOSED, "in_progress");
    await db.update(issues).set({ assigneeAgentId: f.agentId, status: "in_progress", updatedAt: new Date() }).where(eq(issues.id, f.issueId));
    await endHeldRuns();
    holdRuns = true;
    await sweep(f);
    await sweep(f);
    expect(await actionsOf(f.issueId)).toHaveLength(0);
    expect(await blockNotices(f.issueId)).toHaveLength(0);
    expect(await handoversOf(f.issueId)).toHaveLength(1);
    expect(await issueOf(f.issueId)).toMatchObject({ assigneeAgentId: f.agentId });
    expect((await issueOf(f.issueId)).status).not.toBe("blocked");
  }, 180_000);

  // What follows when the manager does nothing with the ticket it received: the product's own path for a ticket in
  // review that nobody reviews. One more wake of the manager, then a block with a Board action.
  it("the manager decides nothing: it is woken once more by the review path, then the ticket is blocked for the Board", async () => {
    holdRuns = false;
    const f = await seed("todo", [{ minutesAgo: 6, errorCode: ENDED }]);
    await sweep(f);
    await expect.poll(async () => (await issueOf(f.issueId)).status, { timeout: 60_000 }).toBe("blocked");
    await heartbeat.drainActiveRunExecutions();
    expect(await issueOf(f.issueId)).toMatchObject({ status: "blocked", assigneeAgentId: f.managerId });
    expect(managerLaunches(f).map((launch) => launch.wakeReason)).toEqual([MANAGER_HANDOVER_WAKE_REASON, "issue_review_path_lost"]);
    expect((await actionsOf(f.issueId)).map((action) => `${action.ownerType}:${action.status}`)).toEqual(["board:active"]);
    expect(await handoversOf(f.issueId)).toHaveLength(1);
  }, 180_000);

  it("a run of the role that was not refused opens a new series", async () => {
    const f = await seed("todo", [{ minutesAgo: 60, errorCode: ENDED }]);
    refusals.set(f.issueId, ENDED);
    await sweep(f);
    await giveBack(f);
    await refusedOnceMore(f);
    await expect.poll(async () => (await handoversOf(f.issueId)).map((row) => (row.details as Record<string, unknown>).handoverInSeries), { timeout: 60_000 })
      .toEqual([1, 2]);
    // The session works again: the role runs and ends well. Later, a new refusal.
    await giveBack(f);
    await new Promise((resolve) => setTimeout(resolve, 20));
    await priorRun(f, { minutesAgo: 0, errorCode: null, status: "succeeded", durationMinutes: 0 });
    await new Promise((resolve) => setTimeout(resolve, 20));
    await priorRun(f, { minutesAgo: 0, errorCode: ENDED, durationMinutes: 0 });
    await sweep(f);
    await expect.poll(async () => (await handoversOf(f.issueId)).map((row) => (row.details as Record<string, unknown>).handoverInSeries), { timeout: 60_000 })
      .toEqual([1, 2, 1]);
    expect(await actionsOf(f.issueId)).toHaveLength(0);
    expect((await handoverNotices(f.issueId)).filter((notice) => notice.body.includes("it will not be handed a third time"))).toHaveLength(1);
  }, 240_000);

  describe("with its rights of agent, by the real route", () => {
    function appAs(f: Fixture, agentId: string, runId: string) {
      const app = express();
      app.use(express.json());
      app.use((req, _res, next) => {
        (req as unknown as { actor: unknown }).actor = { type: "agent", agentId, companyId: f.companyId, runId, source: "agent_jwt" };
        next();
      });
      app.use("/api", issueRoutes(db, {} as never, {}));
      app.use(errorHandler);
      return app;
    }
    async function runOf(f: Fixture, agentId: string) {
      const [run] = await db.insert(heartbeatRuns).values({
        companyId: f.companyId, agentId, invocationSource: "on_demand", triggerDetail: "system", status: "running",
        startedAt: new Date(), contextSnapshot: { issueId: f.issueId, taskId: f.issueId },
      }).returning();
      return run!.id;
    }
    const endRun = (runId: string) => db.update(heartbeatRuns).set({ status: "succeeded", finishedAt: new Date() }).where(eq(heartbeatRuns.id, runId));

    it("the manager closes the ticket it received, in the run it was woken for", async () => {
      const f = await seed("todo", [{ minutesAgo: 6, errorCode: ENDED }]);
      await sweep(f);
      await expect.poll(() => managerLaunches(f).length, { timeout: 30_000 }).toBe(1);
      const [wokenRun] = (await runsOf(f.companyId, f.managerId)).filter((row) => row.status === "running");
      const response = await request(appAs(f, f.managerId, wokenRun!.id)).patch(`/api/issues/${f.issueId}`).send({ status: "done" });
      expect(response.status, JSON.stringify(response.body)).toBe(200);
      expect((await issueOf(f.issueId)).status).toBe("done");
    }, 180_000);

    it("the manager gives the ticket back to the role", async () => {
      const f = await seed("todo", [{ minutesAgo: 6, errorCode: ENDED }]);
      await sweep(f);
      await db.insert(principalPermissionGrants).values({
        companyId: f.companyId, principalType: "agent", principalId: f.managerId, permissionKey: "tasks:assign", scope: null,
      });
      refusals.delete(f.issueId);
      const runId = await runOf(f, f.managerId);
      const response = await request(appAs(f, f.managerId, runId)).patch(`/api/issues/${f.issueId}`)
        .send({ status: "todo", assigneeAgentId: f.agentId });
      expect(response.status, JSON.stringify(response.body)).toBe(200);
      expect(await issueOf(f.issueId)).toMatchObject({ status: "todo", assigneeAgentId: f.agentId });
      await endRun(runId);
    }, 180_000);

    // L12: who settled what, for which role, in what capacity.
    async function blockedWithAction(f: Fixture) {
      await db.update(issues).set({ status: "blocked" }).where(eq(issues.id, f.issueId));
      const action = await issueRecoveryActionService(db).upsertSourceScoped({
        companyId: f.companyId, sourceIssueId: f.issueId, kind: "stranded_assigned_issue", ownerType: "board",
        previousOwnerAgentId: f.agentId, returnOwnerAgentId: f.agentId,
        cause: "stranded_assigned_issue", fingerprint: `stranded:${f.issueId}`, evidence: { latestRunId: "run-1" },
        nextAction: "Choose the next action.", wakePolicy: { type: "manual" },
      });
      return action.id;
    }
    const settle = (f: Fixture, agentId: string, runId: string, actionId: string) =>
      request(appAs(f, agentId, runId)).post(`/api/issues/${f.issueId}/recovery-actions/resolve`)
        .send({ actionId, outcome: "restored", sourceIssueStatus: "todo", resolutionNote: "Looked at it." });
    const settlementNotes = async (issueId: string) => (await commentsOf(issueId))
      .filter((row) => row.authorType === "system" && row.body.includes("settled the recovery action of this ticket"));
    const resolvedActivity = async (issueId: string) => (await db.select().from(activityLog)
      .where(and(eq(activityLog.entityId, issueId), eq(activityLog.action, "issue.recovery_action_resolved"))))[0];

    it("a manager settles the Board action of a role that reports to it: the ticket says who, for whom and as what", async () => {
      const f = await seed("todo", []);
      const actionId = await blockedWithAction(f);
      const runId = await runOf(f, f.managerId);
      const response = await settle(f, f.managerId, runId, actionId);
      expect(response.status, JSON.stringify(response.body)).toBe(200);
      const notes = await settlementNotes(f.issueId);
      expect(notes).toHaveLength(1);
      expect(notes[0]!.body).toBe("CTO settled the recovery action of this ticket for Dev Unity, as a manager in its reporting chain. Outcome: `handed_back`; ticket status: `todo`.");
      expect((await resolvedActivity(f.issueId))!.details).toMatchObject({
        recoveryActionId: actionId, settledByAgentId: f.managerId, settledForAgentId: f.agentId, settledAs: "reporting_chain",
      });
      await endRun(runId);
    }, 180_000);

    it("two levels up, the CEO settles it as CEO; a role with the direct right, by that right", async () => {
      const f = await seed("todo", []);
      const ceoRun = await runOf(f, f.ceoId);
      expect((await settle(f, f.ceoId, ceoRun, await blockedWithAction(f))).status).toBe(200);
      expect((await settlementNotes(f.issueId))[0]!.body).toContain("CEO settled the recovery action of this ticket for Dev Unity, as CEO.");
      await endRun(ceoRun);
      const g = await seed("todo", []);
      const peerId = randomUUID();
      await db.insert(agents).values({ id: peerId, companyId: g.companyId, name: "Game Designer", adapterType, status: "idle", adapterConfig: {}, reportsTo: g.ceoId });
      await db.insert(companyMemberships).values({ companyId: g.companyId, principalId: peerId, principalType: "agent", status: "active", membershipRole: "member" });
      await db.insert(principalPermissionGrants).values({
        companyId: g.companyId, principalType: "agent", principalId: peerId, permissionKey: "tasks:manage_active_checkouts", scope: null,
      });
      const peerRun = await runOf(g, peerId);
      expect((await settle(g, peerId, peerRun, await blockedWithAction(g))).status).toBe(200);
      expect((await settlementNotes(g.issueId))[0]!.body).toContain(
        "Game Designer settled the recovery action of this ticket for Dev Unity, by its right over other agents' checked-out work (`tasks:manage_active_checkouts`).");
      expect((await resolvedActivity(g.issueId))!.details).toMatchObject({ settledAs: "direct_right" });
      await endRun(peerRun);
    }, 180_000);

    it("the assignee settles its own: the activity says so, the ticket gets no note; a peer without the right is refused", async () => {
      const f = await seed("todo", []);
      const peerId = randomUUID();
      await db.insert(agents).values({ id: peerId, companyId: f.companyId, name: "Game Designer", adapterType, status: "idle", adapterConfig: {}, reportsTo: f.ceoId });
      await db.insert(companyMemberships).values({ companyId: f.companyId, principalId: peerId, principalType: "agent", status: "active", membershipRole: "member" });
      const actionId = await blockedWithAction(f);
      const peerRun = await runOf(f, peerId);
      expect((await settle(f, peerId, peerRun, actionId)).status).toBe(403);
      await endRun(peerRun);
      expect(await settlementNotes(f.issueId)).toHaveLength(0);
      expect(await resolvedActivity(f.issueId)).toBeUndefined();
      const ownRun = await runOf(f, f.agentId);
      expect((await settle(f, f.agentId, ownRun, actionId)).status).toBe(200);
      expect(await settlementNotes(f.issueId)).toHaveLength(0);
      expect((await resolvedActivity(f.issueId))!.details).toMatchObject({ settledByAgentId: f.agentId, settledForAgentId: f.agentId, settledAs: "assignee" });
      await endRun(ownRun);
    }, 180_000);
  });

  // L16. A block that still needs the Board woke nobody: only the watch warned the operator.
  describe("a block with a Board action wakes the direct manager of the role, once", () => {
    const BOARD_WAKE = "issue_commented";
    const managerNotices = async (issueId: string) => (await commentsOf(issueId))
      .filter((row) => row.authorType === "system" && (row.presentation as { title?: string } | null)?.title === BOARD_BLOCK_MANAGER_NOTICE_TITLE);
    // An unproven stop that outlasted its bound: normal escalation, "No live execution path".
    const spent = (opts: Parameters<typeof seed>[2] = {}) =>
      seed("todo", [{ minutesAgo: 13 * 60, errorCode: STOP, durationMinutes: 5 }, { minutesAgo: 10, errorCode: UNSETTLED, durationMinutes: 5, retry: true }], opts);

    it("the manager is woken once per action, with the ticket, the action and the cause", async () => {
      const f = await spent();
      await sweep(f);
      expect((await issueOf(f.issueId)).status).toBe("blocked");
      const [action] = await actionsOf(f.issueId);
      expect(action).toMatchObject({ kind: "stranded_assigned_issue", status: "active", ownerType: "board" });
      const wakes = await wakesOf(f.companyId, f.managerId, BOARD_WAKE);
      expect(wakes).toHaveLength(1);
      expect(wakes[0]!.idempotencyKey).toBe(`board-recovery-manager-wake:${action!.id}`);
      const [notice] = await managerNotices(f.issueId);
      expect(notice!.body).toBe(
        "This ticket of Dev Unity was blocked with a recovery action only the Board can settle (`stranded_assigned_issue`). "
        + "CTO, its direct manager, is woken once to look at it: settle the recovery action if the way forward is clear, or tell the operator. "
        + "The ticket stays blocked and stays assigned as it is.");
      expect(wakes[0]!.payload).toMatchObject({ issueId: f.issueId, commentId: notice!.id, recoveryActionId: action!.id });
      await expect.poll(() => managerLaunches(f).map((launch) => launch.wakeReason), { timeout: 30_000 }).toEqual([BOARD_WAKE]);
      // The ticket stays the role's, blocked, with its action: the wake changes nothing else.
      expect(await issueOf(f.issueId)).toMatchObject({ status: "blocked", assigneeAgentId: f.agentId });
      await sweep(f); await sweep(f);
      expect(await wakesOf(f.companyId, f.managerId, BOARD_WAKE)).toHaveLength(1);
      expect(await managerNotices(f.issueId)).toHaveLength(1);
      expect(await actionsOf(f.issueId)).toHaveLength(1);
      // The notice is addressed to the manager and wakes the manager alone. The assignee, the role the router or
      // the engine failed, is NOT woken by it: no wake, no run, during the manager's run and after it ends.
      const roleIsLeftAlone = async () => {
        expect(await db.select().from(agentWakeupRequests)
          .where(and(eq(agentWakeupRequests.companyId, f.companyId), eq(agentWakeupRequests.agentId, f.agentId)))).toHaveLength(0);
        expect((await runsOf(f.companyId, f.agentId)).map((row) => row.id).sort()).toEqual([...f.runIds].sort());
        expect(launched.filter((launch) => launch.issueId === f.issueId && launch.agentId === f.agentId)).toHaveLength(0);
      };
      await roleIsLeftAlone();
      await endHeldRuns();
      await sweep(f);
      await heartbeat.resumeQueuedRuns();
      await heartbeat.drainActiveRunExecutions();
      await roleIsLeftAlone();
      expect(await issueOf(f.issueId)).toMatchObject({ status: "blocked", assigneeAgentId: f.agentId });
      expect(await actionsOf(f.issueId)).toHaveLength(1);
      expect(managerLaunches(f)).toHaveLength(1);
    }, 180_000);

    it("a role without a manager wakes nobody; a manager that is not invokable is not woken", async () => {
      const alone = await spent({ manager: false });
      await sweep(alone);
      expect((await issueOf(alone.issueId)).status).toBe("blocked");
      expect(await db.select().from(agentWakeupRequests)
        .where(and(eq(agentWakeupRequests.companyId, alone.companyId), eq(agentWakeupRequests.reason, BOARD_WAKE)))).toHaveLength(0);
      expect(await managerNotices(alone.issueId)).toHaveLength(0);
      const paused = await spent({ manager: "paused" });
      await sweep(paused);
      expect((await issueOf(paused.issueId)).status).toBe("blocked");
      expect(await db.select().from(agentWakeupRequests)
        .where(and(eq(agentWakeupRequests.companyId, paused.companyId), eq(agentWakeupRequests.reason, BOARD_WAKE)))).toHaveLength(0);
      expect(await managerNotices(paused.issueId)).toHaveLength(0);
    }, 180_000);

    it("a manager whose own run led to the block is not woken on it", async () => {
      const f = await seed("blocked", []);
      const woken: string[] = [];
      const call = (runAgentId: string) => wakeManagerOfBlockedIssue(db, { enqueueWakeup: async (agentId) => { woken.push(agentId); return null; } }, {
        issue: { id: f.issueId, companyId: f.companyId, assigneeAgentId: f.agentId },
        recoveryActionId: randomUUID(), cause: "stranded_assigned_issue",
        sourceRun: { id: randomUUID(), agentId: runAgentId, errorCode: "timeout" },
      });
      expect(await call(f.managerId)).toEqual({ woken: false, reason: "manager_is_the_cause" });
      expect(woken).toEqual([]);
      expect(await managerNotices(f.issueId)).toHaveLength(0);
      expect(await call(f.agentId)).toEqual({ woken: true, managerAgentId: f.managerId });
      expect(woken).toEqual([f.managerId]);
      expect(await managerNotices(f.issueId)).toHaveLength(1);
    }, 180_000);

    it("a refusal blocked for the Board (no hand-over possible) wakes the manager's manager of nobody, and the CEO's ticket nobody", async () => {
      // The ticket of the CTO itself, refused, with the CEO as its manager: handed to the CEO.
      const f = await seed("todo", []);
      await db.update(issues).set({ assigneeAgentId: f.managerId }).where(eq(issues.id, f.issueId));
      refusedRoles.set(f.issueId, f.managerId);
      await priorRun({ companyId: f.companyId, agentId: f.managerId, issueId: f.issueId }, { minutesAgo: 6, errorCode: ENDED });
      await sweep(f);
      expect(await issueOf(f.issueId)).toMatchObject({ status: "in_review", assigneeAgentId: f.ceoId });
      // The ticket of the CEO, refused: nobody above. Blocked for the Board, and nobody is woken.
      const g = await seed("todo", []);
      await db.update(issues).set({ assigneeAgentId: g.ceoId }).where(eq(issues.id, g.issueId));
      await priorRun({ companyId: g.companyId, agentId: g.ceoId, issueId: g.issueId }, { minutesAgo: 6, errorCode: ENDED });
      await sweep(g);
      expect(await issueOf(g.issueId)).toMatchObject({ status: "blocked", assigneeAgentId: g.ceoId });
      expect(await actionsOf(g.issueId)).toHaveLength(1);
      expect(await db.select().from(agentWakeupRequests)
        .where(and(eq(agentWakeupRequests.companyId, g.companyId), eq(agentWakeupRequests.reason, BOARD_WAKE)))).toHaveLength(0);
    }, 180_000);
  });
});
