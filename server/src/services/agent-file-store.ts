import { currentPluginInteractionOrigin } from "./plugin-interaction-context.js";
import { extractAgentMentionIds } from "@paperclipai/shared";
import { assertAgentInteraction } from "./agent-interaction-policy.js";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import { cachedAgentFileManifest, checkpointSnapshot, type AgentFileManifest } from "./agent-file-checkpoints.js";
import { constants } from "node:fs";
import { Readable } from "node:stream";
import path from "node:path";
import { and, desc, eq, isNull, sql } from "drizzle-orm";
import { agents, activityLog, agentInstructionHeads, agentInstructionRevisions, resourceLifecycleEvents, fileStorageDb, type Db } from "@paperclipai/db";
import { captureDirectorySnapshot, mergeDirectoryWithBaseline, type DirectorySnapshot } from "@paperclipai/adapter-utils/workspace-restore-merge";
import { HttpError, conflict, notFound, unprocessable } from "../errors.js";
import { assertNotOwnEntryEdit, authorizeInstructionCommit, authorizeInstructionRead } from "./agent-instruction-authorization.js";
import { assertInstructionPathSafe, instructionPath, instructionBytes, materializeInstructionBytes, readInstructionBytes, MAX_INSTRUCTION_BYTES } from "./agent-instruction-files.js";
import { agentInstructionsBundleMode, deriveBundleState, resolveManagedInstructionsRoot } from "./agent-instructions.js";
import type { AuthorizationActor } from "./authorization.js";
import { durableAgentFilesEnabled, invalidateAgentFileProjection, persistDurableAgentFiles, restoreDurableAgentFiles } from "./agent-file-durability.js";

type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];
type Agent = typeof agents.$inferSelect;
export const AGENT_FILES_CONTRACT = "paperclip.agent-files.v1";
export const MAX_AGENT_FILE_BYTES = 256 * 1024 * 1024;
export const MAX_AGENT_DIRECTORY_BYTES = 2 * 1024 * 1024 * 1024;
export const MAX_AGENT_DIRECTORY_ENTRIES = 100_000;
export const fileHash = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

export class AgentFileLimitError extends HttpError {
  constructor(message: string) {
    super(422, message, { code: "AGENT_FILES_LIMIT_EXCEEDED" });
  }
}
function assertFileSize(size: number, relative: string) {
  if (size > MAX_AGENT_FILE_BYTES) throw new AgentFileLimitError(`Agent file "${relative}" exceeds the 256 MiB per-file limit`);
}
function assertDirectorySize(size: number, count: number) {
  if (size > MAX_AGENT_DIRECTORY_BYTES) throw new AgentFileLimitError("Agent directory exceeds the 2 GiB total storage limit");
  if (count > MAX_AGENT_DIRECTORY_ENTRIES) throw new AgentFileLimitError("Agent directory exceeds the 100,000-entry limit (files and folders)");
}
export function agentStorageWarning(detail: string) {
  return `Agent storage is full. ${detail}. Runs can continue; remove or shrink files in AGENT_HOME to free space. Changes exceeding the storage limits will not be saved.`;
}
function storageWarning(size: number, count: number, fullFile?: string) {
  if (size >= MAX_AGENT_DIRECTORY_BYTES) return agentStorageWarning("The agent folder has reached its 2 GiB limit");
  if (count >= MAX_AGENT_DIRECTORY_ENTRIES) return agentStorageWarning("The agent folder has reached its 100,000-entry limit");
  if (fullFile) return agentStorageWarning(`Agent file "${fullFile}" has reached its 256 MiB limit`);
  return null;
}

export function agentFilePath(value: string): string {
  const relative = instructionPath(value);
  if (relative.split("/").includes(".paperclip-runtime") || relative === "promptTemplate.legacy.md") {
    throw unprocessable(`${relative} is reserved and cannot be used for agent files`);
  }
  return relative;
}

/** Compatibility ETag for clients whose old schema requires a UUID. This is a
 * content token, not a revision ID: no snapshot or history row is created. */
