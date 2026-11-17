/**
 * STUDIO-0064: the Claude adapter's login detection, by the real path.
 *
 * Production, 17 Nov 2026, run 21529e7e of a claude_local role: the run ended on the weekly limit (api_error_status
 * 429, "You've hit your weekly limit"), but a Unity test log in a tool result quoted
 * "System.UnauthorizedAccessException". The adapter sealed the run as claude_auth_required, and the end of the run
 * marked the role's AI account as needing a new sign-in: the role stayed in error until its owner signed in again.
 *
 * Each case runs the REAL claude_local adapter against a fake CLI, stores the run as the heartbeat stores it (status,
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
import { execute } from "@paperclipai/adapter-claude-local/server";
import { aiConnectionService } from "../services/ai-connections.js";
import { prepareManagedAiRuntime } from "../services/ai-connection-runtime.js";
import { connectionIntentService } from "../services/connection-intents.js";

// A background plan observation must not send the fixture credential to a real provider.
vi.mock("../services/subscription-refresh.js", () => ({ refreshSubscriptionConnection: vi.fn().mockResolvedValue(undefined) }));

let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
let db: ReturnType<typeof createDb>;
let home: string;
const companyId = randomUUID();
const binding = { provider: "anthropic", method: "api_key", mode: "responsible_user" } as const;

beforeAll(async () => {
  home = await realpath(await mkdtemp(path.join(os.tmpdir(), "paperclip-claude-login-scope-")));
  vi.stubEnv("PAPERCLIP_HOME", home);
  vi.stubEnv("PAPERCLIP_INSTANCE_ID", "claude-login-scope-fixture");
  database = await startEmbeddedPostgresTestDatabase("paperclip-claude-login-scope-");
  db = createDb(database.connectionString);
  await db.insert(companies).values({ id: companyId, name: "Claude login scope", issuePrefix: "CLS" });
}, 90_000);
afterAll(async () => {
  await database?.cleanup();
  vi.unstubAllEnvs();
  if (home) await rm(home, { recursive: true, force: true });
});

const event = (value: Record<string, unknown>) => JSON.stringify(value);
const SESSION = "11111111-1111-4111-8111-111111111111";

/** A fake Claude CLI: it answers --version, then writes the given stdout and stderr and exits. */
async function runFakeCli(output: { stdout: string[]; stderr?: string; exitCode?: number }) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-claude-login-cli-"));
  const workspace = path.join(root, "workspace");
  const commandPath = path.join(root, "bin", "claude");
  await fs.mkdir(workspace, { recursive: true });
  await fs.mkdir(path.dirname(commandPath), { recursive: true });
  await fs.writeFile(commandPath, `#!/usr/bin/env node
if (process.argv.includes("--version")) { console.log("2.1.286 (Claude Code)"); process.exit(0); }
process.stdout.write(${JSON.stringify(output.stdout.map(line => `${line}\n`).join(""))});
process.stderr.write(${JSON.stringify(output.stderr ?? "")});
process.exit(${output.exitCode ?? 1});
`, "utf8");
  await fs.chmod(commandPath, 0o755);
  const previousHome = process.env.HOME;
  process.env.HOME = root;
  try {
    return await execute({
      runId: `run-${randomUUID()}`,
      agent: { id: "agent-1", companyId: "co-1", name: "Test", adapterType: "claude_local", adapterConfig: { engine: "cli" } },
      runtime: { sessionId: null, sessionParams: null, sessionDisplayId: null, taskKey: null },
      config: { engine: "cli", command: commandPath, cwd: workspace, promptTemplate: "Do work." },
      context: {},
      authToken: "tok",
      onLog: async () => {},
    });
  } finally {
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    await fs.rm(root, { recursive: true, force: true });
  }
}

/** Store a failed run as the heartbeat stores it, on a role whose AI account is connected, and end it. */
async function endFailedRun(run: { errorCode: string | null; resultJson: unknown }) {
  const userId = `owner-${randomUUID()}`;
  const agentId = randomUUID();
  const issueId = randomUUID();
  const runId = randomUUID();
  await db.insert(companyMemberships).values({ companyId, principalId: userId, principalType: "user", status: "active", membershipRole: "member" });
  await db.insert(agents).values({ id: agentId, companyId, name: "Dev", adapterType: "claude_local", runtimeConfig: { aiConnection: binding } });
  await db.insert(issues).values({ id: issueId, companyId, title: "Work", status: "in_progress", assigneeAgentId: agentId });
  const account = await aiConnectionService(db).save(companyId, userId, { provider: "anthropic", method: "api_key",
    ownership: "personal", name: "Role account", apiKey: "fixture", agentIds: [agentId], allAgents: false }, "fixture-key");
  const runtime = await prepareManagedAiRuntime(db, { companyId, agentId, responsibleUserId: userId, adapterType: "claude_local", binding, config: {} });
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

const weeklyLimitResult = {
  type: "result",
  subtype: "success",
  session_id: SESSION,
  is_error: true,
  api_error_status: 429,
  api_error: "usage_limit_reached",
  terminal_reason: "api_error",
  result: "You've hit your weekly limit · resets 6am",
};
// The transcript of run 21529e7e, in shape: a tool result and a model text that quote login words.
const weeklyLimitTranscript = [
  event({ type: "system", subtype: "init", session_id: SESSION, model: "claude-sonnet" }),
  event({ type: "user", session_id: SESSION, message: { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_1",
    content: "SaveIndexGuardTests\n  Expected: no exception\n  But was: <System.UnauthorizedAccessException>\n  unauthorized\n" }] } }),
  event({ type: "assistant", session_id: SESSION, message: { role: "assistant", content: [{ type: "text",
    text: "The guard throws System.UnauthorizedAccessException: unauthorized. Is a login required for the vault?" }] } }),
  event(weeklyLimitResult),
];

