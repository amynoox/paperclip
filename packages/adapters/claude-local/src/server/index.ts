export { claudeSessionCwdMatchesExecutionTarget, execute, runClaudeLogin, usageAccounting } from "./execute.js";
/** Opt-in prepared process hook; older hosts must not silently fall back to CLI. */
export const supportsPreparedInteractiveProcess = true;
export * from "./acp.js";
export { getConfigSchema } from "./config-schema.js";
export { listClaudeSkills, syncClaudeSkills } from "./skills.js";
export { listClaudeModels, refreshClaudeModels, resetClaudeModelsCacheForTests } from "./models.js";
export { testEnvironment } from "./test.js";
export {
  claudeCommandSupportsEffortFlag,
  resetClaudeCliCapabilitiesCacheForTests,
} from "./cli-capabilities.js";
export {
  parseClaudeStreamJson,
  describeClaudeFailure,
  isClaudeMaxTurnsResult,
  isClaudeProviderQuotaError,
  isClaudeRefusalResult,
  isClaudeUnknownSessionError,
} from "./parse.js";
export {
  getQuotaWindows,
  readClaudeAuthStatus,
  readClaudeToken,
  readIsolatedClaudeKeychainToken,
  fetchClaudeQuota,
  fetchClaudeCliQuota,
  captureClaudeCliUsageText,
  parseClaudeCliUsageText,
  toPercent,
  fetchWithTimeout,
  claudeConfigDir,
} from "./quota.js";
// The Claude `setup-token` login parser. It reads the interactive login output
// and returns the authorization URL and the browser-code prompt, or the minted
// OAuth token from the success record. Both functions fail closed and keep every
// input byte out of each log and each thrown error.
export {
  parseSetupTokenPrompt,
  parseSetupTokenCredential,
  SETUP_TOKEN_PROMPT,
  SETUP_TOKEN_AUTH_URLS,
  SETUP_TOKEN_REDIRECT_URI,
  SETUP_TOKEN_URL_QUERY_KEYS,
  SETUP_TOKEN_PREFIX,
  SETUP_TOKEN_BEFORE_ANCHOR,
  SETUP_TOKEN_AFTER_ANCHOR,
} from "./setup-token-parse.js";
export type { SetupTokenPrompt } from "./setup-token-parse.js";
// The Claude `setup-token` login runner. A server-side factory binds it to a
// sandbox pseudo-terminal driver to drive the two-way login round-trip and to
// deliver the minted token one time in memory.
export {
  runSetupTokenLogin,
  CLAUDE_SETUP_TOKEN_COMMAND,
  CODE_SUBMISSION_TERMINATOR,
  CLAUDE_SETUP_TOKEN_MAX_BUFFER_CHARS,
} from "./setup-token-runner.js";
export type {
  SetupTokenPtyDriver,
  SetupTokenPromptSink,
  SetupTokenCodeProvider,
  SetupTokenCredentialSink,
  SetupTokenOutcome,
  SetupTokenLoginResult,
  RunSetupTokenLoginOptions,
} from "./setup-token-runner.js";
import type { AdapterSessionCodec } from "@paperclipai/adapter-utils";
import { sessionCodec as acpxSessionCodec } from "@paperclipai/adapter-utils/acpx-engine/session-codec";

function readNonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

// STUDIO-0059: the cumulative totals the resumed Claude session had reported when its
// previous run ended (execute.ts writes them; parse.ts subtracts them). Without them in
// the stored session params every resumed run reports the whole session's cost.
// Kept only when they belong to this session id and have the shape parse.ts writes.
function readSessionTotals(value: unknown, sessionId: string): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const totals = value as Record<string, unknown>;
  if (readNonEmptyString(totals.sessionId) !== sessionId) return null;
  const finite = (v: unknown) => typeof v === "number" && Number.isFinite(v) && v >= 0;
  if (totals.totalCostUsd !== null && totals.totalCostUsd !== undefined && !finite(totals.totalCostUsd)) return null;
  const usage = totals.modelUsage;
  if (typeof usage !== "object" || usage === null || Array.isArray(usage)) return null;
  const modelUsage: Record<string, Record<string, number>> = {};
  for (const [model, raw] of Object.entries(usage as Record<string, unknown>)) {
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
    const counters: Record<string, number> = {};
    for (const [field, count] of Object.entries(raw as Record<string, unknown>)) {
      if (!finite(count)) return null;
      counters[field] = count as number;
    }
    modelUsage[model] = counters;
  }
  return { sessionId, modelUsage, totalCostUsd: finite(totals.totalCostUsd) ? totals.totalCostUsd : null };
}

