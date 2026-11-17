/**
 * STUDIO-0065: the Codex adapter's login-loss detection, by the real path. The same defect as STUDIO-0064 (found
 * 17 Nov 2026), with a wider reach: the Codex roles share one OpenAI account, so one failed run whose transcript
 * quotes "401 Unauthorized ... bearer token" would put every one of them in error until the owner signs in again.
 *
 * Each case runs the REAL codex_local adapter against a fake CLI, stores the run as the heartbeat stores it (status,
 * error code, result), and calls what the end of a failed run calls (run-lifecycle.ts, classifyAndPersistRunLiveness):
 * connectionIntentService.requestForRunAuthFailure. The heartbeat's own execution loop is not driven here.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { and, eq } from "drizzle-orm";
import {
  activityLog,
  agents,
  companies,
  companyMemberships,
  connectionGrants,
  createDb,
  heartbeatRuns,
  issues,
  toolConnections,
} from "@paperclipai/db";
import { startEmbeddedPostgresTestDatabase } from "@paperclipai/db/test-embedded-postgres";
import { execute } from "@paperclipai/adapter-codex-local/server";
import { aiConnectionService } from "../services/ai-connections.js";
import { prepareManagedAiRuntime } from "../services/ai-connection-runtime.js";
import { connectionIntentService } from "../services/connection-intents.js";

// A background plan observation must not send the fixture credential to a real provider.
vi.mock("../services/subscription-refresh.js", () => ({ refreshSubscriptionConnection: vi.fn().mockResolvedValue(undefined) }));

let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
let db: ReturnType<typeof createDb>;
let home: string;
const companyId = randomUUID();
const binding = { provider: "openai", method: "api_key", mode: "responsible_user" } as const;

beforeAll(async () => {
  home = await realpath(await mkdtemp(path.join(os.tmpdir(), "paperclip-codex-login-scope-")));
  vi.stubEnv("PAPERCLIP_HOME", home);
  vi.stubEnv("PAPERCLIP_INSTANCE_ID", "codex-login-scope-fixture");
  database = await startEmbeddedPostgresTestDatabase("paperclip-codex-login-scope-");
  db = createDb(database.connectionString);
  await db.insert(companies).values({ id: companyId, name: "Codex login scope", issuePrefix: "CXS" });
}, 90_000);
afterAll(async () => {
  await database?.cleanup();
  vi.unstubAllEnvs();
  if (home) await rm(home, { recursive: true, force: true });
});

const event = (value: Record<string, unknown>) => JSON.stringify(value);

/** A fake Codex CLI: it writes the given stdout and stderr and exits. */
async function runFakeCli(output: { stdout: string[]; stderr?: string; exitCode?: number }) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-codex-login-cli-"));
  const workspace = path.join(root, "workspace");
  const commandPath = path.join(root, "codex");
  const codexHome = path.join(root, ".codex");
  await fs.mkdir(workspace, { recursive: true });
  await fs.mkdir(codexHome, { recursive: true });
  await fs.writeFile(path.join(codexHome, "auth.json"), `${JSON.stringify({ OPENAI_API_KEY: "sk-test-codex-local" })}\n`, "utf8");
  await fs.writeFile(commandPath, `#!/usr/bin/env node
process.stdout.write(${JSON.stringify(output.stdout.map(line => `${line}\n`).join(""))});
process.stderr.write(${JSON.stringify(output.stderr ?? "")});
process.exit(${output.exitCode ?? 1});
`, "utf8");
  await fs.chmod(commandPath, 0o755);
  const previousHome = process.env.HOME;
  const previousCodexHome = process.env.CODEX_HOME;
  process.env.HOME = root;
  process.env.CODEX_HOME = codexHome;
  try {
    return await execute({
      runId: `run-${randomUUID()}`,
      agent: { id: "agent-1", companyId: "company-1", name: "Codex Coder", adapterType: "codex_local", adapterConfig: { engine: "cli" } },
      runtime: { sessionId: null, sessionParams: null, sessionDisplayId: null, taskKey: null },
      config: { engine: "cli", command: commandPath, cwd: workspace, promptTemplate: "Follow the paperclip heartbeat." },
      context: {},
      authToken: "run-jwt-token",
      onLog: async () => {},
    });
  } finally {
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    if (previousCodexHome === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = previousCodexHome;
    await fs.rm(root, { recursive: true, force: true });
  }
}