export function agentFileToken(bytes: Uint8Array): string {
  return agentFileTokenFromHash(fileHash(bytes));
}
export function agentFileTokenFromHash(h: string): string {
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-8${h.slice(13, 16)}-a${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

/** Call under the agent row lock. Restore shared authority first; legacy local
 * adoption is allowed only on the server that actually owns the old directory. */
export async function adoptAgentFiles(tx: Tx, agent: Agent): Promise<string> {
  if (agentInstructionsBundleMode(agent) === "external") throw unprocessable("External instructions must be migrated to managed storage first");
  const root = resolveManagedInstructionsRoot(agent);
  if (await restoreDurableAgentFiles(tx, agent, root)) return root;
  const storedRoot = agent.adapterConfig.instructionsRootPath;
  if (durableAgentFilesEnabled() && typeof storedRoot === "string"
    && (path.resolve(storedRoot) !== root || !await readInstructionBytes(root, deriveBundleState(agent).entryFile))) {
    throw new HttpError(503, "Migrate managed agent files on their current server before replacing its filesystem", { code: "AGENT_FILES_MIGRATION_REQUIRED" });
  }
  const markerRoot = path.join(path.dirname(root), "file-sync");
  const marker = "adopted.json";
  await assertInstructionPathSafe(root, deriveBundleState(agent).entryFile);
  await fs.mkdir(root, { recursive: true, mode: 0o700 });
  const filename = await assertInstructionPathSafe(markerRoot, marker);
  const adopted = await fs.readFile(filename, "utf8").catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
  if (adopted !== null) {
    if (JSON.parse(adopted).schema !== AGENT_FILES_CONTRACT) throw new Error("Unsupported agent file contract");
    await persistDurableAgentFiles(tx, agent, root, true);
    return root;
  }
  const legacy = await tx.select({ entryFile: agentInstructionHeads.entryFile, contentBase64: agentInstructionRevisions.contentBase64 })
    .from(agentInstructionHeads).innerJoin(agentInstructionRevisions, eq(agentInstructionHeads.revisionId, agentInstructionRevisions.id))
    .where(and(eq(agentInstructionHeads.companyId, agent.companyId), eq(agentInstructionHeads.agentId, agent.id)));
  for (const entry of legacy) await materializeInstructionBytes(root, entry.entryFile, Buffer.from(entry.contentBase64, "base64"));
  await materializeInstructionBytes(markerRoot, marker, Buffer.from(JSON.stringify({ schema: AGENT_FILES_CONTRACT })));
  await persistDurableAgentFiles(tx, agent, root, true);
  return root;
}

async function openAgentFile(root: string, relative: string) {
  const filename = await assertInstructionPathSafe(root, relative);
  const handle = await fs.open(filename, constants.O_RDONLY | constants.O_NOFOLLOW).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
  if (!handle) return null;
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.nlink !== 1) throw unprocessable("Agent files must be regular files without links");
    assertFileSize(stat.size, relative);
    return { handle, size: stat.size };
  } catch (error) { await handle.close(); throw error; }
}

/** STUDIO-0055: the parents of the entry path in a run's copy must be plain directories (never links). */
async function entryParentsSafe(dir: string, entryPath: string) {
  instructionPath(entryPath);
  let current = dir;
  for (const part of entryPath.split("/").slice(0, -1)) {
    current = path.join(current, part);
    const stat = await fs.lstat(current).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return null;
      throw error;
    });
    if (!stat) return;
    if (stat.isSymbolicLink() || !stat.isDirectory()) throw unprocessable("Agent files must be regular files without links");
  }
}

/**
 * STUDIO-0055: whether a run left its own entry path different from both the run's baseline and the published entry:
 * an edited file, a directory, a link, a special or oversized file. A missing entry counts when one was published.
 */
async function ownEntryLeftChanged(dir: string, entryPath: string, expected: Array<{ kind: string; hash?: string; mode?: number } | undefined>) {
  await entryParentsSafe(dir, entryPath);
  const stat = await fs.lstat(path.join(dir, ...entryPath.split("/"))).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
  if (!stat) return expected.some(entry => entry !== undefined);
  if (!stat.isFile() || stat.nlink !== 1 || stat.size > MAX_INSTRUCTION_BYTES) return true;
  const hash = (await inspectAgentFile(dir, entryPath))?.hash;
  // Same comparison as apply: content and mode.
  return !expected.some(entry => entry?.kind === "file" && entry.hash === hash && entry.mode === stat.mode);
}

