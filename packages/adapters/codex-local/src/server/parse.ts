import {
  asString,
  parseObject,
  parseJson,
  MAX_CAPTURE_BYTES,
} from "@paperclipai/adapter-utils/server-utils";

const CODEX_TRANSIENT_UPSTREAM_RE =
  /(?:we(?:'|’)re\s+currently\s+experiencing\s+high\s+demand|temporary\s+errors|rate[-\s]?limit(?:ed)?|too\s+many\s+requests|\b429\b|server\s+overloaded|service\s+unavailable|try\s+again\s+later)/i;
const CODEX_REMOTE_COMPACTION_RE = /remote\s+compact\s+task/i;
const CODEX_USAGE_LIMIT_RE =
  /you(?:'|’)ve hit your usage limit for .+\.\s+switch to another model now,\s+or try again at\s+([^.!\n]+)(?:[.!]|\n|$)/i;
const CODEX_PROVIDER_QUOTA_RE =
  /(?:you(?:'|’)ve hit your usage limit|usage limit|model (?:is )?at capacity|at capacity for this model|capacity limit)/i;
// STUDIO-0065: the sentences Codex itself writes on a login loss, read in the installed binaries (codex-cli 0.156.1 on
// the server, 0.166.0 on the worker machines, Linux x64). The binary holds no `refresh_token_reused`,
// `refresh_token_expired` or `refresh_token_invalidated` code as text: the code forms below are those of the
// baseline, kept, and they are no proof of a real form.
//   "Your access token could not be refreshed because your refresh token was already used. Please log out and sign in again."
//   "Your access token could not be refreshed because your refresh token has expired. Please log out and sign in again."
//   "Your access token could not be refreshed because your refresh token was revoked. Please log out and sign in again."
//   "Your access token could not be refreshed because you have since logged out or signed in to another account. Please sign in again."
//   "Your access token could not be refreshed. Please log out and sign in again."
//   "Your authentication session could not be refreshed automatically. Please log out and sign in again."
// The specific sentences are tried first: every one of the first five starts with the same words.
const CODEX_REFRESH_TOKEN_REUSED_RE =
  /(?:refresh[_\s-]?token[_\s-]?reused|refresh token (?:has |was )?already (?:been )?used|token reuse detected)/i;
const CODEX_REFRESH_TOKEN_EXPIRED_RE =
  /(?:refresh[_\s-]?token[_\s-]?expired|refresh token (?:has )?expired|expired refresh token)/i;
const CODEX_REFRESH_TOKEN_INVALIDATED_RE =
  /(?:refresh[_\s-]?token[_\s-]?(?:invalidated|revoked|invalid)|refresh token (?:has been |was )?(?:invalidated|revoked|invalid)|invalid refresh token|missing bearer|access token could not be refreshed|authentication session could not be refreshed|signed in to another account)/i;
const CODEX_OAUTH_INVALID_GRANT_RE = /\binvalid_grant\b/i;
// A line that names MCP is about a tool server's own OAuth (in the binary, `invalid_grant` only appears in such
// texts: "The MCP authorization server rejected the enterprise grant: invalid_grant"). The generic patterns
// (`invalid_grant`, an auth word near 401 or unauthorized) are not tried on it; Codex's own sentences still are.
const CODEX_MCP_LINE_RE = /\bmcp\b/i;
// The events of the `codex exec --json` protocol. Another JSON object on stdout (a wrapper's) is a plain line.
const CODEX_PROTOCOL_EVENT_TYPE_RE = /^(?:error|thread\.[a-z_.]+|turn\.[a-z_.]+|item\.[a-z_.]+)$/;
const CODEX_CONTEXTUAL_REFRESH_AUTH_INVALIDATED_RE =
  /(?:(?:oauth|refresh|access[_\s-]?token|bearer|credential).{0,80}(?:\b401\b|unauthori[sz]ed|\binvalid[\s-]grant\b)|(?:\b401\b|unauthori[sz]ed|\binvalid[\s-]grant\b).{0,80}(?:oauth|refresh|access[_\s-]?token|bearer|credential))/i;

export type CodexAuthRefreshFailureClass =
  | "refresh_token_reused"
  | "refresh_token_expired"
  | "refresh_token_invalidated";

export function parseCodexJsonl(stdout: string) {
  return createCodexJsonlParser()(stdout);
}

/** Consume complete JSONL records once, retaining protocol accounting state. */
export function createCodexJsonlParser() {
  let sessionId: string | null = null;
  let finalMessage: string | null = null;
  let errorMessage: string | null = null;
  let sawProtocolEvent = false;
  let sawProtocolTerminalEvent = false;
  let usageReported = false;
  let usageComplete = false;
  const usage = {
    inputTokens: 0,
    cachedInputTokens: 0,
    outputTokens: 0,
  };

  return (stdout: string) => {
    for (const rawLine of stdout.split(/\r?\n/)) {
      const line = rawLine.trim();
      if (!line) continue;

      const event = parseJson(line);
      if (!event) continue;

      const type = asString(event.type, "");
      if (type) sawProtocolEvent = true;
      if (type === "error" || type === "turn.completed" || type === "turn.failed") {
        sawProtocolTerminalEvent = true;
        const reported = parseObject(event.usage);
        const validCount = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
        const cached = reported.cached_input_tokens ?? 0;
        usageComplete = validCount(reported.input_tokens) && validCount(reported.output_tokens)
          && validCount(cached) && cached <= reported.input_tokens;
        if (usageComplete) {
          usage.inputTokens = reported.input_tokens as number;
          usage.cachedInputTokens = cached as number;
          usage.outputTokens = reported.output_tokens as number;
          usageReported = true;
        }
      }
      if (type === "turn.started") usageComplete = false;
      if (type === "thread.started") {
        sessionId = asString(event.thread_id, sessionId ?? "") || sessionId;
        continue;
      }

      if (type === "error") {
        const msg = asString(event.message, "").trim();
        if (msg) errorMessage = msg;
        continue;
      }

      if (type === "item.completed") {
        const item = parseObject(event.item);
        if (asString(item.type, "") === "agent_message") {
          const text = asString(item.text, "");
          if (text) finalMessage = text;
        }
        continue;
      }

      if (type === "turn.failed") {
        const err = parseObject(event.error);
        const msg = asString(err.message, "").trim();
        if (msg) errorMessage = msg;
      }
    }

    return {
      sessionId,
      summary: finalMessage?.trim() ?? "",
      // Codex includes cache hits in input_tokens; Paperclip stores them separately.
      usage: { ...usage, inputTokens: Math.max(0, usage.inputTokens - usage.cachedInputTokens) },
      usageBasis: "per_run" as const,
      errorMessage,
      sawProtocolEvent,
      sawProtocolTerminalEvent,
      usageReported,
      usageComplete,
    };
  };
}

/**
 * Structural crash detection: the codex CLI can only report an agent-level
 * failure through the JSONL protocol (an `error` event, `turn.failed`, or a
 * finished `turn.completed` followed by a nonzero exit). A nonzero exit after
 * the protocol stream started but before any terminal event means the process
 * died out from under the agent (MCP transport crash, worker panic, killed
 * tool server) — retriable infrastructure, not agent behavior. This
 * deliberately does not match error text: transport failure strings vary, and
 * stdout/stderr can quote agent output that merely discusses network errors.
 */
export function isCodexHarnessCrash(input: {
  exitCode: number | null;
  sawProtocolEvent: boolean;
  sawProtocolTerminalEvent: boolean;
}): boolean {
  if ((input.exitCode ?? 0) === 0) return false;
  return input.sawProtocolEvent && !input.sawProtocolTerminalEvent;
}

export function isCodexUnknownSessionError(stdout: string, stderr: string): boolean {
  const haystack = `${stdout}\n${stderr}`
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .join("\n");
  return /unknown (session|thread)|session .* not found|thread .* not found|conversation .* not found|missing rollout path for thread|state db missing rollout path|state db returned stale rollout path|no rollout found for thread id/i.test(
    haystack,
  );
}

// STUDIO-0065 (adapted from paperclipai/paperclip#15832, head 10be54bcba, and extended): reduce a Codex run's
// output to its own error surface.
//
// `codex exec --json` puts the whole transcript on stdout: the output of every command the agent ran
// (`command_execution`), the model's text (`agent_message`), and the CLI's own protocol events. A transcript line that
// merely quotes "401 Unauthorized ... bearer token" (an HTTP log, a source file under review) must not decide that the
// account lost its login: one failed run would put every role that shares the account in error.
//
// - Once the protocol started (an event of the Codex protocol was seen: thread.*, turn.*, item.*, error), the CLI
//   reports a failure through the protocol: only the LAST protocol error of the CURRENT turn counts (an `error`
//   event, or `turn.failed`; a recovered earlier error does not, and `turn.started` or `turn.completed` forgets the
//   errors before it). stderr, the plain stdout lines and the fallback error message built from stderr are NOT read
//   then: stderr also carries the words of MCP servers, hooks and the ssh client of a routed run ("401
//   Unauthorized", an OAuth prompt), which are not about the AI account. Codex reports a login loss through the
//   protocol too (the sentences above, in the `error` event and in `turn.failed`).
// - When the protocol never started, the CLI failed before the stream: the error message the caller passes, the
//   plain stdout lines and stderr are its own words. A JSON object that is not a Codex event does not start the
//   protocol: a wrapper that writes JSON must not switch off the reading of stderr.
// Never read: the content of an item, whatever its type.
//
// The capture keeps the tail of stdout (runChildProcess, appendWithCap: the last MAX_CAPTURE_BYTES characters), so
// its first line can be the cut tail of an event: that fragment is not plain text. The comparison is made in bytes,
// which also covers a capture cut by bytes (appendWithByteCap drops up to three more bytes).
function codexStdoutErrorSurface(stdout: string): {
  protocolStarted: boolean;
  lastProtocolError: string;
  plainLines: string[];
} {
  const plainLines: string[] = [];
  let lastProtocolError = "";
  let protocolStarted = false;
  const lines = stdout.split(/\r?\n/);
  const firstLineMayBeCut = stdout.length >= MAX_CAPTURE_BYTES
    || (stdout.length * 3 >= MAX_CAPTURE_BYTES - 3 && Buffer.byteLength(stdout, "utf8") >= MAX_CAPTURE_BYTES - 3);

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]!.trim();
    if (!line) continue;

    const parsedLine = parseJson(line) as unknown;
    const parsedObject = parsedLine !== null && typeof parsedLine === "object" && !Array.isArray(parsedLine)
      ? (parsedLine as Record<string, unknown>)
      : null;
    const type = parsedObject ? asString(parsedObject.type, "") : "";
    const event = parsedObject && CODEX_PROTOCOL_EVENT_TYPE_RE.test(type) ? parsedObject : null;
    if (!event) {
      if (index === 0 && firstLineMayBeCut) continue;
      plainLines.push(line);
      continue;
    }

    protocolStarted = true;
    if (type === "turn.started" || type === "turn.completed") {
      lastProtocolError = "";
      continue;
    }
    const message = type === "error"
      ? asString(event.message, "").trim()
      : type === "turn.failed"
      ? asString(parseObject(event.error).message, "").trim()
      : "";
    if (message) lastProtocolError = message;
  }

  return { protocolStarted, lastProtocolError, plainLines };
}

function buildCodexErrorHaystack(input: {
  stdout?: string | null;
  stderr?: string | null;
  errorMessage?: string | null;
}): string {
  const surface = codexStdoutErrorSurface(input.stdout ?? "");
  const parts = surface.protocolStarted
    ? [surface.lastProtocolError]
    : [input.errorMessage ?? "", ...surface.plainLines, input.stderr ?? ""];
  return parts
    .join("\n")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .join("\n");
}

export function classifyCodexAuthRefreshFailure(input: {
  stdout?: string | null;
  stderr?: string | null;
  errorMessage?: string | null;
}): CodexAuthRefreshFailureClass | null {
  const haystack = buildCodexErrorHaystack(input);

  if (CODEX_REFRESH_TOKEN_REUSED_RE.test(haystack)) return "refresh_token_reused";
  if (CODEX_REFRESH_TOKEN_EXPIRED_RE.test(haystack)) return "refresh_token_expired";
  if (CODEX_REFRESH_TOKEN_INVALIDATED_RE.test(haystack)) return "refresh_token_invalidated";
  const withoutMcpLines = haystack.split("\n").filter((line) => !CODEX_MCP_LINE_RE.test(line)).join("\n");
  if (CODEX_OAUTH_INVALID_GRANT_RE.test(withoutMcpLines)) return "refresh_token_invalidated";
  if (CODEX_CONTEXTUAL_REFRESH_AUTH_INVALIDATED_RE.test(withoutMcpLines)) return "refresh_token_invalidated";
  return null;
}

function readTimeZoneParts(date: Date, timeZone: string) {
  const values = new Map(
    new Intl.DateTimeFormat("en-US", {
      timeZone,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
    }).formatToParts(date).map((part) => [part.type, part.value]),
  );
  return {
    year: Number.parseInt(values.get("year") ?? "", 10),
    month: Number.parseInt(values.get("month") ?? "", 10),
    day: Number.parseInt(values.get("day") ?? "", 10),
    hour: Number.parseInt(values.get("hour") ?? "", 10),
    minute: Number.parseInt(values.get("minute") ?? "", 10),
  };
}

function normalizeResetTimeZone(timeZoneHint: string | null | undefined): string | null {
  const normalized = timeZoneHint?.trim();
  if (!normalized) return null;
  if (/^(?:utc|gmt)$/i.test(normalized)) return "UTC";

  try {
    new Intl.DateTimeFormat("en-US", { timeZone: normalized }).format(new Date(0));
    return normalized;
  } catch {
    return null;
  }
}

function dateFromTimeZoneWallClock(input: {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  timeZone: string;
}): Date | null {
  let candidate = new Date(Date.UTC(input.year, input.month - 1, input.day, input.hour, input.minute, 0, 0));
  const targetUtc = Date.UTC(input.year, input.month - 1, input.day, input.hour, input.minute, 0, 0);

  for (let attempt = 0; attempt < 4; attempt += 1) {
    const actual = readTimeZoneParts(candidate, input.timeZone);
    const actualUtc = Date.UTC(actual.year, actual.month - 1, actual.day, actual.hour, actual.minute, 0, 0);
    const offsetMs = targetUtc - actualUtc;
    if (offsetMs === 0) break;
    candidate = new Date(candidate.getTime() + offsetMs);
  }

  const verified = readTimeZoneParts(candidate, input.timeZone);
  if (
    verified.year !== input.year ||
    verified.month !== input.month ||
    verified.day !== input.day ||
    verified.hour !== input.hour ||
    verified.minute !== input.minute
  ) {
    return null;
  }

  return candidate;
}

function nextClockTimeInTimeZone(input: {
  now: Date;
  hour: number;
  minute: number;
  timeZoneHint: string;
}): Date | null {
  const timeZone = normalizeResetTimeZone(input.timeZoneHint);
  if (!timeZone) return null;

  const nowParts = readTimeZoneParts(input.now, timeZone);
  let retryAt = dateFromTimeZoneWallClock({
    year: nowParts.year,
    month: nowParts.month,
    day: nowParts.day,
    hour: input.hour,
    minute: input.minute,
    timeZone,
  });
  if (!retryAt) return null;

  if (retryAt.getTime() <= input.now.getTime()) {
    const nextDay = new Date(Date.UTC(nowParts.year, nowParts.month - 1, nowParts.day + 1, 0, 0, 0, 0));
    retryAt = dateFromTimeZoneWallClock({
      year: nextDay.getUTCFullYear(),
      month: nextDay.getUTCMonth() + 1,
      day: nextDay.getUTCDate(),
      hour: input.hour,
      minute: input.minute,
      timeZone,
    });
  }

  return retryAt;
}

function parseLocalClockTime(clockText: string, now: Date): Date | null {
  const normalized = clockText.trim();
  const match = normalized.match(/^(\d{1,2})(?::(\d{2}))?\s*([ap])\.?\s*m\.?(?:\s*\(([^)]+)\)|\s+([A-Z]{2,5}))?$/i);
  if (!match) return null;

  const hour12 = Number.parseInt(match[1] ?? "", 10);
  const minute = Number.parseInt(match[2] ?? "0", 10);
  if (!Number.isInteger(hour12) || hour12 < 1 || hour12 > 12) return null;
  if (!Number.isInteger(minute) || minute < 0 || minute > 59) return null;

  let hour24 = hour12 % 12;
  if ((match[3] ?? "").toLowerCase() === "p") hour24 += 12;

  const timeZoneHint = match[4] ?? match[5];
  if (timeZoneHint) {
    const explicitRetryAt = nextClockTimeInTimeZone({
      now,
      hour: hour24,
      minute,
      timeZoneHint,
    });
    if (explicitRetryAt) return explicitRetryAt;
  }

  const retryAt = new Date(now);
  retryAt.setHours(hour24, minute, 0, 0);
  if (retryAt.getTime() <= now.getTime()) {
    retryAt.setDate(retryAt.getDate() + 1);
  }
  return retryAt;
}

export function extractCodexRetryNotBefore(input: {
  stdout?: string | null;
  stderr?: string | null;
  errorMessage?: string | null;
}, now = new Date()): Date | null {
  const haystack = buildCodexErrorHaystack(input);
  const usageLimitMatch = haystack.match(CODEX_USAGE_LIMIT_RE);
  if (!usageLimitMatch) return null;
  return parseLocalClockTime(usageLimitMatch[1] ?? "", now);
}

export function isCodexTransientUpstreamError(input: {
  stdout?: string | null;
  stderr?: string | null;
  errorMessage?: string | null;
}): boolean {
  const haystack = buildCodexErrorHaystack(input);

  if (isCodexProviderQuotaError(input)) return false;
  if (!CODEX_TRANSIENT_UPSTREAM_RE.test(haystack)) return false;
  // Keep automatic retries scoped to the observed remote-compaction/high-demand
  // failure shape.
  return CODEX_REMOTE_COMPACTION_RE.test(haystack) || /high\s+demand|temporary\s+errors/i.test(haystack);
}

export function isCodexProviderQuotaError(input: {
  stdout?: string | null;
  stderr?: string | null;
  errorMessage?: string | null;
}): boolean {
  const haystack = buildCodexErrorHaystack(input);
  return CODEX_PROVIDER_QUOTA_RE.test(haystack) || extractCodexRetryNotBefore(input) != null;
}
