import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { and, asc, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  activityLog,
  agents,
  authUsers,
  companies,
  companyMemberships,
  createDb,
  documents,
  heartbeatRuns,
  issueComments,
  issueDocuments,
  issueThreadInteractions,
  issues,
} from "@paperclipai/db";
import { registerServerAdapter, unregisterServerAdapter } from "../adapters/index.js";
import {
  UNFINISHED_RUN_STATUS_LINE_REASON_CODE,
  buildHeartbeatRunIssueComment,
  readUnfinishedRunStatus,
  resolveHeartbeatRunResponse,
  unfinishedRunStatusLine,
} from "../services/heartbeat-run-summary.js";
import { buildHeartbeatRunStopMetadata, mergeHeartbeatRunStopMetadata } from "../services/heartbeat-stop-metadata.js";
import { heartbeatService } from "../services/heartbeat.js";
import { recoveryPostgresSupport, startRecoveryPostgres } from "./helpers/recovery-postgres.js";

const describePostgres = recoveryPostgresSupport.supported ? describe : describe.skip;
if (!recoveryPostgresSupport.supported) console.warn(`Skipping failed run summary tests: ${recoveryPostgresSupport.reason}`);

const SAID = "The player builds now and the smoke scene loads. Running the full test suite.";
const under = (status: "timed_out" | "failed" | "cancelled" | "interrupted", text = SAID) =>
  `This run ended \`${status}\` before it finished. Its last message:\n\n${text}`;