/** STUDIO-0055: the published entry's bytes and file mode (the copy must match the canonical file exactly). */
async function readPublishedEntry(root: string, entryPath: string) {
  const bytes = await readAgentFile(root, entryPath);
  if (!bytes) return null;
  const mode = (await fs.stat(await assertInstructionPathSafe(root, entryPath))).mode & 0o7777;
  return { bytes, mode };
}

/**
 * STUDIO-0055: replace whatever a run left at its entry path by the published entry (or remove it if none). A warm
 * run may still be running: the parents are checked again right before each removal, the bytes are written by
 * materializeInstructionBytes (its own checks before the rename), and the mode is set on the opened file, never
 * through a link.
 */
async function putPublishedEntryBack(dir: string, entryPath: string, published: { bytes: Buffer; mode: number } | null) {
  await entryParentsSafe(dir, entryPath);
  const absolute = path.join(dir, ...entryPath.split("/"));
  const stat = await fs.lstat(absolute).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
  // A directory, a link or a special file is removed itself (a link is never followed).
  if (stat && (!stat.isFile() || stat.nlink !== 1)) {
    await entryParentsSafe(dir, entryPath);
    await fs.rm(absolute, { recursive: true, force: true });
  }
  if (published) {
    await materializeInstructionBytes(dir, entryPath, published.bytes);
    const handle = await fs.open(await assertInstructionPathSafe(dir, entryPath), constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      if (!(await handle.stat()).isFile()) throw unprocessable("Agent files must be regular files without links");
      await handle.chmod(published.mode);
    } finally { await handle.close(); }
  } else if (stat) {
    await entryParentsSafe(dir, entryPath);
    await fs.rm(absolute, { recursive: true, force: true });
  }
}

/** Hash large files incrementally. Only editor-sized content is retained in RAM. */
export async function inspectAgentFile(root: string, relative: string, bufferLimit = MAX_INSTRUCTION_BYTES) {
  const opened = await openAgentFile(root, relative);
  if (!opened) return null;
  const hash = createHash("sha256");
  let chunks: Buffer[] | null = opened.size <= bufferLimit ? [] : null;
  let size = 0;
  try {
    for await (const chunk of opened.handle.createReadStream()) {
      size += chunk.length;
      assertFileSize(size, relative);
      hash.update(chunk);
      if (size > bufferLimit) chunks = null;
      chunks?.push(chunk);
    }
    return { size, hash: hash.digest("hex"), bytes: chunks ? Buffer.concat(chunks) : null };
  } finally { await opened.handle.close(); }
}

export async function readAgentFile(root: string, relative: string): Promise<Buffer | null> {
  return (await inspectAgentFile(root, relative, MAX_AGENT_FILE_BYTES))?.bytes ?? null;
}

/** Validate before staging and again after provider stop; never follow links or
 * silently skip an unsupported file. Bounds apply to bytes, including binaries. */
async function scanAgentFiles(root: string, enforceLimits = true) {
  await assertInstructionPathSafe(root, ".path-check");
  let size = 0, count = 0;
  const entries = new Set<string>();
  let fullFile: string | undefined;
  async function walk(dir: string) {
    for (const item of await fs.readdir(path.join(root, dir), { withFileTypes: true })) {
      const relative = agentFilePath(dir ? `${dir}/${item.name}` : item.name);
      const stat = await fs.lstat(path.join(root, relative));
      count++;
      if (enforceLimits) assertDirectorySize(size, count);
      entries.add(relative);
      if (stat.isDirectory()) await walk(relative);
      else if (stat.isFile() && stat.nlink === 1) {
        size += stat.size;
        if (stat.size >= MAX_AGENT_FILE_BYTES) fullFile ??= relative;
        if (enforceLimits) {
          assertFileSize(stat.size, relative);
          assertDirectorySize(size, count);
        }
      } else throw unprocessable("Agent directories support regular files and directories, without links or special files");
    }
  }
  await walk("");
  return { size, entries, storageWarning: storageWarning(size, count, fullFile) };
}

