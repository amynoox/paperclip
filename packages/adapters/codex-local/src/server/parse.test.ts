import { describe, expect, it } from "vitest";
import {
  classifyCodexAuthRefreshFailure,
  extractCodexRetryNotBefore,
  isCodexHarnessCrash,
  isCodexProviderQuotaError,
  isCodexTransientUpstreamError,
  isCodexUnknownSessionError,
  parseCodexJsonl,
} from "./parse.js";

describe("parseCodexJsonl", () => {
  it.each(["turn.failed", "error", "turn.completed"])("does not invent zero usage for %s without counters", (type) => {
    expect(parseCodexJsonl(JSON.stringify({ type }))).toMatchObject({
      sawProtocolTerminalEvent: true, usageReported: false, usageComplete: false,
    });
  });
  it.each([{}, { input_tokens: 0 }, { input_tokens: -1, output_tokens: 0 }, { input_tokens: 1, output_tokens: 0, cached_input_tokens: 2 }])("rejects missing or invalid completion counters: %j", (usage) => {
    expect(parseCodexJsonl(JSON.stringify({ type: "turn.completed", usage })).usageComplete).toBe(false);
  });
  it("distinguishes explicit zero usage from missing usage", () => {
    expect(parseCodexJsonl(JSON.stringify({ type: "turn.completed", usage: { input_tokens: 0, output_tokens: 0 } }))).toMatchObject({
      usageReported: true, usageComplete: true, usage: { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0 },
    });
  });
  it("captures session id, assistant summary, usage, and error message", () => {
    const stdout = [
      JSON.stringify({ type: "thread.started", thread_id: "thread_123" }),
      JSON.stringify({
        type: "item.completed",
        item: { type: "agent_message", text: "Recovered response" },
      }),
      JSON.stringify({
        type: "turn.completed",
        usage: { input_tokens: 10, cached_input_tokens: 2, output_tokens: 4 },
      }),
      JSON.stringify({ type: "turn.failed", error: { message: "resume failed" } }),
    ].join("\n");

    expect(parseCodexJsonl(stdout)).toEqual({
      sessionId: "thread_123",
      summary: "Recovered response",
      usage: {
        inputTokens: 8,
        cachedInputTokens: 2,
        outputTokens: 4,
      },
      usageBasis: "per_run",
      errorMessage: "resume failed",
      sawProtocolEvent: true,
      sawProtocolTerminalEvent: true,
      usageReported: true,
      usageComplete: false,
    });
  });

  it("uses the last agent message as the summary when commentary updates precede the final answer", () => {
    const stdout = [
      JSON.stringify({ type: "thread.started", thread_id: "thread_123" }),
      JSON.stringify({
        type: "item.completed",
        item: { type: "reasoning", text: "Checking the heartbeat procedure" },
      }),
      JSON.stringify({
        type: "item.completed",
        item: { type: "agent_message", text: "I’m checking out the issue and reading the docs now." },
      }),
      JSON.stringify({
        type: "item.completed",
        item: { type: "agent_message", text: "Fixed the issue and verified the targeted tests pass." },
      }),
      JSON.stringify({
        type: "turn.completed",
        usage: { input_tokens: 10, cached_input_tokens: 2, output_tokens: 4 },
      }),
    ].join("\n");

    expect(parseCodexJsonl(stdout)).toEqual({
      sessionId: "thread_123",
      summary: "Fixed the issue and verified the targeted tests pass.",
      usage: {
        inputTokens: 8,
        cachedInputTokens: 2,
        outputTokens: 4,
      },
      usageBasis: "per_run",
      errorMessage: null,
      sawProtocolEvent: true,
      sawProtocolTerminalEvent: true,
      usageReported: true,
      usageComplete: true,
    });
  });
});

