import { randomUUID } from "node:crypto";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import express from "express";
import request from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { and, eq } from "drizzle-orm";
import {
  agents,
  companies,
  companyMemberships,
  createDb,
  heartbeatRuns,
  issueRecoveryActions,
  issues,
  principalPermissionGrants,
} from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { errorHandler } from "../middleware/index.js";
import { NEW_STANDARD_AGENT_DEFAULT_GRANT_KEYS } from "../lib/agent-permissions.js";
import { agentPermissionGrantRoutes } from "../routes/agent-permission-grants.js";
import { agentRoutes } from "../routes/agents.js";
import { issueRoutes } from "../routes/issues.js";
import { authorizationService } from "../services/authorization.js";
import { issueRecoveryActionService } from "../services/issue-recovery-actions.js";

// STUDIO-0084. What a role created by the API may do with the rights a new agent receives by default: the real
// routes, the real authorization service, a real database. Nothing is doubled.

const support = await getEmbeddedPostgresTestSupport();
const describePostgres = support.supported ? describe : describe.skip;

const NO_LONGER_GIVEN = [
  "agents:configure",
  "agents:suggest-changes",
  "skills:create",
  "skills:suggest-changes",
  "tasks:manage_active_checkouts",
] as const;

describePostgres("default rights of a new agent", () => {
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

  /** The role speaks with the key of one of its runs, as it does in production. */
  async function as(agentId: string) {
    const [run] = await db.insert(heartbeatRuns).values({
      companyId, agentId, invocationSource: "manual", status: "running", contextSnapshot: {},
    }).returning();
    actor = { type: "agent", agentId, companyId, runId: run!.id, source: "agent_jwt" } as Express.Request["actor"];
  }

  /** A role created by the API, by the Board, as a new hire. */
  async function hire(name: string, extra: Record<string, unknown> = {}) {
    actor = board();
    const response = await request(app).post(`/api/companies/${companyId}/agent-hires`)
      .send({ name, role: "engineer", adapterType: "codex_local", adapterConfig: { model: "gpt-5.5" }, ...extra });
    expect(response.status, JSON.stringify(response.body)).toBe(201);
    return response.body.agent.id as string;
  }

  const grantKeys = async (agentId: string) =>
    (await db.select().from(principalPermissionGrants).where(and(
      eq(principalPermissionGrants.principalType, "agent"), eq(principalPermissionGrants.principalId, agentId),
    ))).map((grant) => grant.permissionKey).sort();
  const readAgent = async (agentId: string) => (await db.select().from(agents).where(eq(agents.id, agentId)))[0]!;

  /** A task of `assigneeId` under an open recovery action that `assigneeId` owns. */
  async function recoveryOn(assigneeId: string) {
    const issueId = randomUUID();
    const number = ++fixtureNumber;
    await db.insert(issues).values({
      id: issueId, companyId, title: "Work under recovery", status: "blocked", priority: "medium",
      assigneeAgentId: assigneeId, issueNumber: number, identifier: `DG${number}-${number}`,
    });
    const action = await issueRecoveryActionService(db).upsertSourceScoped({
      companyId,
      sourceIssueId: issueId,
      kind: "workspace_validation",
      ownerType: "agent",
      ownerAgentId: assigneeId,
      previousOwnerAgentId: assigneeId,
      returnOwnerAgentId: assigneeId,
      cause: "workspace_validation_failed",
      fingerprint: `workspace:${issueId}`,
      evidence: { latestRunId: "run-1" },
      nextAction: "Repair the workspace and hand the issue back.",
      wakePolicy: { type: "manual" },
    });
    return { issueId, actionId: action.id };
  }
  const settle = (recovery: { issueId: string; actionId: string }) =>
    request(app).post(`/api/issues/${recovery.issueId}/recovery-actions/resolve`).send({
      actionId: recovery.actionId, outcome: "restored", sourceIssueStatus: "todo", resolutionNote: "Workspace repaired.",
    });
  const readAction = async (actionId: string) =>
    (await db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.id, actionId)))[0]!;

  beforeAll(async () => {
    home = await realpath(await mkdtemp(path.join(os.tmpdir(), "paperclip-default-grants-")));
    vi.stubEnv("PAPERCLIP_HOME", home);
    vi.stubEnv("PAPERCLIP_INSTANCE_ID", "default-grants-fixture");
    database = await startEmbeddedPostgresTestDatabase("paperclip-default-grants-db-");
    db = createDb(database.connectionString);
    app = express();
    app.use(express.json());
    app.use((req, _res, next) => { req.actor = actor; next(); });
    app.use("/api", agentRoutes(db));
    app.use("/api", agentPermissionGrantRoutes(db));
    app.use("/api", issueRoutes(db, {} as never, {}));
    app.use(errorHandler);
  }, 90_000);

  beforeEach(async () => {
    companyId = randomUUID();
    await db.insert(companies).values({
      id: companyId, name: "Default grants", issuePrefix: `DG${++fixtureNumber}`, requireBoardApprovalForNewAgents: false,
    });
    await db.insert(companyMemberships).values({
      companyId, principalId: userId, principalType: "user", status: "active", membershipRole: "owner",
    });
  });

  afterAll(async () => {
    await database?.cleanup();
    vi.unstubAllEnvs();
    if (home) await rm(home, { recursive: true, force: true });
  });

  it("a role created by the API receives the standard rights and none of the five that reach other roles", async () => {
    const role = await hire("New role");
    const keys = await grantKeys(role);
    expect(keys).toEqual([...NEW_STANDARD_AGENT_DEFAULT_GRANT_KEYS].sort());
    expect(keys).toEqual([
      "agents:read", "audit:view_agent_actions", "inbox:manage", "tasks:assign", "tasks:assign_scope",
      "tools:manage_connections", "tools:manage_profiles", "tools:manage_runtime", "tools:use", "tools:view_audit",
    ]);
    for (const key of NO_LONGER_GIVEN) expect(keys).not.toContain(key);
  });

  it("the authorization service refuses each of the five for lack of a grant, not for lack of a consent", async () => {
    const role = await hire("New role");
    const other = await hire("Other role");
    const decide = authorizationService(db).decide;
    const who = { type: "agent", agentId: role, companyId, source: "agent_key" } as const;
    expect(await decide({
      actor: who, action: "agent_config:update", resource: { type: "agent", agentId: other, companyId },
      scope: { requiresChangeGrant: true },
    })).toMatchObject({ allowed: false, reason: "deny_no_grant" });
    expect(await decide({
      actor: who, action: "skill_config:update", resource: { type: "company", companyId },
    })).toMatchObject({ allowed: false, reason: "deny_no_grant" });
    expect(await decide({
      actor: who, action: "tasks:manage_active_checkouts",
      resource: { type: "issue", companyId, assigneeAgentId: other },
    })).toMatchObject({ allowed: false, reason: "deny_missing_grant" });
  });

  it("cannot change the model of another role", async () => {
    const role = await hire("New role");
    const other = await hire("Other role");
    await as(role);
    const response = await request(app).patch(`/api/agents/${other}`).send({ adapterConfig: { model: "gpt-5.6-sol" } });
    expect(response.status, JSON.stringify(response.body)).toBe(403);
    expect(response.body.error).toContain("agents:configure");
    expect((await readAgent(other)).adapterConfig).toMatchObject({ model: "gpt-5.5" });
  });

  it("cannot change the skills of another role", async () => {
    const role = await hire("New role");
    const other = await hire("Other role");
    const before = (await readAgent(other)).adapterConfig;
    await as(role);
    const response = await request(app).post(`/api/agents/${other}/skills/sync`).send({ mode: "replace", desiredSkills: [] });
    expect(response.status, JSON.stringify(response.body)).toBe(403);
    expect(response.body.error).toContain("agents:configure");
    expect((await readAgent(other)).adapterConfig).toEqual(before);
  });

  it("cannot write the instructions of another role", async () => {
    const role = await hire("New role");
    const other = await hire("Other role");
    await as(role);
    const response = await request(app).put(`/api/agents/${other}/instructions-bundle/file`)
      .send({ path: "notes/taken-over.md", content: "Written by another role.", baseHash: null });
    expect(response.status, JSON.stringify(response.body)).toBe(403);
    expect(response.body.error).toContain("agents:configure");
  });

  it("changes its own model", async () => {
    const role = await hire("New role");
    await as(role);
    const response = await request(app).patch(`/api/agents/${role}`).send({ adapterConfig: { model: "gpt-5.6-sol" } });
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    expect((await readAgent(role)).adapterConfig).toMatchObject({ model: "gpt-5.6-sol" });
  });

  it("changes its own skills", async () => {
    const role = await hire("New role");
    await as(role);
    const response = await request(app).post(`/api/agents/${role}/skills/sync`).send({ mode: "replace", desiredSkills: [] });
    expect(response.status, JSON.stringify(response.body)).toBe(200);
  });

  // Two things a new role could do through `agents:configure` and no longer can: they ask for the right over
  // agents even on itself (a protected change), so the Board's grant is the only way.
  it("cannot change its own name or title", async () => {
    const role = await hire("New role");
    await as(role);
    const response = await request(app).patch(`/api/agents/${role}`).send({ title: "A title it gave itself" });
    expect(response.status, JSON.stringify(response.body)).toBe(403);
    expect(response.body.error).toContain("agents:configure");
    expect((await readAgent(role)).title).toBeNull();
  });

  it("cannot resume a role the Board paused", async () => {
    const role = await hire("New role");
    const other = await hire("Other role");
    await db.update(agents).set({ status: "paused", pauseReason: "manual", pausedAt: new Date() }).where(eq(agents.id, other));
    await as(role);
    const response = await request(app).post(`/api/agents/${other}/resume`).send({});
    expect(response.status, JSON.stringify(response.body)).toBe(403);
    expect(response.body.error).toContain("agents:configure");
    expect((await readAgent(other)).status).toBe("paused");
  });

  it("cannot settle the recovery action of a role it does not manage", async () => {
    const role = await hire("New role");
    const other = await hire("Other role");
    const recovery = await recoveryOn(other);
    await as(role);
    const response = await settle(recovery);
    expect(response.status, JSON.stringify(response.body)).toBe(403);
    expect(response.body.error).toContain("another owner's recovery action");
    expect(await readAction(recovery.actionId)).toMatchObject({ status: "active", outcome: null });
  });

  it("settles the recovery action of a role that reports to it, by the reporting chain", async () => {
    const role = await hire("New role");
    const report = await hire("Report", { reportsTo: role });
    expect(await grantKeys(role)).not.toContain("tasks:manage_active_checkouts");
    const recovery = await recoveryOn(report);
    await as(role);
    const response = await settle(recovery);
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    expect((await readAction(recovery.actionId)).status).toBe("resolved");
    expect(await authorizationService(db).decide({
      actor: { type: "agent", agentId: role, companyId, source: "agent_key" },
      action: "tasks:manage_active_checkouts",
      resource: { type: "issue", companyId, assigneeAgentId: report },
    })).toMatchObject({ allowed: true, reason: "allow_manager_chain" });
  });

  it("the Board gives a right to one role: that role then does what the right covers", async () => {
    const role = await hire("New role");
    const other = await hire("Other role");
    const recovery = await recoveryOn(other);
    actor = board();
    for (const permissionKey of ["agents:configure", "tasks:manage_active_checkouts"]) {
      const granted = await request(app).patch(`/api/agents/${role}/permission-grants`).send({ permissionKey, enabled: true });
      expect(granted.status, JSON.stringify(granted.body)).toBe(200);
    }
    await as(role);
    const model = await request(app).patch(`/api/agents/${other}`).send({ adapterConfig: { model: "gpt-5.6-sol" } });
    expect(model.status, JSON.stringify(model.body)).toBe(200);
    expect((await readAgent(other)).adapterConfig).toMatchObject({ model: "gpt-5.6-sol" });
    const settled = await settle(recovery);
    expect(settled.status, JSON.stringify(settled.body)).toBe(200);
    // The right was given to that role alone.
    expect(await grantKeys(other)).not.toContain("agents:configure");
  });

  it("a role that already holds the five keeps them when another role is hired", async () => {
    // The rows of a role activated before this patch, written here as the old list wrote them.
    const existing = await hire("Existing role");
    await db.insert(principalPermissionGrants).values(NO_LONGER_GIVEN.map((permissionKey) => ({
      companyId, principalType: "agent" as const, principalId: existing, permissionKey, scope: null,
    }))).onConflictDoNothing();
    const other = await hire("Other role");
    for (const key of NO_LONGER_GIVEN) expect(await grantKeys(existing)).toContain(key);
    await as(existing);
    const response = await request(app).patch(`/api/agents/${other}`).send({ adapterConfig: { model: "gpt-5.6-sol" } });
    expect(response.status, JSON.stringify(response.body)).toBe(200);
  });
});