export async function inspectAgentDirectory(root: string, enforceLimits = true) {
  const usage = await scanAgentFiles(root, enforceLimits);
  return { snapshot: await captureDirectorySnapshot(root), storageWarning: usage.storageWarning };
}
export async function snapshotAgentFiles(root: string, enforceLimits = true): Promise<DirectorySnapshot> {
  return (await inspectAgentDirectory(root, enforceLimits)).snapshot;
}

export async function isAgentFileSaveRecorded(tx: Tx, agent: Agent, relative: string, contentHash: string | null): Promise<boolean> {
  if (agent.status === "pending_approval" || agent.status === "terminated") return true;
  const [latest] = await tx.select({ id: resourceLifecycleEvents.id }).from(resourceLifecycleEvents)
    .where(and(eq(resourceLifecycleEvents.companyId, agent.companyId), eq(resourceLifecycleEvents.resourceType, "agent_runtime"), eq(resourceLifecycleEvents.resourceId, agent.id)))
    .orderBy(desc(resourceLifecycleEvents.id)).limit(1);
  if (!latest) return false;
  const hash = sql<string>`${activityLog.details}->>'contentHash'`;
  const [recorded] = await tx.select({ id: activityLog.id }).from(activityLog)
    .innerJoin(resourceLifecycleEvents, and(eq(resourceLifecycleEvents.id, latest.id), eq(activityLog.createdAt, resourceLifecycleEvents.createdAt))).where(and(
    eq(activityLog.companyId, agent.companyId), eq(activityLog.entityType, "agent"), eq(activityLog.entityId, agent.id), eq(activityLog.action, "agent.files_updated"),
    eq(sql<string>`${activityLog.details}->>'agentRuntimeRevision'`, String(latest.id)),
    eq(sql<string>`${activityLog.details}->>'path'`, relative), contentHash === null ? isNull(hash) : eq(hash, contentHash),
  )).limit(1);
  return Boolean(recorded);
}

