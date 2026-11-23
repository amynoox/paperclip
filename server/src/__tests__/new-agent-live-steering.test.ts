// STUDIO-0096: a new agent is steerable while it works, unless its creation says otherwise.
//
// `experimentalLiveSteering` is a free key of an agent's adapter configuration; absent, it reads as off, and nothing
// wrote it for a new agent. The server now writes it `true` where a new agent is written, for the two engines that
// read it. The cases create an agent by each way a role is created (the direct creation route, the hire route, the
// setup draft of the screen finished through the hire route with `setupAgentId`, a hire that waits for an approval),
// and read the stored row.
import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { agents, approvals, companies, companyMemberships, createDb, type Db } from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { errorHandler } from "../middleware/error-handler.js";
import { agentRoutes } from "../routes/agents.js";
import { createAgentLifecycle } from "../services/agent-lifecycle.js";
import { selectsAdapterInteractiveControl } from "../services/adapter-interactive-control.js";
import { LIVE_STEERING_ADAPTER_TYPES, LIVE_STEERING_KEY, withLiveSteeringCarriedOver, withLiveSteeringDefault } from "../lib/agent-live-steering.js";

describe("live steering by default: the rule", () => {
  it("is written for the engines that read it, when the creation says nothing of it", () => {
    expect([...LIVE_STEERING_ADAPTER_TYPES]).toEqual(["claude_local", "codex_local"]);
    for (const adapterType of LIVE_STEERING_ADAPTER_TYPES) {
      expect(withLiveSteeringDefault(adapterType, {})).toEqual({ experimentalLiveSteering: true });
      expect(withLiveSteeringDefault(adapterType, { model: "m" })).toEqual({ model: "m", experimentalLiveSteering: true });
      expect(withLiveSteeringDefault(adapterType, null)).toEqual({ experimentalLiveSteering: true });
      expect(withLiveSteeringDefault(adapterType, undefined)).toEqual({ experimentalLiveSteering: true });
    }
  });

  it("keeps what a creation says, false included, and leaves another engine's configuration as it is", () => {
    const off = { model: "m", experimentalLiveSteering: false };
    expect(withLiveSteeringDefault("codex_local", off)).toBe(off);
    const on = { experimentalLiveSteering: true };
    expect(withLiveSteeringDefault("claude_local", on)).toBe(on);
    // A value that is not a boolean is not rewritten either: the reader takes anything but `true` as off.
    const odd = { experimentalLiveSteering: "yes" };
    expect(withLiveSteeringDefault("codex_local", odd)).toBe(odd);
    for (const adapterType of ["process", "paperclip_runner", "cursor_cloud", "gemini_local", null, undefined]) {
      const config = { model: "m" };
      expect(withLiveSteeringDefault(adapterType, config)).toBe(config);
    }
  });

  it("through a change of engine: what the request says, else what the old configuration said, else true; nothing for another engine", () => {
    for (const next of LIVE_STEERING_ADAPTER_TYPES) {
      expect(withLiveSteeringCarriedOver(next, { experimentalLiveSteering: true, model: "old" }, { model: "new" }))
        .toEqual({ model: "new", experimentalLiveSteering: true });
      expect(withLiveSteeringCarriedOver(next, { experimentalLiveSteering: false }, { model: "new" }))
        .toEqual({ model: "new", experimentalLiveSteering: false });
      expect(withLiveSteeringCarriedOver(next, { model: "old" }, { model: "new" })).toEqual({ model: "new", experimentalLiveSteering: true });
      expect(withLiveSteeringCarriedOver(next, null, {})).toEqual({ experimentalLiveSteering: true });
      // The request's own word wins over the old configuration, both ways.
      const off = { experimentalLiveSteering: false };
      expect(withLiveSteeringCarriedOver(next, { experimentalLiveSteering: true }, off)).toBe(off);
      const on = { experimentalLiveSteering: true };
      expect(withLiveSteeringCarriedOver(next, { experimentalLiveSteering: false }, on)).toBe(on);
    }
    for (const next of ["process", "paperclip_runner", "cursor_cloud", null, undefined]) {
      const config = { model: "new" };
      expect(withLiveSteeringCarriedOver(next, { experimentalLiveSteering: true }, config)).toBe(config);
    }
  });

  it("is what the dispatch reads: a run of an agent with the written key is selected as steerable", () => {
    expect(selectsAdapterInteractiveControl({}, withLiveSteeringDefault("codex_local", {}) as Record<string, unknown>)).toBe(true);
    expect(selectsAdapterInteractiveControl({}, {})).toBe(false);
    expect(selectsAdapterInteractiveControl({}, { [LIVE_STEERING_KEY]: false })).toBe(false);
  });
});