/** Store a failed run as the heartbeat stores it, on a role whose OpenAI account is connected, and end it. */
async function endFailedRun(run: { errorCode: string | null; resultJson: unknown }) {
  const userId = `owner-${randomUUID()}`;
  const agentId = randomUUID();
  const issueId = randomUUID();
  const runId = randomUUID();
  await db.insert(companyMemberships).values({ companyId, principalId: userId, principalType: "user", status: "active", membershipRole: "member" });
  await db.insert(agents).values({ id: agentId, companyId, name: "Dev", adapterType: "codex_local", runtimeConfig: { aiConnection: binding } });
  await db.insert(issues).values({ id: issueId, companyId, title: "Work", status: "in_progress", assigneeAgentId: agentId });
  const account = await aiConnectionService(db).save(companyId, userId, { provider: "openai", method: "api_key",
    ownership: "personal", name: "Shared account", apiKey: "fixture", agentIds: [agentId], allAgents: false }, "fixture-key");
  const runtime = await prepareManagedAiRuntime(db, { companyId, agentId, responsibleUserId: userId, adapterType: "codex_local", binding, config: {} });
  await db.insert(heartbeatRuns).values({ id: runId, companyId, agentId, status: "failed", errorCode: run.errorCode,
    resultJson: run.resultJson as Record<string, unknown>, responsibleUserId: userId,
    contextSnapshot: { issueId, aiConnection: { ...runtime.attribution, identity: runtime.identity } } });
  await runtime.cleanup();
  // What run-lifecycle.ts calls at the end of a failed run.
  const repair = await connectionIntentService(db).requestForRunAuthFailure(runId);
  const [grant] = await db.select().from(connectionGrants).where(eq(connectionGrants.id, account.grantId));
  const [connection] = await db.select().from(toolConnections).where(eq(toolConnections.id, account.connectionId));
  const marks = await db.select().from(activityLog).where(and(eq(activityLog.companyId, companyId),
    eq(activityLog.action, "ai_connection.authentication_failed"), eq(activityLog.runId, runId)));
  return { repair, grantStatus: grant!.status, health: connection!.healthStatus, marks: marks.length };
}

const QUOTED = "< HTTP/1.1 401 Unauthorized\n< www-authenticate: Bearer error=\"invalid_token\", the bearer token expired\n";
const LIMIT = "You've hit your usage limit for GPT-5.3-Codex. Switch to another model now, or try again at 11:31 PM.";
// A transcript whose command output and model text quote a login failure.
const transcript = [
  event({ type: "thread.started", thread_id: "codex-session-1" }),
  event({ type: "turn.started" }),
  event({ type: "item.completed", item: { type: "command_execution", command: "curl -v https://api.example/items",
    aggregated_output: QUOTED, exit_code: 0 } }),
  event({ type: "item.completed", item: { type: "agent_message",
    text: "The upstream API answered 401 Unauthorized: its bearer token expired. I will report it." } }),
];
const failed = (message: string) => [event({ type: "error", message }), event({ type: "turn.failed", error: { message } })];
const intact = { repair: null, grantStatus: "active", marks: 0 };

