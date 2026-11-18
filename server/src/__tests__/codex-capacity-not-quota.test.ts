/**
 * STUDIO-0067: a saturated model is not an exhausted account. Production, 18 Nov 2026: the Feedback Manager's run of
 * 07:00:00 UTC ended on "Reconnecting... 2/5 (Selected model is at capacity. Please try a different model.)" and was
 * classified provider_quota. The server then cancelled every later run of the role (provider_limit_wait) until
 * 08:23:32 UTC, its default wait of one hour when a limit reports no reset time, although the account had allowance.
 *
 * Each case runs the REAL codex_local adapter (CLI lane) against a fake CLI, stores the run as the heartbeat stores
 * it, and asks what the dispatch asks before starting the role's next run: agentProviderLimitCooldown.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { agents, companies, createDb, heartbeatRuns } from "@paperclipai/db";
import { startEmbeddedPostgresTestDatabase } from "@paperclipai/db/test-embedded-postgres";
import { execute } from "@paperclipai/adapter-codex-local/server";
import { agentProviderLimitCooldown } from "../services/native-runtime/native-startup-retry.js";

let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
let db: ReturnType<typeof createDb>;
const companyId = randomUUID();

beforeAll(async () => {
  database = await startEmbeddedPostgresTestDatabase("paperclip-codex-capacity-");
  db = createDb(database.connectionString);
  await db.insert(companies).values({ id: companyId, name: "Codex capacity", issuePrefix: "CXC" });
}, 90_000);
afterAll(async () => { await database?.cleanup(); });

const event = (value: Record<string, unknown>) => JSON.stringify(value);

/** A fake Codex CLI: it writes the given stdout and exits with the given code. */
async function runFakeCli(output: { stdout: string[]; exitCode: number }) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-codex-capacity-cli-"));
  const workspace = path.join(root, "workspace");
  const commandPath = path.join(root, "codex");
  const codexHome = path.join(root, ".codex");
  await fs.mkdir(workspace, { recursive: true });
  await fs.mkdir(codexHome, { recursive: true });
  await fs.writeFile(path.join(codexHome, "auth.json"), `${JSON.stringify({ OPENAI_API_KEY: "sk-test-codex-local" })}\n`, "utf8");
  await fs.writeFile(commandPath, `#!/usr/bin/env node
process.stdout.write(${JSON.stringify(output.stdout.map(line => `${line}\n`).join(""))});
process.exit(${output.exitCode});
`, "utf8");
  await fs.chmod(commandPath, 0o755);
  const previousHome = process.env.HOME;
  const previousCodexHome = process.env.CODEX_HOME;
  process.env.HOME = root;
  process.env.CODEX_HOME = codexHome;
  try {
    return await execute({
      runId: `run-${randomUUID()}`,
      agent: { id: "agent-1", companyId: "company-1", name: "Feedback Manager", adapterType: "codex_local", adapterConfig: { engine: "cli" } },
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

/** Store runs of one role as the heartbeat stores them, oldest first, and ask whether its next run is held. */
async function nextRunHold(runs: Array<{ exitCode: number | null; errorCode?: string | null; resultJson?: unknown }>) {
  const agentId = randomUUID();
  await db.insert(agents).values({ id: agentId, companyId, name: "Feedback Manager", adapterType: "codex_local" });
  const now = Date.now();
  for (const [index, run] of runs.entries()) {
    const at = new Date(now - (runs.length - index) * 60_000);
    await db.insert(heartbeatRuns).values({ id: randomUUID(), companyId, agentId,
      status: (run.exitCode ?? 0) === 0 ? "succeeded" : "failed", errorCode: run.errorCode ?? null,
      resultJson: (run.resultJson ?? {}) as Record<string, unknown>, startedAt: at, finishedAt: at, updatedAt: at });
  }
  return agentProviderLimitCooldown(db, { companyId, agentId, now: new Date(now) });
}

const started = [event({ type: "thread.started", thread_id: "codex-session-1" }), event({ type: "turn.started" })];
const CAPACITY = "Selected model is at capacity. Please try a different model.";
const ANNOUNCEMENT = `Reconnecting... 2/5 (${CAPACITY})`;
const LIMIT = "You've hit your usage limit for GPT-5.3-Codex. Switch to another model now, or try again at 11:31 PM.";

describe("a saturated Codex model is not an exhausted account (STUDIO-0067)", () => {
  it("retries the run of 18 Nov shortly and does not hold the role's next runs", async () => {
    // The stream ended on Codex's announcement of its next attempt, with a non-zero exit.
    const result = await runFakeCli({ stdout: [...started, event({ type: "error", message: ANNOUNCEMENT })], exitCode: 1 });
    expect(result.exitCode).toBe(1);
    expect(result.errorCode).toBe("codex_transient_upstream");
    expect(result.errorFamily).toBe("transient_upstream");
    expect(result.errorMessage).toBe(ANNOUNCEMENT);
    expect(result.retryNotBefore ?? null).toBeNull();
    expect(result.resultJson).not.toHaveProperty("providerLimitObserved");
    expect(await nextRunHold([{ exitCode: result.exitCode, errorCode: result.errorCode, resultJson: result.resultJson }])).toBeNull();
  }, 120_000);

  it("does not take a retry announcement for a verdict, whatever cause it quotes", async () => {
    // The stream ended while Codex was still retrying. The cause it quotes here is a usage limit: if it is real, the
    // next run ends on the provider's final error and holds the role then.
    for (const announcement of [`Reconnecting... 3/5 (${LIMIT})`, "Reconnecting... 1/5 (stream disconnected before completion)"]) {
      const result = await runFakeCli({ stdout: [...started, event({ type: "error", message: announcement })], exitCode: 1 });
      expect(result.errorCode).toBe("codex_transient_upstream");
      expect(result.retryNotBefore ?? null).toBeNull();
      expect(result.resultJson).not.toHaveProperty("providerLimitObserved");
      expect(await nextRunHold([{ exitCode: result.exitCode, errorCode: result.errorCode, resultJson: result.resultJson }])).toBeNull();
    }
  }, 120_000);

  it("does the same when Codex gave up on the saturated model", async () => {
    const result = await runFakeCli({ stdout: [...started, event({ type: "error", message: ANNOUNCEMENT }),
      event({ type: "error", message: CAPACITY }), event({ type: "turn.failed", error: { message: CAPACITY } })], exitCode: 1 });
    expect(result.errorCode).toBe("codex_transient_upstream");
    expect(await nextRunHold([{ exitCode: result.exitCode, errorCode: result.errorCode, resultJson: result.resultJson }])).toBeNull();
  }, 120_000);

  it("still holds the role on a real usage limit, until its reported reset or for an hour without one", async () => {
    const timed = await runFakeCli({ stdout: [...started, event({ type: "error", message: LIMIT }),
      event({ type: "turn.failed", error: { message: LIMIT } })], exitCode: 1 });
    expect(timed.errorCode).toBe("provider_quota");
    expect(timed.resultJson).toMatchObject({ errorFamily: "provider_quota", providerLimitObserved: true });
    expect(await nextRunHold([{ exitCode: timed.exitCode, errorCode: timed.errorCode, resultJson: timed.resultJson }]))
      .toMatchObject({ resetReported: true, category: "quota_exhausted" });
    const untimed = await runFakeCli({ stdout: [...started, event({ type: "turn.failed", error: { message: "You've hit your usage limit." } })], exitCode: 1 });
    expect(untimed.errorCode).toBe("provider_quota");
    const hold = await nextRunHold([{ exitCode: untimed.exitCode, errorCode: untimed.errorCode, resultJson: untimed.resultJson }]);
    expect(hold).toMatchObject({ resetReported: false, category: "quota_exhausted" });
    expect(hold!.resetAt.getTime() - Date.now()).toBeGreaterThan(50 * 60_000);
  }, 120_000);

  it("never fails nor holds anything for a successful turn that carries recovered error lines", async () => {
    // A successful turn can carry `error` lines Codex recovered from, before its turn.completed, with exit code zero.
    const result = await runFakeCli({ stdout: [...started, event({ type: "error", message: ANNOUNCEMENT }),
      event({ type: "error", message: `Reconnecting... 3/5 (${LIMIT})` }),
      event({ type: "item.completed", item: { type: "agent_message", text: "Done." } }),
      event({ type: "turn.completed", usage: { input_tokens: 10, output_tokens: 2, cached_input_tokens: 0 } })], exitCode: 0 });
    expect(result.exitCode).toBe(0);
    expect(result.errorCode ?? null).toBeNull();
    expect(result.errorFamily ?? null).toBeNull();
    expect(result.errorMessage ?? null).toBeNull();
    expect(result.retryNotBefore ?? null).toBeNull();
    expect(result.resultJson).not.toHaveProperty("providerLimitObserved");
    expect(result.summary).toBe("Done.");
    expect(await nextRunHold([{ exitCode: 0, errorCode: null, resultJson: result.resultJson }])).toBeNull();
    // Such a success also clears an earlier limit of the role, like any successful run.
    expect(await nextRunHold([
      { exitCode: 1, errorCode: "provider_quota", resultJson: { errorFamily: "provider_quota", providerLimitObserved: true } },
      { exitCode: 0, errorCode: null, resultJson: result.resultJson },
    ])).toBeNull();
  }, 120_000);
});