describe("Claude login detection by the real path (STUDIO-0064)", () => {
  it("ends the weekly-limit run 21529e7e as a limit wait and leaves the account connected", async () => {
    const result = await runFakeCli({ stdout: weeklyLimitTranscript });
    expect(result.exitCode).toBe(1);
    expect(result.errorCode).toBe("provider_quota");
    expect(result.errorFamily).toBe("provider_quota");
    expect(result.errorMessage).toContain("weekly limit");
    expect(result.resultJson).toMatchObject({ api_error_status: 429, errorFamily: "provider_quota" });
    const ended = await endFailedRun({ errorCode: result.errorCode ?? null, resultJson: result.resultJson });
    expect(ended).toEqual({ repair: null, grantStatus: "active", health: expect.not.stringMatching(/^error$/), marks: 0 });
  }, 120_000);

  it("lets the limit outrank a login word the CLI process wrote on stderr", async () => {
    const result = await runFakeCli({ stdout: weeklyLimitTranscript, stderr: "hook failed: 401 Unauthorized\n" });
    expect(result.errorCode).toBe("provider_quota");
    const ended = await endFailedRun({ errorCode: result.errorCode ?? null, resultJson: result.resultJson });
    expect(ended).toMatchObject({ repair: null, grantStatus: "active", marks: 0 });
  }, 120_000);

  it("ends a failed run whose transcript quotes login words as its own failure, not as a login request", async () => {
    // No limit here: only the scope of the login markers keeps the transcript out.
    const result = await runFakeCli({ stdout: [
      ...weeklyLimitTranscript.slice(0, 3),
      event({ type: "result", subtype: "error_during_execution", session_id: SESSION, is_error: true,
        result: "The engine stopped on an internal error." }),
    ] });
    expect(result.exitCode).toBe(1);
    expect(result.errorCode).not.toBe("claude_auth_required");
    const ended = await endFailedRun({ errorCode: result.errorCode ?? null, resultJson: result.resultJson });
    expect(ended).toMatchObject({ repair: null, grantStatus: "active", marks: 0 });
  }, 120_000);

  it("does not mark the account for a run stored as claude_auth_required whose result reports a limit", async () => {
    // The run as fb1ad740 stored it: the adapter's old code, with the limit in its result.
    const ended = await endFailedRun({ errorCode: "claude_auth_required",
      resultJson: { ...weeklyLimitResult, stdout: weeklyLimitTranscript.join("\n") } });
    expect(ended).toMatchObject({ repair: null, grantStatus: "active", marks: 0 });
    expect(ended.health).not.toBe("error");
  }, 120_000);

  // The real forms of a login request. Each one still marks the account.
  it.each([
    ["a plain stdout line, the CLI refusing to start", { stdout: ["Not logged in · Please run /login"] }],
    ["the result field", { stdout: [
      event({ type: "system", subtype: "init", session_id: SESSION }),
      event({ type: "result", subtype: "success", session_id: SESSION, is_error: true, result: "Not logged in · Please run /login" }),
    ] }],
    ["an invalid API key in the result field", { stdout: [
      event({ type: "result", subtype: "success", session_id: SESSION, is_error: true, result: "Invalid API key · Please run /login" }),
    ] }],
    ["stderr", { stdout: [], stderr: "Invalid API key · Please run /login\n" }],
    ["a 401 status with a refused bearer token", { stdout: [
      event({ type: "system", subtype: "api_retry", attempt: 1, error_status: 401, error: "authentication_failed: bearer is invalid", session_id: SESSION }),
      event({ type: "assistant", session_id: SESSION, error: "authentication_failed",
        message: { role: "assistant", content: [{ type: "text", text: "Failed to authenticate. API Error: 401 Invalid bearer token" }] } }),
      event({ type: "result", subtype: "success", session_id: SESSION, is_error: true, api_error_status: 401,
        error: "authentication_failed", result: "Failed to authenticate. API Error: 401 Invalid bearer token" }),
    ] }],
    ["a 401 status alone", { stdout: [
      event({ type: "result", subtype: "success", session_id: SESSION, is_error: true, api_error_status: 401, result: "API Error: 401" }),
    ] }],
    ["an expired OAuth token in the terminal fields", { stdout: [
      event({ type: "result", subtype: "success", session_id: SESSION, is_error: true,
        result: "OAuth token has expired. Please obtain a new token or refresh your existing token." }),
    ] }],
    ["a cut stream whose assistant event carries the CLI's error field", { stdout: [
      event({ type: "system", subtype: "init", session_id: SESSION }),
      event({ type: "assistant", session_id: SESSION, error: "authentication_failed",
        message: { role: "assistant", content: [{ type: "text", text: "Failed to authenticate. API Error: 401 Invalid bearer token" }] } }),
    ] }],
  ] as const)("still marks the account for a login request in %s", async (_form, output) => {
    const result = await runFakeCli({ stdout: [...output.stdout], stderr: "stderr" in output ? output.stderr : undefined });
    expect(result.errorCode).toBe("claude_auth_required");
    const ended = await endFailedRun({ errorCode: result.errorCode ?? null, resultJson: result.resultJson });
    expect(ended.repair).toMatchObject({ state: "needs_user_action", service: "anthropic" });
    expect(ended).toMatchObject({ grantStatus: "needs_reauthorization", health: "error", marks: 1 });
  }, 120_000);
});
