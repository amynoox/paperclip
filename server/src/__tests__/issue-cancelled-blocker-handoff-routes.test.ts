// STUDIO-0029: a cancelled blocker never resolves its dependents. Its
// cancellation hands the dependency back to each assigned dependent's agent,
// and that agent may drop the cancelled blocker and change the status in one
// update. Cancelled blockers still count as unresolved.
import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  activityLog,
  agents,
  companies,
  createDb,
  heartbeatRuns,
  issueComments,
  issueRelations,
  issues,
  projects,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";

vi.setConfig({ testTimeout: 30_000 });

const mockWakeup = vi.hoisted(() => vi.fn(async () => undefined));

vi.mock("../services/index.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../services/index.js")>();
  return {
    ...actual,
    heartbeatService: (db: Parameters<typeof actual.heartbeatService>[0]) => ({
      ...actual.heartbeatService(db),
      wakeup: mockWakeup,
    }),
  };
});

const { errorHandler } = await import("../middleware/index.js");
const { issueRoutes } = await import("../routes/issues.js");

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres cancelled blocker handoff tests on this host: ${
      embeddedPostgresSupport.reason ?? "unsupported environment"
    }`,
  );
}

type Db = ReturnType<typeof createDb>;
type CompanyRow = typeof companies.$inferSelect;
type AgentRow = typeof agents.$inferSelect;

function createApp(db: Db, actor: Express.Request["actor"]) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.actor = actor;
    next();
  });
  app.use("/api", issueRoutes(db, {} as any));
  app.use(errorHandler);
  return app;
}

function boardActor(company: CompanyRow): Express.Request["actor"] {
  return {
    type: "board",
    userId: "board-user",
    companyIds: [company.id],
    memberships: [{ companyId: company.id, membershipRole: "operator", status: "active" }],
    isInstanceAdmin: true,
    source: "local_implicit",
  };
}

function agentActor(company: CompanyRow, agent: AgentRow, runId: string): Express.Request["actor"] {
  return {
    type: "agent",
    agentId: agent.id,
    companyId: company.id,
    runId,
    source: "agent_jwt",
  };
}

describeEmbeddedPostgres("cancelled blocker handoff (STUDIO-0029)", () => {
  let db!: Db;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-cancelled-blocker-handoff-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  beforeEach(() => {
    mockWakeup.mockClear();
  });

  async function seedCompany() {
    const nonce = randomUUID().slice(0, 8);
    const [company] = await db.insert(companies).values({
      name: `Handoff ${nonce}`,
      issuePrefix: `HO${nonce.slice(0, 4).toUpperCase()}`,
      defaultResponsibleUserId: "board-user",
    }).returning();
    const [project] = await db.insert(projects).values({
      companyId: company!.id,
      name: "Core",
      status: "in_progress",
    }).returning();
    return { company: company!, project: project! };
  }

  async function seedAgent(companyId: string) {
    const [agent] = await db.insert(agents).values({
      companyId,
      name: `Agent ${randomUUID().slice(0, 6)}`,
      role: "engineer",
      adapterType: "process",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    }).returning();
    return agent!;
  }

  async function seedIssue(input: {
    companyId: string;
    projectId: string;
    title: string;
    status: string;
    assigneeAgentId?: string | null;
    assigneeUserId?: string | null;
  }) {
    const [issue] = await db.insert(issues).values({
      companyId: input.companyId,
      projectId: input.projectId,
      title: input.title,
      status: input.status,
      priority: "medium",
      assigneeAgentId: input.assigneeAgentId ?? null,
      assigneeUserId: input.assigneeUserId ?? null,
      responsibleUserId: "board-user",
      ...(input.status === "cancelled" ? { cancelledAt: new Date() } : {}),
    }).returning();
    return issue!;
  }

  async function blocks(companyId: string, blockerId: string, blockedId: string) {
    await db.insert(issueRelations).values({
      companyId,
      issueId: blockerId,
      relatedIssueId: blockedId,
      type: "blocks",
    });
  }

  async function startRun(companyId: string, agentId: string, issueId: string) {
    const [run] = await db.insert(heartbeatRuns).values({
      companyId,
      agentId,
      status: "running",
      contextSnapshot: { issueId },
    }).returning();
    await db.update(issues).set({ checkoutRunId: run!.id, executionRunId: run!.id }).where(eq(issues.id, issueId));
    return run!;
  }

  async function blockerIdsOf(issueId: string) {
    const rows = await db.select({ id: issueRelations.issueId }).from(issueRelations)
      .where(and(eq(issueRelations.relatedIssueId, issueId), eq(issueRelations.type, "blocks")));
    return rows.map((row) => row.id).sort();
  }

  async function statusOf(issueId: string) {
    const [row] = await db.select({ status: issues.status }).from(issues).where(eq(issues.id, issueId));
    return row?.status;
  }

  /** A blocked QA follow-up assigned to an agent, waiting on a done and a cancelled prerequisite. */
  async function seedBlockedFollowUp() {
    const { company, project } = await seedCompany();
    const qm = await seedAgent(company.id);
    const followUp = await seedIssue({
      companyId: company.id, projectId: project.id, title: "QA follow-up", status: "blocked", assigneeAgentId: qm.id,
    });
    const cancelled = await seedIssue({ companyId: company.id, projectId: project.id, title: "Cancelled prep", status: "cancelled" });
    const done = await seedIssue({ companyId: company.id, projectId: project.id, title: "Done prep", status: "done" });
    await blocks(company.id, cancelled.id, followUp.id);
    await blocks(company.id, done.id, followUp.id);
    const run = await startRun(company.id, qm.id, followUp.id);
    return { company, project, qm, followUp, cancelled, done, run };
  }

  it("hands the dependency back to the assigned dependent's agent when its blocker is cancelled", async () => {
    const { company, project } = await seedCompany();
    const qm = await seedAgent(company.id);
    const cto = await seedAgent(company.id);
    const followUp = await seedIssue({
      companyId: company.id, projectId: project.id, title: "QA follow-up", status: "blocked", assigneeAgentId: qm.id,
    });
    const prep = await seedIssue({
      companyId: company.id, projectId: project.id, title: "Retest preparation", status: "in_progress", assigneeAgentId: cto.id,
    });
    await blocks(company.id, prep.id, followUp.id);

    const res = await request(createApp(db, boardActor(company)))
      .patch(`/api/issues/${prep.id}`)
      .send({ status: "cancelled" });
    expect(res.status, JSON.stringify(res.body)).toBe(200);

    await vi.waitFor(() => {
      expect(mockWakeup).toHaveBeenCalledWith(
        qm.id,
        expect.objectContaining({ reason: "issue_commented", payload: expect.objectContaining({ issueId: followUp.id }) }),
      );
    });
    const comments = await db.select().from(issueComments).where(eq(issueComments.issueId, followUp.id));
    expect(comments).toHaveLength(1);
    expect(comments[0]).toMatchObject({ authorType: "system" });
    expect(comments[0]!.body).toContain("System dependency handoff");
    expect(comments[0]!.body).toContain(prep.identifier ?? prep.id);

    const call = (mockWakeup.mock.calls as unknown as Array<[string, Record<string, any>]>)
      .find(([agentId]) => agentId === qm.id)!;
    expect(call[1]).toMatchObject({
      source: "automation",
      idempotencyKey: `issue_dependency_cancelled:${comments[0]!.id}`,
      contextSnapshot: expect.objectContaining({
        issueId: followUp.id,
        wakeCommentId: comments[0]!.id,
        wakeReason: "issue_commented",
        source: "issue.cancelled_dependency_handoff",
        cancelledBlockerIssueId: prep.id,
      }),
    });

    const activity = await db.select().from(activityLog).where(and(
      eq(activityLog.entityId, followUp.id),
      eq(activityLog.action, "issue.comment_added"),
    ));
    expect(activity.map((row) => row.details)).toContainEqual(expect.objectContaining({
      commentId: comments[0]!.id,
      source: "issue.cancelled_dependency_handoff",
      cancelledBlockerIssueId: prep.id,
    }));

    // Cancellation still does not resolve the dependency.
    expect(await statusOf(followUp.id)).toBe("blocked");
    expect(await blockerIdsOf(followUp.id)).toEqual([prep.id]);
    expect(mockWakeup).not.toHaveBeenCalledWith(
      qm.id,
      expect.objectContaining({ reason: "issue_blockers_resolved" }),
    );
  });

  it("does not hand off to unassigned, user-assigned or finished dependents", async () => {
    const { company, project } = await seedCompany();
    const finishedOwner = await seedAgent(company.id);
    const prep = await seedIssue({ companyId: company.id, projectId: project.id, title: "Prep", status: "todo" });
    const unassigned = await seedIssue({ companyId: company.id, projectId: project.id, title: "Unassigned", status: "blocked" });
    const userOwned = await seedIssue({
      companyId: company.id, projectId: project.id, title: "Person's task", status: "blocked", assigneeUserId: "board-user",
    });
    const finished = await seedIssue({
      companyId: company.id, projectId: project.id, title: "Finished", status: "done", assigneeAgentId: finishedOwner.id,
    });
    for (const dependent of [unassigned, userOwned, finished]) await blocks(company.id, prep.id, dependent.id);

    const res = await request(createApp(db, boardActor(company)))
      .patch(`/api/issues/${prep.id}`)
      .send({ status: "cancelled" });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    await new Promise((resolve) => setTimeout(resolve, 300));

    for (const dependent of [unassigned, userOwned, finished]) {
      const comments = await db.select().from(issueComments).where(eq(issueComments.issueId, dependent.id));
      expect(comments).toHaveLength(0);
    }
    expect(mockWakeup).not.toHaveBeenCalledWith(finishedOwner.id, expect.anything());
  });

  it("lets the assignee drop a cancelled blocker and move its task to todo in one update", async () => {
    const f = await seedBlockedFollowUp();

    const res = await request(createApp(db, agentActor(f.company, f.qm, f.run.id)))
      .patch(`/api/issues/${f.followUp.id}`)
      .send({ status: "todo", blockedByIssueIds: [f.done.id] });

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(await statusOf(f.followUp.id)).toBe("todo");
    expect(await blockerIdsOf(f.followUp.id)).toEqual([f.done.id]);
    const activity = await db.select().from(activityLog).where(and(
      eq(activityLog.entityId, f.followUp.id),
      eq(activityLog.action, "issue.blockers_updated"),
    ));
    expect(activity).toHaveLength(1);
    expect(activity[0]).toMatchObject({ actorType: "agent", actorId: f.qm.id });
    expect(activity[0]!.details).toMatchObject({ removedBlockedByIssueIds: [f.cancelled.id] });
  });

  it("lets the assignee cancel its blocked task while dropping the cancelled blocker", async () => {
    const f = await seedBlockedFollowUp();

    const res = await request(createApp(db, agentActor(f.company, f.qm, f.run.id)))
      .patch(`/api/issues/${f.followUp.id}`)
      .send({ status: "cancelled", blockedByIssueIds: [f.done.id] });

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(await statusOf(f.followUp.id)).toBe("cancelled");
    expect(await blockerIdsOf(f.followUp.id)).toEqual([f.done.id]);
  });

  it("still refuses a status change while the update keeps the cancelled blocker", async () => {
    const f = await seedBlockedFollowUp();

    const res = await request(createApp(db, agentActor(f.company, f.qm, f.run.id)))
      .patch(`/api/issues/${f.followUp.id}`)
      .send({ status: "todo", blockedByIssueIds: [f.cancelled.id, f.done.id] });

    expect(res.status, JSON.stringify(res.body)).toBe(409);
    expect(res.body.details).toMatchObject({ unresolvedBlockerIssueIds: [f.cancelled.id] });
    expect(await statusOf(f.followUp.id)).toBe("blocked");
    expect(await blockerIdsOf(f.followUp.id)).toEqual([f.cancelled.id, f.done.id].sort());
  });

  it("judges an update that adds a blocker on the stored blockers", async () => {
    const f = await seedBlockedFollowUp();
    const replacement = await seedIssue({
      companyId: f.company.id, projectId: f.project.id, title: "New preparation", status: "in_progress",
    });

    const res = await request(createApp(db, agentActor(f.company, f.qm, f.run.id)))
      .patch(`/api/issues/${f.followUp.id}`)
      .send({ status: "todo", blockedByIssueIds: [replacement.id, f.done.id] });

    expect(res.status, JSON.stringify(res.body)).toBe(409);
    expect(res.body.details).toMatchObject({ unresolvedBlockerIssueIds: [f.cancelled.id] });
    expect(await statusOf(f.followUp.id)).toBe("blocked");
  });
});
