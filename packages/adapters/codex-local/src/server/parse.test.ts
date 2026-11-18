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
    // The sentences Codex writes on a login loss, read in the installed binaries (codex-cli 0.156.1 and 0.166.0).
    const REUSED = "Your access token could not be refreshed because your refresh token was already used. Please log out and sign in again.";
    const EXPIRED = "Your access token could not be refreshed because your refresh token has expired. Please log out and sign in again.";
    const REVOKED = "Your access token could not be refreshed because your refresh token was revoked. Please log out and sign in again.";
    const OTHER_ACCOUNT = "Your access token could not be refreshed because you have since logged out or signed in to another account. Please sign in again.";
    const NOT_REFRESHED = "Your access token could not be refreshed. Please log out and sign in again.";
    const SESSION = "Your authentication session could not be refreshed automatically. Please log out and sign in again.";
    // The trace Codex writes on stderr next to them.
    const TRACE = "ERROR codex_login::auth::manager: Failed to refresh token status=401 Unauthorized";
    const turn = [event({ type: "thread.started", thread_id: "t" }), event({ type: "turn.started" })];

    it.each([
      [REUSED, "refresh_token_reused"],
      [EXPIRED, "refresh_token_expired"],
      [REVOKED, "refresh_token_invalidated"],
      [OTHER_ACCOUNT, "refresh_token_invalidated"],
      [NOT_REFRESHED, "refresh_token_invalidated"],
      [SESSION, "refresh_token_invalidated"],
    ])("classifies Codex's own sentence in the protocol error: %s", (sentence, expected) => {
      // The real order: thread.started, turn.started, the `error` event, turn.failed; the trace on stderr.
      const stdout = [...turn, ...failed(sentence)].join("\n");
      const input = { stdout, stderr: `${TRACE}\n`, errorMessage: parseCodexJsonl(stdout).errorMessage };
      expect(classifyCodexAuthRefreshFailure(input)).toBe(expected);
      expect(isCodexProviderQuotaError(input)).toBe(false);
      expect(isCodexTransientUpstreamError(input)).toBe(false);
      // The protocol alone is enough: a stdout composed by the router carries no stderr.
      expect(classifyCodexAuthRefreshFailure({ stdout: [...turn, event({ type: "turn.failed", error: { message: sentence } })].join("\n"), stderr: "" }))
        .toBe(expected);
      // The same sentence quoted by a command or by the model classifies nothing.
      const quotedOnly = [...turn, commandOutput(sentence), agentText(sentence), ...failed("The model rejected the request.")].join("\n");
      expect(classifyCodexAuthRefreshFailure({ stdout: quotedOnly, stderr: "" })).toBeNull();
    });

    it("reads the stderr trace only when the protocol never started", () => {
      // Before the stream the CLI's stderr is its own words.
      expect(classifyCodexAuthRefreshFailure({ stdout: "", stderr: `${TRACE}\n` })).toBe("refresh_token_invalidated");
      expect(classifyCodexAuthRefreshFailure({ stdout: `${EXPIRED}\n`, stderr: "" })).toBe("refresh_token_expired");
      // Once the protocol started, the trace alone, without a protocol error, classifies nothing: the run is a
      // harness crash, retried; the next run meets the login loss through the protocol.
      expect(classifyCodexAuthRefreshFailure({ stdout: turn.join("\n"), stderr: `${TRACE}\n` })).toBeNull();
      // A refresh that failed for another reason, and a sign-in mode mismatch, are not a login loss of the account.
      expect(classifyCodexAuthRefreshFailure({ stdout: "", stderr: "Failed to refresh token: error sending request for url" })).toBeNull();
      expect(classifyCodexAuthRefreshFailure({ stdout: "", stderr: "ChatGPT login is required, but an API key is currently being used. Logging out." })).toBeNull();
    });

    it("does not read an MCP server's OAuth words as a login loss of the account", () => {
      const mcpGrant = "The MCP authorization server rejected the enterprise grant: invalid_grant";
      const mcpLogin = "ERROR mcp server linear requires OAuth login: 401 Unauthorized";
      for (const line of [mcpGrant, mcpLogin]) {
        // As the protocol's last error, on stderr or as a plain line before the protocol, and on stderr after it.
        expect(classifyCodexAuthRefreshFailure({ stdout: [...turn, ...failed(line)].join("\n") })).toBeNull();
        expect(classifyCodexAuthRefreshFailure({ stdout: "", stderr: line, errorMessage: line })).toBeNull();
        expect(classifyCodexAuthRefreshFailure({ stdout: line })).toBeNull();
        expect(classifyCodexAuthRefreshFailure({ stdout: turn.join("\n"), stderr: line })).toBeNull();
        // Codex's own sentence next to such a line still classifies.
        expect(classifyCodexAuthRefreshFailure({ stdout: "", stderr: `${line}\n${REVOKED}` })).toBe("refresh_token_invalidated");
      }
      // The generic patterns still work on a line that does not name MCP.
      expect(classifyCodexAuthRefreshFailure({ stdout: "", stderr: "OAuth failed: invalid_grant" })).toBe("refresh_token_invalidated");
    });

    it("forgets the errors of an earlier turn", () => {
      // A non-zero exit after a turn that completed, or during a later turn, must not classify an old error.
      const completed = [...turn, ...[event({ type: "error", message: REUSED })], event({ type: "turn.completed", usage: { input_tokens: 1, output_tokens: 1 } })];
      expect(classifyCodexAuthRefreshFailure({ stdout: completed.join("\n") })).toBeNull();
      const laterTurn = [...turn, ...failed(REUSED), event({ type: "turn.started" }), agentText("Working on it.")];
      expect(classifyCodexAuthRefreshFailure({ stdout: laterTurn.join("\n") })).toBeNull();
      const limitThenTurn = [...turn, ...failed(limit), event({ type: "turn.started" })];
      expect(isCodexProviderQuotaError({ stdout: limitThenTurn.join("\n") })).toBe(false);
      expect(extractCodexRetryNotBefore({ stdout: limitThenTurn.join("\n") })).toBeNull();
      // The error of the current turn counts.
      const current = [...turn, ...failed("The model rejected the request."), event({ type: "turn.started" }), ...failed(REUSED)];
      expect(classifyCodexAuthRefreshFailure({ stdout: current.join("\n") })).toBe("refresh_token_reused");
    });

    it("starts the protocol on a Codex event only, not on another JSON object", () => {
      // A wrapper that writes JSON on stdout must not switch off the reading of stderr.
      for (const wrapper of [event({ type: "log", message: "connected" }), event({ level: "info", msg: "connected" }), event({ type: "result", ok: false })]) {
        expect(classifyCodexAuthRefreshFailure({ stdout: wrapper, stderr: `${TRACE}\n` })).toBe("refresh_token_invalidated");
        expect(isCodexProviderQuotaError({ stdout: wrapper, stderr: limit })).toBe(true);
        // Followed by Codex events, the protocol started: stderr is not read.
        expect(classifyCodexAuthRefreshFailure({ stdout: [wrapper, ...turn].join("\n"), stderr: `${TRACE}\n` })).toBeNull();
      }
      for (const type of ["thread.started", "turn.started", "turn.completed", "turn.failed", "item.started", "item.updated", "item.completed", "error"]) {
        expect(classifyCodexAuthRefreshFailure({ stdout: event({ type }), stderr: `${TRACE}\n` })).toBeNull();
      }
    });

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
        ...failed(REUSED),
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
    ])("still classifies the baseline's code forms in a protocol error (kept; Codex does not write them): %s", (message, expected) => {
      const stdout = [event({ type: "thread.started", thread_id: "auth-thread" }), ...failed(message)].join("\n");
      expect(classifyCodexAuthRefreshFailure({ stdout })).toBe(expected);
      expect(isCodexProviderQuotaError({ stdout })).toBe(false);
    });

    it("reads stderr, plain stdout lines and the caller's message when the protocol never started", () => {
      // The CLI failed before its stream: these are its own words.
      expect(classifyCodexAuthRefreshFailure({ stdout: "", stderr: "OAuth failed: refresh token has expired" }))
        .toBe("refresh_token_expired");
      expect(classifyCodexAuthRefreshFailure({ stdout: "OAuth failed: invalid_grant" })).toBe("refresh_token_invalidated");
      expect(classifyCodexAuthRefreshFailure({ stdout: "OAuth failed: refresh_token_reused" })).toBe("refresh_token_reused");
      expect(classifyCodexAuthRefreshFailure({ errorMessage: "credential refresh returned 401 Unauthorized" }))
        .toBe("refresh_token_invalidated");
      expect(isCodexProviderQuotaError({ stdout: "", stderr: limit })).toBe(true);
    });

    it("reads only the protocol's last error once the protocol started", () => {
      // stderr also carries the words of MCP servers, hooks and the ssh client: they are not about the AI account.
      const started = [event({ type: "thread.started", thread_id: "t" }), agentText("Working on it.")];
      const mcp = "ERROR mcp server linear requires OAuth login: 401 Unauthorized";
      for (const stdout of [started.join("\n"), [...started, ...failed("The model rejected the request.")].join("\n")]) {
        expect(classifyCodexAuthRefreshFailure({ stdout, stderr: mcp })).toBeNull();
        expect(classifyCodexAuthRefreshFailure({ stdout, stderr: "OAuth failed: refresh token has expired" })).toBeNull();
        expect(classifyCodexAuthRefreshFailure({ stdout, errorMessage: mcp })).toBeNull();
        expect(classifyCodexAuthRefreshFailure({ stdout: `${stdout}\nOAuth failed: invalid_grant` })).toBeNull();
        expect(isCodexProviderQuotaError({ stdout, stderr: limit })).toBe(false);
      }
      // The protocol's own last error still decides.
      const stdout = [...started, ...failed(REUSED)].join("\n");
      expect(classifyCodexAuthRefreshFailure({ stdout, stderr: mcp })).toBe("refresh_token_reused");
    });

    it("matches no ssh client message of a routed run, which is about the machine's key", () => {
      for (const stderr of [
        "amyne@worker: Permission denied (publickey).",
        "Received disconnect from 10.0.0.12 port 22:2: Too many authentication failures",
        "Host key verification failed.",
      ]) {
        expect(classifyCodexAuthRefreshFailure({ stdout: "", stderr, errorMessage: stderr })).toBeNull();
        expect(isCodexProviderQuotaError({ stdout: "", stderr, errorMessage: stderr })).toBe(false);
      }
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
      // The capture keeps the last 4 MiB of stdout: its first line can be the tail of a command's output. Here no
      // protocol event is left in the capture, so the plain lines are read: all but that cut first line.
      const fragment = `www-authenticate: Bearer error=\\"invalid_token\\" 401 Unauthorized","exit_code":0}}`;
      const filler = `${"x".repeat(1024)}\n`;
      const stdout = `${fragment}\n${filler.repeat(Math.ceil((4 * 1024 * 1024) / filler.length))}`;
      expect(stdout.length).toBeGreaterThanOrEqual(4 * 1024 * 1024);
      expect(classifyCodexAuthRefreshFailure({ stdout })).toBeNull();
      // The same words on a real first line of a short capture are the CLI's own plain text.
      expect(classifyCodexAuthRefreshFailure({ stdout: `${fragment}\n` })).toBe("refresh_token_invalidated");
      // A capture cut by bytes is shorter in characters than the cap: the comparison is made in bytes.
      const wide = `${"\u00e9".repeat(1024)}\n`;
      const cutByBytes = `${fragment}\n${wide.repeat(Math.ceil((4 * 1024 * 1024) / Buffer.byteLength(wide, "utf8")))}`;
      expect(cutByBytes.length).toBeLessThan(4 * 1024 * 1024);
      expect(Buffer.byteLength(cutByBytes, "utf8")).toBeGreaterThanOrEqual(4 * 1024 * 1024);
      expect(classifyCodexAuthRefreshFailure({ stdout: cutByBytes })).toBeNull();
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

  // STUDIO-0067: this case said "provider quota" on the baseline. A saturated model is not an exhausted account:
  // classified as a limit, it held every later run of the role for an hour.
  it("classifies model-capacity messages as a transient upstream error, not as a provider quota", () => {
    for (const errorMessage of [
      "The requested model is at capacity. Please try again later.",
      "Selected model is at capacity. Please try a different model.",
      "We're at capacity for this model. Try again soon.",
    ]) {
      expect(isCodexProviderQuotaError({ errorMessage })).toBe(false);
      expect(isCodexTransientUpstreamError({ errorMessage })).toBe(true);
      expect(extractCodexRetryNotBefore({ errorMessage })).toBeNull();
    }
  });

  describe("a stream that ends on Codex's own retry announcement (STUDIO-0067)", () => {
    const event = (value: Record<string, unknown>) => JSON.stringify(value);
    const started = [event({ type: "thread.started", thread_id: "t" }), event({ type: "turn.started" })];
    const error = (message: string) => event({ type: "error", message });
    const limit = "You've hit your usage limit for GPT-5.3-Codex. Switch to another model now, or try again at 11:31 PM.";
    // The line of production, 18 Nov 2026, Feedback Manager.
    const CAPACITY = "Reconnecting... 2/5 (Selected model is at capacity. Please try a different model.)";

    it("is a transient error, never a quota, whatever cause the announcement quotes", () => {
      for (const announcement of [
        CAPACITY,
        "Reconnecting... 1/5 (stream disconnected before completion)",
        `Reconnecting... 3/5 (${limit})`,
        "Reconnecting... 5/5",
      ]) {
        const stdout = [...started, error(announcement)].join("\n");
        const input = { stdout, stderr: "", errorMessage: announcement };
        expect(isCodexProviderQuotaError(input)).toBe(false);
        expect(extractCodexRetryNotBefore(input)).toBeNull();
        expect(isCodexTransientUpstreamError(input)).toBe(true);
      }
    });

    it("still classifies from the provider's final error after the announcements", () => {
      // Codex gave up: its final error is the verdict.
      const failedOnLimit = [...started, error(CAPACITY), error(limit), event({ type: "turn.failed", error: { message: limit } })].join("\n");
      expect(isCodexProviderQuotaError({ stdout: failedOnLimit })).toBe(true);
      expect(isCodexTransientUpstreamError({ stdout: failedOnLimit })).toBe(false);
      expect(extractCodexRetryNotBefore({ stdout: failedOnLimit }, new Date(2026, 3, 22, 22, 29, 2))?.getHours()).toBe(23);
      const failedOnCapacity = [...started, error(CAPACITY),
        event({ type: "turn.failed", error: { message: "Selected model is at capacity. Please try a different model." } })].join("\n");
      expect(isCodexProviderQuotaError({ stdout: failedOnCapacity })).toBe(false);
      expect(isCodexTransientUpstreamError({ stdout: failedOnCapacity })).toBe(true);
    });

    it("keeps a real usage limit a quota, in the protocol error and before the protocol", () => {
      const stdout = [...started, error(limit), event({ type: "turn.failed", error: { message: limit } })].join("\n");
      expect(isCodexProviderQuotaError({ stdout })).toBe(true);
      expect(isCodexTransientUpstreamError({ stdout })).toBe(false);
      expect(isCodexProviderQuotaError({ stdout: "", stderr: limit })).toBe(true);
      // An announcement quoted by a command or by the model decides nothing.
      const quoted = [...started, event({ type: "item.completed", item: { type: "agent_message", text: CAPACITY } }),
        event({ type: "turn.failed", error: { message: "The model rejected the request." } })].join("\n");
      expect(isCodexProviderQuotaError({ stdout: quoted })).toBe(false);
      expect(isCodexTransientUpstreamError({ stdout: quoted })).toBe(false);
    });

    it("forgets the announcements of a turn that completed", () => {
      // A successful turn can carry error lines Codex recovered from, before its turn.completed.
      const recovered = [...started, error(CAPACITY), error(`Reconnecting... 2/5 (${limit})`),
        event({ type: "turn.completed", usage: { input_tokens: 1, output_tokens: 1 } })].join("\n");
      expect(isCodexProviderQuotaError({ stdout: recovered })).toBe(false);
      expect(isCodexTransientUpstreamError({ stdout: recovered })).toBe(false);
      expect(extractCodexRetryNotBefore({ stdout: recovered })).toBeNull();
      expect(classifyCodexAuthRefreshFailure({ stdout: recovered })).toBeNull();
    });
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