describe("isCodexHarnessCrash", () => {
  const crashedMidTurnStream = [
    JSON.stringify({ type: "thread.started", thread_id: "thread_123" }),
    JSON.stringify({
      type: "item.completed",
      item: { type: "agent_message", text: "Checking out the issue now." },
    }),
    JSON.stringify({ type: "item.started", item: { type: "command_execution" } }),
  ].join("\n");

  it("classifies a nonzero exit with no protocol-terminal event as a harness crash", () => {
    const parsed = parseCodexJsonl(crashedMidTurnStream);
    expect(parsed.sawProtocolEvent).toBe(true);
    expect(parsed.sawProtocolTerminalEvent).toBe(false);
    expect(isCodexHarnessCrash({ exitCode: 1, ...parsed })).toBe(true);
  });

  it("does not classify runs whose turn reached a protocol-terminal event", () => {
    const failedInProtocol = parseCodexJsonl(
      [
        JSON.stringify({ type: "thread.started", thread_id: "thread_123" }),
        JSON.stringify({ type: "turn.failed", error: { message: "the model rejected the request" } }),
      ].join("\n"),
    );
    expect(isCodexHarnessCrash({ exitCode: 1, ...failedInProtocol })).toBe(false);

    const completedThenFailedExit = parseCodexJsonl(
      [
        JSON.stringify({ type: "thread.started", thread_id: "thread_123" }),
        JSON.stringify({
          type: "turn.completed",
          usage: { input_tokens: 10, cached_input_tokens: 2, output_tokens: 4 },
        }),
      ].join("\n"),
    );
    expect(isCodexHarnessCrash({ exitCode: 1, ...completedThenFailedExit })).toBe(false);
  });

  it("does not classify successful exits or streams that never spoke the protocol", () => {
    expect(isCodexHarnessCrash({ exitCode: 0, ...parseCodexJsonl(crashedMidTurnStream) })).toBe(false);
    expect(isCodexHarnessCrash({ exitCode: null, ...parseCodexJsonl(crashedMidTurnStream) })).toBe(false);

    const neverStarted = parseCodexJsonl("error: unexpected argument '--bogus-flag'\n");
    expect(neverStarted.sawProtocolEvent).toBe(false);
    expect(isCodexHarnessCrash({ exitCode: 2, ...neverStarted })).toBe(false);
  });

  it("stays structural: agent output discussing network errors does not affect classification", () => {
    const parsed = parseCodexJsonl(
      [
        JSON.stringify({ type: "thread.started", thread_id: "thread_123" }),
        JSON.stringify({
          type: "item.completed",
          item: { type: "agent_message", text: "The deploy failed with connection reset by peer; investigating." },
        }),
        JSON.stringify({ type: "turn.failed", error: { message: "agent gave up" } }),
      ].join("\n"),
    );
    expect(isCodexHarnessCrash({ exitCode: 1, ...parsed })).toBe(false);
    expect(
      isCodexTransientUpstreamError({
        stdout: "connection reset by peer while running the deploy",
        errorMessage: "agent gave up",
      }),
    ).toBe(false);
  });
});