// STUDIO-0080. The server posts an adapter's summary as a comment of the agent whatever the run's outcome. What a
// run that did not succeed returns is what its engine last said before it was cut: it stays posted, under a first
// line of the server that gives the run's status.
describe("the summary of a run that did not succeed: the status line", () => {
  // The result as the completion persists it: the adapter's summary, and the stop reason the server writes.
  const persisted = (outcome: Parameters<typeof buildHeartbeatRunStopMetadata>[0]["outcome"], patch: Record<string, unknown> = {}, error: { errorCode?: string; errorMessage?: string } = {}) =>
    mergeHeartbeatRunStopMetadata({ summary: SAID, ...patch }, buildHeartbeatRunStopMetadata({ adapterType: "codex_local", adapterConfig: {}, outcome, ...error }));

  it.each([
    ["timed_out", "timed_out", {}],
    ["failed", "failed", {}],
    ["failed", "failed", { errorCode: "process_lost" }],
    ["failed", "failed", { errorCode: "max_turns_exhausted" }],
    ["cancelled", "cancelled", {}],
    ["cancelled", "cancelled", { errorMessage: "Agent paused by the board" }],
    ["cancelled", "cancelled", { errorMessage: "Budget hard stop" }],
    ["interrupted", "interrupted", {}],
  ] as const)("a run that ended %s is posted under a line that says %s (%j)", (outcome, status, error) => {
    const resultJson = persisted(outcome, {}, error);
    expect(readUnfinishedRunStatus(resultJson)).toBe(status);
    const resolved = resolveHeartbeatRunResponse({ resultJson });
    expect(resolved.text).toBe(under(status));
    expect(resolved.decision).toMatchObject({ chosenSource: "adapter_final_response", commentAction: "create",
      reasonCodes: ["legacy_adapter_summary_compatibility", UNFINISHED_RUN_STATUS_LINE_REASON_CODE] });
    // The run's final text, as its status payload gives it, is the same body.
    expect(buildHeartbeatRunIssueComment(resultJson)).toBe(under(status));
  });

  it("the line names the status in the product's own word, and nothing else changes in the text", () => {
    expect(unfinishedRunStatusLine("timed_out")).toBe("This run ended `timed_out` before it finished. Its last message:");
    const multiline = "First line.\n\n- a list\n- of two\n";
    expect(resolveHeartbeatRunResponse({ resultJson: persisted("timed_out", { summary: multiline }) }).text)
      .toBe(`This run ended \`timed_out\` before it finished. Its last message:\n\n${multiline}`);
    // `result` and `message` are read like `summary`.
    expect(resolveHeartbeatRunResponse({ resultJson: persisted("failed", { summary: "", result: "From result." }) }).text).toBe(under("failed", "From result."));
    expect(resolveHeartbeatRunResponse({ resultJson: persisted("failed", { summary: undefined, message: "From message." }) }).text).toBe(under("failed", "From message."));
  });

  it("a run that succeeded is unchanged", () => {
    const resultJson = persisted("succeeded");
    expect(resultJson.stopReason).toBe("completed");
    expect(readUnfinishedRunStatus(resultJson)).toBeNull();
    const resolved = resolveHeartbeatRunResponse({ resultJson });
    expect(resolved.text).toBe(SAID);
    expect(resolved.decision.reasonCodes).toEqual(["legacy_adapter_summary_compatibility"]);
  });

  it("no line without the server's stop reason, or under one that does not say the run failed", () => {
    for (const stopReason of [undefined, null, "", "completed", "unmanaged_background_task_stopped", "something_new", 7, "toString", "constructor"]) {
      const resultJson = { summary: SAID, stopReason } as Record<string, unknown>;
      expect(readUnfinishedRunStatus(resultJson), String(stopReason)).toBeNull();
      expect(resolveHeartbeatRunResponse({ resultJson }).text, String(stopReason)).toBe(SAID);
    }
    expect(readUnfinishedRunStatus(null)).toBeNull();
    expect(readUnfinishedRunStatus(undefined)).toBeNull();
  });

  it("a summary that opens as narration is still not posted, whatever the outcome", () => {
    for (const outcome of ["timed_out", "failed", "succeeded"] as const) {
      const resolved = resolveHeartbeatRunResponse({ resultJson: persisted(outcome, { summary: "I'll run the full test suite now." }) });
      expect(resolved.text).toBeNull();
      expect(resolved.decision).toMatchObject({ commentAction: "none", reasonCodes: ["legacy_adapter_summary_ambiguous"] });
    }
  });

  it("the other sources of a response take no line: a comment the run posted itself, a marked final answer", () => {
    const resultJson = persisted("timed_out");
    expect(resolveHeartbeatRunResponse({ resultJson, existingComment: { id: "c1", body: "Posted by the role during the run." } }))
      .toMatchObject({ text: "Posted by the role during the run.", decision: { commentAction: "reuse", commentId: "c1" } });
    expect(resolveHeartbeatRunResponse({ resultJson: { ...resultJson, finalResponse: { disposition: "final", text: "Marked final." } } }).text).toBe("Marked final.");
  });
});

