import { createHash } from "node:crypto";
import { and, eq, inArray, or, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { heartbeatRuns } from "@paperclipai/db";
import { REDACTED_EVENT_VALUE } from "../redaction.js";
import { getSecretProvider } from "../secrets/provider-registry.js";
import type { StoredSecretVersionMaterial } from "../secrets/types.js";
import { credentialAccessConnectionNameSql } from "./credential-access-visibility.js";

const REGISTRY_KEY = "paperclipSecretRedactions";
// Project only the registry: run contexts can contain megabytes of prompt data.
const registrySnapshot = sql`jsonb_build_object('paperclipSecretRedactions', ${heartbeatRuns.contextSnapshot} -> 'paperclipSecretRedactions')`;

type RegistryEntry = {
  fingerprintSha256: string;
  material: StoredSecretVersionMaterial;
};

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function registryEntries(contextSnapshot: unknown): RegistryEntry[] {
  const context = asRecord(contextSnapshot);
  const raw = context?.[REGISTRY_KEY];
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((value) => {
    const entry = asRecord(value);
    const material = asRecord(entry?.material);
    return typeof entry?.fingerprintSha256 === "string" && material
      ? [{ fingerprintSha256: entry.fingerprintSha256, material }]
      : [];
  });
}

// STUDIO-0085: the local address of a KitWright broker carries an access token in its path,
// http://127.0.0.1:<port>/p/<pin>/t/<32 characters>/, and an engine prints it whole in its own errors. It is masked
// by its form, when a run's output is written and again at every read of a run. Only the token is replaced.
//
// STUDIO-0098: the form is the PATH, not the address. Production, 23 Nov 2026 (TR-2598): the token is the Unity
// project's own (read in KitWright 1.0.1: durable, kept in the EditorPrefs), and the first form (http, 127.0.0.1, a
// pin of exactly 8 characters, plain slashes) let it through under another host name, another scheme, another pin
// length, in a text whose slashes are escaped (a JSON text quoted in another), or percent-encoded.
// What is recognised now: /p/<pin of 1 to 64 characters>/t/<32 characters>, where each slash may be written "/",
// "\/" (with up to fifteen backslashes: a JSON text quoted in another, up to four times) or "%2F", whatever comes before. A token of another length, another path, and a
// token an engine already masked are left as they are.
const SLASH = String.raw`(?:\\{0,15}\/|%2[Ff])`;
/** A slash that is begun and not finished: backslashes still waiting for it, or the beginning of %2F. */
const SLASH_OPEN = String.raw`(?:\\{1,15}|%2?)`;
const BROKER_TOKEN = new RegExp(`(${SLASH}p${SLASH}[\\w-]{1,64}${SLASH}t${SLASH})[\\w-]{32}(?![\\w-])`, "g");
// Every beginning of that form that is not closed yet, from its first slash to 31 characters of the token.
const BROKER_TOKEN_OPEN = new RegExp(`^(?:${SLASH_OPEN}|${SLASH}(?:p(?:${SLASH_OPEN}|${SLASH}(?:[\\w-]{0,64}`
  + `|[\\w-]{1,64}(?:${SLASH_OPEN}|${SLASH}(?:t(?:${SLASH_OPEN}|${SLASH}[\\w-]{0,31})?)?)))?)?)$`);
const BROKER_TOKEN_OPEN_END = new RegExp(`(${SLASH}t${SLASH})([\\w-]+)$`);
/** The longest beginning: four slashes of up to sixteen characters, p, t, a pin of 64 and 31 characters of the token. */
const BROKER_TOKEN_OPEN_MAX = 4 * 16 + 2 + 64 + 31;

export function maskBrokerAddresses(text: string) {
  return text.length > 36 ? text.replace(BROKER_TOKEN, `$1${REDACTED_EVENT_VALUE}`) : text;
}

/** How many characters at the end of the text could be the beginning of a broker token's path that is not closed yet. */
export function openBrokerAddressLength(text: string) {
  const tail = text.slice(-BROKER_TOKEN_OPEN_MAX);
  for (let start = 0; start < tail.length; start++) {
    const first = tail.charCodeAt(start);
    // A beginning starts on a slash, a backslash or a percent sign.
    if (first !== 47 && first !== 92 && first !== 37) continue;
    if (BROKER_TOKEN_OPEN.test(tail.slice(start))) return tail.length - start;
  }
  return 0;
}

/** A beginning that the end of the output interrupted: what follows /t/ is hidden, the rest is ordinary text. */
export function maskOpenBrokerToken(held: string) {
  return held.replace(BROKER_TOKEN_OPEN_END, `$1${REDACTED_EVENT_VALUE}`);
}

// A page of a run log is read by byte offset and can end inside a broker token's path: it is ended just before, and
// the next page starts there (that path is ASCII, so one character is one byte). In a page the mask keeps the length
// of the token: a reader that has no next offset computes it from the size of what it received. A page that is
// nothing but such a beginning (a page shorter than the path itself) is not emptied, so that its reader advances:
// the characters of the token it holds are hidden in place.
function maskBrokerAddressesOfLogPage<T>(value: T): T {
  const page = asRecord(value);
  if (!page || typeof page.content !== "string" || !("logRef" in page)) return value;
  const held = openBrokerAddressLength(page.content);
  if (held && held === page.content.length) {
    return { ...page, content: page.content.replace(BROKER_TOKEN_OPEN_END,
      (_whole: string, head: string, token: string) => head + "*".repeat(token.length)) } as T;
  }
  return { ...page,
    content: page.content.slice(0, page.content.length - held).replace(BROKER_TOKEN, `$1${REDACTED_EVENT_VALUE.padEnd(32, "*")}`),
    ...(held && typeof page.nextOffset === "number" ? { nextOffset: page.nextOffset - held } : {}) } as T;
}

function redactText(input: string, values: string[]) {
  return maskBrokerAddresses(values.reduce(
    (result, value) => value.length > 0 ? result.split(value).join(REDACTED_EVENT_VALUE) : result,
    input,
  ));
}

export function redactRegisteredSecretValues<T>(input: T, values: string[], credentialConnectionName: string | null = null): T {
  if (typeof input === "string") return redactText(input, values) as T;
  if (Array.isArray(input)) return input.map((value) => redactRegisteredSecretValues(value, values, credentialConnectionName)) as T;
  // Dates carry no redactable text; rebuilding them via Object.entries would
  // collapse them to `{}` and break every timestamp in redacted responses.
  if (input instanceof Date) return input;
  const record = asRecord(input);
  if (!record) return input;
  return Object.fromEntries(
    Object.entries(record)
      .filter(([key]) => key !== REGISTRY_KEY && key !== "nativeControllerRecovery" && key !== "nativeTaskSessionPublication" && key !== "legacyProcessSettlement")
      .map(([key, value]) => [key, key === "credentialAccess"
        ? (credentialConnectionName ? { connectionName: redactText(credentialConnectionName, values) } : {})
        : redactRegisteredSecretValues(value, values, credentialConnectionName)]),
  ) as T;
}

export function createRunSecretRedactionRegistry(db: Db) {
  const provider = getSecretProvider("local_encrypted");

  async function valuesForRuns(rows: Array<{ contextSnapshot: unknown }>) {
    const entries = rows.flatMap((row) => registryEntries(row.contextSnapshot));
    const unique = new Map(entries.map((entry) => [entry.fingerprintSha256, entry]));
    const values = await Promise.all(
      [...unique.values()].map((entry) => provider.resolveVersion({
        material: entry.material,
        externalRef: null,
      })),
    );
    return values.sort((left, right) => right.length - left.length);
  }

  async function valuesForRun(companyId: string, runId: string, viewerUserId: string | null) {
    const rows = await db.select({ contextSnapshot: registrySnapshot, credentialConnectionName: credentialAccessConnectionNameSql(viewerUserId) })
      .from(heartbeatRuns)
      .where(and(eq(heartbeatRuns.companyId, companyId), eq(heartbeatRuns.id, runId)));
    return { values: await valuesForRuns(rows), credentialConnectionName: rows[0]?.credentialConnectionName ?? null };
  }

  async function valuesForIssue(companyId: string, issueId: string) {
    const rows = await db.select({ contextSnapshot: registrySnapshot })
      .from(heartbeatRuns)
      .where(and(
        eq(heartbeatRuns.companyId, companyId),
        or(
          sql`${heartbeatRuns.contextSnapshot} ->> 'issueId' = ${issueId}`,
          sql`${heartbeatRuns.contextSnapshot} -> 'paperclipIssue' ->> 'id' = ${issueId}`,
        ),
      ));
    return valuesForRuns(rows);
  }

  return {
    redactionValuesForRun: async (companyId: string, runId: string) => valuesForRuns(await db
      .select({ contextSnapshot: registrySnapshot }).from(heartbeatRuns)
      .where(and(eq(heartbeatRuns.companyId, companyId), eq(heartbeatRuns.id, runId)))),
    register: async (companyId: string, runId: string, value: string) => {
      const fingerprintSha256 = createHash("sha256").update(value).digest("hex");
      await db.transaction(async (tx) => {
        const row = await tx.select({ contextSnapshot: heartbeatRuns.contextSnapshot })
          .from(heartbeatRuns)
          .where(and(eq(heartbeatRuns.companyId, companyId), eq(heartbeatRuns.id, runId)))
          .for("update")
          .then((rows) => rows[0] ?? null);
        if (!row) throw new Error("Heartbeat run redaction registration failed");
        if (registryEntries(row.contextSnapshot).some((entry) => entry.fingerprintSha256 === fingerprintSha256)) {
          return;
        }
        const prepared = await provider.createSecret({ value });
        const entry: RegistryEntry = { fingerprintSha256, material: prepared.material };
        const contextSnapshot = asRecord(row.contextSnapshot) ?? {};
        const currentEntries = Array.isArray(contextSnapshot[REGISTRY_KEY])
          ? contextSnapshot[REGISTRY_KEY]
          : [];
        await tx.update(heartbeatRuns)
          .set({
            contextSnapshot: { ...contextSnapshot, [REGISTRY_KEY]: [...currentEntries, entry] },
            updatedAt: new Date(),
          })
          .where(and(eq(heartbeatRuns.companyId, companyId), eq(heartbeatRuns.id, runId)));
      });
    },
    redactForRuns: async <T extends { id: string }>(companyId: string, runs: T[], viewerUserId: string | null = null): Promise<T[]> => {
      if (runs.length === 0) return [];
      const rows = await db.select({ id: heartbeatRuns.id, contextSnapshot: registrySnapshot, credentialConnectionName: credentialAccessConnectionNameSql(viewerUserId) })
        .from(heartbeatRuns)
        .where(and(eq(heartbeatRuns.companyId, companyId), inArray(heartbeatRuns.id, runs.map((run) => run.id))));
      // Resolve each encrypted value once per request, but apply only each run's
      // own registry. Do not retain plaintext secrets across requests.
      const resolved = new Map<string, Promise<string>>();
      const valuesByRun = new Map(await Promise.all(rows.map(async (row) => {
        const values = await Promise.all(registryEntries(row.contextSnapshot).map((entry) => {
          let value = resolved.get(entry.fingerprintSha256);
          if (!value) {
            value = provider.resolveVersion({ material: entry.material, externalRef: null });
            resolved.set(entry.fingerprintSha256, value);
          }
          return value;
        }));
        return [row.id, { values: values.sort((a, b) => b.length - a.length), credentialConnectionName: row.credentialConnectionName ?? null }] as const;
      })));
      return runs.map((run) => {
        const disclosure = valuesByRun.get(run.id);
        return redactRegisteredSecretValues(run, disclosure?.values ?? [], disclosure?.credentialConnectionName ?? null);
      });
    },
    redactForRun: async <T>(companyId: string, runId: string, value: T, viewerUserId: string | null = null): Promise<T> => {
      const disclosure = await valuesForRun(companyId, runId, viewerUserId);
      return redactRegisteredSecretValues(maskBrokerAddressesOfLogPage(value), disclosure.values, disclosure.credentialConnectionName);
    },
    redactForIssue: async <T>(companyId: string, issueId: string, value: T): Promise<T> =>
      redactRegisteredSecretValues(value, await valuesForIssue(companyId, issueId)),
  };
}