describe("classifyCodexAuthRefreshFailure", () => {
  it("classifies explicit refresh-token failure messages", () => {
    expect(classifyCodexAuthRefreshFailure({ errorMessage: "provider error: refresh_token_reused" })).toBe(
      "refresh_token_reused",
    );
    expect(classifyCodexAuthRefreshFailure({ stderr: "OAuth failed: refresh token has expired" })).toBe(
      "refresh_token_expired",
    );
    expect(classifyCodexAuthRefreshFailure({ stdout: "OAuth failed: invalid_grant" })).toBe(
      "refresh_token_invalidated",
    );
    expect(classifyCodexAuthRefreshFailure({ errorMessage: "credential refresh returned 401 Unauthorized" })).toBe(
      "refresh_token_invalidated",
    );
  });

  // STUDIO-0065 (adapted from paperclipai/paperclip#15832, head 10be54bcba, and extended): the login and limit
  // classifiers read the run's own error surface, never the output of a command nor the model's text.
  describe("classifiers and the transcript (STUDIO-0065)", () => {
    const event = (value: Record<string, unknown>) => JSON.stringify(value);
    const commandOutput = (output: string) => event({
      type: "item.completed",
      item: { type: "command_execution", command: "curl -v https://api.example", aggregated_output: output, exit_code: 0 },
    });
    const agentText = (text: string) => event({ type: "item.completed", item: { type: "agent_message", text } });
    const failed = (message: string) => [event({ type: "error", message }), event({ type: "turn.failed", error: { message } })];
    const quoted = "< HTTP/1.1 401 Unauthorized\n< www-authenticate: Bearer error=\"invalid_token\", the bearer token expired";
    const limit = "You've hit your usage limit for GPT-5.3-Codex. Switch to another model now, or try again at 11:31 PM.";

    it.each([
      "Invalid or expired refresh token",
      "refresh_token_reused",
      "credential refresh returned 401 Unauthorized",
      quoted,
      "OAuth failed: invalid_grant",
    ])("does not classify a login loss when a failed run only quotes %s", (quotedError) => {
      const providerError = "This content was flagged for possible cybersecurity risk.";
      const stdout = [
        event({ type: "thread.started", thread_id: "review-thread" }),
        commandOutput(`throw unauthorized('${quotedError}');`),
        agentText(quotedError),
        ...failed(providerError),
      ].join("\n");
      expect(classifyCodexAuthRefreshFailure({ stdout, errorMessage: parseCodexJsonl(stdout).errorMessage })).toBeNull();
      expect(parseCodexJsonl(stdout).errorMessage).toBe(providerError);
    });

    it("classifies a usage limit as a limit although the transcript quotes a login failure", () => {
      const stdout = [
        event({ type: "thread.started", thread_id: "t" }),
        commandOutput(quoted),
        agentText(`The API answered: ${quoted}`),
        ...failed(limit),
      ].join("\n");
      const input = { stdout, stderr: "", errorMessage: parseCodexJsonl(stdout).errorMessage };
      expect(isCodexProviderQuotaError(input)).toBe(true);
      expect(classifyCodexAuthRefreshFailure(input)).toBeNull();
      expect(extractCodexRetryNotBefore(input, new Date(2026, 3, 22, 22, 29, 2))?.getHours()).toBe(23);
    });

    it("does not classify a limit, a transient error or a retry time from the transcript alone", () => {
      // The limit outranks the login failure, so a transcript that quotes a limit must not hide a real login loss.
      const stdout = [
        event({ type: "thread.started", thread_id: "t" }),
        commandOutput(`${limit}\nWe're currently experiencing high demand, remote compact task failed`),
        agentText(limit),
        ...failed("OAuth failed: refresh_token_reused"),
      ].join("\n");
      const input = { stdout, stderr: "", errorMessage: parseCodexJsonl(stdout).errorMessage };
      expect(isCodexProviderQuotaError(input)).toBe(false);
      expect(isCodexTransientUpstreamError(input)).toBe(false);
      expect(extractCodexRetryNotBefore(input)).toBeNull();
      expect(classifyCodexAuthRefreshFailure(input)).toBe("refresh_token_reused");
    });

    it.each([
      ["refresh_token_reused", "refresh_token_reused"],
      ["refresh token has expired", "refresh_token_expired"],
      ["OAuth failed: refresh_token_invalidated", "refresh_token_invalidated"],
      ["OAuth failed: invalid_grant", "refresh_token_invalidated"],
      ["credential refresh returned 401 Unauthorized", "refresh_token_invalidated"],
    ])("still classifies a real protocol failure: %s", (message, expected) => {
      const stdout = [event({ type: "thread.started", thread_id: "auth-thread" }), ...failed(message)].join("\n");
      expect(classifyCodexAuthRefreshFailure({ stdout })).toBe(expected);
      expect(isCodexProviderQuotaError({ stdout })).toBe(false);
    });

    it("still reads a login loss on stderr and on a plain stdout line, with or without protocol events", () => {
      const transcript = [event({ type: "thread.started", thread_id: "t" }), agentText("Application error: refresh_token_reused")];
      expect(classifyCodexAuthRefreshFailure({ stdout: transcript.join("\n"), stderr: "OAuth failed: refresh token has expired" }))
        .toBe("refresh_token_expired");
      expect(classifyCodexAuthRefreshFailure({ stdout: [...transcript, "OAuth failed: invalid_grant"].join("\n") }))
        .toBe("refresh_token_invalidated");
      expect(classifyCodexAuthRefreshFailure({ stdout: "OAuth failed: refresh_token_reused" })).toBe("refresh_token_reused");
    });

    it("uses the final protocol failure rather than a recovered earlier error", () => {
      const stdout = [
        event({ type: "error", message: "refresh_token_expired" }),
        event({ type: "turn.failed", error: { message: "Unrelated provider failure" } }),
      ].join("\n");
      expect(classifyCodexAuthRefreshFailure({ stdout })).toBeNull();
    });

    it("ignores quoted login errors when the protocol stops without a terminal error", () => {
      const stdout = commandOutput("Invalid or expired refresh token");
      expect(classifyCodexAuthRefreshFailure({ stdout, stderr: "Process terminated unexpectedly" })).toBeNull();
    });

    it("does not read the cut head of a capped capture as plain text", () => {
      // The capture keeps the last 4 MiB of stdout: its first line can be the tail of a command's output.
      const fragment = `www-authenticate: Bearer error=\\"invalid_token\\" 401 Unauthorized","exit_code":0}}`;
      const filler = `${agentText("x".repeat(1024))}\n`;
      const body = filler.repeat(Math.ceil((4 * 1024 * 1024) / filler.length));
      const stdout = `${fragment}\n${body}${failed("The model rejected the request.").join("\n")}`;
      expect(stdout.length).toBeGreaterThanOrEqual(4 * 1024 * 1024);
      expect(classifyCodexAuthRefreshFailure({ stdout })).toBeNull();
      // The same words on a real first line of a short capture are the CLI's own plain text.
      expect(classifyCodexAuthRefreshFailure({ stdout: "credential refresh returned 401 Unauthorized\n" }))
        .toBe("refresh_token_invalidated");
    });
  });

  it("does not classify bare 401 or quota messages as auth-refresh failures", () => {
    expect(classifyCodexAuthRefreshFailure({ errorMessage: "chatgpt wham api returned 401" })).toBeNull();
    expect(classifyCodexAuthRefreshFailure({ errorMessage: "You've hit your usage limit for GPT-5." })).toBeNull();
  });
});