const support = await getEmbeddedPostgresTestSupport();
(support.supported ? describe : describe.skip)("live steering by default: every way an agent is created", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: Db;
  let companyId: string;
  beforeAll(async () => { database = await startEmbeddedPostgresTestDatabase("new-agent-live-steering-"); db = createDb(database.connectionString); }, 90_000);
  afterAll(async () => { await database?.cleanup(); });
  beforeEach(async () => {
    companyId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Steering test", issuePrefix: `L${companyId.replaceAll("-", "").slice(0, 7)}`,
      requireBoardApprovalForNewAgents: false });
    await db.insert(companyMemberships).values({ companyId, principalType: "user", principalId: "board-user", membershipRole: "owner" });
  });
  const stored = async (id: string) => (await db.select().from(agents).where(eq(agents.id, id)))[0]!;
  const configOf = async (id: string) => (await stored(id)).adapterConfig as Record<string, unknown>;
  /** The Board, on the real routes. */
  function app() {
    const value = express(); value.use(express.json());
    value.use((req, _res, next) => { req.actor = { type: "board", source: "local_implicit", userId: "board-user", isInstanceAdmin: true,
      companyIds: [companyId], memberships: [{ companyId, membershipRole: "owner", status: "active" }] } as never; next(); });
    value.use("/api", agentRoutes(db)); value.use(errorHandler); return value;
  }

  it.each(LIVE_STEERING_ADAPTER_TYPES)("the creation route, engine %s: the agent is written steerable", async (adapterType) => {
    const created = await request(app()).post(`/api/companies/${companyId}/agents`).send({ name: `Direct ${adapterType}`, adapterType, adapterConfig: {}, runner: "legacy" });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    expect((await stored(created.body.id)).adapterType).toBe(adapterType);
    expect(await configOf(created.body.id)).toMatchObject({ experimentalLiveSteering: true });
  });

  it.each(LIVE_STEERING_ADAPTER_TYPES)("the hire route, engine %s: the agent is written steerable", async (adapterType) => {
    const hired = await request(app()).post(`/api/companies/${companyId}/agent-hires`).send({ name: `Hired ${adapterType}`, adapterType, adapterConfig: {}, runner: "legacy" });
    expect(hired.status, JSON.stringify(hired.body)).toBe(201);
    expect((await stored(hired.body.agent.id)).adapterType).toBe(adapterType);
    expect(await configOf(hired.body.agent.id)).toMatchObject({ experimentalLiveSteering: true });
  });

  it("the screen's way: a setup draft, then the hire route with `setupAgentId`: the finished agent is steerable", async () => {
    const setupId = randomUUID();
    const draft = await request(app()).post(`/api/companies/${companyId}/agents`).send({ setupId, name: "Screen agent", adapterType: "codex_local", adapterConfig: {}, runner: "legacy" });
    expect(draft.status, JSON.stringify(draft.body)).toBe(201);
    expect(await stored(setupId)).toMatchObject({ status: "paused", lifecycleHolds: ["setup"] });
    // The screen then saves the draft's configuration as it shows it, without a key it does not know.
    const saved = await request(app()).patch(`/api/agents/${setupId}`).send({ adapterConfig: { model: "gpt-test" }, replaceAdapterConfig: true });
    expect(saved.status, JSON.stringify(saved.body)).toBe(200);
    const finished = await request(app()).post(`/api/companies/${companyId}/agent-hires`)
      .send({ setupAgentId: setupId, name: "Screen agent", adapterType: "codex_local", adapterConfig: { model: "gpt-test" }, runner: "legacy" });
    expect(finished.status, JSON.stringify(finished.body)).toBe(201);
    expect(finished.body.agent.id).toBe(setupId);
    expect(await configOf(setupId)).toMatchObject({ model: "gpt-test", experimentalLiveSteering: true });
    expect((await stored(setupId)).lifecycleHolds).not.toContain("setup");
  });

  it("a hire that waits for the Board's approval: steerable when it is asked for, and a hire asked for before this patch becomes steerable at its approval", async () => {
    await db.update(companies).set({ requireBoardApprovalForNewAgents: true }).where(eq(companies.id, companyId));
    const hired = await request(app()).post(`/api/companies/${companyId}/agent-hires`).send({ name: "Pending hire", adapterType: "claude_local", adapterConfig: {}, runner: "legacy" });
    expect(hired.status, JSON.stringify(hired.body)).toBe(201);
    const id = hired.body.agent.id as string;
    expect(await stored(id)).toMatchObject({ status: "pending_approval" });
    expect(await configOf(id)).toMatchObject({ experimentalLiveSteering: true });
    // The approval writes the configuration its request stored over the agent's. A hire asked for BEFORE this patch
    // has the key neither in its row nor in its request: both are put back in that state here.
    const [approval] = await db.select().from(approvals).where(eq(approvals.companyId, companyId));
    const requested = { ...(approval!.payload as Record<string, unknown>) };
    const { [LIVE_STEERING_KEY]: _asked, ...requestedConfig } = (requested.adapterConfig ?? {}) as Record<string, unknown>;
    await db.update(approvals).set({ payload: { ...requested, adapterConfig: requestedConfig } }).where(eq(approvals.id, approval!.id));
    const { [LIVE_STEERING_KEY]: _stored, ...storedConfig } = await configOf(id);
    await db.update(agents).set({ adapterConfig: storedConfig }).where(eq(agents.id, id));
    expect(await configOf(id)).not.toHaveProperty(LIVE_STEERING_KEY);
    const decided = await createAgentLifecycle(db).approveHire(id, "board-user");
    expect(decided, JSON.stringify(decided)).toMatchObject({ applied: true });
    expect((await stored(id)).status).not.toBe("pending_approval");
    expect((await stored(id)).adapterType).toBe("claude_local");
    expect(await configOf(id)).toMatchObject({ experimentalLiveSteering: true });
  });

  it("a creation that says `false` keeps it, by the creation route and by the approval", async () => {
    const created = await request(app()).post(`/api/companies/${companyId}/agents`)
      .send({ name: "Not steered", adapterType: "codex_local", adapterConfig: { experimentalLiveSteering: false }, runner: "legacy" });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    expect(await configOf(created.body.id)).toMatchObject({ experimentalLiveSteering: false });
    await db.update(companies).set({ requireBoardApprovalForNewAgents: true }).where(eq(companies.id, companyId));
    const hired = await request(app()).post(`/api/companies/${companyId}/agent-hires`)
      .send({ name: "Not steered, pending", adapterType: "claude_local", adapterConfig: { experimentalLiveSteering: false }, runner: "legacy" });
    expect(hired.status, JSON.stringify(hired.body)).toBe(201);
    expect(await configOf(hired.body.agent.id)).toMatchObject({ experimentalLiveSteering: false });
    await createAgentLifecycle(db).approveHire(hired.body.agent.id, "board-user");
    expect((await stored(hired.body.agent.id)).status).not.toBe("pending_approval");
    expect(await configOf(hired.body.agent.id)).toMatchObject({ experimentalLiveSteering: false });
  });

  // What the default does NOT reach, said by a case: without `runner: "legacy"` the server stores a new agent on its
  // native launcher, another engine, which does not read this key.
  it("a creation the server stores on its native launcher gets nothing written", async () => {
    const created = await request(app()).post(`/api/companies/${companyId}/agents`).send({ name: "Native agent", adapterType: "codex_local", adapterConfig: {} });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    expect((await stored(created.body.id)).adapterType).toBe("paperclip_runner");
    expect(await configOf(created.body.id)).not.toHaveProperty(LIVE_STEERING_KEY);
  });

  it("an engine that does not read the key gets nothing written", async () => {
    const lifecycle = createAgentLifecycle(db);
    const created = await lifecycle.requestHire(companyId, { name: "Process agent", adapterType: "process", adapterConfig: { command: "true" } });
    expect(await configOf(created.id)).not.toHaveProperty(LIVE_STEERING_KEY);
  });

  it("an agent that already exists is not touched: neither by a change of its configuration nor by another agent's creation", async () => {
    const lifecycle = createAgentLifecycle(db);
    // An agent as the ones created before this patch: no key in its stored configuration.
    const old = await lifecycle.requestHire(companyId, { name: "Old agent", adapterType: "codex_local", adapterConfig: { model: "old" } });
    await db.update(agents).set({ adapterConfig: { model: "old" } }).where(eq(agents.id, old.id));
    expect(await configOf(old.id)).not.toHaveProperty(LIVE_STEERING_KEY);
    // Its configuration is changed through the route, and through the service: no key appears.
    const patched = await request(app()).patch(`/api/agents/${old.id}`).send({ adapterConfig: { model: "newer" } });
    expect(patched.status, JSON.stringify(patched.body)).toBe(200);
    expect(await configOf(old.id)).toMatchObject({ model: "newer" });
    expect(await configOf(old.id)).not.toHaveProperty(LIVE_STEERING_KEY);
    await lifecycle.updateConfiguration(old.id, { adapterConfig: { model: "newest" } });
    expect(await configOf(old.id)).not.toHaveProperty(LIVE_STEERING_KEY);
    // Another agent is created beside it.
    await lifecycle.requestHire(companyId, { name: "New neighbour", adapterType: "codex_local", adapterConfig: {}, runner: "legacy" });
    expect(await configOf(old.id)).not.toHaveProperty(LIVE_STEERING_KEY);
    // And one that was switched off by hand stays off.
    await db.update(agents).set({ adapterConfig: { model: "old", experimentalLiveSteering: false } }).where(eq(agents.id, old.id));
    await lifecycle.updateConfiguration(old.id, { runtimeConfig: { heartbeat: { enabled: false } } });
    expect(await configOf(old.id)).toMatchObject({ experimentalLiveSteering: false });
  });

  // The change of engine of an existing agent, through the real route: the way the studio's roles get their engine.
  // The route keeps only the engine-agnostic keys of the old configuration; live steering was dropped with the rest.
  async function existingAgent(adapterType: string, config: Record<string, unknown>) {
    const created = await createAgentLifecycle(db).requestHire(companyId, { name: `Existing ${randomUUID().slice(0, 8)}`, adapterType, adapterConfig: {} });
    await db.update(agents).set({ adapterConfig: config }).where(eq(agents.id, created.id));
    return created.id;
  }
  const changeEngine = (id: string, adapterType: string, adapterConfig: Record<string, unknown>) =>
    request(app()).patch(`/api/agents/${id}`).send({ adapterType, adapterConfig });

  it.each([
    ["codex_local", "claude_local"],
    ["claude_local", "codex_local"],
  ])("a change of engine from %s to %s: a steerable agent stays steerable", async (from, to) => {
    const id = await existingAgent(from, { model: "old-model", experimentalLiveSteering: true });
    const changed = await changeEngine(id, to, { model: "new-model" });
    expect(changed.status, JSON.stringify(changed.body)).toBe(200);
    expect(await stored(id)).toMatchObject({ adapterType: to });
    expect(await configOf(id)).toMatchObject({ model: "new-model", experimentalLiveSteering: true });
    expect(await configOf(id)).not.toMatchObject({ model: "old-model" });
  });

  it("a change of engine: an agent switched off stays off", async () => {
    const id = await existingAgent("codex_local", { model: "old-model", experimentalLiveSteering: false });
    const changed = await changeEngine(id, "claude_local", { model: "new-model" });
    expect(changed.status, JSON.stringify(changed.body)).toBe(200);
    expect(await stored(id)).toMatchObject({ adapterType: "claude_local" });
    expect(await configOf(id)).toMatchObject({ model: "new-model", experimentalLiveSteering: false });
  });

  it("a change of engine: an agent whose old configuration said nothing becomes steerable", async () => {
    const id = await existingAgent("codex_local", { model: "old-model" });
    const changed = await changeEngine(id, "claude_local", { model: "new-model" });
    expect(changed.status, JSON.stringify(changed.body)).toBe(200);
    expect(await configOf(id)).toMatchObject({ model: "new-model", experimentalLiveSteering: true });
  });

  it("a change of engine: what the request says wins over the old configuration", async () => {
    const id = await existingAgent("codex_local", { model: "old-model", experimentalLiveSteering: true });
    const changed = await changeEngine(id, "claude_local", { model: "new-model", experimentalLiveSteering: false });
    expect(changed.status, JSON.stringify(changed.body)).toBe(200);
    expect(await configOf(id)).toMatchObject({ model: "new-model", experimentalLiveSteering: false });
  });

  it("no change of engine: a configuration saved again, also replaced whole, gets nothing written and loses nothing", async () => {
    const id = await existingAgent("codex_local", { model: "old-model" });
    const replaced = await request(app()).patch(`/api/agents/${id}`).send({ adapterConfig: { model: "new-model" }, replaceAdapterConfig: true });
    expect(replaced.status, JSON.stringify(replaced.body)).toBe(200);
    expect(await configOf(id)).not.toHaveProperty(LIVE_STEERING_KEY);
    const steered = await existingAgent("codex_local", { model: "old-model", experimentalLiveSteering: true });
    const merged = await request(app()).patch(`/api/agents/${steered}`).send({ adapterConfig: { model: "new-model" } });
    expect(merged.status, JSON.stringify(merged.body)).toBe(200);
    expect(await configOf(steered)).toMatchObject({ model: "new-model", experimentalLiveSteering: true });
  });
});
