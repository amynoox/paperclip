import { describe, expect, it } from "vitest";
import {
  claudeModelUsageTotals,
  claudeSessionTotals,
  readClaudeSessionTotals,
  parseClaudeStreamJson,
  detectClaudeLoginRequired,
  extractClaudeRetryNotBefore,
  isClaudeProviderQuotaError,
  isClaudeTransientUpstreamError,
  isClaudePoisonedPreviousMessageIdError,
  isClaudeRefusalResult,
  isClaudeUnknownSessionError,
  isClaudeImageProcessingError,
  isClaudeModelNotFoundError,
} from "./parse.js";

describe("detectClaudeLoginRequired", () => {
  it("classifies Claude's invalid API key login prompt as auth required", () => {
    expect(
      detectClaudeLoginRequired({
        parsed: null,
        stdout: "",
        stderr: "Invalid API key · Please run /login",
      }),
    ).toEqual({ requiresLogin: true, loginUrl: null });
  });

  it("does not classify a bare invalid API key as the Claude login flow", () => {
    expect(
      detectClaudeLoginRequired({
        parsed: null,
        stdout: "",
        stderr: "Invalid API key",
      }).requiresLogin,
    ).toBe(false);
  });

  it("classifies an invalid or expired OAuth bearer token as login required", () => {
    // Grounded on the real Claude CLI output for CLAUDE_CODE_OAUTH_TOKEN=invalid:
    // the result event carries a 401 authentication failure and an "Invalid
    // bearer token" message. This is an auth failure, not a probe that could not
    // run, so the detector must classify it as login required.
    const parsed = {
      is_error: true,
      subtype: "success",
      api_error_status: 401,
      error: "authentication_failed",
      result: "Failed to authenticate. API Error: 401 Invalid bearer token",
    };
    expect(
      detectClaudeLoginRequired({
        parsed,
        stdout:
          '{"type":"assistant","message":{"content":[{"type":"text","text":"Failed to authenticate. API Error: 401 Invalid bearer token"}]},"error":"authentication_failed"}',
        stderr: "",
      }).requiresLogin,
    ).toBe(true);
  });

  it("does not route an invalid token to the transient or quota classifiers", () => {
    // An auth failure must win over the transient and quota lanes, so a run
    // surfaces login required instead of a retry.
    const input = {
      parsed: {
        is_error: true,
        result: "Failed to authenticate. API Error: 401 Invalid bearer token",
      },
      stdout: "",
      stderr: "",
    };
    expect(isClaudeTransientUpstreamError(input)).toBe(false);
    expect(isClaudeProviderQuotaError(input)).toBe(false);
  });

  it("classifies an expired or revoked token in the parsed result as login required", () => {
    // The result event marks the run as a failure and reports an expired token.
    // This is a token failure, so the detector classifies it as login required.
    const parsed = {
      is_error: true,
      subtype: "success",
      result: "Failed to authenticate. Your OAuth access token is expired.",
    };
    expect(
      detectClaudeLoginRequired({ parsed, stdout: "", stderr: "" }).requiresLogin,
    ).toBe(true);
  });

  it("does not classify a successful probe whose assistant text repeats a token phrase", () => {
    // A healthy run can print an auth phrase in its answer text. The parsed
    // result is a success, so the token-failure markers must not fire on the raw
    // stdout assistant event.
    const parsed = {
      is_error: false,
      subtype: "success",
      result: "hello",
    };
    expect(
      detectClaudeLoginRequired({
        parsed,
        stdout:
          '{"type":"assistant","message":{"content":[{"type":"text","text":"The phrase authentication_failed means an invalid bearer token."}]}}',
        stderr: "",
      }).requiresLogin,
    ).toBe(false);
  });

  it("does not classify a success whose result text repeats a token phrase", () => {
    // The model's own answer repeats a token phrase, so the phrase lands in the
    // parsed result. The run is a success, so the failure gate keeps it healthy.
    const parsed = {
      is_error: false,
      subtype: "success",
      result: "Sure. An invalid bearer token means authentication_failed.",
    };
    expect(
      detectClaudeLoginRequired({ parsed, stdout: "", stderr: "" }).requiresLogin,
    ).toBe(false);
  });

  it("keeps a transient failure with an assistant token phrase on the transient lane", () => {
    // The run fails on a 503 transient error. The token phrase appears only in
    // the raw stdout assistant event, not the parsed result, so the run stays
    // transient and never classifies as login required.
    const input = {
      parsed: {
        is_error: true,
        subtype: "error_during_execution",
        result: "API Error: 503 service unavailable",
      },
      stdout:
        '{"type":"assistant","message":{"content":[{"type":"text","text":"authentication_failed: the bearer token is invalid"}]}}',
      stderr: "",
    };
    expect(detectClaudeLoginRequired(input).requiresLogin).toBe(false);
    expect(isClaudeTransientUpstreamError(input)).toBe(true);
  });

  // STUDIO-0064 (adapted from paperclipai/paperclip#13647, commit 306451274e, and extended): the login markers read
  // the run's own error surface, never text a tool or the model produced.
  describe("login markers and the transcript (STUDIO-0064)", () => {
    const event = (value: Record<string, unknown>) => JSON.stringify(value);
    const toolResult = (content: string) => event({
      type: "user",
      message: { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_1", content }] },
    });
    const assistantText = (text: string, extra: Record<string, unknown> = {}) => event({
      type: "assistant",
      message: { role: "assistant", content: [{ type: "text", text }] },
      ...extra,
    });

    it("classifies the weekly-limit run 21529e7e as a limit, not a login request", () => {
      // Production, 17 Nov 2026: the run ended on the weekly limit; a Unity test log in a tool result quoted
      // "System.UnauthorizedAccessException", and the run was sealed as claude_auth_required.
      const parsed = {
        type: "result",
        subtype: "success",
        is_error: true,
        api_error_status: 429,
        api_error: "usage_limit_reached",
        terminal_reason: "api_error",
        result: "You've hit your weekly limit · resets 6am",
      };
      const stdout = [
        event({ type: "system", subtype: "init", session_id: "s" }),
        toolResult("SaveIndexGuardTests\n  Expected: no exception\n  But was: <System.UnauthorizedAccessException>\n"),
        assistantText("The save index test fails with an unauthorized access error; login required to the vault?"),
        event(parsed),
      ].join("\n");
      const input = { parsed, stdout, stderr: "" };
      expect(detectClaudeLoginRequired(input).requiresLogin).toBe(false);
      expect(isClaudeProviderQuotaError(input)).toBe(true);
    });

    it("does not classify 'Unauthorized' quoted in a tool result as login required", () => {
      const parsed = {
        is_error: true,
        subtype: "success",
        api_error_status: 429,
        result: "You've hit your session limit · resets 4:20am (Europe/Zurich)",
      };
      const stdout = [toolResult("=== TCP-Router ===\n401 Unauthorized\n"), event({ type: "result", ...parsed })].join("\n");
      const input = { parsed, stdout, stderr: "" };
      expect(detectClaudeLoginRequired(input).requiresLogin).toBe(false);
      expect(isClaudeProviderQuotaError(input)).toBe(true);
    });

    it("lets a usage limit outrank a login word on stderr or in a plain stdout line", () => {
      for (const parsed of [
        { is_error: true, subtype: "success", api_error_status: 429, result: "API Error: 429" },
        { is_error: true, subtype: "success", api_error: "usage_limit_reached", result: "Limit reached" },
        { is_error: true, subtype: "success", api_error: { type: "rate_limit_error" }, result: "Limit reached" },
        { is_error: true, subtype: "success", result: "You've hit your weekly limit · resets 6am" },
      ]) {
        expect(detectClaudeLoginRequired({
          parsed,
          stdout: ["warning: unauthorized plugin skipped", event({ type: "result", ...parsed })].join("\n"),
          stderr: "hook failed: 401 Unauthorized",
        }).requiresLogin).toBe(false);
      }
    });

    it("does not read the text of an assistant or user message, with or without a result event", () => {
      const transcript = [
        assistantText("Not logged in · Please run /login"),
        toolResult("Invalid API key · Please run /login"),
        event({ type: "user", message: { role: "user", content: "please log in, authentication required" } }),
      ].join("\n");
      const failed = { is_error: true, subtype: "error_during_execution", result: "API Error: 500 internal error" };
      expect(detectClaudeLoginRequired({ parsed: failed, stdout: transcript, stderr: "" }).requiresLogin).toBe(false);
      expect(detectClaudeLoginRequired({ parsed: null, stdout: transcript, stderr: "" }).requiresLogin).toBe(false);
    });

    it("does not read the answer of a successful run or of a turn-budget stop", () => {
      expect(detectClaudeLoginRequired({
        parsed: { is_error: false, subtype: "success", result: "The API answered 401 Unauthorized: please log in." },
        stdout: "",
        stderr: "",
      }).requiresLogin).toBe(false);
      expect(detectClaudeLoginRequired({
        parsed: { is_error: true, subtype: "error_max_turns", result: "Next step: the user is not logged in, login required." },
        stdout: "",
        stderr: "",
      }).requiresLogin).toBe(false);
    });

    it("does not read the cut head of a capped capture as plain text", () => {
      // The capture keeps the last 4 MiB of stdout: its first line can be the tail of a tool result.
      const fragment = `But was: <System.UnauthorizedAccessException>"}]}}`;
      const parsed = { is_error: true, subtype: "error_during_execution", result: "API Error: 500 internal error" };
      const filler = `${event({ type: "assistant", message: { content: [{ type: "text", text: "x".repeat(1024) }] } })}\n`;
      const body = filler.repeat(Math.ceil((4 * 1024 * 1024) / filler.length));
      const stdout = `${fragment}\n${body}${event({ type: "result", ...parsed })}`;
      expect(stdout.length).toBeGreaterThanOrEqual(4 * 1024 * 1024);
      expect(detectClaudeLoginRequired({ parsed, stdout, stderr: "" }).requiresLogin).toBe(false);
      // The same words on a real first line of a short capture are the CLI's own plain text.
      expect(detectClaudeLoginRequired({ parsed: null, stdout: "401 Unauthorized\n", stderr: "" }).requiresLogin).toBe(true);
    });

    // The real forms of a login request. Each one must still be seen.
    it.each([
      ["a plain stdout line before the stream", { parsed: null, stdout: "Not logged in · Please run /login\n", stderr: "" }],
      ["a plain stdout line with `claude login`", { parsed: null, stdout: "Please log in with `claude login` to continue.", stderr: "" }],
      ["stderr", { parsed: null, stdout: "", stderr: "Invalid API key · Please run /login" }],
      ["a plain line among stream events", {
        parsed: null,
        stdout: [event({ type: "system", subtype: "init" }), "Not logged in · Please run /login"].join("\n"),
        stderr: "",
      }],
      ["the result field of a failed result", {
        parsed: { is_error: true, subtype: "success", result: "Not logged in · Please run /login" },
        stdout: "",
        stderr: "",
      }],
      ["an invalid API key in the result field", {
        parsed: { is_error: true, subtype: "success", result: "Invalid API key · Please run /login" },
        stdout: "",
        stderr: "",
      }],
      ["the errors list of a failed result", {
        parsed: { is_error: true, subtype: "error_during_execution", errors: [{ message: "Not logged in · Please run /login" }] },
        stdout: "",
        stderr: "",
      }],
      ["a 401 status with a refused bearer token", {
        parsed: {
          is_error: true,
          subtype: "success",
          api_error_status: 401,
          error: "authentication_failed",
          result: "Failed to authenticate. API Error: 401 Invalid bearer token",
        },
        stdout: "",
        stderr: "",
      }],
      ["a 401 status alone", {
        parsed: { is_error: true, subtype: "success", api_error_status: 401, result: "API Error: 401" },
        stdout: "",
        stderr: "",
      }],
      ["an expired OAuth token in the terminal fields", {
        parsed: {
          is_error: true,
          subtype: "success",
          result: "OAuth token has expired. Please obtain a new token or refresh your existing token.",
        },
        stdout: "",
        stderr: "",
      }],
      ["a cut stream whose assistant event carries the CLI's error field", {
        parsed: null,
        stdout: [
          event({ type: "system", subtype: "init" }),
          assistantText("Failed to authenticate. API Error: 401 Invalid bearer token", { error: "authentication_failed" }),
        ].join("\n"),
        stderr: "",
      }],
      ["a cut stream whose retry event carries the CLI's error field", {
        parsed: null,
        stdout: event({ type: "system", subtype: "api_retry", attempt: 1, error_status: 401, error: "authentication_failed: bearer is invalid" }),
        stderr: "",
      }],
    ])("still sees a login request in %s", (_form, input) => {
      expect(detectClaudeLoginRequired(input).requiresLogin).toBe(true);
      expect(isClaudeProviderQuotaError(input)).toBe(false);
    });

    it("still finds a login URL quoted in the transcript although requiresLogin ignores it", () => {
      const parsed = { is_error: false, subtype: "success", result: "done" };
      const result = detectClaudeLoginRequired({
        parsed,
        stdout: assistantText("Visit https://claude.ai/login to re-authenticate."),
        stderr: "",
      });
      expect(result.requiresLogin).toBe(false);
      expect(result.loginUrl).toBe("https://claude.ai/login");
    });
  });

  it("does not treat a bare token phrase in raw stdout with no parsed result as login required", () => {
    // Untrusted stdout alone must not satisfy a token-failure marker. Only the
    // parsed terminal result fields of a failed run can trip the token markers.
    expect(
      detectClaudeLoginRequired({
        parsed: null,
        stdout: "authentication_failed while the assistant called a tool",
        stderr: "",
      }).requiresLogin,
    ).toBe(false);
  });
});

describe("isClaudeModelNotFoundError", () => {
  it("detects model resolution failures from structured and fallback output", () => {
    expect(isClaudeModelNotFoundError({
      parsed: {
        result: "API Error: 404 model not found: claude-haiku-4-6",
      },
    })).toBe(true);
    expect(isClaudeModelNotFoundError({
      stderr: "Unknown model claude-haiku-4-6",
    })).toBe(true);
  });

  it("does not classify unrelated provider failures as model resolution errors", () => {
    expect(isClaudeModelNotFoundError({
      errorMessage: "API Error: 503 service unavailable",
    })).toBe(false);
  });
});

describe("isClaudeTransientUpstreamError", () => {
  it("classifies the 'out of extra usage' subscription window failure as provider quota", () => {
    expect(
      isClaudeProviderQuotaError({
        errorMessage: "You're out of extra usage · resets 4pm (America/Chicago)",
      }),
    ).toBe(true);
    expect(
      isClaudeProviderQuotaError({
        parsed: {
          is_error: true,
          result: "You're out of extra usage. Resets at 4pm (America/Chicago).",
        },
      }),
    ).toBe(true);
    expect(
      isClaudeTransientUpstreamError({
        errorMessage: "You're out of extra usage · resets 4pm (America/Chicago)",
      }),
    ).toBe(false);
  });

  it("classifies Claude session-limit windows as provider quota and extracts the retry time", () => {
    const now = new Date("2026-04-22T15:15:00.000Z");
    const errorMessage = "You've hit your session limit - resets at 4pm (America/Chicago).";

    expect(isClaudeProviderQuotaError({ errorMessage })).toBe(true);
    expect(isClaudeTransientUpstreamError({ errorMessage })).toBe(false);
    expect(extractClaudeRetryNotBefore({ errorMessage }, now)?.toISOString()).toBe(
      "2026-04-22T21:00:00.000Z",
    );
  });

  it("classifies the qualifier-less limit wording as provider quota and extracts the retry time", () => {
    // Current Claude CLI phrasing: no "session"/"usage" qualifier before "limit".
    const now = new Date("2026-08-28T22:30:00.000Z");
    const errorMessage = "You've hit your limit · resets 2:30am (UTC)";

    expect(isClaudeProviderQuotaError({ errorMessage })).toBe(true);
    expect(isClaudeTransientUpstreamError({ errorMessage })).toBe(false);
    expect(extractClaudeRetryNotBefore({ errorMessage }, now)?.toISOString()).toBe(
      "2026-08-29T02:30:00.000Z",
    );
  });

  it("classifies Anthropic API rate_limit_error and overloaded_error as transient", () => {
    expect(
      isClaudeTransientUpstreamError({
        parsed: {
          is_error: true,
          errors: [{ type: "rate_limit_error", message: "Rate limit reached for requests." }],
        },
      }),
    ).toBe(true);
    expect(
      isClaudeTransientUpstreamError({
        parsed: {
          is_error: true,
          errors: [{ type: "overloaded_error", message: "Overloaded" }],
        },
      }),
    ).toBe(true);
    expect(
      isClaudeTransientUpstreamError({
        stderr: "HTTP 429: Too Many Requests",
      }),
    ).toBe(true);
    expect(
      isClaudeTransientUpstreamError({
        stderr: "Bedrock ThrottlingException: slow down",
      }),
    ).toBe(true);
  });

  it("classifies the subscription 5-hour / weekly limit wording as provider quota", () => {
    expect(
      isClaudeProviderQuotaError({
        errorMessage: "Claude usage limit reached — weekly limit reached. Try again in 2 days.",
      }),
    ).toBe(true);
    expect(
      isClaudeProviderQuotaError({
        errorMessage: "5-hour limit reached.",
      }),
    ).toBe(true);
  });

  it("does not classify login/auth failures as transient", () => {
    expect(
      isClaudeTransientUpstreamError({
        stderr: "Please log in. Run `claude login` first.",
      }),
    ).toBe(false);
  });

  it("does not classify max-turns or unknown-session as transient", () => {
    expect(
      isClaudeTransientUpstreamError({
        parsed: { subtype: "error_max_turns", result: "Maximum turns reached." },
      }),
    ).toBe(false);
    expect(
      isClaudeTransientUpstreamError({
        parsed: {
          result: "No conversation found with session id abc-123",
          errors: [{ message: "No conversation found with session id abc-123" }],
        },
      }),
    ).toBe(false);
  });

  it("does not classify deterministic validation errors as transient", () => {
    expect(
      isClaudeTransientUpstreamError({
        errorMessage: "Invalid request_error: Unknown parameter 'foo'.",
      }),
    ).toBe(false);
  });

  it("does not classify poisoned previous_message_id errors as transient", () => {
    expect(
      isClaudeTransientUpstreamError({
        parsed: {
          subtype: "success",
          is_error: true,
          result: "API Error: 400 diagnostics.previous_message_id: must be the `id` from a prior /v1/messages response (starts with `msg_`)",
        },
      }),
    ).toBe(false);
  });
});

describe("isClaudePoisonedPreviousMessageIdError", () => {
  it("detects the previous_message_id 400 error in the result field", () => {
    expect(
      isClaudePoisonedPreviousMessageIdError({
        subtype: "success",
        is_error: true,
        result: "API Error: 400 diagnostics.previous_message_id: must be the `id` from a prior /v1/messages response (starts with `msg_`)",
      }),
    ).toBe(true);
  });

  it("detects the error in the errors array", () => {
    expect(
      isClaudePoisonedPreviousMessageIdError({
        is_error: true,
        result: "",
        errors: [{ message: "400 diagnostics.previous_message_id: must be the `id` from a prior /v1/messages response (starts with `msg_`)" }],
      }),
    ).toBe(true);
  });

  it("returns false for unrelated errors", () => {
    expect(
      isClaudePoisonedPreviousMessageIdError({
        is_error: true,
        result: "No conversation found with session id abc-123",
      }),
    ).toBe(false);
  });

  it("returns false for empty parsed result", () => {
    expect(isClaudePoisonedPreviousMessageIdError({})).toBe(false);
  });
});

describe("isClaudeRefusalResult", () => {
  it("detects stop_reason: refusal even on a clean (is_error=false) result", () => {
    expect(
      isClaudeRefusalResult({
        type: "result",
        subtype: "success",
        is_error: false,
        stop_reason: "refusal",
        result: "",
      }),
    ).toBe(true);
  });

  it("detects the camelCase stopReason variant", () => {
    expect(isClaudeRefusalResult({ stopReason: "refusal" })).toBe(true);
  });

  it("detects subtype: model_refusal", () => {
    expect(
      isClaudeRefusalResult({ subtype: "model_refusal", is_error: false }),
    ).toBe(true);
  });

  it("is case-insensitive and tolerant of surrounding whitespace", () => {
    expect(isClaudeRefusalResult({ stop_reason: "  Refusal " })).toBe(true);
  });

  it("returns false for ordinary successful turns", () => {
    expect(
      isClaudeRefusalResult({
        subtype: "success",
        is_error: false,
        stop_reason: "end_turn",
        result: "Here is your answer.",
      }),
    ).toBe(false);
  });

  it("returns false for max-turns and other stop reasons", () => {
    expect(isClaudeRefusalResult({ stop_reason: "max_turns" })).toBe(false);
    expect(isClaudeRefusalResult({ subtype: "error_max_turns" })).toBe(false);
  });

  it("returns false for null/empty parsed result", () => {
    expect(isClaudeRefusalResult(null)).toBe(false);
    expect(isClaudeRefusalResult({})).toBe(false);
  });
});

describe("isClaudeUnknownSessionError", () => {
  it("detects the legacy 'no conversation found' message", () => {
    expect(
      isClaudeUnknownSessionError({
        result: "Error: No conversation found with session id 1234",
      }),
    ).toBe(true);
  });

  it("detects 'session ... not found' style errors", () => {
    expect(
      isClaudeUnknownSessionError({
        errors: [{ message: "Session abc123 not found" }],
      }),
    ).toBe(true);
  });

  it("detects '--resume requires a valid session' validation error from non-UUID input", () => {
    expect(
      isClaudeUnknownSessionError({
        errors: [
          {
            message:
              'Error: --resume requires a valid session ID or session title when used with --print. Usage: claude -p --resume <session-id|title>. Provided value "ses_268c2d0a5ffemYbEaeG7c86Uvo" is not a UUID and does not match any session title.',
          },
        ],
      }),
    ).toBe(true);
  });

  it("returns false for unrelated error text", () => {
    expect(
      isClaudeUnknownSessionError({
        result: "Some other failure",
        errors: [{ message: "Network timeout" }],
      }),
    ).toBe(false);
  });
});

describe("isClaudeImageProcessingError", () => {
  it("detects the 'Could not process image' 400 error in the result field", () => {
    expect(
      isClaudeImageProcessingError({
        subtype: "success",
        is_error: true,
        result: "API Error: 400 Could not process image: image source URL has expired",
      }),
    ).toBe(true);
  });

  it("detects the error in the errors array", () => {
    expect(
      isClaudeImageProcessingError({
        is_error: true,
        result: "",
        errors: [{ message: "400 Could not process image" }],
      }),
    ).toBe(true);
  });

  it("is case-insensitive", () => {
    expect(
      isClaudeImageProcessingError({
        is_error: true,
        result: "could not process image attached to message",
      }),
    ).toBe(true);
  });

  it("returns false for unrelated errors", () => {
    expect(
      isClaudeImageProcessingError({
        is_error: true,
        result: "No conversation found with session id abc-123",
      }),
    ).toBe(false);
  });

  it("returns false for empty parsed result", () => {
    expect(isClaudeImageProcessingError({})).toBe(false);
  });
});

describe("extractClaudeRetryNotBefore", () => {
  it("parses the 'resets 4pm' hint in its explicit timezone", () => {
    const now = new Date("2026-04-22T15:15:00.000Z");
    const extracted = extractClaudeRetryNotBefore(
      { errorMessage: "You're out of extra usage · resets 4pm (America/Chicago)" },
      now,
    );
    expect(extracted?.toISOString()).toBe("2026-04-22T21:00:00.000Z");
  });

  it("rolls forward past midnight when the reset time has already passed today", () => {
    const now = new Date("2026-04-22T23:30:00.000Z");
    const extracted = extractClaudeRetryNotBefore(
      { errorMessage: "Usage limit reached. Resets at 3:15 AM (UTC)." },
      now,
    );
    expect(extracted?.toISOString()).toBe("2026-04-23T03:15:00.000Z");
  });

  it("returns null when no reset hint is present", () => {
    expect(
      extractClaudeRetryNotBefore({ errorMessage: "Overloaded. Try again later." }, new Date()),
    ).toBeNull();
  });
});

describe("claudeModelUsageTotals", () => {
  it("sums per-model usage across models and counts cache writes as input", () => {
    const totals = claudeModelUsageTotals({
      "claude-fable-5": {
        inputTokens: 100,
        outputTokens: 70_000,
        cacheReadInputTokens: 250_000,
        cacheCreationInputTokens: 4_000,
        costUSD: 1.2,
      },
      "claude-haiku-4-5": {
        inputTokens: 50,
        outputTokens: 7_000,
        cacheReadInputTokens: 10_000,
        cacheCreationInputTokens: 500,
        costUSD: 0.05,
      },
    });
    expect(totals).toEqual({
      inputTokens: 4_650,
      outputTokens: 77_000,
      cachedInputTokens: 260_000,
    });
  });

  it("returns null for missing or empty modelUsage", () => {
    expect(claudeModelUsageTotals(undefined)).toBeNull();
    expect(claudeModelUsageTotals({})).toBeNull();
  });
});

describe("parseClaudeStreamJson usage extraction", () => {
  const resultEvent = (extra: Record<string, unknown>) =>
    JSON.stringify({
      type: "result",
      subtype: "success",
      session_id: "sess-1",
      result: "done",
      total_cost_usd: 1.25,
      usage: { input_tokens: 10, output_tokens: 1_800, cache_read_input_tokens: 20 },
      ...extra,
    });

  it("prefers modelUsage totals over the main-loop usage block and marks them per-run", () => {
    const parsed = parseClaudeStreamJson(
      `${resultEvent({
        modelUsage: {
          "claude-fable-5": {
            inputTokens: 90,
            outputTokens: 77_000,
            cacheReadInputTokens: 300_000,
            cacheCreationInputTokens: 2_000,
          },
        },
      })}\n`,
    );
    expect(parsed.usage).toEqual({
      inputTokens: 2_090,
      outputTokens: 77_000,
      cachedInputTokens: 300_000,
    });
    expect(parsed.usageBasis).toBe("per_run");
    expect(parsed.costUsd).toBeCloseTo(1.25);
  });

  it("falls back to the result usage block when modelUsage is absent", () => {
    const parsed = parseClaudeStreamJson(`${resultEvent({})}\n`);
    expect(parsed.usage).toEqual({
      inputTokens: 10,
      outputTokens: 1_800,
      cachedInputTokens: 20,
    });
    expect(parsed.usageBasis).toBe("per_run");
  });
});

describe("interrupted Claude accounting", () => {
  it("retains partial usage and replaces repeated message snapshots", () => {
    const events = [
      { type: "assistant", message: { id: "m1", usage: { input_tokens: 10, cache_creation_input_tokens: 20, cache_read_input_tokens: 40, output_tokens: 3 } } },
      { type: "assistant", message: { id: "m1", usage: { input_tokens: 10, cache_creation_input_tokens: 20, cache_read_input_tokens: 40, output_tokens: 7 } } },
      { type: "assistant", message: { id: "m2", usage: { input_tokens: 5, output_tokens: 2 } } },
    ];
    const parsed = parseClaudeStreamJson(events.map((event) => JSON.stringify(event)).join("\n"));
    expect(parsed.usage).toEqual({ inputTokens: 35, cachedInputTokens: 40, outputTokens: 9 });
    expect(parsed.usageBasis).toBe("per_run");
    expect(parsed.costUsd).toBeNull();
  });
});

// The CLI's result ledger (`modelUsage`, `total_cost_usd`) is cumulative over the
// launch and, with --resume, over the whole resumed session; `usage` covers one
// message. Measured on Claude Code 2.1.322 (0.0844 then 0.0942 USD, inputTokens
// 20 then 30 across two launches of one session).
describe("Claude per-invocation accounting (STUDIO-0013)", () => {
  const SESSION = "11111111-2222-4333-8444-555555555555";
  const result = (cost: number, input: number, output: number, extra: Record<string, unknown> = {}) =>
    JSON.stringify({
      type: "result",
      subtype: "success",
      session_id: SESSION,
      result: `reply ${cost}`,
      total_cost_usd: cost,
      usage: { input_tokens: 1, output_tokens: 2 },
      modelUsage: { "claude-sonnet": { inputTokens: input, outputTokens: output, cacheReadInputTokens: 0, cacheCreationInputTokens: 0, costUSD: cost } },
      ...extra,
    });

  it("keeps a fresh launch's figures and persists its cumulative ledger", () => {
    const parsed = parseClaudeStreamJson(`${result(0.0844, 20, 5)}\n`);
    expect(parsed.costUsd).toBeCloseTo(0.0844);
    expect(parsed.usage).toEqual({ inputTokens: 20, outputTokens: 5, cachedInputTokens: 0 });
    expect(parsed.sessionTotals).toEqual({
      sessionId: SESSION,
      modelUsage: { "claude-sonnet": { inputTokens: 20, outputTokens: 5, cacheReadInputTokens: 0, cacheCreationInputTokens: 0, costUSD: 0.0844 } },
      totalCostUsd: 0.0844,
    });
  });

  it("reports only a resumed launch's share of the session ledger", () => {
    const baseline = claudeSessionTotals(SESSION, JSON.parse(result(0.0844, 20, 5)));
    const parsed = parseClaudeStreamJson(`${result(0.0942, 30, 8)}\n`, { sessionBaseline: baseline });
    expect(parsed.usageBasis).toBe("per_run");
    expect(parsed.costUsd).toBeCloseTo(0.0098);
    expect(parsed.usage).toEqual({ inputTokens: 10, outputTokens: 3, cachedInputTokens: 0 });
    expect(parsed.invocationModelUsage).toMatchObject({ "claude-sonnet": { inputTokens: 10, outputTokens: 3 } });
    expect((parsed.invocationModelUsage["claude-sonnet"] as { costUSD: number }).costUSD).toBeCloseTo(0.0098);
    expect(parsed.sessionTotals?.totalCostUsd).toBeCloseTo(0.0942);
    expect(parsed.summary).toBe("reply 0.0942");
  });

  it("takes the last of several results in one launch as final, never adding the cumulative ledgers", () => {
    const parsed = parseClaudeStreamJson([result(0.01, 4, 1), result(0.03, 9, 4)].join("\n"));
    expect(parsed.costUsd).toBeCloseTo(0.03);
    expect(parsed.usage).toEqual({ inputTokens: 9, outputTokens: 4, cachedInputTokens: 0 });
    expect(parsed.summary).toBe("reply 0.03");
  });

  it("sums the per-message usage of every result when no ledger is reported", () => {
    const bare = (input: number, output: number) =>
      JSON.stringify({ type: "result", session_id: SESSION, result: "ok", usage: { input_tokens: input, output_tokens: output, cache_read_input_tokens: 1 } });
    const parsed = parseClaudeStreamJson([bare(3, 2), bare(4, 5)].join("\n"));
    expect(parsed.usage).toEqual({ inputTokens: 7, outputTokens: 7, cachedInputTokens: 2 });
    expect(parsed.costUsd).toBeNull();
  });

  it("ignores a baseline from another session or one above the ledger", () => {
    const other = claudeSessionTotals("99999999-2222-4333-8444-555555555555", JSON.parse(result(0.05, 15, 3)));
    expect(parseClaudeStreamJson(`${result(0.0942, 30, 8)}\n`, { sessionBaseline: other }).costUsd).toBeCloseTo(0.0942);
    const reset = claudeSessionTotals(SESSION, JSON.parse(result(0.5, 50, 9)));
    const parsed = parseClaudeStreamJson(`${result(0.0942, 30, 8)}\n`, { sessionBaseline: reset });
    expect(parsed.costUsd).toBeCloseTo(0.0942);
    expect(parsed.usage).toEqual({ inputTokens: 30, outputTokens: 8, cachedInputTokens: 0 });
  });

  it("reads persisted totals only for the session being resumed", () => {
    const stored = claudeSessionTotals(SESSION, JSON.parse(result(0.0844, 20, 5)));
    expect(readClaudeSessionTotals(stored, SESSION)).toEqual(stored);
    expect(readClaudeSessionTotals(stored, null)).toBeNull();
    expect(readClaudeSessionTotals(stored, "99999999-2222-4333-8444-555555555555")).toBeNull();
    expect(readClaudeSessionTotals("garbage", SESSION)).toBeNull();
  });
});
