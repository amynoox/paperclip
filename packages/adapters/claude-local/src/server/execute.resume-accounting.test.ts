import { beforeEach, describe, expect, it, vi } from "vitest";

const { runAdapterExecutionTargetProcess } = vi.hoisted(() => ({
  runAdapterExecutionTargetProcess: vi.fn(),
}));

vi.mock("./acp.js", () => ({
  createClaudeAcpExecutor: () => vi.fn(),
  resolveClaudeExecutionEngineForRun: async () => ({ engine: "cli", explicit: true }),
}));

vi.mock("@paperclipai/adapter-utils/execution-target", async () => {
  const actual = await vi.importActual<typeof import("@paperclipai/adapter-utils/execution-target")>(
    "@paperclipai/adapter-utils/execution-target",
  );
  return {
    ...actual,
    ensureAdapterExecutionTargetCommandResolvable: vi.fn(async () => undefined),
    ensureAdapterExecutionTargetRuntimeCommandInstalled: vi.fn(async () => undefined),
    resolveAdapterExecutionTargetCommandForLogs: vi.fn(async () => "claude"),
    runAdapterExecutionTargetProcess,
  };
});

import { execute, usageAccounting } from "./execute.js";

// A resumed Claude session reports a cumulative result ledger; each run must
// report its own share and persist the ledger for the next resumed run.
const SESSION = "11111111-2222-4333-8444-555555555555";

function launch(cost: number, input: number, output: number) {
  const stdout = [
    JSON.stringify({ type: "system", subtype: "init", session_id: SESSION, model: "claude-sonnet" }),
    JSON.stringify({
      type: "result",
      subtype: "success",
      session_id: SESSION,
      result: "done",
      total_cost_usd: cost,
      usage: { input_tokens: 1, output_tokens: 1 },
      modelUsage: { "claude-sonnet": { inputTokens: input, outputTokens: output, costUSD: cost } },
    }),
  ].join("\n");
  runAdapterExecutionTargetProcess.mockImplementation(async (
    _runId: string,
    _target: unknown,
    _command: string,
    args: string[],
    options?: { onLog?: (stream: "stdout" | "stderr", chunk: string) => Promise<void> },
  ) => {
    const output = args.includes("--version") ? "2.1.322 (Claude Code)" : stdout;
    if (!args.includes("--version")) await options?.onLog?.("stdout", `${output}
`);
    return { exitCode: 0, signal: null, timedOut: false, stdout: output, stderr: "", pid: 321, startedAt: new Date().toISOString() };
  });
}

function buildContext(sessionParams: Record<string, unknown> | null, onUsage: (...args: never[]) => Promise<void> = vi.fn(async () => {})) {
  return {
    runId: "run-1",
    agent: { id: "agent-1", companyId: "company-1", name: "Claude Coder", adapterType: "claude_local", adapterConfig: {} },
    runtime: { sessionId: null, sessionParams, sessionDisplayId: null, taskKey: null },
    config: { engine: "cli" },
    context: {},
    onLog: vi.fn(async () => {}),
    onUsage,
  };
}

function claudeArgs() {
  return runAdapterExecutionTargetProcess.mock.calls
    .map((call) => call[3] as string[])
    .filter((args) => !args.includes("--version"))
    .at(-1)!;
}

describe("claude_local per-invocation accounting (STUDIO-0013)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("exports the per-invocation marker", () => {
    expect(usageAccounting).toBe("per_invocation");
  });

  it("reports a resumed run's own share and carries the ledger forward", async () => {
    launch(0.0844, 20, 5);
    const first = await execute(buildContext(null) as never);
    expect(first.costUsd).toBeCloseTo(0.0844);
    expect(first.usage).toMatchObject({ inputTokens: 20, outputTokens: 5 });
    expect(first.sessionParams?.claudeSessionTotals).toMatchObject({ sessionId: SESSION, totalCostUsd: 0.0844 });

    launch(0.0942, 30, 8);
    const onUsage = vi.fn(async (_receipt: { costUsd?: number | null; complete?: boolean }) => {});
    const second = await execute(buildContext(first.sessionParams ?? null, onUsage) as never);
    expect(claudeArgs()).toEqual(expect.arrayContaining(["--resume", SESSION]));
    expect(second.usageBasis).toBe("per_run");
    expect(second.costUsd).toBeCloseTo(0.0098);
    expect(second.usage).toMatchObject({ inputTokens: 10, outputTokens: 3 });
    expect(second.usageByModel).toEqual([expect.objectContaining({ model: "claude-sonnet", usage: expect.objectContaining({ inputTokens: 10, outputTokens: 3 }) })]);
    expect(second.usageByModel?.[0]?.costUsd).toBeCloseTo(0.0098);
    const receipt = onUsage.mock.calls.at(-1)?.[0];
    expect(receipt?.complete).toBe(true);
    expect(receipt?.costUsd).toBeCloseTo(0.0098);
    expect(second.sessionParams?.claudeSessionTotals).toMatchObject({ sessionId: SESSION, totalCostUsd: 0.0942 });
  });

  it("does not subtract a ledger persisted for another session", async () => {
    launch(0.0942, 30, 8);
    const result = await execute(buildContext({
      sessionId: SESSION,
      cwd: process.cwd(),
      claudeSessionTotals: { sessionId: "99999999-2222-4333-8444-555555555555", modelUsage: { "claude-sonnet": { inputTokens: 20 } }, totalCostUsd: 0.0844 },
    }) as never);
    expect(result.costUsd).toBeCloseTo(0.0942);
    expect(result.usage).toMatchObject({ inputTokens: 30, outputTokens: 8 });
  });
});