describe("Codex login-loss detection by the real path (STUDIO-0065)", () => {
  it("ends a usage-limit run as a limit and leaves the shared account connected", async () => {
    const result = await runFakeCli({ stdout: [...transcript, ...failed(LIMIT)] });
    expect(result.exitCode).toBe(1);
    expect(result.errorCode).toBe("provider_quota");
    expect(result.errorFamily).toBe("provider_quota");
    expect(result.errorMessage).toContain("usage limit");
    const ended = await endFailedRun({ errorCode: result.errorCode ?? null, resultJson: result.resultJson });
    expect(ended).toMatchObject(intact);
    expect(ended.health).not.toBe("error");
  }, 120_000);

  it("lets the limit outrank a login word the CLI process wrote on stderr", async () => {
    const result = await runFakeCli({ stdout: [...transcript, ...failed(LIMIT)],
      stderr: "WARN mcp server answered 401 Unauthorized to the bearer token\n" });
    expect(result.errorCode).toBe("provider_quota");
    const ended = await endFailedRun({ errorCode: result.errorCode ?? null, resultJson: result.resultJson });
    expect(ended).toMatchObject(intact);
  }, 120_000);

  it("does not mark the account for a failed run without a limit whose command output quotes a login failure", async () => {
    const result = await runFakeCli({ stdout: [...transcript, ...failed("The model rejected the request.")] });
    expect(result.exitCode).toBe(1);
    expect(result.errorCode ?? "").not.toMatch(/^refresh_token_/);
    const ended = await endFailedRun({ errorCode: result.errorCode ?? null, resultJson: result.resultJson });
    expect(ended).toMatchObject(intact);
    expect(ended.health).not.toBe("error");
  }, 120_000);

  it("does not mark the account for a run stored with a login code whose own error is a usage limit", async () => {
    // The run as fb1ad740 stored it: the adapter's old code, with the limit as its last protocol error.
    const stdout = [...transcript, ...failed(LIMIT)].map(line => `${line}\n`).join("");
    const ended = await endFailedRun({ errorCode: "refresh_token_invalidated",
      resultJson: { stdout, stderr: "", errorFamily: "refresh_token_invalidated" } });
    expect(ended).toMatchObject(intact);
    expect(ended.health).not.toBe("error");
  }, 120_000);

  it("still marks the account when a transcript that quotes a usage limit ends on a real login loss", async () => {
    // The limit outranks the login failure, so a quoted limit must not hide a real loss.
    const result = await runFakeCli({ stdout: [
      event({ type: "thread.started", thread_id: "codex-session-1" }),
      event({ type: "item.completed", item: { type: "command_execution", command: "cat notes.txt", aggregated_output: `${LIMIT}\n`, exit_code: 0 } }),
      event({ type: "item.completed", item: { type: "agent_message", text: LIMIT } }),
      ...failed("OAuth failed: refresh_token_reused"),
    ] });
    expect(result.errorCode).toBe("refresh_token_reused");
    const ended = await endFailedRun({ errorCode: result.errorCode ?? null, resultJson: result.resultJson });
    expect(ended).toMatchObject({ grantStatus: "needs_reauthorization", health: "error", marks: 1 });
  }, 120_000);

  // The known real forms of a Codex login loss. Each one still marks the account.
  it.each([
    ["refresh_token_reused in the protocol error", { stdout: [...transcript, ...failed("OAuth failed: refresh_token_reused")] }, "refresh_token_reused"],
    ["refresh_token_expired in the protocol error", { stdout: [...transcript, ...failed("OAuth failed: refresh token has expired")] }, "refresh_token_expired"],
    ["refresh_token_invalidated in the protocol error", { stdout: [...transcript, ...failed("OAuth failed: refresh_token_invalidated")] }, "refresh_token_invalidated"],
    ["invalid_grant in the protocol error", { stdout: failed("OAuth failed: invalid_grant") }, "refresh_token_invalidated"],
    ["a 401 from the API on the credential", { stdout: [...transcript, ...failed("credential refresh returned 401 Unauthorized")] }, "refresh_token_invalidated"],
    ["a login loss on stderr", { stdout: transcript, stderr: "OAuth failed: refresh token has expired\n" }, "refresh_token_expired"],
    ["a plain stdout line, the CLI failing before the protocol", { stdout: ["OAuth failed: refresh_token_reused"] }, "refresh_token_reused"],
    ["a plain stdout line among protocol events", { stdout: [...transcript, "OAuth failed: invalid_grant"] }, "refresh_token_invalidated"],
  ] as const)("still marks the account for %s", async (_form, output, code) => {
    const result = await runFakeCli({ stdout: [...output.stdout], stderr: "stderr" in output ? output.stderr : undefined });
    expect(result.exitCode).toBe(1);
    expect(result.errorCode).toBe(code);
    const ended = await endFailedRun({ errorCode: result.errorCode ?? null, resultJson: result.resultJson });
    expect(ended.repair).toMatchObject({ state: "needs_user_action", service: "openai" });
    expect(ended).toMatchObject({ grantStatus: "needs_reauthorization", health: "error", marks: 1 });
  }, 120_000);
});