export const sessionCodec: AdapterSessionCodec = {
  deserialize(raw: unknown) {
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
    const record = raw as Record<string, unknown>;
    const sessionId = readNonEmptyString(record.sessionId) ?? readNonEmptyString(record.session_id);
    if (!sessionId) return acpxSessionCodec.deserialize(raw);
    const cwd =
      readNonEmptyString(record.cwd) ??
      readNonEmptyString(record.workdir) ??
      readNonEmptyString(record.folder);
    const promptBundleKey =
      readNonEmptyString(record.promptBundleKey) ??
      readNonEmptyString(record.prompt_bundle_key);
    const mcpServerIdentity = readNonEmptyString(record.mcpServerIdentity);
    const workspaceId = readNonEmptyString(record.workspaceId) ?? readNonEmptyString(record.workspace_id);
    const repoUrl = readNonEmptyString(record.repoUrl) ?? readNonEmptyString(record.repo_url);
    const repoRef = readNonEmptyString(record.repoRef) ?? readNonEmptyString(record.repo_ref);
    const claudeSessionTotals = readSessionTotals(record.claudeSessionTotals, sessionId);
    return {
      sessionId,
      ...(cwd ? { cwd } : {}),
      ...(promptBundleKey ? { promptBundleKey } : {}),
      ...(mcpServerIdentity ? { mcpServerIdentity } : {}),
      ...(workspaceId ? { workspaceId } : {}),
      ...(repoUrl ? { repoUrl } : {}),
      ...(repoRef ? { repoRef } : {}),
      ...(claudeSessionTotals ? { claudeSessionTotals } : {}),
    };
  },
  serialize(params: Record<string, unknown> | null) {
    if (!params) return null;
    const sessionId = readNonEmptyString(params.sessionId) ?? readNonEmptyString(params.session_id);
    if (!sessionId) return acpxSessionCodec.serialize(params);
    const cwd =
      readNonEmptyString(params.cwd) ??
      readNonEmptyString(params.workdir) ??
      readNonEmptyString(params.folder);
    const promptBundleKey =
      readNonEmptyString(params.promptBundleKey) ??
      readNonEmptyString(params.prompt_bundle_key);
    const mcpServerIdentity = readNonEmptyString(params.mcpServerIdentity);
    const workspaceId = readNonEmptyString(params.workspaceId) ?? readNonEmptyString(params.workspace_id);
    const repoUrl = readNonEmptyString(params.repoUrl) ?? readNonEmptyString(params.repo_url);
    const repoRef = readNonEmptyString(params.repoRef) ?? readNonEmptyString(params.repo_ref);
    const claudeSessionTotals = readSessionTotals(params.claudeSessionTotals, sessionId);
    return {
      sessionId,
      ...(cwd ? { cwd } : {}),
      ...(promptBundleKey ? { promptBundleKey } : {}),
      ...(mcpServerIdentity ? { mcpServerIdentity } : {}),
      ...(workspaceId ? { workspaceId } : {}),
      ...(repoUrl ? { repoUrl } : {}),
      ...(repoRef ? { repoRef } : {}),
      ...(claudeSessionTotals ? { claudeSessionTotals } : {}),
    };
  },
  getDisplayId(params: Record<string, unknown> | null) {
    if (!params) return null;
    return (
      readNonEmptyString(params.sessionId) ??
      readNonEmptyString(params.session_id) ??
      acpxSessionCodec.getDisplayId?.(params) ??
      null
    );
  },
};
