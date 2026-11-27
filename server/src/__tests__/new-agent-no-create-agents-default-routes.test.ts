import { randomUUID } from "node:crypto";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import express from "express";
import request from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { and, eq } from "drizzle-orm";
import { agents, approvals, companies, companyMemberships, createDb, heartbeatRuns } from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { errorHandler } from "../middleware/index.js";
import { agentRoutes } from "../routes/agents.js";
import { approvalService } from "../services/approvals.js";

// STUDIO-0106. A new agent is born without the right to create agents (canCreateAgents) unless its creation request
// asks for it; existing agents keep what they hold; a CEO keeps what its recorded decision says. The real agent
// routes, the real authorization service, a real database.

const support = await getEmbeddedPostgresTestSupport();
const describePostgres = support.supported ? describe : describe.skip;

describePostgres("hiring authority of a new agent", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  let home: string;
  let app: express.Express;
  let actor: Express.Request["actor"];
  let companyId: string;
  let fixtureNumber = 0;
  const userId = randomUUID();

  const board = (): Express.Request["actor"] =>
    ({ type: "board", source: "local_implicit", userId, companyIds: [companyId] }) as Express.Request["actor"];

  async function as(agentId: string) {
    const [run] = await db.insert(heartbeatRuns).values({
      companyId, agentId, invocationSource: "manual", status: "running", contextSnapshot: {},
    }).returning();
    actor = { type: "agent", agentId, companyId, runId: run!.id, source: "agent_jwt" } as Express.Request["actor"];
  }

  const hireBody = (name: string, extra: Record<string, unknown> = {}) =>
    ({ name, role: "engineer", adapterType: "codex_local", adapterConfig: { model: "gpt-5.5" }, ...extra });
  const postHire = (name: string, extra: Record<string, unknown> = {}) =>
    request(app).post(`/api/companies/${companyId}/agent-hires`).send(hireBody(name, extra));
  async function hireByBoard(name: string, extra: Record<string, unknown> = {}) {
    actor = board();
    const response = await postHire(name, extra);
    expect(response.status, JSON.stringify(response.body)).toBe(201);
    return response.body.agent.id as string;
  }
  const storedPermissions = async (agentId: string) =>
    (await db.select().from(agents).where(eq(agents.id, agentId)))[0]!.permissions as Record<string, unknown>;
  const insertAgent = (role: string, permissions: Record<string, unknown>) => db.insert(agents).values({
    companyId, name: `Existing ${role} ${randomUUID().slice(0, 8)}`, role, status: "idle", permissions,
    adapterType: "process", adapterConfig: {}, runtimeConfig: {},
  }).returning().then((rows) => rows[0]!);

  beforeAll(async () => {
    home = await realpath(await mkdtemp(path.join(os.tmpdir(), "paperclip-no-create-agents-")));
    vi.stubEnv("PAPERCLIP_HOME", home);
    vi.stubEnv("PAPERCLIP_INSTANCE_ID", "no-create-agents-fixture");
    database = await startEmbeddedPostgresTestDatabase("paperclip-no-create-agents-db-");
    db = createDb(database.connectionString);
    app = express();
    app.use(express.json());
    app.use((req, _res, next) => { req.actor = actor; next(); });
    app.use("/api", agentRoutes(db));
    app.use(errorHandler);
  }, 90_000);

  async function seedCompany(requireBoardApprovalForNewAgents: boolean) {
    companyId = randomUUID();
    await db.insert(companies).values({
      id: companyId, name: "No create agents", issuePrefix: `NC${++fixtureNumber}`, requireBoardApprovalForNewAgents,
    });
    await db.insert(companyMemberships).values({
      companyId, principalId: userId, principalType: "user", status: "active", membershipRole: "owner",
    });
  }

  beforeEach(async () => { await seedCompany(false); });

  afterAll(async () => {
    await database?.cleanup();
    vi.unstubAllEnvs();
    if (home) await rm(home, { recursive: true, force: true });
  });

  it("a role hired by the Board without asking for it is born without hiring authority and cannot hire", async () => {
    const role = await hireByBoard("New role");
    expect(await storedPermissions(role)).toMatchObject({ canCreateAgents: false });
    await as(role);
    const response = await postHire("Grandchild");
    expect(response.status, JSON.stringify(response.body)).toBe(403);
  });

  it("a role hired with an explicit canCreateAgents: true holds it and hires", async () => {
    const recruiter = await hireByBoard("Recruiter", { permissions: { canCreateAgents: true } });
    expect(await storedPermissions(recruiter)).toMatchObject({ canCreateAgents: true });
    await as(recruiter);
    const plain = await postHire("Plain hire");
    expect(plain.status, JSON.stringify(plain.body)).toBe(201);
    expect(await storedPermissions(plain.body.agent.id)).toMatchObject({ canCreateAgents: false });
    await as(recruiter);
    const granted = await postHire("Granted hire", { permissions: { canCreateAgents: true } });
    expect(granted.status, JSON.stringify(granted.body)).toBe(201);
    expect(await storedPermissions(granted.body.agent.id)).toMatchObject({ canCreateAgents: true });
  });

  it("a role that cannot hire cannot give hiring authority through a hire request", async () => {
    const role = await hireByBoard("New role");
    await as(role);
    const response = await postHire("Smuggled", { permissions: { canCreateAgents: true } });
    expect(response.status, JSON.stringify(response.body)).toBe(403);
    expect(await db.select().from(agents).where(and(eq(agents.companyId, companyId), eq(agents.name, "Smuggled"))))
      .toHaveLength(0);
  });

  it("a hire approved by the Board is activated without hiring authority", async () => {
    await seedCompany(true);
    const recruiter = await insertAgent("general", { canCreateAgents: true, canCreateSkills: true });
    await as(recruiter.id);
    const response = await postHire("Pending hire");
    expect(response.status, JSON.stringify(response.body)).toBe(201);
    expect(response.body.approval?.id).toBeTruthy();
    const pendingId = response.body.agent.id as string;
    expect(await storedPermissions(pendingId)).toMatchObject({ canCreateAgents: false });
    await approvalService(db).approve(response.body.approval.id, userId, "Approved");
    const [activated] = await db.select().from(agents).where(eq(agents.id, pendingId));
    expect(activated!.status).not.toBe("pending_approval");
    expect(activated!.permissions).toMatchObject({ canCreateAgents: false });
    const [approval] = await db.select().from(approvals).where(eq(approvals.id, response.body.approval.id));
    expect(approval!.status).toBe("approved");
  });

  it("existing agents keep their stored permissions, and a CEO keeps what its recorded decision says", async () => {
    const holder = await insertAgent("general", { canCreateAgents: true, canCreateSkills: true });
    const legacy = await insertAgent("engineer", {});
    const ceo = await insertAgent("ceo", {});
    const denial = { actorType: "user", actorId: userId, at: "2026-11-08T00:00:00.000Z" };
    const deniedCeo = await insertAgent("ceo", { canCreateAgents: false, canCreateSkills: true, ceoHiringDeniedBy: denial });
    const before = await Promise.all([holder, legacy, ceo, deniedCeo].map((agent) => storedPermissions(agent.id)));

    await hireByBoard("Someone new");
    const after = await Promise.all([holder, legacy, ceo, deniedCeo].map((agent) => storedPermissions(agent.id)));
    expect(after).toEqual(before);

    await as(holder.id);
    expect((await postHire("By the holder")).status).toBe(201);
    await as(ceo.id);
    expect((await postHire("By the CEO")).status).toBe(201);
    await as(deniedCeo.id);
    expect((await postHire("By the denied CEO")).status).toBe(403);
    await as(legacy.id);
    expect((await postHire("By the legacy role")).status).toBe(403);
  });

  it("a CEO hired without asking for it keeps the CEO's hiring authority", async () => {
    const ceo = await hireByBoard("New CEO", { role: "ceo" });
    await as(ceo);
    const response = await postHire("Hired by the new CEO");
    expect(response.status, JSON.stringify(response.body)).toBe(201);
    expect(await storedPermissions(response.body.agent.id)).toMatchObject({ canCreateAgents: false });
  });
});
