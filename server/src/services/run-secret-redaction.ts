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

// STUDIO-0085: the local address of a KitWright broker carries the broker's access token in its path,
// http://127.0.0.1:<port>/p/<8 characters>/t/<32 characters>/, and an engine prints it whole in its own errors.
// It is masked by its form, when a run's output is written and again at every read of a run. Only the token is
// replaced. Another host, other lengths, or a token already masked by the engine are left as they are.
const BROKER_ADDRESS = /(http:\/\/127\.0\.0\.1:\d{1,5}\/p\/[\w-]{8}\/t\/)[\w-]{32}(?![\w-])/g;
const BROKER_ADDRESS_OPEN = /http:\/\/127\.0\.0\.1:(?:\d{0,5}|\d{1,5}\/(?:p(?:\/(?:[\w-]{0,8}|[\w-]{8}\/(?:t(?:\/[\w-]{0,32})?)?))?)?)$/;
const BROKER_ADDRESS_HEAD = "http://127.0.0.1:";

export function maskBrokerAddresses(text: string) {
  return text.includes("/t/") ? text.replace(BROKER_ADDRESS, `$1${REDACTED_EVENT_VALUE}`) : text;
}

/** How many characters at the end of the text could be the beginning of a broker address that is not closed yet. */
export function openBrokerAddressLength(text: string) {
  const open = BROKER_ADDRESS_OPEN.exec(text.slice(-68));
  if (open) return open[0].length;
  for (let size = Math.min(BROKER_ADDRESS_HEAD.length - 1, text.length); size > 0; size--) {
    if (text.endsWith(BROKER_ADDRESS_HEAD.slice(0, size))) return size;
  }
  return 0;
}

// A page of a run log is read by byte offset and can end inside a broker address: it is ended just before, and the
// next page starts there (an address is ASCII, so one character is one byte). In a page the mask keeps the length
// of the token: a reader that has no next offset computes it from the size of what it received.
function maskBrokerAddressesOfLogPage<T>(value: T): T {
  const page = asRecord(value);
  if (!page || typeof page.content !== "string" || !("logRef" in page)) return value;
  const held = openBrokerAddressLength(page.content);
  return { ...page,
    content: page.content.slice(0, page.content.length - held).replace(BROKER_ADDRESS, `$1${REDACTED_EVENT_VALUE.padEnd(32, "*")}`),
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
