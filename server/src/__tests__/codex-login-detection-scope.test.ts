/**
 * STUDIO-0065: the Codex adapter's login-loss detection, by the real path. The same defect as STUDIO-0064 (found
 * 17 Nov 2026), with a wider reach: the Codex roles share one OpenAI account, so one failed run whose transcript
 * quotes "401 Unauthorized ... bearer token" would put every one of them in error until the owner signs in again.
 *
 * Each case runs the REAL codex_local adapter against a fake CLI, stores the run as the heartbeat stores it (status,
 * error code, result), and calls what the end of a failed run calls (run-lifecycle.ts, classifyAndPersistRunLiveness):
 * connectionIntentService.requestForRunAuthFailure. The heartbeat's own execution loop is not driven here.
 *
 * The login-loss sentences and the stderr trace are Codex's own, read in the installed binaries (codex-cli 0.156.1 on
 * the server, 0.166.0 on the worker machines, Linux x64; read only). The real CLI was not run in a login-loss state.
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
const loggedOut = { grantStatus: "needs_reauthorization", health: "error", marks: 1 };

// Codex's own sentences on a login loss, and the trace it writes on stderr next to them.
const REUSED = "Your access token could not be refreshed because your refresh token was already used. Please log out and sign in again.";
const EXPIRED = "Your access token could not be refreshed because your refresh token has expired. Please log out and sign in again.";
const REVOKED = "Your access token could not be refreshed because your refresh token was revoked. Please log out and sign in again.";
const OTHER_ACCOUNT = "Your access token could not be refreshed because you have since logged out or signed in to another account. Please sign in again.";
const NOT_REFRESHED = "Your access token could not be refreshed. Please log out and sign in again.";
const AUTH_SESSION = "Your authentication session could not be refreshed automatically. Please log out and sign in again.";
const TRACE = "ERROR codex_login::auth::manager: Failed to refresh token status=401 Unauthorized\n";
const REAL_SENTENCES = [
  ["refresh token already used", REUSED, "refresh_token_reused"],
  ["refresh token expired", EXPIRED, "refresh_token_expired"],
  ["refresh token revoked", REVOKED, "refresh_token_invalidated"],
  ["logged out or signed in to another account", OTHER_ACCOUNT, "refresh_token_invalidated"],
  ["access token could not be refreshed", NOT_REFRESHED, "refresh_token_invalidated"],
  ["authentication session could not be refreshed", AUTH_SESSION, "refresh_token_invalidated"],
] as const;

describe("Codex login-loss detection by the real path (STUDIO-0065)", () => {
  it("ends a usage-limit run as a limit and leaves the shared account connected", async () => {
    const result = await runFakeCli({ stdout: [...transcript, ...failed(LIMIT)] });
    expect(result.exitCode).toBe(1);
    expect(result.errorCode).toBe("provider_quota");
    expect(result.errorFamily).toBe("provider_quota");
    expect(result.errorMessage).toContain("usage limit");
    // The structured mark the server guard reads.
    expect(result.resultJson).toMatchObject({ errorFamily: "provider_quota", providerLimitObserved: true });
    const ended = await endFailedRun({ errorCode: result.errorCode ?? null, resultJson: result.resultJson });
    expect(ended).toMatchObject(intact);
    expect(ended.health).not.toBe("error");
  }, 120_000);

  it("lets the limit outrank a login loss when the CLI failed before the protocol and wrote both", async () => {
    const result = await runFakeCli({ stdout: [LIMIT], stderr: "credential refresh returned 401 Unauthorized\n" });
    expect(result.errorCode).toBe("provider_quota");
    const ended = await endFailedRun({ errorCode: result.errorCode ?? null, resultJson: result.resultJson });
    expect(ended).toMatchObject(intact);
  }, 120_000);

  it("does not mark the account for login words on stderr once the protocol started", async () => {
    // An MCP server, a hook or the ssh client of a routed run writes there: not the AI account's words.
    const stderr = [
      "ERROR mcp server linear requires OAuth login: 401 Unauthorized",
      "The MCP authorization server rejected the enterprise grant: invalid_grant",
      "OAuth failed: refresh token has expired",
      "amyne@worker: Permission denied (publickey).",
      "Received disconnect from 10.0.0.12 port 22:2: Too many authentication failures",
      "Host key verification failed.",
    ].map(line => `${line}\n`).join("");
    for (const stdout of [[...transcript, ...failed("The model rejected the request.")], transcript]) {
      const result = await runFakeCli({ stdout, stderr });
      expect(result.exitCode).toBe(1);
      expect(result.errorCode ?? "").not.toMatch(/^refresh_token_/);
      const ended = await endFailedRun({ errorCode: result.errorCode ?? null, resultJson: result.resultJson });
      expect(ended).toMatchObject(intact);
    }
  }, 120_000);

  it("does not mark the account for the ssh client's messages when the CLI never started", async () => {
    const result = await runFakeCli({ stdout: [], stderr:
      "amyne@worker: Permission denied (publickey).\nToo many authentication failures\nHost key verification failed.\n" });
    expect(result.exitCode).toBe(1);
    expect(result.errorCode ?? "").not.toMatch(/^refresh_token_/);
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

  it("does not mark the account for a run whose result carries the structured limit mark, and reads no text", async () => {
    const stdout = [...transcript, ...failed(LIMIT)].map(line => `${line}\n`).join("");
    // A login code with the adapter's limit mark: the guard keeps the account.
    const marked = await endFailedRun({ errorCode: "refresh_token_invalidated",
      resultJson: { stdout, stderr: "", errorFamily: "refresh_token_invalidated", providerLimitObserved: true } });
    expect(marked).toMatchObject(intact);
    expect(marked.health).not.toBe("error");
    // The guard reads structured fields only: the same output without the mark is not re-read.
    const unmarked = await endFailedRun({ errorCode: "refresh_token_invalidated",
      resultJson: { stdout, stderr: "", errorFamily: "refresh_token_invalidated" } });
    expect(unmarked).toMatchObject({ grantStatus: "needs_reauthorization", health: "error", marks: 1 });
  }, 120_000);

  it("still marks the account when a transcript that quotes a usage limit ends on a real login loss", async () => {
    // The limit outranks the login failure, so a quoted limit must not hide a real loss.
    const result = await runFakeCli({ stdout: [
      event({ type: "thread.started", thread_id: "codex-session-1" }),
      event({ type: "item.completed", item: { type: "command_execution", command: "cat notes.txt", aggregated_output: `${LIMIT}\n`, exit_code: 0 } }),
      event({ type: "item.completed", item: { type: "agent_message", text: LIMIT } }),
      ...failed(REUSED),
    ], stderr: TRACE });
    expect(result.errorCode).toBe("refresh_token_reused");
    const ended = await endFailedRun({ errorCode: result.errorCode ?? null, resultJson: result.resultJson });
    expect(ended).toMatchObject(loggedOut);
  }, 120_000);

  // A real login loss, as Codex writes it: thread.started, turn.started, the `error` event, turn.failed, and the trace
  // on stderr. On the baseline these were caught by the stderr trace alone; stderr is no longer read once the
  // protocol started, so the sentences themselves must classify.
  it.each(REAL_SENTENCES)("marks the account for Codex's own sentence in the protocol error: %s", async (_form, sentence, code) => {
    const result = await runFakeCli({ stdout: [...transcript, ...failed(sentence)], stderr: TRACE });
    expect(result.exitCode).toBe(1);
    expect(result.errorCode).toBe(code);
    expect(result.errorMessage).toBe(sentence);
    const ended = await endFailedRun({ errorCode: result.errorCode ?? null, resultJson: result.resultJson });
    expect(ended.repair).toMatchObject({ state: "needs_user_action", service: "openai" });
    expect(ended).toMatchObject(loggedOut);
  }, 120_000);

  // Live steering through the worker router: the adapter receives a stdout composed in the `codex exec` format
  // (thread.started, turn.started, turn.failed) and an empty stderr. The login loss is seen only if that turn.failed
  // carries Codex's message word for word.
  it.each(REAL_SENTENCES)("marks the account for a composed turn.failed that carries Codex's sentence, without stderr: %s", async (_form, sentence, code) => {
    const result = await runFakeCli({ stdout: [
      event({ type: "thread.started", thread_id: "codex-session-1" }),
      event({ type: "turn.started" }),
      event({ type: "turn.failed", error: { message: sentence } }),
    ], stderr: "" });
    expect(result.errorCode).toBe(code);
    const ended = await endFailedRun({ errorCode: result.errorCode ?? null, resultJson: result.resultJson });
    expect(ended.repair).toMatchObject({ state: "needs_user_action", service: "openai" });
    expect(ended).toMatchObject(loggedOut);
  }, 120_000);

  it("does not see a login loss behind the router's fixed turn.failed text (a limit of the composed stdout)", async () => {
    // Router 0.30.x composes this text whatever the provider said, and returns an empty stderr.
    const result = await runFakeCli({ stdout: [
      event({ type: "thread.started", thread_id: "codex-session-1" }),
      event({ type: "turn.started" }),
      event({ type: "turn.failed", error: { message: "Interactive provider turn did not complete successfully." } }),
    ], stderr: "" });
    expect(result.exitCode).toBe(1);
    expect(result.errorCode ?? "").not.toMatch(/^refresh_token_/);
    const ended = await endFailedRun({ errorCode: result.errorCode ?? null, resultJson: result.resultJson });
    expect(ended).toMatchObject(intact);
  }, 120_000);

  it("marks the account when the CLI failed before the protocol with the trace on stderr or a sentence on stdout", async () => {
    for (const [output, code] of [
      [{ stdout: [], stderr: TRACE }, "refresh_token_invalidated"],
      [{ stdout: [EXPIRED], stderr: "" }, "refresh_token_expired"],
      [{ stdout: [], stderr: `${REUSED}\n` }, "refresh_token_reused"],
    ] as const) {
      const result = await runFakeCli({ stdout: [...output.stdout], stderr: output.stderr });
      expect(result.errorCode).toBe(code);
      const ended = await endFailedRun({ errorCode: result.errorCode ?? null, resultJson: result.resultJson });
      expect(ended).toMatchObject(loggedOut);
    }
  }, 120_000);

  it("retries as a harness crash a run that died after the protocol started with the trace only on stderr", async () => {
    // No protocol error: the login loss is not classified on this run. It is retried, and the next run meets the
    // login loss through the protocol.
    const result = await runFakeCli({ stdout: transcript, stderr: TRACE });
    expect(result.exitCode).toBe(1);
    expect(result.errorCode).toBe("codex_harness_crash");
    const ended = await endFailedRun({ errorCode: result.errorCode ?? null, resultJson: result.resultJson });
    expect(ended).toMatchObject(intact);
  }, 120_000);

  it("does not mark the account for an MCP server's OAuth refusal, wherever Codex writes it", async () => {
    const mcpGrant = "The MCP authorization server rejected the enterprise grant: invalid_grant";
    for (const output of [
      { stdout: [...transcript, ...failed(mcpGrant)], stderr: "" },
      { stdout: [], stderr: `${mcpGrant}\n` },
      { stdout: [mcpGrant], stderr: "" },
    ]) {
      const result = await runFakeCli(output);
      expect(result.exitCode).toBe(1);
      expect(result.errorCode ?? "").not.toMatch(/^refresh_token_/);
      const ended = await endFailedRun({ errorCode: result.errorCode ?? null, resultJson: result.resultJson });
      expect(ended).toMatchObject(intact);
    }
  }, 120_000);

  it("does not classify the error of an earlier turn after a turn that completed", async () => {
    const result = await runFakeCli({ stdout: [
      event({ type: "thread.started", thread_id: "codex-session-1" }),
      event({ type: "turn.started" }),
      event({ type: "error", message: REUSED }),
      event({ type: "turn.completed", usage: { input_tokens: 10, output_tokens: 2, cached_input_tokens: 0 } }),
    ], stderr: "" });
    expect(result.exitCode).toBe(1);
    expect(result.errorCode ?? "").not.toMatch(/^refresh_token_/);
    const ended = await endFailedRun({ errorCode: result.errorCode ?? null, resultJson: result.resultJson });
    expect(ended).toMatchObject(intact);
  }, 120_000);

  it("keeps reading stderr when a wrapper wrote a JSON object that is not a Codex event", async () => {
    const result = await runFakeCli({ stdout: [event({ type: "log", message: "connected" })], stderr: TRACE });
    expect(result.errorCode).toBe("refresh_token_invalidated");
    const ended = await endFailedRun({ errorCode: result.errorCode ?? null, resultJson: result.resultJson });
    expect(ended).toMatchObject(loggedOut);
  }, 120_000);

  // The code forms of the baseline's tests. Codex 0.156.1 and 0.166.0 do not write these codes; the patterns are
  // kept, and each form still marks the account.
  it.each([
    ["refresh_token_reused in the protocol error", { stdout: [...transcript, ...failed("OAuth failed: refresh_token_reused")] }, "refresh_token_reused"],
    ["refresh_token_expired in the protocol error", { stdout: [...transcript, ...failed("OAuth failed: refresh token has expired")] }, "refresh_token_expired"],
    ["refresh_token_invalidated in the protocol error", { stdout: [...transcript, ...failed("OAuth failed: refresh_token_invalidated")] }, "refresh_token_invalidated"],
    ["invalid_grant in the protocol error", { stdout: failed("OAuth failed: invalid_grant") }, "refresh_token_invalidated"],
    ["a 401 from the API on the credential", { stdout: [...transcript, ...failed("credential refresh returned 401 Unauthorized")] }, "refresh_token_invalidated"],
    ["a login loss on stderr, the CLI failing before the protocol", { stdout: [], stderr: "OAuth failed: refresh token has expired\n" }, "refresh_token_expired"],
    ["a plain stdout line, the CLI failing before the protocol", { stdout: ["OAuth failed: refresh_token_reused"] }, "refresh_token_reused"],
  ] as const)("still marks the account for the baseline's form: %s", async (_form, output, code) => {
    const result = await runFakeCli({ stdout: [...output.stdout], stderr: "stderr" in output ? output.stderr : undefined });
    expect(result.exitCode).toBe(1);
    expect(result.errorCode).toBe(code);
    const ended = await endFailedRun({ errorCode: result.errorCode ?? null, resultJson: result.resultJson });
    expect(ended.repair).toMatchObject({ state: "needs_user_action", service: "openai" });
    expect(ended).toMatchObject({ grantStatus: "needs_reauthorization", health: "error", marks: 1 });
  }, 120_000);
});