describe("isCodexUnknownSessionError", () => {
  it("detects the current missing-rollout thread error", () => {
    expect(
      isCodexUnknownSessionError(
        "",
        "Error: thread/resume: thread/resume failed: no rollout found for thread id d448e715-7607-4bcc-91fc-7a3c0c5a9632",
      ),
    ).toBe(true);
  });

  it("still detects existing stale-session wordings", () => {
    expect(isCodexUnknownSessionError("unknown thread id", "")).toBe(true);
    expect(isCodexUnknownSessionError("", "state db missing rollout path for thread abc")).toBe(true);
    expect(isCodexUnknownSessionError("", "state db returned stale rollout path for thread abc")).toBe(true);
  });

  it("does not classify unrelated Codex failures as stale sessions", () => {
    expect(isCodexUnknownSessionError("", "model overloaded")).toBe(false);
  });
});

describe("isCodexTransientUpstreamError", () => {
  it("classifies the remote-compaction high-demand failure as transient upstream", () => {
    expect(
      isCodexTransientUpstreamError({
        errorMessage:
          "Error running remote compact task: We're currently experiencing high demand, which may cause temporary errors.",
      }),
    ).toBe(true);
    expect(
      isCodexTransientUpstreamError({
        stderr: "We're currently experiencing high demand, which may cause temporary errors.",
      }),
    ).toBe(true);
  });

  it("classifies usage-limit windows as provider quota and extracts the retry time", () => {
    const errorMessage = "You've hit your usage limit for GPT-5.3-Codex-Spark. Switch to another model now, or try again at 11:31 PM.";
    const now = new Date(2026, 3, 22, 22, 29, 2);

    expect(isCodexProviderQuotaError({ errorMessage })).toBe(true);
    expect(isCodexTransientUpstreamError({ errorMessage })).toBe(false);
    expect(extractCodexRetryNotBefore({ errorMessage }, now)?.getTime()).toBe(
      new Date(2026, 3, 22, 23, 31, 0, 0).getTime(),
    );
  });

  it("classifies model-capacity messages as provider quota without reset metadata", () => {
    const errorMessage = "The requested model is at capacity. Please try again later.";

    expect(isCodexProviderQuotaError({ errorMessage })).toBe(true);
    expect(isCodexTransientUpstreamError({ errorMessage })).toBe(false);
    expect(extractCodexRetryNotBefore({ errorMessage })).toBeNull();
  });

  it("parses explicit timezone hints on usage-limit retry windows", () => {
    const errorMessage = "You've hit your usage limit for GPT-5.3-Codex-Spark. Switch to another model now, or try again at 11:31 PM (America/Chicago).";
    const now = new Date("2026-04-23T03:29:02.000Z");

    expect(extractCodexRetryNotBefore({ errorMessage }, now)?.toISOString()).toBe(
      "2026-04-23T04:31:00.000Z",
    );
  });

  it("does not classify deterministic compaction errors as transient", () => {
    expect(
      isCodexTransientUpstreamError({
        errorMessage: [
          "Error running remote compact task: {",
          '  "error": {',
          '    "message": "Unknown parameter: \'prompt_cache_retention\'.",',
          '    "type": "invalid_request_error",',
          '    "param": "prompt_cache_retention",',
          '    "code": "unknown_parameter"',
          "  }",
          "}",
        ].join("\n"),
      }),
    ).toBe(false);
  });
});