describePostgres("the summary of a run that did not succeed, on the real run path", () => {
  let temporary: Awaited<ReturnType<typeof startRecoveryPostgres>>;
  let db: ReturnType<typeof createDb>;
  let heartbeat: ReturnType<typeof heartbeatService>;
  const adapterType = "codex_local";
  const oldHome = process.env.PAPERCLIP_HOME;
  let home: string;

  type Step = { outcome: "timeout" | "failure" | "success" | "provider_cancelled" | "killed"; summary?: string; session?: string; waitFor?: Promise<void> };
  const scripts = new Map<string, Step[]>();
  const contexts = new Map<string, Array<Record<string, unknown>>>();
  const launched = new Map<string, number>();

  beforeAll(async () => {
    temporary = await startRecoveryPostgres("failed-run-summary-");
    db = createDb(temporary.connectionString);
    home = await mkdtemp(path.join(tmpdir(), "paperclip-failed-run-summary-"));
    process.env.PAPERCLIP_HOME = home;
    heartbeat = heartbeatService(db);
    registerServerAdapter({
      type: adapterType, supportsLocalAgentJwt: false,
      execute: async (input) => {
        const issueId = String(input.context.issueId);
        contexts.set(issueId, [...(contexts.get(issueId) ?? []), JSON.parse(JSON.stringify(input.context))]);
        launched.set(issueId, (launched.get(issueId) ?? 0) + 1);
        const step = scripts.get(issueId)?.shift() ?? { outcome: "failure" as const };
        if (step.waitFor) await step.waitFor;
        const session = step.session ? { sessionId: step.session, sessionDisplayId: step.session, sessionParams: { sessionId: step.session } } : {};
        const summary = step.summary ? { summary: step.summary } : {};
        switch (step.outcome) {
          // The shape codex_local returns when the run reaches its timeout (STUDIO-0080).
          case "timeout":
            return { exitCode: null, signal: "SIGTERM", timedOut: true, errorMessage: "Timed out after 1800s", ...summary, ...session };
          case "success":
            return { exitCode: 0, signal: null, timedOut: false, resultJson: {}, ...summary, ...session };
          // An engine that reports its own cancellation.
          case "provider_cancelled":
            return { exitCode: null, signal: null, timedOut: false, resultJson: { status: "cancelled" }, ...summary, ...session };
          // The engine killed while it ran (a pause): what was read of its output comes back with the kill.
          case "killed":
            return { exitCode: null, signal: "SIGTERM", timedOut: false, errorMessage: "Process terminated by SIGTERM",
              resultJson: { stdout: "", stderr: "" }, ...summary, ...session };
          // The shape codex_local returns on any other failure, at 19c312cf already: the last message with the output.
          default:
            return { exitCode: 1, signal: null, timedOut: false, errorCode: "adapter_failed", errorMessage: "engine failed",
              resultJson: { stdout: "", stderr: "" }, ...summary, ...session };
        }
      },
      testEnvironment: async () => ({ adapterType, status: "pass", checks: [], testedAt: new Date().toISOString() }),
    });
  }, 240_000);

  afterAll(async () => {
    await heartbeat?.drainActiveRunExecutions();
    unregisterServerAdapter(adapterType);
    await db?.$client.end({ timeout: 0 });
    await temporary?.cleanup();
    if (oldHome === undefined) delete process.env.PAPERCLIP_HOME; else process.env.PAPERCLIP_HOME = oldHome;
    if (home) await rm(home, { recursive: true, force: true });
  });

  type Fixture = { companyId: string; devId: string; ctoId: string; issueId: string };

  async function seed(): Promise<Fixture> {
    const companyId = randomUUID(), devId = randomUUID(), ctoId = randomUUID(), issueId = randomUUID();
    const userId = `summary-user-${companyId}`;
    await db.insert(authUsers).values({ id: userId, name: "Board user", email: `${userId}@example.test`, createdAt: new Date(), updatedAt: new Date() });
    await db.insert(companies).values({ id: companyId, name: "Failed run summary fixture", issuePrefix: `S${companyId.slice(0, 6)}` });
    await db.insert(companyMemberships).values({ companyId, principalId: userId, principalType: "user", status: "active", membershipRole: "member" });
    await db.insert(agents).values({ id: ctoId, companyId, name: "CTO", role: "cto", adapterType, status: "idle", adapterConfig: {} });
    await db.insert(agents).values({ id: devId, companyId, name: "Dev Unity", adapterType, status: "idle", adapterConfig: {}, reportsTo: ctoId });
    await db.insert(issues).values({
      id: issueId, companyId, title: "Build the player", status: "in_progress", assigneeAgentId: devId,
      responsibleUserId: userId, issueNumber: 1, startedAt: new Date(),
    });
    await db.insert(issueThreadInteractions).values({
      companyId, issueId, status: "pending", kind: "request_confirmation", continuationPolicy: "none", addresseeAgentId: ctoId,
      idempotencyKey: `interruption/${randomUUID()}/${randomUUID()}`,
      payload: { version: 1, prompt: "Keep the current reservation?" },
    } as never);
    scripts.set(issueId, []);
    return { companyId, devId, ctoId, issueId };
  }

  const runRow = async (id: string) => (await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, id)))[0]!;

  async function wake(f: Fixture, step: Step) {
    scripts.get(f.issueId)!.push(step);
    const [comment] = await db.insert(issueComments).values({
      companyId: f.companyId, issueId: f.issueId, authorType: "agent", authorAgentId: f.ctoId, body: "Go on.",
    }).returning();
    const run = await heartbeat.wakeup(f.devId, {
      source: "automation", triggerDetail: "system", reason: "issue_commented",
      payload: { issueId: f.issueId, commentId: comment!.id },
      contextSnapshot: { issueId: f.issueId, taskId: f.issueId, wakeReason: "issue_commented", commentId: comment!.id, wakeCommentId: comment!.id },
      requestedByActorType: "agent", requestedByActorId: f.ctoId,
    });
    expect(run).not.toBeNull();
    return run!;
  }

  async function turn(f: Fixture, step: Step) {
    const run = await wake(f, step);
    await heartbeat.drainActiveRunExecutions();
    await expect.poll(async () => (await runRow(run.id)).status, { timeout: 30_000 }).toMatch(/^(failed|succeeded|timed_out|cancelled)$/);
    return runRow(run.id);
  }

  const roleComments = async (f: Fixture) => (await db.select().from(issueComments)
    .where(and(eq(issueComments.issueId, f.issueId), eq(issueComments.authorAgentId, f.devId))).orderBy(asc(issueComments.createdAt)));
  const continuationSummary = async (f: Fixture) => (await db.select({ body: documents.latestBody, key: issueDocuments.key }).from(issueDocuments)
    .innerJoin(documents, eq(issueDocuments.documentId, documents.id)).where(eq(issueDocuments.issueId, f.issueId)));

  it("a run that reaches its timeout with a summary: the comment of the role says the run ended `timed_out`, and the next run reads it so", async () => {
    const f = await seed();
    const run = await turn(f, { outcome: "timeout", summary: SAID, session: "s1" });
    expect(run).toMatchObject({ status: "timed_out", errorCode: "timeout", livenessState: "failed", nextAction: null });
    // The run keeps the engine's text as it came: the line is on the comment, not in the result.
    expect(run.resultJson).toMatchObject({ summary: SAID, stopReason: "timeout" });

    const comments = await roleComments(f);
    expect(comments.map((row) => [row.body, row.authorType, row.createdByRunId])).toEqual([[under("timed_out"), "agent", run.id]]);
    expect(run.resultJson).toMatchObject({ presentationDecision: { chosenSource: "adapter_final_response", commentAction: "create", commentId: comments[0]!.id,
      reasonCodes: ["legacy_adapter_summary_compatibility", UNFINISHED_RUN_STATUS_LINE_REASON_CODE, "resolved_response_materialized"] } });
    const activity = await db.select().from(activityLog).where(and(eq(activityLog.entityId, f.issueId), eq(activityLog.runId, run.id)));
    expect(activity.map((row) => [row.action, row.actorType, (row.details as Record<string, unknown>).source]))
      .toEqual([["issue.comment_added", "agent", "run_presentation_resolver"]]);

    // The continuation summary of the issue said the status already, and still does.
    const [summary] = await continuationSummary(f);
    expect(summary!.body).toContain(`- Run \`${run.id}\` finished with status \`timed_out\``);
    expect(summary!.body).toContain(`- ${SAID}`);
    expect(summary!.body).toContain("- Latest run ended with `timed_out`; inspect the error before continuing.");
    expect((await db.select().from(issues).where(eq(issues.id, f.issueId)))[0]!.status).toBe("in_progress");

    // The next run of the role is given that comment as one of its own messages, with its status line.
    await turn(f, { outcome: "failure" });
    const given = contexts.get(f.issueId)!.at(-1)!;
    const continuation = given.executionContinuation as { messages: Array<{ id: string; authorType: string; body: string; createdByRunId: string | null }>; completedWork: string | null };
    expect(continuation.messages.filter((message) => message.createdByRunId === run.id))
      .toEqual([expect.objectContaining({ id: comments[0]!.id, authorType: "agent", body: under("timed_out") })]);
    expect(continuation.messages.some((message) => message.body === SAID)).toBe(false);
    expect(continuation.completedWork).toBe(summary!.body);
  }, 180_000);

  it("a run that fails otherwise with a summary (codex_local on every other failure): the comment says `failed`", async () => {
    const f = await seed();
    const run = await turn(f, { outcome: "failure", summary: SAID, session: "s1" });
    expect(run).toMatchObject({ status: "failed", errorCode: "adapter_failed" });
    expect((await roleComments(f)).map((row) => [row.body, row.createdByRunId])).toEqual([[under("failed"), run.id]]);
  }, 180_000);

  it("a run that succeeds with a summary: the comment is the summary, unchanged", async () => {
    const f = await seed();
    const run = await turn(f, { outcome: "success", summary: SAID, session: "s1" });
    expect(run.status).toBe("succeeded");
    expect(run.resultJson).toMatchObject({ stopReason: "completed", presentationDecision: { reasonCodes: ["legacy_adapter_summary_compatibility", "resolved_response_materialized"] } });
    expect((await roleComments(f)).map((row) => [row.body, row.createdByRunId])).toEqual([[SAID, run.id]]);
  }, 180_000);

  it("a timed-out run without a summary posts nothing, and one whose summary opens as narration posts nothing", async () => {
    const f = await seed();
    const bare = await turn(f, { outcome: "timeout", session: "s1" });
    expect(bare.status).toBe("timed_out");
    const narration = await turn(f, { outcome: "timeout", summary: "I'll run the full test suite now.", session: "s1" });
    expect(narration.status).toBe("timed_out");
    expect(narration.resultJson).toMatchObject({ presentationDecision: { commentAction: "none", reasonCodes: ["legacy_adapter_summary_ambiguous"] } });
    expect(await roleComments(f)).toEqual([]);
  }, 180_000);

  it("a run its engine reports as cancelled takes the same path: the comment says `cancelled`", async () => {
    const f = await seed();
    const run = await turn(f, { outcome: "provider_cancelled", summary: SAID, session: "s1" });
    expect(run).toMatchObject({ status: "cancelled", errorCode: "cancelled" });
    expect(run.resultJson).toMatchObject({ stopReason: "cancelled" });
    expect((await roleComments(f)).map((row) => [row.body, row.createdByRunId])).toEqual([[under("cancelled"), run.id]]);
  }, 180_000);

  // A stop while the engine runs (the run is cancelled first, its engine is killed and returns late) does not
  // take that path: the late result is not presented, with this patch or without it.
  it("a run stopped while its engine runs posts no comment at all: its late result is not presented", async () => {
    const f = await seed();
    let release!: () => void;
    const waitFor = new Promise<void>((resolve) => { release = resolve; });
    const run = await wake(f, { outcome: "killed", summary: SAID, session: "s1", waitFor });
    await expect.poll(() => launched.get(f.issueId) ?? 0, { timeout: 30_000 }).toBe(1);
    await heartbeat.cancelRun(run.id, "Agent paused");
    expect(await runRow(run.id)).toMatchObject({ status: "cancelled", errorCode: "cancelled" });
    release();
    await heartbeat.drainActiveRunExecutions();
    const after = await runRow(run.id);
    expect(after).toMatchObject({ status: "cancelled", errorCode: "cancelled" });
    expect(after.resultJson).toMatchObject({ stopReason: "paused" });
    expect(after.resultJson).not.toHaveProperty("presentationDecision");
    expect(await roleComments(f)).toEqual([]);
  }, 180_000);
});