export function agentFileStore(db: Db) {
  db = fileStorageDb(db);
  async function locked<T>(companyId: string, agentId: string, actor: AuthorizationActor, write: boolean,
    fn: (tx: Tx, agent: Agent, root: string, bound: AuthorizationActor) => Promise<T>, texts: string[] = []) {
    return db.transaction(async tx => {
      if (write) await assertAgentInteraction(tx, { companyId, actorAgentId: actor.type === "agent" ? actor.agentId : null,
        operation: "configure", targetAgentId: agentId, lockAgentIds: texts.flatMap(extractAgentMentionIds), lock: "update" });
      const [agent] = await tx.select().from(agents).where(and(eq(agents.companyId, companyId), eq(agents.id, agentId))).for("update");
      if (!agent) throw notFound("Agent not found");
      const bound = write ? await authorizeInstructionCommit(tx, actor, agent) : await authorizeInstructionRead(tx, actor, agent);
      const root = await adoptAgentFiles(tx, agent);
      if (write) await invalidateAgentFileProjection(root);
      const result = await fn(tx, agent, root, bound);
      if (write) await persistDurableAgentFiles(tx, agent, root);
      return result;
    });
  }
  async function audit(tx: Tx, agent: Agent, actor: AuthorizationActor, details: Record<string, unknown>) {
    const origin = currentPluginInteractionOrigin();
    await tx.insert(activityLog).values({ companyId: agent.companyId, actorType: origin ? "agent" : actor.type === "board" ? "user" : "agent",
      actorId: origin?.agentId ?? (actor.type === "board" ? actor.userId : actor.agentId)!, agentId: origin?.agentId ?? (actor.type === "agent" ? actor.agentId : null),
      runId: origin ? origin.runId : actor.runId, responsibleUserId: origin ? null : actor.type === "board" ? actor.userId : actor.onBehalfOfUserId,
      action: "agent.files_updated", entityType: "agent", entityId: agent.id, details });
  }
  return {
    locked,
    download: async (companyId: string, agentId: string, relative: string, actor: AuthorizationActor) => {
      const opened: { file: Awaited<ReturnType<typeof openAgentFile>> } = { file: null };
      try {
        const file = await locked(companyId, agentId, actor, false, async (_tx, _agent, root) => {
          opened.file = await openAgentFile(root, instructionPath(relative));
          return opened.file;
        });
        // Transfer outside the database lock. The open descriptor pins the file
        // across concurrent atomic replacements; end bounds concurrent growth.
        if (!file) return null;
        if (file.size === 0) { await file.handle.close(); return { size: 0, stream: Readable.from([]) }; }
        return { size: file.size, stream: file.handle.createReadStream({ end: file.size - 1 }) };
      } catch (error) { await opened.file?.handle.close(); throw error; }
    },
    read: (companyId: string, agentId: string, relative: string, actor: AuthorizationActor) =>
      locked(companyId, agentId, actor, false, (_tx, _agent, root) => readAgentFile(root, instructionPath(relative))),
    write: (input: { companyId: string; agentId: string; path: string; bytes: Buffer | null; baseHash: string | null }, actor: AuthorizationActor) =>
      locked(input.companyId, input.agentId, actor, true, async (tx, agent, root, bound) => {
        const relative = agentFilePath(input.path);
        if (relative === deriveBundleState(agent).entryFile) assertNotOwnEntryEdit(bound, agent.id);
        if (input.bytes) assertFileSize(input.bytes.length, relative);
        const previous = await inspectAgentFile(root, relative);
        const currentHash = previous?.hash ?? null;
        const incomingHash = input.bytes === null ? null : fileHash(input.bytes);
        if (currentHash === incomingHash) {
          if (!await isAgentFileSaveRecorded(tx, agent, relative, incomingHash)) await audit(tx, agent, bound, { path: relative, contentHash: incomingHash });
          return { contentHash: currentHash, changed: false };
        }
        if (input.bytes && input.bytes.length <= MAX_INSTRUCTION_BYTES) {
          await assertAgentInteraction(tx, { companyId: input.companyId, actorAgentId: bound.type === "agent" ? bound.agentId : null,
            operation: "mention", texts: [input.bytes.toString("utf8")] });
        }
        if (currentHash !== input.baseHash) throw conflict("This file changed since it was read. Reload before saving.", { code: "AGENT_FILE_CONFLICT", path: relative, currentHash });
        if (input.bytes === null && relative === deriveBundleState(agent).entryFile) throw unprocessable("The configured instruction entry cannot be deleted");
        if (input.bytes !== null) {
          if (relative === deriveBundleState(agent).entryFile) instructionBytes(input.bytes);
          // A quota check needs metadata only. Do not hash unrelated large
          // files while holding the editor's row lock for a one-file save.
          const snapshot = await scanAgentFiles(root);
          const total = snapshot.size + input.bytes.length - (previous?.size ?? 0);
          const newEntries = relative.split("/").map((_part, i, parts) => parts.slice(0, i + 1).join("/")).filter(name => !snapshot.entries.has(name)).length;
          assertDirectorySize(total, snapshot.entries.size + newEntries);
        }
        if (input.bytes === null) await fs.unlink(await assertInstructionPathSafe(root, relative));
        else await materializeInstructionBytes(root, relative, input.bytes);
        await audit(tx, agent, bound, { path: relative, contentHash: incomingHash, created: previous === null && input.bytes !== null });
        return { contentHash: incomingHash, changed: true };
      }, input.bytes && input.bytes.length <= MAX_INSTRUCTION_BYTES ? [input.bytes.toString("utf8")] : []),
    /**
     * STUDIO-0055: before a run's own copy is scanned, put the published entry back if the run changed it (edited,
     * replaced by a directory or a link, oversized). Returns whether something was set aside. Only for the agent's
     * own run; the scan and the save of the rest of the folder then proceed as usual.
     */
    setOwnEntryAside: (input: { companyId: string; agentId: string; dir: string; baseline: DirectorySnapshot }, actor: AuthorizationActor) =>
      locked(input.companyId, input.agentId, actor, false, async (_tx, agent, root, bound) => {
        if (bound.type !== "agent" || bound.agentId !== agent.id) return false;
        const entryPath = deriveBundleState(agent).entryFile;
        const published = await inspectAgentFile(root, entryPath);
        const publishedEntry = published
          ? { kind: "file" as const, hash: published.hash, mode: (await fs.lstat(await assertInstructionPathSafe(root, entryPath))).mode }
          : undefined;
        if (!await ownEntryLeftChanged(input.dir, entryPath, [input.baseline.entries.get(entryPath), publishedEntry])) return false;
        await putPublishedEntryBack(input.dir, entryPath, await readPublishedEntry(root, entryPath));
        return true;
      }),
    apply: async (input: { companyId: string; agentId: string; sourceDir: string; baseline: DirectorySnapshot; checkpoint?: AgentFileManifest }, actor: AuthorizationActor) => {
      const incoming = input.checkpoint ? checkpointSnapshot(input.checkpoint) : await snapshotAgentFiles(input.sourceDir);
      const [target] = await db.select().from(agents).where(and(eq(agents.companyId, input.companyId), eq(agents.id, input.agentId)));
      if (!target) throw notFound("Agent not found");
      const requestedEntry = deriveBundleState(target).entryFile;
      const changedMentions = new Map<string, { hash: string; text: string }>();
      let entryEditDiscarded = false;
      if (actor.type === "agent" || currentPluginInteractionOrigin()) {
        for (const [name, entry] of incoming.entries) {
          if (entry.kind !== "file" || JSON.stringify(entry) === JSON.stringify(input.baseline.entries.get(name))) continue;
          if ((await fs.stat(await assertInstructionPathSafe(input.sourceDir, name))).size > MAX_INSTRUCTION_BYTES) continue;
          const bytes = (await inspectAgentFile(input.sourceDir, name))?.bytes;
          const mentions = bytes ? extractAgentMentionIds(bytes.toString("utf8")) : [];
          if (mentions.length) changedMentions.set(name, { hash: fileHash(bytes!), text: mentions.map(id => `[@agent](agent://${id})`).join(" ") });
        }
      }
      return locked(input.companyId, input.agentId, actor, true, async (tx, agent, root, bound) => {
        if (deriveBundleState(agent).entryFile !== requestedEntry) throw conflict("Agent instructions entry changed; retry the file synchronization");
        const entryPath = deriveBundleState(agent).entryFile;
        // Previously saved/imported bytes must remain readable, including when
        // over quota. Enforce limits on the incoming and resulting tree so a
        // run can delete files to recover instead of being locked out forever.
        const current = input.checkpoint ? checkpointSnapshot(await cachedAgentFileManifest(root)) : await snapshotAgentFiles(root, false);
        // STUDIO-0055: the agent's own run never rewrites its entry file (the Board publishes it); the rest of its
        // folder (notes, evidence) is saved as usual and the receipt says the entry edit was set aside. A Board
        // publication during the run is not an edit: the run's copy then holds the published entry.
        const baselineEntry = input.baseline.entries.get(entryPath);
        const runEntry = JSON.stringify(incoming.entries.get(entryPath));
        const ownRun = bound.type === "agent" && bound.agentId === agent.id;
        if (ownRun && runEntry !== JSON.stringify(baselineEntry) && runEntry !== JSON.stringify(current.entries.get(entryPath))) {
          const entries = new Map(incoming.entries);
          for (const name of [...entries.keys()]) if (name.startsWith(`${entryPath}/`)) { entries.delete(name); changedMentions.delete(name); }
          if (baselineEntry) entries.set(entryPath, baselineEntry); else entries.delete(entryPath);
          incoming.entries = entries;
          changedMentions.delete(entryPath);
          entryEditDiscarded = true;
          // The directory merge reads the run's copy on disk: put the published entry back into it, so the
          // merge has nothing to bring over.
          await putPublishedEntryBack(input.sourceDir, entryPath, await readPublishedEntry(root, entryPath));
        }
        // With no published entry at all, the agent's own run has no entry to keep (and may not create one).
        const nothingPublished = ownRun && !baselineEntry && !current.entries.get(entryPath);
        if (!entryEditDiscarded && !nothingPublished) {
          if (incoming.entries.get(entryPath)?.kind !== "file") throw unprocessable("The configured instruction entry cannot be deleted");
          if (!input.checkpoint || JSON.stringify(incoming.entries.get(entryPath)) !== JSON.stringify(input.baseline.entries.get(entryPath))) {
            const entry = await readInstructionBytes(input.sourceDir, entryPath);
            if (entry === null) throw unprocessable("The configured instruction entry cannot be deleted");
            instructionBytes(entry);
          }
        }
        const texts = [...changedMentions].flatMap(([name, value]) => {
          const prior = current.entries.get(name);
          return prior?.kind === "file" && prior.hash === value.hash ? [] : [value.text];
        });
        await assertAgentInteraction(tx, { companyId: input.companyId, actorAgentId: bound.type === "agent" ? bound.agentId : null,
          operation: "mention", texts });
        // Rebase only the run's changed paths onto the current tree. This makes
        // same-file edits/deletions last-sync-wins while untouched files retain
        // changes from other runs. Ancestors may need recreating after a writer
        // replaced a directory with a file.
        const entries = new Map(input.baseline.entries);
        const changed = [...new Set([...input.baseline.entries, ...incoming.entries].map(([name]) => name))]
          .filter(name => JSON.stringify(input.baseline.entries.get(name)) !== JSON.stringify(incoming.entries.get(name)));
        for (const name of changed) {
          const present = current.entries.get(name);
          if (present) entries.set(name, present); else entries.delete(name);
          if (incoming.entries.has(name)) {
            for (let parent = path.posix.dirname(name); parent !== "."; parent = path.posix.dirname(parent)) {
              if (current.entries.get(parent)?.kind === "dir") continue;
              const before = current.entries.get(parent);
              if (before) entries.set(parent, before); else entries.delete(parent);
            }
          }
        }
        const applyBaseline = { ...input.baseline, entries };
        const finalEntries = new Map([...current.entries].map(([name, value]) => [name, { value, root }]));
        for (const name of changed) if (!incoming.entries.has(name)) finalEntries.delete(name);
        for (const [name, value] of incoming.entries) {
          if (JSON.stringify(input.baseline.entries.get(name)) === JSON.stringify(value)) continue;
          if (value.kind !== "dir") for (const child of finalEntries.keys()) if (child.startsWith(`${name}/`)) finalEntries.delete(child);
          finalEntries.set(name, { value, root: input.sourceDir });
          for (let parent = path.posix.dirname(name); parent !== "."; parent = path.posix.dirname(parent)) {
            if (finalEntries.get(parent)?.value.kind !== "dir") finalEntries.set(parent, { value: { kind: "dir" }, root: input.sourceDir });
          }
        }
        // An unchanged file created by another run can keep a removed folder
        // alive. Count those surviving parent directories in quota preflight.
        for (const name of finalEntries.keys()) {
          for (let parent = path.posix.dirname(name); parent !== "."; parent = path.posix.dirname(parent)) {
            if (!finalEntries.has(parent)) finalEntries.set(parent, { value: { kind: "dir" }, root });
          }
        }
        let total = 0;
        let fullFile: string | undefined;
        for (const [name, item] of finalEntries) if (item.value.kind === "file") {
          const size = (await fs.stat(path.join(item.root, name))).size;
          assertFileSize(size, name);
          if (size >= MAX_AGENT_FILE_BYTES) fullFile ??= name;
          total += size;
        }
        assertDirectorySize(total, finalEntries.size);
        await mergeDirectoryWithBaseline({ ...input, baseline: applyBaseline, targetDir: root,
          ...(input.checkpoint ? { snapshots: { source: incoming, current } } : {}) });
        await audit(tx, agent, bound, { sourceRunId: currentPluginInteractionOrigin()?.runId ?? actor.runId, contract: AGENT_FILES_CONTRACT,
          ...(entryEditDiscarded ? { entryEditDiscarded: true } : {}) });
        return { storageWarning: storageWarning(total, finalEntries.size, fullFile), entryEditDiscarded };
      }, [...changedMentions.values()].map(value => value.text)).catch((error: unknown) => {
        // STUDIO-0055: the run's copy already holds the published entry; a retry would see no edit, so the failure
        // carries the mark for the receipt.
        if (entryEditDiscarded && error && typeof error === "object") Object.assign(error, { entryEditDiscarded: true });
        throw error;
      });
    },
  };
}
