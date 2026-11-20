import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { and, asc, eq, inArray, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  activityLog,
  agentTaskSessions,
  agentWakeupRequests,
  agents,
  authUsers,
  companies,
  companyMemberships,
  createDb,
  heartbeatRunEvents,
  heartbeatRuns,
  issueComments,
  issueRecoveryActions,
  issueThreadInteractions,
  issues,
} from "@paperclipai/db";
import { registerServerAdapter, unregisterServerAdapter } from "../adapters/index.js";
import { resolvePaperclipInstanceRoot } from "../home-paths.js";
import { logActivity } from "../services/activity-log.js";
import { heartbeatService } from "../services/heartbeat.js";
import {
  RELAUNCH_LOOP_FAILURE_THRESHOLD,
  RELAUNCH_LOOP_FRESH_SESSION_ACTIVITY_ACTION,
  RELAUNCH_LOOP_GUARD_CONTEXT_KEY,
  RELAUNCH_LOOP_PASSING_FAILURE_CODES,
  RELAUNCH_LOOP_SHORT_RUN_MS,
  RELAUNCH_LOOP_TIMEOUT_ERROR_CODES,
  ROUTER_PRE_LAUNCH_FAILURE_CODES,
  ROUTER_PRE_RESERVATION_REFUSAL_CODES,
  RUN_LOG_HOST_LINE_PREFIXES,
  applyRelaunchLoopGuard,
  classifyRelaunchLoopRun,
  evaluateRelaunchLoop,
  evaluateRelaunchLoopHandover,
  handOverAfterFreshSessionFailure,
  isEngineOutputChunk,
  lastEngineOutputAtInLogPage,
  readRelaunchLoopDecision,
  relaunchLoopHandoverNote,
  RELAUNCH_LOOP_HANDOVER_CAUSE,
  type RelaunchLoopRunLogReader,
  type RelaunchLoopRunSample,
} from "../services/heartbeat/relaunch-loop-guard.js";
import { ISSUE_PROGRESS_ACTIVITY_ACTIONS } from "../services/issue-rewake-throttle.js";
import { issueService } from "../services/issues.js";
import { getRunLogStore } from "../services/run-log-store.js";
import { recoveryPostgresSupport, startRecoveryPostgres } from "./helpers/recovery-postgres.js";

const describePostgres = recoveryPostgresSupport.supported ? describe : describe.skip;
if (!recoveryPostgresSupport.supported) console.warn(`Skipping relaunch loop guard tests: ${recoveryPostgresSupport.reason}`);

// The two codes of TR-2069 (20 Nov 2026), in the order production saw them.
const OUTPUT_LIMIT = "router_interactive_output_limit";
const ACK_UNCERTAIN = "router_interactive_ack_uncertain";
const WAIT = "router_waiting_for_resources";
// What a run log holds. The engine's lines are its own events; the others are written by the host.
const ENGINE_LINE = "{\"type\":\"item.completed\",\"item\":{\"type\":\"command_execution\"}}\n";
const ROUTER_LINE = "[paperclip-router] waiting for a cost estimate (still waiting)\n";
const HOST_LINE = "[paperclip] Restoring workspace changes from the remote target.\n";
const NARRATION = "Let me run the build again and read what it prints.";
const CODEX_ANNOUNCEMENT ="{\"type\":\"thread.started\",\"thread_id\":\"019a-session\"}\n";

const at = (minutesAgo: number) => new Date(Date.UTC(2026, 10, 20, 6, 45) - minutesAgo * 60_000);
function sample(minutesAgo: number, patch: Partial<RelaunchLoopRunSample> = {}): RelaunchLoopRunSample {
  return {
    id: randomUUID(), status: "failed", errorCode: ACK_UNCERTAIN, startedAt: at(minutesAgo),
    finishedAt: new Date(at(minutesAgo).getTime() + 60_000), sessionIdBefore: "s1", engineNeverStarted: false, engineWorked: false, ...patch,
  };
}
const decide = (runs: RelaunchLoopRunSample[], produced: string[] = []) =>
  evaluateRelaunchLoop({ runs, runIdsThatProducedSomething: new Set(produced) });

describe("relaunch loop guard: the decision", () => {
  it("counts three empty failures on one session, whatever their codes, and names the session", () => {
    const runs = [sample(1, { errorCode: "adapter_failed" }), sample(5), sample(9, { errorCode: OUTPUT_LIMIT })];
    const decision = decide(runs);
    expect(decision).toMatchObject({ action: "fresh_session", sessionId: "s1" });
    // The series is given oldest first.
    expect(decision.action === "fresh_session" && decision.failedRuns.map((run) => run.id)).toEqual([runs[2]!.id, runs[1]!.id, runs[0]!.id]);
    expect(RELAUNCH_LOOP_FAILURE_THRESHOLD).toBe(3);
    expect(RELAUNCH_LOOP_SHORT_RUN_MS).toBe(5 * 60_000);
  });

  it("does nothing below three", () => {
    expect(decide([sample(1), sample(5)])).toEqual({ action: "none", streak: 2 });
    expect(decide([])).toEqual({ action: "none", streak: 0 });
  });

  it.each([
    ["a declared wait", { errorCode: WAIT }],
    ["a stop wait", { errorCode: "router_previous_dispatch_unsettled" }],
    ["a refusal before any reservation", { errorCode: "router_group_participant_reserved" }],
    ["a later refusal code of the router", { errorCode: "router_reservation_unavailable" }],
    ...ROUTER_PRE_LAUNCH_FAILURE_CODES.map((errorCode): [string, Partial<RelaunchLoopRunSample>] =>
      [`the router's failure before any launch \`${errorCode}\``, { errorCode }]),
    // The same, after the ten minutes the router may wait before it gives up.
    ...ROUTER_PRE_LAUNCH_FAILURE_CODES.map((errorCode): [string, Partial<RelaunchLoopRunSample>] =>
      [`\`${errorCode}\` after ten minutes`, { errorCode, finishedAt: new Date(at(3).getTime() + 10 * 60_000) }]),
    ["a cancellation", { status: "cancelled", errorCode: "agent_paused" }],
    ["an interrupted run", { status: "interrupted", errorCode: null }],
    ["a run that never started", { status: "cancelled", errorCode: "issue_waiting_for_response", startedAt: null, finishedAt: null }],
    ["a run that failed in setup before its adapter was admitted", { errorCode: "setup_failed", engineNeverStarted: true }],
  ] as Array<[string, Partial<RelaunchLoopRunSample>]>)("neither counts nor ends the series on %s", (_name, patch) => {
    expect(classifyRelaunchLoopRun(sample(3, patch), false)).toBe("skipped");
    expect(decide([sample(1), sample(3, patch), sample(5), sample(9)]).action).toBe("fresh_session");
    // Three of them alone are no series at all.
    expect(decide([sample(1, patch), sample(3, patch), sample(5, patch)])).toEqual({ action: "none", streak: 0 });
  });

  it("lists the router's refusals before reservation", () => {
    expect(ROUTER_PRE_RESERVATION_REFUSAL_CODES).toEqual([
      "router_group_participant_ended", "router_group_participant_closed", "router_group_participant_mismatch",
      "router_group_participant_reserved", "router_request_block_invalid", "router_request_system_unknown",
      "router_attempt_already_used", "router_ticket_already_completed", "router_reservation_released",
      "router_reservation_unavailable", "router_stale_reservation_wake", "router_ticket_not_assigned_to_agent",
    ]);
  });

  it("lists every failure the router returns before it launches an engine, by its own list or as a declared wait", () => {
    expect(ROUTER_PRE_LAUNCH_FAILURE_CODES).toEqual([
      "router_estimate_not_received", "router_control_scope_busy", "router_secret_read_limited",
      "router_worker_unreachable", "router_continuation_deadline_expired",
    ]);
    // The router's list of 20 Nov 2026: seven codes. None of them is ever counted, short or long.
    for (const errorCode of [...ROUTER_PRE_LAUNCH_FAILURE_CODES, WAIT, "router_previous_dispatch_unsettled"]) {
      expect(classifyRelaunchLoopRun(sample(3, { errorCode }), false)).toBe("skipped");
      expect(classifyRelaunchLoopRun(sample(30, { errorCode, finishedAt: new Date(at(30).getTime() + 10 * 60_000) }), false)).toBe("skipped");
    }
    // The codes of a launched engine are not in it: the loop's own code, and the turn that ran out of time.
    expect(ROUTER_PRE_LAUNCH_FAILURE_CODES).not.toContain(ACK_UNCERTAIN);
    expect(ROUTER_PRE_LAUNCH_FAILURE_CODES).not.toContain("router_interactive_timeout");
    expect(classifyRelaunchLoopRun(sample(3, { errorCode: ACK_UNCERTAIN }), false)).toBe("empty_failure");
  });

  it("tells the engine's output from the lines the host writes into the run log", () => {
    expect(RUN_LOG_HOST_LINE_PREFIXES).toEqual(["[paperclip-router] ", "[paperclip] "]);
    expect(isEngineOutputChunk(ROUTER_LINE)).toBe(false);
    expect(isEngineOutputChunk(HOST_LINE)).toBe(false);
    expect(isEngineOutputChunk(`${ROUTER_LINE}${ROUTER_LINE}\n  ${HOST_LINE}`)).toBe(false);
    expect(isEngineOutputChunk("")).toBe(false);
    expect(isEngineOutputChunk(" \r\n\n")).toBe(false);
    expect(isEngineOutputChunk(ENGINE_LINE)).toBe(true);
    // One chunk that holds both is the engine's.
    expect(isEngineOutputChunk(`${ROUTER_LINE}${ENGINE_LINE}`)).toBe(true);
    // An engine that quotes the router is still the engine.
    expect(isEngineOutputChunk("{\"type\":\"item.completed\",\"item\":{\"text\":\"[paperclip-router] waiting\"}}\n")).toBe(true);
    // Another bracketed word is not the host's prefix.
    expect(isEngineOutputChunk("[paperclip-routerX] something\n")).toBe(true);
    expect(isEngineOutputChunk("[paperclip-router]\n")).toBe(true);
    // The line by which an engine announces its session is not work: Codex's, written by the router when the
    // session opens (possibly minutes into a run that waited before its launch), and Claude's.
    expect(isEngineOutputChunk(CODEX_ANNOUNCEMENT)).toBe(false);
    expect(isEngineOutputChunk("{\"type\":\"system\",\"subtype\":\"init\",\"session_id\":\"c1\"}\n")).toBe(false);
    expect(isEngineOutputChunk(`${ROUTER_LINE}  ${CODEX_ANNOUNCEMENT}`)).toBe(false);
    expect(isEngineOutputChunk(`${CODEX_ANNOUNCEMENT}${ENGINE_LINE}`)).toBe(true);
    // Any other event of the engine is work, as is a line that only looks like the announcement.
    expect(isEngineOutputChunk("{\"type\":\"system\",\"subtype\":\"status\"}\n")).toBe(true);
    expect(isEngineOutputChunk("{\"type\":\"turn.started\"}\n")).toBe(true);
    expect(isEngineOutputChunk("{\"type\":\"thread.started\"\n")).toBe(true);
    expect(isEngineOutputChunk("thread.started\n")).toBe(true);
  });

  it("reads the time of the last engine output of a log page, past the host's later lines", () => {
    const record = (minute: number, stream: string, chunk: string) => JSON.stringify({ ts: at(60 - minute).toISOString(), stream, chunk, seq: minute });
    const page = (...records: string[]) => `${records.join("\n")}\n`;
    expect(lastEngineOutputAtInLogPage(page(
      record(0, "stdout", ROUTER_LINE), record(1, "stdout", ENGINE_LINE), record(2, "stdout", ENGINE_LINE),
      record(3, "stdout", ROUTER_LINE), record(4, "stderr", HOST_LINE), record(5, "system", "run settled"),
    ))).toEqual(at(58));
    // The engine's stderr is its output too.
    expect(lastEngineOutputAtInLogPage(page(record(1, "stdout", ENGINE_LINE), record(7, "stderr", "warning: slow link\n")))).toEqual(at(53));
    // Nothing of the engine: no time.
    expect(lastEngineOutputAtInLogPage(page(record(0, "stdout", ROUTER_LINE), record(9, "stdout", ROUTER_LINE), record(10, "stderr", HOST_LINE)))).toBeNull();
    expect(lastEngineOutputAtInLogPage("")).toBeNull();
    // A cut or foreign line is passed over, as is a record without a readable time.
    expect(lastEngineOutputAtInLogPage(`{"ts":"2026-11-20T06:0\n${record(2, "stdout", ENGINE_LINE)}\nnot json\n${JSON.stringify({ ts: "never", stream: "stdout", chunk: ENGINE_LINE })}\n`))
      .toEqual(at(58));
  });

  it.each([
    ["a success", { status: "succeeded", errorCode: null }],
    ["a failure of five minutes or more", { finishedAt: new Date(at(3).getTime() + RELAUNCH_LOOP_SHORT_RUN_MS) }],
    ["a failure on another session", { sessionIdBefore: "s2" }],
    ["a failure on a fresh session", { sessionIdBefore: null }],
    ["a run still running", { status: "running", errorCode: null, finishedAt: null }],
  ] as Array<[string, Partial<RelaunchLoopRunSample>]>)("ends the series on %s", (_name, patch) => {
    expect(decide([sample(1), sample(2), sample(3, patch), sample(5), sample(9)])).toEqual({ action: "none", streak: 2 });
  });

  it("ends the series on a failure that left something behind", () => {
    const productive = sample(3);
    expect(decide([sample(1), sample(2), productive, sample(5)], [productive.id])).toEqual({ action: "none", streak: 2 });
    expect(decide([sample(1), sample(2), productive, sample(5)]).action).toBe("fresh_session");
  });

  it.each([
    ["the run's own status", { status: "timed_out", errorCode: "timeout" }],
    ["the status alone", { status: "timed_out", errorCode: null }],
    ["the adapter's code on a failed run", { status: "failed", errorCode: "timeout" }],
    ["the worker router's code", { status: "failed", errorCode: "router_interactive_timeout" }],
  ] as Array<[string, Partial<RelaunchLoopRunSample>]>)("counts a run that ended on a timeout whatever it lasted (%s)", (_name, patch) => {
    const twentyMinutes = (minutesAgo: number) => sample(minutesAgo, { ...patch, finishedAt: new Date(at(minutesAgo).getTime() + 20 * 60_000) });
    expect(classifyRelaunchLoopRun(twentyMinutes(30), false)).toBe("empty_failure");
    expect(decide([twentyMinutes(30), twentyMinutes(60), twentyMinutes(90)]).action).toBe("fresh_session");
    // Its other conditions hold: something left behind, or another session, still ends the series.
    const productive = twentyMinutes(60);
    expect(decide([twentyMinutes(30), productive, twentyMinutes(90), twentyMinutes(120)], [productive.id]).action).toBe("none");
    expect(decide([twentyMinutes(30), sample(60, { ...patch, sessionIdBefore: "s2" }), twentyMinutes(90), twentyMinutes(120)]).action).toBe("none");
    expect(RELAUNCH_LOOP_TIMEOUT_ERROR_CODES).toEqual(["timeout", "router_interactive_timeout"]);
    // A timeout during which the engine worked is a long run like another: it ends the series.
    const worked = sample(60, { ...patch, engineWorked: true, finishedAt: new Date(at(60).getTime() + 20 * 60_000) });
    expect(classifyRelaunchLoopRun(worked, false)).toBe("other");
    expect(decide([twentyMinutes(30), worked, twentyMinutes(90), twentyMinutes(120)]).action).toBe("none");
  });

  it("the engine's own work is read only for a long run that ended on a timeout", () => {
    // A short failure counts whatever the engine wrote before it failed.
    expect(classifyRelaunchLoopRun(sample(3, { engineWorked: true }), false)).toBe("empty_failure");
    expect(classifyRelaunchLoopRun(sample(3, { status: "timed_out", errorCode: "timeout", engineWorked: true }), false)).toBe("empty_failure");
  });

  it("a timed-out run under five minutes counts like a failure", () => {
    expect(decide([sample(1, { status: "timed_out", errorCode: "timeout" }), sample(3), sample(5)]).action).toBe("fresh_session");
  });
});

// Step three: the run on a fresh session failed the same way.
describe("relaunch loop guard: passing failures of the provider or of the host", () => {
  it("by its code, such a failure neither counts nor ends the series", () => {
    expect([...RELAUNCH_LOOP_PASSING_FAILURE_CODES]).toEqual(["provider_quota", "codex_transient_upstream", "claude_transient_upstream", "process_lost"]);
    for (const code of RELAUNCH_LOOP_PASSING_FAILURE_CODES) {
      expect(classifyRelaunchLoopRun(sample(1, { errorCode: code }), false)).toBe("skipped");
      // Three of them in a row, during an outage: the session is kept.
      expect(decide([sample(1, { errorCode: code }), sample(2, { errorCode: code }), sample(3, { errorCode: code })])).toMatchObject({ action: "none" });
      // Among the failures of a series it changes nothing: one before it, two after, three in all.
      expect(decide([sample(1), sample(2, { errorCode: code }), sample(3), sample(4)])).toMatchObject({ action: "fresh_session", sessionId: "s1" });
    }
    // The code of TR-2069 is counted, whatever family the worker router declares for it.
    expect(classifyRelaunchLoopRun(sample(1, { errorCode: ACK_UNCERTAIN }), false)).toBe("empty_failure");
  });
});

describe("relaunch loop guard: the hand-over decision", () => {
  const hand = (runs: RelaunchLoopRunSample[], produced: string[] = []) =>
    evaluateRelaunchLoopHandover({ runs, runIdsThatProducedSomething: new Set(produced) });
  const freshRun = (minutesAgo: number, patch: Partial<RelaunchLoopRunSample> = {}) =>
    sample(minutesAgo, { sessionIdBefore: null, guardFailedRunCount: 3, ...patch });

  it("hands over when the newest run is the one the guard started fresh and it is an empty failure too", () => {
    const fresh = freshRun(1);
    expect(hand([fresh, sample(5), sample(9), sample(13)])).toEqual({ handover: true, freshRun: fresh });
    // A timeout of the fresh run counts as for the series: only when its engine did nothing.
    const hung = freshRun(21, { status: "timed_out", errorCode: "timeout", finishedAt: at(1) });
    expect(hand([hung, sample(25)])).toMatchObject({ handover: true });
    expect(hand([{ ...hung, engineWorked: true }, sample(25)])).toEqual({ handover: false });
  });

  it("does not hand over a fresh run that worked: a success, a failure that left something, a long failure", () => {
    expect(hand([freshRun(1, { status: "succeeded", errorCode: null })])).toEqual({ handover: false });
    const produced = freshRun(1);
    expect(hand([produced], [produced.id])).toEqual({ handover: false });
    expect(hand([freshRun(10, { finishedAt: at(2) })])).toEqual({ handover: false });
  });

  it("passes over runs that say nothing about the session, and stops at any other run of the role", () => {
    const fresh = freshRun(9);
    // A wait, a refusal before any reservation and a cancelled retry after the fresh run: still to hand.
    expect(hand([
      sample(1, { status: "cancelled", errorCode: "issue_waiting_for_response" }),
      sample(3, { errorCode: "router_group_participant_ended" }),
      sample(5, { errorCode: WAIT }),
      fresh,
    ])).toEqual({ handover: true, freshRun: fresh });
    // The role ran again since (the manager gave the issue back): the fresh run is no longer the newest.
    expect(hand([sample(1, { sessionIdBefore: "s2" }), fresh])).toEqual({ handover: false });
    // A failure the guard did not start fresh is never handed by itself.
    expect(hand([sample(1, { sessionIdBefore: null }), sample(5), sample(9), sample(13)])).toEqual({ handover: false });
    expect(hand([])).toEqual({ handover: false });
  });

  it("a hand-over that was held stays due while the role only failed empty again; a run that did something ends it", () => {
    const fresh = freshRun(9);
    const again = sample(1, { sessionIdBefore: "s2" });
    const held = (runs: RelaunchLoopRunSample[], produced: string[] = []) =>
      evaluateRelaunchLoopHandover({ runs, runIdsThatProducedSomething: new Set(produced), heldBefore: true });
    // Not held before: the role ran again, the matter is closed.
    expect(hand([again, fresh])).toEqual({ handover: false });
    expect(held([again, sample(5, { sessionIdBefore: "s2" }), fresh])).toEqual({ handover: true, freshRun: fresh });
    expect(held([again, fresh], [again.id])).toEqual({ handover: false });
    expect(held([sample(1, { status: "succeeded", errorCode: null }), fresh])).toEqual({ handover: false });
    // A fresh run that failed on the provider's quota says nothing about the session: nothing is handed for it.
    expect(hand([freshRun(1, { errorCode: "provider_quota" }), sample(5), sample(9), sample(13)])).toEqual({ handover: false });
  });

  it("says in the note who failed, how many times, under which code, and what the manager may do", () => {
    const note = relaunchLoopHandoverNote({ agentName: "Dev Unity", failedRunCount: 3, code: ACK_UNCERTAIN });
    expect(note.title).toBe("Relaunch guard: handed to the manager");
    expect(note.body).toBe(
      "Dev Unity failed 3 times in a row on this issue while resuming the same engine session, then failed again on a fresh session "
      + "(`router_interactive_ack_uncertain`), each time without leaving anything behind. "
      + "The session was not the cause, so Dev Unity is no longer relaunched on this issue. "
      + "Handed to {manager} for review: read the failed runs, then give the issue back to Dev Unity, reassign it, or close it.");
    expect(relaunchLoopHandoverNote({ agentName: "Dev Unity", failedRunCount: 4, code: null }).body).toContain("failed 4 times in a row");
    expect(relaunchLoopHandoverNote({ agentName: "Dev Unity", failedRunCount: 4, code: null }).body).toContain("(`no code`)");
  });
});

describePostgres("relaunch loop guard on the real run path (TR-2069)", () => {
  let temporary: Awaited<ReturnType<typeof startRecoveryPostgres>>;
  let db: ReturnType<typeof createDb>;
  let heartbeat: ReturnType<typeof heartbeatService>;
  // A conversation adapter, as every role of the studio: its failed runs are continued by a retry, not held for reconciliation.
  const adapterType = "codex_local";
  const oldHome = process.env.PAPERCLIP_HOME;
  let home: string;

  type Step =
    | { kind: "fail"; code: string; during?: (runId: string) => Promise<void>; session?: string; clearSession?: boolean; comment?: boolean; document?: boolean; productionActivity?: boolean; timedOut?: boolean;
        /** What the engine did before its timeout, as the server records it. */
        engine?: "output_tokens" | "summary" | "narration" | "output" | "router_lines" | "host_lines" | "router_around_output" | "announcement_after_a_wait" }
    | { kind: "ok"; session: string }
    | { kind: "throw" };
  // What each engine launch was asked to resume, in order, per issue.
  type Launch = { runId: string; agentId: string; resumed: string | null; resumedParams: Record<string, unknown> | null };
  const scripts = new Map<string, Step[]>();
  const launches = new Map<string, Launch[]>();
  // The run of another agent on a ticket (the CTO, after the worker router's card) ends at once with nothing done,
  // in the cases that say so; elsewhere it waits on the router, as an unscripted launch does.
  let othersFailAtOnce = false;

  beforeAll(async () => {
    temporary = await startRecoveryPostgres("relaunch-loop-guard-");
    db = createDb(temporary.connectionString);
    home = await mkdtemp(path.join(tmpdir(), "paperclip-relaunch-guard-"));
    process.env.PAPERCLIP_HOME = home;
    heartbeat = heartbeatService(db);
    registerServerAdapter({
      type: adapterType, supportsLocalAgentJwt: false,
      execute: async (input) => {
        const issueId = String(input.context.issueId);
        const list = launches.get(issueId) ?? [];
        list.push({ runId: input.runId, agentId: input.agent.id, resumed: input.runtime.sessionId, resumedParams: input.runtime.sessionParams });
        launches.set(issueId, list);
        const ofTheRole = input.agent.name === "Dev Unity";
        if (!ofTheRole && othersFailAtOnce) {
          return { exitCode: 1, signal: null, timedOut: false, errorCode: "adapter_failed", errorMessage: "engine failed (adapter_failed)" };
        }
        // Unscripted launches wait on the router: such a run is outside every series. The script is the role's.
        const step: Step = (ofTheRole ? scripts.get(issueId)?.shift() : undefined) ?? { kind: "fail", code: WAIT };
        // An error of the run itself, as a crash of the adapter: the server fails the run by its error branch.
        if (step.kind === "throw") throw new Error("the adapter failed before any answer of the engine");
        if (step.kind === "ok") {
          await issueService(db).addComment(issueId, "Work done in this run.", { agentId: input.agent.id, runId: input.runId });
          return {
            exitCode: 0, signal: null, timedOut: false, resultJson: {},
            sessionId: step.session, sessionDisplayId: step.session, sessionParams: { sessionId: step.session },
          };
        }
        if (step.comment) await issueService(db).addComment(issueId, "Partial result before the failure.", { agentId: input.agent.id, runId: input.runId });
        if (step.during) await step.during(input.runId);
        // The four entries production recorded under each failed run of TR-2069: none is the role's work.
        if (step.productionActivity) {
          for (const [action, actorType] of [["environment.lease_acquired", "agent"], ["environment.lease_released", "agent"],
            ["tool_gateway.discovery", "agent"], ["cost.reported", "system"]] as const) {
            await logActivity(db, {
              companyId: input.agent.companyId, actorType, actorId: actorType === "agent" ? input.agent.id : "cost", agentId: input.agent.id,
              runId: input.runId, action, entityType: "issue", entityId: issueId, details: {},
            });
          }
        }
        if (step.document) {
          await logActivity(db, {
            companyId: input.agent.companyId, actorType: "agent", actorId: input.agent.id, agentId: input.agent.id, runId: input.runId,
            action: "issue.document_upserted", entityType: "issue", entityId: issueId, details: { key: "notes" },
          });
        }
        // What reaches the run log during the run, each line through its own log call, as the adapters and the
        // worker router write them.
        const logged: Array<["stdout" | "stderr", string]> =
          step.engine === "output" ? [["stdout", ENGINE_LINE]]
            : step.engine === "router_lines" ? [["stdout", ROUTER_LINE], ["stdout", ROUTER_LINE], ["stderr", ROUTER_LINE]]
            : step.engine === "host_lines" ? [["stdout", HOST_LINE], ["stderr", HOST_LINE]]
            : step.engine === "announcement_after_a_wait" ? [["stdout", ROUTER_LINE], ["stdout", ROUTER_LINE], ["stdout", CODEX_ANNOUNCEMENT], ["stdout", ROUTER_LINE]]
            : step.engine === "router_around_output" ? [["stdout", ROUTER_LINE], ["stdout", ENGINE_LINE], ["stdout", ROUTER_LINE], ["stderr", HOST_LINE]]
            : [];
        for (const [stream, line] of logged) await input.onLog(stream, line);
        // A run that reaches its timeout: the adapter returns the session its engine announced (STUDIO-0080).
        if (step.timedOut) {
          return { exitCode: null, signal: "SIGTERM", timedOut: true, errorCode: "timeout", errorMessage: "Timed out after 1200s",
            ...(step.engine === "output_tokens" ? { usage: { inputTokens: 1200, outputTokens: 5400 }, usageBasis: "per_run" as const } : {}),
            ...(step.engine === "summary" ? { summary: "Built the player and ran the smoke scene." } : {}),
            ...(step.engine === "narration" ? { summary: NARRATION } : {}),
            ...(step.session ? { sessionId: step.session, sessionDisplayId: step.session, sessionParams: { sessionId: step.session } } : {}) };
        }
        return {
          exitCode: 1, signal: null, timedOut: false, errorCode: step.code, errorMessage: `engine failed (${step.code})`,
          ...(step.clearSession ? { clearSession: true } : {}),
          ...(step.session ? { sessionId: step.session, sessionDisplayId: step.session, sessionParams: { sessionId: step.session } } : {}),
        };
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
    othersFailAtOnce = false;
    const companyId = randomUUID(), devId = randomUUID(), ctoId = randomUUID(), issueId = randomUUID();
    const userId = `guard-user-${companyId}`;
    await db.insert(authUsers).values({ id: userId, name: "Board user", email: `${userId}@example.test`, createdAt: new Date(), updatedAt: new Date() });
    await db.insert(companies).values({ id: companyId, name: "Relaunch guard fixture", issuePrefix: `G${companyId.slice(0, 6)}` });
    await db.insert(companyMemberships).values({ companyId, principalId: userId, principalType: "user", status: "active", membershipRole: "member" });
    await db.insert(agents).values({ id: ctoId, companyId, name: "CTO", role: "cto", adapterType, status: "idle", adapterConfig: {} });
    await db.insert(agents).values({ id: devId, companyId, name: "Dev Unity", adapterType, status: "idle", adapterConfig: {}, reportsTo: ctoId });
    await db.insert(issues).values({
      id: issueId, companyId, title: "Routed task", status: "in_progress", assigneeAgentId: devId,
      responsibleUserId: userId, issueNumber: 1, startedAt: new Date(),
    });
    // As on TR-2069: the worker router's card for an interrupted run, addressed to the manager, is pending
    // on the ticket; each next run of the role comes from the manager's answer.
    await db.insert(issueThreadInteractions).values({
      companyId, issueId, status: "pending", kind: "request_confirmation", continuationPolicy: "none", addresseeAgentId: ctoId,
      idempotencyKey: `interruption/${randomUUID()}/${randomUUID()}`,
      payload: { version: 1, prompt: "The executor was interrupted. Keep the current reservation while resuming on the same worker?" },
    } as never);
    scripts.set(issueId, []);
    return { companyId, devId, ctoId, issueId };
  }

  const devRuns = (f: Fixture) => db.select().from(heartbeatRuns)
    .where(and(eq(heartbeatRuns.companyId, f.companyId), eq(heartbeatRuns.agentId, f.devId)))
    .orderBy(asc(heartbeatRuns.createdAt));
  const guardNotes = async (f: Fixture) => (await db.select().from(issueComments).where(eq(issueComments.issueId, f.issueId)))
    .filter((row) => row.authorType === "system" && row.body.includes("That session is dropped"));
  const keptSessions = (f: Fixture) => db.select().from(agentTaskSessions)
    .where(and(eq(agentTaskSessions.companyId, f.companyId), eq(agentTaskSessions.agentId, f.devId)));
  const devLaunches = (f: Fixture) => (launches.get(f.issueId) ?? []).filter((launch) => launch.agentId === f.devId);

  // One turn of the production cycle: the CTO's run on the ticket, its comment, and the Dev's run that
  // the comment wakes (`issue_commented`, asked by an agent). Returns the Dev's finished run.
  // A run waiting in the queue on the ticket, as the server writes it: the wake of another agent by a comment (the
  // worker router's card wakes the CTO: a comment wake is the one the queue starts for an agent that is not the
  // assignee), or the role's own retry of a failed run once its delay has passed.
  async function queueARun(f: Fixture, agentId: string, retryOfRunId: string | null = null) {
    const now = new Date();
    const comment = retryOfRunId ? null : (await db.insert(issueComments).values({
      companyId: f.companyId, issueId: f.issueId, authorType: "system", body: "The executor was interrupted. Keep the current reservation?",
    }).returning())[0]!;
    const reason = retryOfRunId ? "transient_failure_retry" : "issue_commented";
    const context = retryOfRunId
      ? { retryReason: "transient_failure", retryOfRunId }
      : { commentId: comment!.id, wakeCommentId: comment!.id };
    const [request] = await db.insert(agentWakeupRequests).values({
      companyId: f.companyId, agentId, source: "automation", triggerDetail: "system", reason,
      payload: { issueId: f.issueId, ...(retryOfRunId ? { retryOfRunId, retryReason: "transient_failure" } : { commentId: comment!.id }) },
      status: "queued", requestedByActorType: "system",
    }).returning();
    const [queued] = await db.insert(heartbeatRuns).values({
      companyId: f.companyId, agentId, invocationSource: "automation", triggerDetail: "system", status: "queued",
      wakeupRequestId: request!.id, ...(retryOfRunId ? { retryOfRunId } : {}), createdAt: now, updatedAt: now,
      contextSnapshot: { issueId: f.issueId, taskId: f.issueId, wakeReason: reason, ...context },
    }).returning();
    await db.update(agentWakeupRequests).set({ runId: queued!.id }).where(eq(agentWakeupRequests.id, request!.id));
    return queued!;
  }
  // `ctoRunAlive`: as production ran it. The worker router's card wakes the CTO as the role fails: a run of the CTO is
  // in the queue on the ticket when the server decides what to do with the failure. It runs once the role's run is
  // over, and has ended when the CTO answers the next time. `othersHeld`: the case holds another agent's run itself.
  async function turn(f: Fixture, step: Step, opts: { ctoRun?: boolean; ctoRunAlive?: boolean; othersHeld?: boolean; cancelledRetry?: boolean } = {}) {
    if (opts.ctoRunAlive) {
      othersFailAtOnce = true;
      if (step.kind === "fail") {
        const during = step.during;
        step = { ...step, during: async (runId) => { await queueARun(f, f.ctoId); await during?.(runId); } };
      }
    }
    scripts.get(f.issueId)!.push(step);
    if (opts.ctoRun !== false && !opts.ctoRunAlive) {
      const now = new Date();
      await db.insert(heartbeatRuns).values({
        companyId: f.companyId, agentId: f.ctoId, invocationSource: "automation", triggerDetail: "system", status: "succeeded",
        createdAt: now, startedAt: now, finishedAt: now, updatedAt: now, sessionIdBefore: "cto-session",
        contextSnapshot: { issueId: f.issueId, taskId: f.issueId, wakeReason: "issue_commented" },
      });
    }
    const [comment] = await db.insert(issueComments).values({
      companyId: f.companyId, issueId: f.issueId, authorType: "agent", authorAgentId: f.ctoId, body: "Try again, the build is ready.",
    }).returning();
    const before = devLaunches(f).length;
    const run = await heartbeat.wakeup(f.devId, {
      source: "automation", triggerDetail: "system", reason: "issue_commented",
      payload: { issueId: f.issueId, commentId: comment!.id },
      contextSnapshot: { issueId: f.issueId, taskId: f.issueId, wakeReason: "issue_commented", commentId: comment!.id, wakeCommentId: comment!.id },
      requestedByActorType: "agent", requestedByActorId: f.ctoId,
    });
    expect(run).not.toBeNull();
    await heartbeat.drainActiveRunExecutions();
    await expect.poll(async () => (await devRuns(f)).find((row) => row.id === run!.id)?.status, { timeout: 30_000 })
      .toMatch(/^(failed|succeeded|timed_out)$/);
    expect(devLaunches(f).length).toBe(before + 1);
    const finished = (await devRuns(f)).find((row) => row.id === run!.id)!;
    // As production recorded it: the retry scheduled after a failure was cancelled before it started,
    // because the router's card was pending (`issue_waiting_for_response`). It never ran.
    if (finished.status === "failed" && opts.cancelledRetry !== false) {
      const now = new Date();
      await db.insert(heartbeatRuns).values({
        companyId: f.companyId, agentId: f.devId, invocationSource: "automation", triggerDetail: "system", status: "cancelled",
        errorCode: "issue_waiting_for_response", retryOfRunId: finished.id, scheduledRetryReason: "transient_failure", scheduledRetryAttempt: 1,
        createdAt: now, finishedAt: now, updatedAt: now, sessionIdBefore: finished.sessionIdBefore,
        contextSnapshot: { issueId: f.issueId, taskId: f.issueId, wakeReason: "transient_failure_retry", retryReason: "transient_failure" },
      });
    }
    if (opts.ctoRunAlive) {
      // The CTO's run of the card: it starts now that the role's run is over, and ends.
      await heartbeat.resumeQueuedRuns();
      await heartbeat.drainActiveRunExecutions();
    }
    return finished;
  }
  const fail = (code: string, patch: Partial<Extract<Step, { kind: "fail" }>> = {}): Step => ({ kind: "fail", code, ...patch });
  // The first run of the role opens the session `s1` and fails; it resumed nothing, so it is in no series.
  const openSession = (f: Fixture) => turn(f, fail("adapter_failed", { session: "s1" }));
  const resumedOf = (f: Fixture) => devLaunches(f).map((launch) => launch.resumed);

  it("TR-2069: a failure, the CTO's answer, a failure, an answer, a failure; the fourth run starts on a fresh session, with one note", async () => {
    const f = await seed();
    await openSession(f);
    // The router returns the session in its failure, and production recorded four activity entries per run.
    const routerFailure = (code: string) => fail(code, { session: "s1", productionActivity: true });
    const failed = [
      await turn(f, routerFailure(OUTPUT_LIMIT)),
      await turn(f, routerFailure(ACK_UNCERTAIN)),
      await turn(f, routerFailure(ACK_UNCERTAIN)),
    ];
    expect(failed.map((run) => `${run.status}:${run.errorCode}:${run.sessionIdBefore}`)).toEqual([
      `failed:${OUTPUT_LIMIT}:s1`, `failed:${ACK_UNCERTAIN}:s1`, `failed:${ACK_UNCERTAIN}:s1`,
    ]);
    // The exact shape production recorded for the ten failures (20 Nov 2026, c6c6a3e0 and the others): a legacy
    // run left at stage `dispatching`, no `executionRecovery`, the same session before and after, woken by a
    // comment, not a retry; and between two of them a retry cancelled before it started, with no stage.
    for (const run of failed) {
      expect(run).toMatchObject({ runtimeMode: "legacy", executionStage: "dispatching", sessionIdAfter: "s1", retryOfRunId: null, scheduledRetryReason: null });
      expect(run.resultJson).not.toHaveProperty("executionRecovery");
      expect(run.contextSnapshot).toMatchObject({ wakeReason: "issue_commented" });
    }
    const cancelledRetries = (await devRuns(f)).filter((run) => run.status === "cancelled");
    expect(cancelledRetries).toHaveLength(4);
    for (const run of cancelledRetries) {
      expect(run).toMatchObject({ runtimeMode: "legacy", executionStage: null, startedAt: null, errorCode: "issue_waiting_for_response", scheduledRetryReason: "transient_failure" });
    }
    // Production: 79 to 104 seconds each. Ninety seconds here, for every run of the role, so their order holds.
    await db.update(heartbeatRuns).set({ startedAt: sql`${heartbeatRuns.finishedAt} - interval '90 seconds'` })
      .where(and(eq(heartbeatRuns.agentId, f.devId), sql`${heartbeatRuns.startedAt} is not null`));
    for (const action of ["environment.lease_acquired", "environment.lease_released", "tool_gateway.discovery", "cost.reported"]) {
      expect(ISSUE_PROGRESS_ACTIVITY_ACTIONS).not.toContain(action);
    }
    expect(await db.select().from(activityLog).where(and(eq(activityLog.runId, failed[2]!.id), eq(activityLog.entityId, f.issueId))))
      .toHaveLength(4);
    expect(await guardNotes(f)).toHaveLength(0);

    const fresh = await turn(f, { kind: "ok", session: "s2" });
    // The engine was launched five times; the first and the fifth resumed nothing.
    expect(resumedOf(f)).toEqual([null, "s1", "s1", "s1", null]);
    expect(devLaunches(f)[4]!.resumedParams).toBeNull();
    expect(fresh.status).toBe("succeeded");
    expect(fresh.sessionIdBefore).toBeNull();
    expect(fresh.contextSnapshot).toMatchObject({
      forceFreshSession: true,
      [RELAUNCH_LOOP_GUARD_CONTEXT_KEY]: { version: 1, action: "fresh_session", droppedSessionId: "s1", failedRunIds: failed.map((run) => run.id),
        errorCodes: [OUTPUT_LIMIT, ACK_UNCERTAIN, ACK_UNCERTAIN] },
    });
    const notes = await guardNotes(f);
    expect(notes).toHaveLength(1);
    expect(notes[0]!.body).toBe(
      "The last 3 runs of Dev Unity on this issue failed one after the other while resuming the same engine session, "
      + `each in under 5 minutes and without leaving anything behind (\`${OUTPUT_LIMIT}\`, \`${ACK_UNCERTAIN}\`). `
      + "That session is dropped: the next run starts on a fresh session.",
    );
    expect(notes[0]!.metadata).toMatchObject({ sourceRunId: fresh.id });
    const activity = await db.select().from(activityLog)
      .where(and(eq(activityLog.entityId, f.issueId), eq(activityLog.action, RELAUNCH_LOOP_FRESH_SESSION_ACTIVITY_ACTION)));
    expect(activity).toHaveLength(1);
    expect(activity[0]).toMatchObject({ actorType: "system", actorId: "relaunch_loop_guard", agentId: f.devId, runId: fresh.id,
      details: { droppedSessionId: "s1", failedRunIds: failed.map((run) => run.id) } });
    // The session the fresh run opened is the one kept now.
    expect((await keptSessions(f)).map((row) => row.sessionDisplayId)).toEqual(["s2"]);
    // The next run resumes the new session, and the guard says nothing more.
    await turn(f, fail(ACK_UNCERTAIN));
    expect(resumedOf(f)[5]).toBe("s2");
    expect(await guardNotes(f)).toHaveLength(1);
  }, 180_000);

  // The lived case behind STUDIO-0080's review: a session too large to reopen. Every run that resumes it
  // reaches its timeout, so each lasts as long as the timeout itself and none is "short".
  it("three runs in a row that reach their timeout on the same session, twenty minutes each: the fourth starts fresh, with the note", async () => {
    const f = await seed();
    await openSession(f);
    const timedOut = [
      await turn(f, fail("timeout", { timedOut: true, session: "s1" })),
      await turn(f, fail("timeout", { timedOut: true, session: "s1" })),
      await turn(f, fail("timeout", { timedOut: true, session: "s1" })),
    ];
    expect(timedOut.map((run) => `${run.status}:${run.errorCode}:${run.sessionIdBefore}:${run.sessionIdAfter}`))
      .toEqual(["timed_out:timeout:s1:s1", "timed_out:timeout:s1:s1", "timed_out:timeout:s1:s1"]);
    // Twenty minutes each, for every run of the role, so their order holds.
    await db.update(heartbeatRuns).set({ startedAt: sql`${heartbeatRuns.finishedAt} - interval '20 minutes'` })
      .where(and(eq(heartbeatRuns.agentId, f.devId), sql`${heartbeatRuns.startedAt} is not null`));
    expect(await guardNotes(f)).toHaveLength(0);

    const fresh = await turn(f, { kind: "ok", session: "s2" });
    expect(resumedOf(f)).toEqual([null, "s1", "s1", "s1", null]);
    expect(fresh.contextSnapshot).toMatchObject({ forceFreshSession: true,
      [RELAUNCH_LOOP_GUARD_CONTEXT_KEY]: { action: "fresh_session", droppedSessionId: "s1", failedRunIds: timedOut.map((run) => run.id) } });
    const notes = await guardNotes(f);
    expect(notes).toHaveLength(1);
    expect(notes[0]!.body).toBe(
      "The last 3 runs of Dev Unity on this issue failed one after the other while resuming the same engine session, "
      + "each on a timeout and without leaving anything behind (`timeout`). "
      + "That session is dropped: the next run starts on a fresh session.",
    );
  }, 180_000);

  // The other side of the same rule: a role that works through its whole timeout and writes nothing on the issue
  // (it compiles, plays, migrates, pushes to Git, and comments only at the end) must keep its session.
  it.each([
    ["the model's output tokens", "output_tokens"],
    ["a summary returned by the adapter", "summary"],
    // The last message of an engine cut in the middle of its work: the server posts no comment for it, so the
    // summary kept on the run is the only sign.
    ["a last message that is narration and is posted nowhere", "narration"],
    ["output still written after its first five minutes", "output"],
  ] as const)("three timeouts during which the engine worked (%s) and nothing on the issue: no guard, the session is kept", async (_name, engine) => {
    const f = await seed();
    await openSession(f);
    const worked = [
      await turn(f, fail("timeout", { timedOut: true, session: "s1", engine })),
      await turn(f, fail("timeout", { timedOut: true, session: "s1", engine })),
      await turn(f, fail("timeout", { timedOut: true, session: "s1", engine })),
    ];
    expect(worked.map((run) => `${run.status}:${run.sessionIdBefore}`)).toEqual(["timed_out:s1", "timed_out:s1", "timed_out:s1"]);
    if (engine === "output_tokens") expect(worked[2]!.usageJson).toMatchObject({ outputTokens: 5400 });
    if (engine === "summary") expect(worked[2]!.resultJson).toMatchObject({ summary: "Built the player and ran the smoke scene." });
    if (engine === "narration") {
      expect(worked[2]!.resultJson).toMatchObject({ summary: NARRATION });
      const posted = await db.select().from(issueComments).where(eq(issueComments.issueId, f.issueId));
      expect(posted.filter((row) => row.authorAgentId === f.devId)).toHaveLength(0);
    }
    if (engine === "output") expect(worked[2]!.lastOutputAt).not.toBeNull();
    // Twenty minutes each; the output of each run was written near its end.
    await db.update(heartbeatRuns).set({ startedAt: sql`${heartbeatRuns.finishedAt} - interval '20 minutes'` })
      .where(and(eq(heartbeatRuns.agentId, f.devId), sql`${heartbeatRuns.startedAt} is not null`));
    await turn(f, fail(ACK_UNCERTAIN));
    expect(resumedOf(f)).toEqual([null, "s1", "s1", "s1", "s1"]);
    expect(await guardNotes(f)).toHaveLength(0);
  }, 180_000);

  it("an engine that wrote only in its first minute and then nothing until its timeout did nothing: the guard acts", async () => {
    const f = await seed();
    await openSession(f);
    for (let index = 0; index < 3; index += 1) await turn(f, fail("timeout", { timedOut: true, session: "s1", engine: "output" }));
    // Twenty minutes each, and the only output came one minute after the start (the session's announcement).
    await db.update(heartbeatRuns).set({ startedAt: sql`${heartbeatRuns.finishedAt} - interval '20 minutes'` })
      .where(and(eq(heartbeatRuns.agentId, f.devId), sql`${heartbeatRuns.startedAt} is not null`));
    await db.update(heartbeatRuns).set({ lastOutputAt: sql`${heartbeatRuns.startedAt} + interval '1 minute'` })
      .where(and(eq(heartbeatRuns.agentId, f.devId), sql`${heartbeatRuns.lastOutputAt} is not null`));
    await turn(f, { kind: "ok", session: "s2" });
    expect(resumedOf(f)).toEqual([null, "s1", "s1", "s1", null]);
    expect(await guardNotes(f)).toHaveLength(1);
  }, 180_000);

  const twentyMinutesEach = (f: Fixture) => db.update(heartbeatRuns).set({ startedAt: sql`${heartbeatRuns.finishedAt} - interval '20 minutes'` })
    .where(and(eq(heartbeatRuns.agentId, f.devId), sql`${heartbeatRuns.startedAt} is not null`));
  const decisionWith = (f: Fixture, readRunLog?: RelaunchLoopRunLogReader) => readRelaunchLoopDecision(db, {
    companyId: f.companyId, agentId: f.devId, issueId: f.issueId, runId: randomUUID(), readRunLog });

  // The worker router writes its own lines into the run log, one a minute while it waits before a launch, and
  // Paperclip writes its diagnostics there too. A run that received nothing else is a run whose engine did nothing.
  it.each([
    ["the worker router's lines", "router_lines"],
    ["Paperclip's own lines", "host_lines"],
    ["the router's lines and, after its wait, the announcement of the session", "announcement_after_a_wait"],
  ] as const)("three timeouts of twenty minutes during which only the host wrote into the log (%s): the guard acts", async (_name, engine) => {
    const f = await seed();
    await openSession(f);
    const silent = [
      await turn(f, fail("timeout", { timedOut: true, session: "s1", engine })),
      await turn(f, fail("timeout", { timedOut: true, session: "s1", engine })),
      await turn(f, fail("timeout", { timedOut: true, session: "s1", engine })),
    ];
    await twentyMinutesEach(f);
    // The run row says "output was still written late": it does not say whose.
    for (const run of await devRuns(f)) {
      if (!silent.some((row) => row.id === run.id)) continue;
      expect(run.lastOutputAt!.getTime()).toBeGreaterThanOrEqual(run.startedAt!.getTime() + RELAUNCH_LOOP_SHORT_RUN_MS);
      expect(run.logBytes).toBeGreaterThan(0);
    }
    // Without the log, or when it cannot be read, the late chunk is taken as the engine's and the session is kept.
    expect(await decisionWith(f)).toEqual({ action: "none", streak: 0 });
    expect(await decisionWith(f, async () => { throw new Error("log storage unavailable"); })).toEqual({ action: "none", streak: 0 });
    const store = getRunLogStore();
    expect(await decisionWith(f, (handle, opts) => store.read(handle, opts))).toMatchObject({ action: "fresh_session", sessionId: "s1" });

    await turn(f, { kind: "ok", session: "s2" });
    expect(resumedOf(f)).toEqual([null, "s1", "s1", "s1", null]);
    expect(await guardNotes(f)).toHaveLength(1);
  }, 180_000);

  it("the host's lines before and after the engine's output do not hide it: the session is kept", async () => {
    const f = await seed();
    await openSession(f);
    for (let index = 0; index < 3; index += 1) await turn(f, fail("timeout", { timedOut: true, session: "s1", engine: "router_around_output" }));
    await twentyMinutesEach(f);
    await turn(f, fail(ACK_UNCERTAIN));
    expect(resumedOf(f)).toEqual([null, "s1", "s1", "s1", "s1"]);
    expect(await guardNotes(f)).toHaveLength(0);
  }, 180_000);

  it("the log is read from its end, page by page, and only as far as needed", async () => {
    const f = await seed();
    await openSession(f);
    const [newest] = [await turn(f, fail("timeout", { timedOut: true, session: "s1", engine: "router_lines" }))];
    await twentyMinutesEach(f);
    const record = (chunk: string) => `${JSON.stringify({ ts: new Date().toISOString(), stream: "stdout", chunk })}\n`;
    const reads: Array<{ logRef: string; offset: number; limitBytes: number; alignStartToRecord: boolean }> = [];
    const reader = (content: (offset: number) => string): RelaunchLoopRunLogReader => async (handle, opts) => {
      reads.push({ logRef: handle.logRef, ...opts });
      return { content: content(opts.offset) };
    };
    const logRef = (await devRuns(f)).find((run) => run.id === newest!.id)!.logRef!;
    // A log of 300 000 bytes whose last page holds only the router's lines, and the page before it the engine's.
    await db.update(heartbeatRuns).set({ logBytes: 300_000 }).where(eq(heartbeatRuns.id, newest!.id));
    await decisionWith(f, reader((offset) => (offset === 0 ? record(ENGINE_LINE) : record(ROUTER_LINE))));
    expect(reads).toEqual([
      { logRef, offset: 44_000, limitBytes: 256_000, alignStartToRecord: true },
      { logRef, offset: 0, limitBytes: 44_000, alignStartToRecord: true },
    ]);
    // The engine's output is in the last page: one read.
    reads.length = 0;
    await decisionWith(f, reader(() => record(ENGINE_LINE)));
    expect(reads).toHaveLength(1);
    // A log longer than what is read back, with the host's lines only as far as it was read: not known, the session is kept.
    reads.length = 0;
    await db.update(heartbeatRuns).set({ logBytes: 4_000_000 }).where(eq(heartbeatRuns.id, newest!.id));
    await turn(f, fail("timeout", { timedOut: true, session: "s1", engine: "router_lines" }));
    await turn(f, fail("timeout", { timedOut: true, session: "s1", engine: "router_lines" }));
    await twentyMinutesEach(f);
    await db.update(heartbeatRuns).set({ logBytes: 4_000_000 }).where(and(eq(heartbeatRuns.agentId, f.devId), sql`${heartbeatRuns.logRef} is not null`));
    expect(await decisionWith(f, reader(() => record(ROUTER_LINE)))).toEqual({ action: "none", streak: 0 });
    expect(reads.filter((read) => read.logRef === logRef)).toHaveLength(8);
    // The same three runs with their real logs, read whole: three empty timeouts.
    const store = getRunLogStore();
    await db.update(heartbeatRuns).set({ logBytes: 4_000 }).where(and(eq(heartbeatRuns.agentId, f.devId), sql`${heartbeatRuns.logRef} is not null`));
    expect(await decisionWith(f, (handle, opts) => store.read(handle, opts))).toMatchObject({ action: "fresh_session" });
  }, 180_000);

  it("the engine's last output is set against the run's first five minutes, and at most six logs are read", async () => {
    const f = await seed();
    // Eight timeouts of twenty minutes on the session, written as the server writes them, each with a late log chunk.
    for (let index = 0; index < 8; index += 1) {
      const startedAt = new Date(Date.now() - 30 * (index + 1) * 60_000);
      await insertDevRun(f, { status: "timed_out", errorCode: "timeout", createdAt: startedAt, startedAt, finishedAt: new Date(startedAt.getTime() + 20 * 60_000),
        lastOutputAt: new Date(startedAt.getTime() + 19 * 60_000), logStore: "local_file", logRef: `log-${index}`, logBytes: 2_000 });
    }
    const startOf = new Map((await devRuns(f)).map((run) => [run.logRef!, run.startedAt!]));
    const read: string[] = [];
    // The router's line comes nineteen minutes after the start; the engine's, when the case says.
    const engineAt = (minutes: number): RelaunchLoopRunLogReader => async (handle) => {
      read.push(handle.logRef);
      const at = (after: number) => new Date(startOf.get(handle.logRef)!.getTime() + after * 60_000).toISOString();
      return { content: `${JSON.stringify({ ts: at(minutes), stream: "stdout", chunk: ENGINE_LINE })}\n${JSON.stringify({ ts: at(19), stream: "stdout", chunk: ROUTER_LINE })}\n` };
    };
    // The engine wrote one minute after the start and then nothing: it did nothing.
    const silent = await decisionWith(f, engineAt(1));
    expect(silent).toMatchObject({ action: "fresh_session", sessionId: "s1" });
    // Six logs are read, the newest runs first; the seventh run keeps "the engine worked" and ends the series.
    expect(read).toEqual(["log-0", "log-1", "log-2", "log-3", "log-4", "log-5"]);
    expect(silent.action === "fresh_session" && silent.failedRuns).toHaveLength(6);
    expect(await decisionWith(f, engineAt(4))).toMatchObject({ action: "fresh_session" });
    // Five minutes after the start, or later: the engine was at work, and the newest run ends the series.
    expect(await decisionWith(f, engineAt(5))).toEqual({ action: "none", streak: 0 });
    expect(await decisionWith(f, engineAt(12))).toEqual({ action: "none", streak: 0 });
  }, 60_000);

  // The worker router's own shape for a turn that ran out of time (its chat, 20 Nov 2026): a failed run,
  // `timedOut: false`, under `router_interactive_timeout`. Its engine was launched and was at work.
  it("the router's `router_interactive_timeout`, a failed run with timedOut false: the engine's output keeps it out of the series", async () => {
    const f = await seed();
    await openSession(f);
    const turns = [
      await turn(f, fail("router_interactive_timeout", { session: "s1", engine: "router_around_output" })),
      await turn(f, fail("router_interactive_timeout", { session: "s1", engine: "router_around_output" })),
      await turn(f, fail("router_interactive_timeout", { session: "s1", engine: "router_around_output" })),
    ];
    expect(turns.map((run) => `${run.status}:${run.errorCode}:${run.exitCode}:${run.sessionIdAfter}`))
      .toEqual(["failed:router_interactive_timeout:1:s1", "failed:router_interactive_timeout:1:s1", "failed:router_interactive_timeout:1:s1"]);
    await twentyMinutesEach(f);
    await turn(f, fail(ACK_UNCERTAIN));
    expect(resumedOf(f)).toEqual([null, "s1", "s1", "s1", "s1"]);
    expect(await guardNotes(f)).toHaveLength(0);
  }, 180_000);

  // A steered routed run that ends on a timeout carries neither tokens nor a summary, even with STUDIO-0080: the
  // router's own envelope builds its whole result. What the engine wrote live into the run log is its only sign.
  // A trial cannot wait fifteen minutes, so the time of the engine's records is moved in the log file itself,
  // which the guard then reads through the real store; the router's notes keep their time, the end of the run.
  async function engineLastWroteAt(f: Fixture, minutesAfterStart: number) {
    const base = process.env.RUN_LOG_BASE_PATH ?? path.resolve(resolvePaperclipInstanceRoot(), "data", "run-logs");
    let moved = 0;
    for (const run of await devRuns(f)) {
      if (!run.logRef || !run.startedAt) continue;
      const file = path.resolve(base, run.logRef);
      const records = (await readFile(file, "utf8")).split("\n").filter(Boolean).map((line) => JSON.parse(line) as { ts: string; chunk: string });
      for (const record of records) {
        if (!isEngineOutputChunk(record.chunk)) continue;
        record.ts = new Date(run.startedAt.getTime() + minutesAfterStart * 60_000).toISOString();
        moved += 1;
      }
      const content = records.map((record) => `${JSON.stringify(record)}\n`).join("");
      await writeFile(file, content);
      await db.update(heartbeatRuns).set({ logBytes: Buffer.byteLength(content) }).where(eq(heartbeatRuns.id, run.id));
    }
    return moved;
  }

  it.each([
    [15, "is not counted: the session is kept", false],
    [1, "is counted: nothing of the engine after its announcement", true],
  ] as const)("a `router_interactive_timeout` of twenty minutes whose engine last wrote live at minute %i %s", async (minute, _name, counted) => {
    const f = await seed();
    await openSession(f);
    const timedOut = [];
    for (let index = 0; index < 3; index += 1) timedOut.push(await turn(f, fail("router_interactive_timeout", { session: "s1", engine: "router_around_output" })));
    await twentyMinutesEach(f);
    expect(await engineLastWroteAt(f, minute)).toBe(3);
    // The router's envelope: a failed run, no timedOut, no tokens, no summary; the run row says only that
    // something was still written late, which is the router's own note.
    for (const run of (await devRuns(f)).filter((row) => timedOut.some((failed) => failed.id === row.id))) {
      expect(run).toMatchObject({ status: "failed", errorCode: "router_interactive_timeout", exitCode: 1 });
      expect(run.resultJson).not.toHaveProperty("summary");
      expect(Number((run.usageJson as Record<string, unknown> | null)?.outputTokens ?? 0)).toBe(0);
      expect(run.lastOutputAt!.getTime()).toBeGreaterThanOrEqual(run.startedAt!.getTime() + RELAUNCH_LOOP_SHORT_RUN_MS);
    }
    await turn(f, counted ? { kind: "ok", session: "s2" } : fail(ACK_UNCERTAIN));
    expect(resumedOf(f)).toEqual([null, "s1", "s1", "s1", counted ? null : "s1"]);
    expect(await guardNotes(f)).toHaveLength(counted ? 1 : 0);
  }, 180_000);

  it("three `router_interactive_timeout` during which the engine wrote nothing: the guard acts, and the note names the code", async () => {
    const f = await seed();
    await openSession(f);
    for (let index = 0; index < 3; index += 1) await turn(f, fail("router_interactive_timeout", { session: "s1", engine: "router_lines" }));
    await twentyMinutesEach(f);
    await turn(f, { kind: "ok", session: "s2" });
    expect(resumedOf(f)).toEqual([null, "s1", "s1", "s1", null]);
    const notes = await guardNotes(f);
    expect(notes).toHaveLength(1);
    expect(notes[0]!.body).toContain("each on a timeout and without leaving anything behind (`router_interactive_timeout`)");
  }, 180_000);

  // The router's failures before any launch (its chat, 20 Nov 2026) reach the server as failed runs whose adapter
  // was admitted: nothing but their code tells them from a launched engine.
  it.each(ROUTER_PRE_LAUNCH_FAILURE_CODES)("two failures, the router's pre-launch failure `%s`, a failure: the guard still acts", async (code) => {
    const f = await seed();
    await openSession(f);
    await turn(f, fail(ACK_UNCERTAIN));
    await turn(f, fail(ACK_UNCERTAIN));
    const preLaunch = await turn(f, fail(code, { session: "s1", engine: "router_lines" }));
    expect(preLaunch).toMatchObject({ status: "failed", errorCode: code, runtimeMode: "legacy", executionStage: "dispatching" });
    await turn(f, fail(ACK_UNCERTAIN));
    await turn(f, { kind: "ok", session: "s2" });
    expect(resumedOf(f)).toEqual([null, "s1", "s1", "s1", "s1", null]);
    expect(await guardNotes(f)).toHaveLength(1);
  }, 180_000);

  it("three pre-launch failures of the router in a row, ten minutes each, are no series: the session is kept", async () => {
    const f = await seed();
    await openSession(f);
    await turn(f, fail("router_estimate_not_received", { session: "s1", engine: "router_lines" }));
    await turn(f, fail("router_worker_unreachable", { session: "s1" }));
    await turn(f, fail("router_continuation_deadline_expired", { session: "s1" }));
    await db.update(heartbeatRuns).set({ startedAt: sql`${heartbeatRuns.finishedAt} - interval '10 minutes'` })
      .where(and(eq(heartbeatRuns.agentId, f.devId), sql`${heartbeatRuns.startedAt} is not null`));
    await turn(f, fail(ACK_UNCERTAIN));
    expect(resumedOf(f)).toEqual([null, "s1", "s1", "s1", "s1"]);
    expect(await guardNotes(f)).toHaveLength(0);
  }, 180_000);

  it("a twenty-minute failure that is not a timeout still ends the series, among two timeouts", async () => {
    const f = await seed();
    await openSession(f);
    await turn(f, fail("timeout", { timedOut: true, session: "s1" }));
    const long = await turn(f, fail(ACK_UNCERTAIN, { session: "s1" }));
    await turn(f, fail("timeout", { timedOut: true, session: "s1" }));
    await db.update(heartbeatRuns).set({ startedAt: sql`${heartbeatRuns.finishedAt} - interval '20 minutes'` })
      .where(and(eq(heartbeatRuns.agentId, f.devId), sql`${heartbeatRuns.startedAt} is not null`));
    expect(long.status).toBe("failed");
    await turn(f, fail(ACK_UNCERTAIN));
    // The run after the long failure is the only one that counts: no series.
    expect(resumedOf(f)).toEqual([null, "s1", "s1", "s1", "s1"]);
    expect(await guardNotes(f)).toHaveLength(0);
  }, 180_000);

  it("two failures on the session are not a series: the third run still resumes it", async () => {
    const f = await seed();
    await openSession(f);
    await turn(f, fail(ACK_UNCERTAIN));
    await turn(f, fail(ACK_UNCERTAIN));
    const third = await turn(f, fail(ACK_UNCERTAIN));
    expect(resumedOf(f)).toEqual([null, "s1", "s1", "s1"]);
    expect(third.contextSnapshot?.[RELAUNCH_LOOP_GUARD_CONTEXT_KEY]).toBeUndefined();
    expect(await guardNotes(f)).toHaveLength(0);
  }, 180_000);

  it("three failures under three different codes on the same session trigger the guard", async () => {
    const f = await seed();
    await openSession(f);
    await turn(f, fail(OUTPUT_LIMIT));
    await turn(f, fail("adapter_failed"));
    await turn(f, fail(ACK_UNCERTAIN));
    await turn(f, { kind: "ok", session: "s2" });
    expect(resumedOf(f)).toEqual([null, "s1", "s1", "s1", null]);
    expect((await guardNotes(f))[0]!.body).toContain(`(\`${OUTPUT_LIMIT}\`, \`adapter_failed\`, \`${ACK_UNCERTAIN}\`)`);
  }, 180_000);

  it("two failures, a declared wait, a failure: the wait neither counts nor ends the series", async () => {
    const f = await seed();
    await openSession(f);
    await turn(f, fail(ACK_UNCERTAIN));
    await turn(f, fail(ACK_UNCERTAIN));
    const waited = await turn(f, fail(WAIT));
    expect(waited.errorCode).toBe(WAIT);
    // After the wait the series still holds two: the run resumes the session.
    await turn(f, fail(ACK_UNCERTAIN));
    expect(await guardNotes(f)).toHaveLength(0);
    await turn(f, { kind: "ok", session: "s2" });
    expect(resumedOf(f)).toEqual([null, "s1", "s1", "s1", "s1", null]);
    const notes = await guardNotes(f);
    expect(notes).toHaveLength(1);
    expect(notes[0]!.body).toContain("The last 3 runs");
  }, 180_000);

  it("two failures, a passing failure of the provider, a failure: it neither counts nor ends the series", async () => {
    const f = await seed();
    await openSession(f);
    await turn(f, fail(ACK_UNCERTAIN));
    await turn(f, fail(ACK_UNCERTAIN));
    const outage = await turn(f, fail("codex_transient_upstream"));
    expect(outage).toMatchObject({ status: "failed", errorCode: "codex_transient_upstream" });
    // After the outage the series still holds two: the run resumes the session.
    await turn(f, fail(ACK_UNCERTAIN));
    expect(await guardNotes(f)).toHaveLength(0);
    await turn(f, { kind: "ok", session: "s2" });
    expect(resumedOf(f)).toEqual([null, "s1", "s1", "s1", "s1", null]);
    expect(await guardNotes(f)).toHaveLength(1);
  }, 180_000);

  it("two failures, then a run of the same role that leaves a comment: the series starts over", async () => {
    const f = await seed();
    await openSession(f);
    await turn(f, fail(ACK_UNCERTAIN));
    await turn(f, fail(ACK_UNCERTAIN));
    await turn(f, fail(ACK_UNCERTAIN, { comment: true }));
    await turn(f, fail(ACK_UNCERTAIN));
    await turn(f, fail(ACK_UNCERTAIN));
    // Five runs resumed s1; the run after the comment and the next are only two.
    await turn(f, fail(ACK_UNCERTAIN));
    expect(resumedOf(f)).toEqual([null, "s1", "s1", "s1", "s1", "s1", "s1"]);
    expect(await guardNotes(f)).toHaveLength(0);
    // The third empty failure since the comment is the one above: now the guard acts.
    await turn(f, { kind: "ok", session: "s2" });
    expect(resumedOf(f)[7]).toBeNull();
    expect(await guardNotes(f)).toHaveLength(1);
  }, 180_000);

  it("a document written by the role during a failed run counts as something left behind; the server's own entries do not", async () => {
    const f = await seed();
    await openSession(f);
    await turn(f, fail(ACK_UNCERTAIN));
    const productive = await turn(f, fail(ACK_UNCERTAIN, { document: true }));
    // An entry the server writes on its own under the run's id is not the role's work.
    const silent = await turn(f, fail(ACK_UNCERTAIN));
    await logActivity(db, { companyId: f.companyId, actorType: "system", actorId: "recovery", runId: silent.id,
      action: "issue.updated", entityType: "issue", entityId: f.issueId, details: {} });
    await turn(f, fail(ACK_UNCERTAIN));
    expect(resumedOf(f)).toEqual([null, "s1", "s1", "s1", "s1"]);
    expect(await guardNotes(f)).toHaveLength(0);
    expect(productive.status).toBe("failed");
    await turn(f, fail(ACK_UNCERTAIN));
    await turn(f, { kind: "ok", session: "s2" });
    // Three empty failures after the productive one: the seventh launch is fresh.
    expect(resumedOf(f)).toEqual([null, "s1", "s1", "s1", "s1", "s1", null]);
  }, 180_000);

  it("a failure that returns clearSession erases the session at once, and the guard has nothing to do", async () => {
    const f = await seed();
    await openSession(f);
    await turn(f, fail(ACK_UNCERTAIN, { clearSession: true }));
    expect(await keptSessions(f)).toHaveLength(0);
    await turn(f, fail(ACK_UNCERTAIN));
    await turn(f, fail(ACK_UNCERTAIN));
    await turn(f, fail(ACK_UNCERTAIN));
    // Only the second launch resumed s1; every later one started fresh by itself.
    expect(resumedOf(f)).toEqual([null, "s1", null, null, null]);
    expect(await guardNotes(f)).toHaveLength(0);
    expect((await devRuns(f)).some((run) => run.contextSnapshot?.[RELAUNCH_LOOP_GUARD_CONTEXT_KEY])).toBe(false);
  }, 180_000);

  it("a success in the middle ends the series", async () => {
    const f = await seed();
    await openSession(f);
    await turn(f, fail(ACK_UNCERTAIN));
    await turn(f, fail(ACK_UNCERTAIN));
    await turn(f, { kind: "ok", session: "s1" });
    await turn(f, fail(ACK_UNCERTAIN));
    await turn(f, fail(ACK_UNCERTAIN));
    await turn(f, fail(ACK_UNCERTAIN));
    expect(resumedOf(f)).toEqual([null, "s1", "s1", "s1", "s1", "s1", "s1"]);
    expect(await guardNotes(f)).toHaveLength(0);
  }, 180_000);

  it("a failure of five minutes or more is not counted and ends the series", async () => {
    const f = await seed();
    await openSession(f);
    const first = await turn(f, fail(ACK_UNCERTAIN));
    const long = await turn(f, fail(ACK_UNCERTAIN));
    // The second failure lasted six minutes: it and everything before it move back six minutes.
    const earlier = (await devRuns(f)).filter((run) => run.id !== long.id).map((run) => run.id);
    await db.update(heartbeatRuns).set({
      startedAt: sql`${heartbeatRuns.startedAt} - interval '6 minutes'`, finishedAt: sql`${heartbeatRuns.finishedAt} - interval '6 minutes'`,
    }).where(inArray(heartbeatRuns.id, earlier));
    await db.update(heartbeatRuns).set({ startedAt: sql`${heartbeatRuns.startedAt} - interval '6 minutes'` }).where(eq(heartbeatRuns.id, long.id));
    await turn(f, fail(ACK_UNCERTAIN));
    await turn(f, fail(ACK_UNCERTAIN));
    expect(first.status).toBe("failed");
    // Four failures resumed s1, the long one among them: only two stand after it.
    expect(resumedOf(f)).toEqual([null, "s1", "s1", "s1", "s1"]);
    expect(await guardNotes(f)).toHaveLength(0);
  }, 180_000);

  // Rows written as the server writes them, between two real failures.
  async function insertDevRun(f: Fixture, patch: Partial<typeof heartbeatRuns.$inferInsert>) {
    const now = new Date();
    await db.insert(heartbeatRuns).values({
      companyId: f.companyId, agentId: f.devId, invocationSource: "automation", triggerDetail: "system", status: "failed",
      createdAt: now, startedAt: now, finishedAt: now, updatedAt: now, sessionIdBefore: "s1",
      contextSnapshot: { issueId: f.issueId, taskId: f.issueId, wakeReason: "issue_commented" }, ...patch,
    });
  }

  it.each([
    ["a run cancelled by a pause", { status: "cancelled", errorCode: "agent_paused" }],
    ["a refusal before any reservation", { errorCode: "router_group_participant_reserved" }],
    ["a failed lease acquisition (the adapter was never admitted)", { errorCode: "setup_failed", runtimeMode: "legacy", executionStage: "preparing", resultJson: { executionRecovery: { kind: "bootstrap", providerWorkStarted: false } } }],
  ] as Array<[string, Partial<typeof heartbeatRuns.$inferInsert>]>)("two failures, %s, a failure: the guard still acts", async (_name, patch) => {
    const f = await seed();
    await openSession(f);
    await turn(f, fail(ACK_UNCERTAIN));
    await turn(f, fail(ACK_UNCERTAIN));
    await insertDevRun(f, patch);
    await turn(f, fail(ACK_UNCERTAIN));
    await turn(f, { kind: "ok", session: "s2" });
    expect(resumedOf(f)).toEqual([null, "s1", "s1", "s1", null]);
    expect(await guardNotes(f)).toHaveLength(1);
  }, 180_000);

  it("three failed lease acquisitions in a row are no series: the session is kept", async () => {
    const f = await seed();
    await openSession(f);
    for (let index = 0; index < 3; index += 1) {
      await insertDevRun(f, { errorCode: "setup_failed", runtimeMode: "legacy", executionStage: "preparing", resultJson: { executionRecovery: { kind: "bootstrap", providerWorkStarted: false } } });
    }
    await turn(f, fail(ACK_UNCERTAIN));
    expect(resumedOf(f)).toEqual([null, "s1"]);
    expect(await guardNotes(f)).toHaveLength(0);
  }, 180_000);

  it("failures of the role on another issue are not read", async () => {
    const f = await seed();
    await openSession(f);
    const [other] = await db.insert(issues).values({
      companyId: f.companyId, title: "Another task", status: "in_progress", assigneeAgentId: f.devId, issueNumber: 2, startedAt: new Date(),
    }).returning();
    for (let index = 0; index < 2; index += 1) {
      await insertDevRun(f, { errorCode: ACK_UNCERTAIN, contextSnapshot: { issueId: other!.id, taskId: other!.id, wakeReason: "issue_commented" } });
    }
    await turn(f, fail(ACK_UNCERTAIN));
    await turn(f, fail(ACK_UNCERTAIN));
    expect(resumedOf(f)).toEqual([null, "s1", "s1"]);
    expect(await guardNotes(f)).toHaveLength(0);
  }, 180_000);

  it("the fresh run fails too: the dropped session is not resumed again", async () => {
    const f = await seed();
    await openSession(f);
    await turn(f, fail(ACK_UNCERTAIN));
    await turn(f, fail(ACK_UNCERTAIN));
    await turn(f, fail(ACK_UNCERTAIN));
    const fresh = await turn(f, fail(ACK_UNCERTAIN));
    expect(fresh.sessionIdBefore).toBeNull();
    expect(await keptSessions(f)).toHaveLength(0);
    await turn(f, fail(ACK_UNCERTAIN));
    expect(resumedOf(f)).toEqual([null, "s1", "s1", "s1", null, null]);
    expect(await guardNotes(f)).toHaveLength(1);
  }, 180_000);

  it("the fresh run is held by the router, then the next run takes the same decision: still one note", async () => {
    const f = await seed();
    await openSession(f);
    await turn(f, fail(ACK_UNCERTAIN));
    await turn(f, fail(ACK_UNCERTAIN));
    await turn(f, fail(ACK_UNCERTAIN));
    const held = await turn(f, fail(WAIT));
    expect(held.contextSnapshot?.[RELAUNCH_LOOP_GUARD_CONTEXT_KEY]).toMatchObject({ action: "fresh_session" });
    const next = await turn(f, { kind: "ok", session: "s2" });
    expect(next.contextSnapshot?.[RELAUNCH_LOOP_GUARD_CONTEXT_KEY]).toMatchObject({ action: "fresh_session", droppedSessionId: "s1" });
    expect(resumedOf(f)).toEqual([null, "s1", "s1", "s1", null, null]);
    expect(await guardNotes(f)).toHaveLength(1);
  }, 180_000);

  it("an explicit resume of the dropped session is removed with it", async () => {
    const f = await seed();
    await openSession(f);
    await turn(f, fail(ACK_UNCERTAIN));
    await turn(f, fail(ACK_UNCERTAIN));
    await turn(f, fail(ACK_UNCERTAIN));
    const [run] = await db.insert(heartbeatRuns).values({
      companyId: f.companyId, agentId: f.devId, invocationSource: "on_demand", triggerDetail: "manual", status: "running",
      startedAt: new Date(), sessionIdBefore: "s1",
      contextSnapshot: { issueId: f.issueId, taskId: f.issueId, resumeSessionParams: { sessionId: "s1" }, resumeSessionDisplayId: "s1", other: "kept" },
    }).returning();
    const context: Record<string, unknown> = { ...(run!.contextSnapshot as Record<string, unknown>) };
    const cleared: Array<Record<string, unknown> | undefined> = [];
    const decision = await applyRelaunchLoopGuard(db, {
      clearTaskSessions: async (_companyId, _agentId, opts) => { cleared.push(opts); },
    }, { run: run!, agent: { id: f.devId, companyId: f.companyId, name: "Dev Unity", adapterType }, issueId: f.issueId, taskKey: f.issueId, context });
    expect(decision.action).toBe("fresh_session");
    expect(cleared).toEqual([{ taskKey: f.issueId, adapterType }]);
    expect(context).toMatchObject({ forceFreshSession: true, other: "kept" });
    expect(context.resumeSessionParams).toBeUndefined();
    expect(context.resumeSessionDisplayId).toBeUndefined();
    const [stored] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, run!.id));
    expect(stored!.sessionIdBefore).toBeNull();
    expect(stored!.contextSnapshot).toMatchObject({ forceFreshSession: true, other: "kept", [RELAUNCH_LOOP_GUARD_CONTEXT_KEY]: { droppedSessionId: "s1" } });
    expect(stored!.contextSnapshot).not.toHaveProperty("resumeSessionParams");
    expect(stored!.contextSnapshot).not.toHaveProperty("resumeSessionDisplayId");
    await db.update(heartbeatRuns).set({ status: "cancelled", finishedAt: new Date() }).where(eq(heartbeatRuns.id, run!.id));
  }, 180_000);

  it("an error inside the guard is reported and never fails the run", async () => {
    const f = await seed();
    await openSession(f);
    await turn(f, fail(ACK_UNCERTAIN));
    await turn(f, fail(ACK_UNCERTAIN));
    await turn(f, fail(ACK_UNCERTAIN));
    const [run] = await db.insert(heartbeatRuns).values({
      companyId: f.companyId, agentId: f.devId, invocationSource: "on_demand", triggerDetail: "manual", status: "running",
      startedAt: new Date(), sessionIdBefore: "s1", contextSnapshot: { issueId: f.issueId, taskId: f.issueId },
    }).returning();
    const errors: unknown[] = [];
    const context: Record<string, unknown> = { issueId: f.issueId };
    const decision = await applyRelaunchLoopGuard(db, {
      clearTaskSessions: async () => { throw new Error("sessions unavailable"); },
      onError: (error) => errors.push(error),
    }, { run: run!, agent: { id: f.devId, companyId: f.companyId, name: "Dev Unity", adapterType }, issueId: f.issueId, taskKey: f.issueId, context });
    expect(decision).toEqual({ action: "none", streak: 0 });
    expect(errors.map((error) => (error as Error).message)).toEqual(["sessions unavailable"]);
    expect(context.forceFreshSession).toBeUndefined();
    await db.update(heartbeatRuns).set({ status: "cancelled", finishedAt: new Date() }).where(eq(heartbeatRuns.id, run!.id));
  }, 180_000);
  // Step three, on the real path. The session was not the cause: the role fails on a fresh session too.
  const issueRow = async (f: Fixture) => (await db.select().from(issues).where(eq(issues.id, f.issueId)))[0]!;
  const handovers = async (f: Fixture) => (await db.select().from(activityLog)
    .where(and(eq(activityLog.entityId, f.issueId), eq(activityLog.action, "issue.handed_to_manager"))))
    .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
  const handoverNotes = async (f: Fixture) => (await db.select().from(issueComments).where(eq(issueComments.issueId, f.issueId)))
    .filter((row) => row.authorType === "system" && row.body.includes("Handed to CTO for review"));
  const boardActions = (f: Fixture) => db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.sourceIssueId, f.issueId));
  // Three empty failures on the session, then the run on a fresh session, which fails too and returns its session.
  async function failThroughTheFreshSession(f: Fixture, session: string, next: string) {
    for (let index = 0; index < 3; index += 1) await turn(f, fail(ACK_UNCERTAIN, { session }));
    return turn(f, fail(ACK_UNCERTAIN, { session: next }));
  }
  const giveBack = (f: Fixture) => db.update(issues)
    .set({ assigneeAgentId: f.devId, status: "in_progress", updatedAt: new Date() }).where(eq(issues.id, f.issueId));

  it("TR-2069 to its end: the fresh session fails too, and the issue goes to the CTO, with a note and no Board action", async () => {
    const f = await seed();
    await openSession(f);
    const fresh = await failThroughTheFreshSession(f, "s1", "s2");
    expect(resumedOf(f)).toEqual([null, "s1", "s1", "s1", null]);
    expect(fresh).toMatchObject({ status: "failed", errorCode: ACK_UNCERTAIN, sessionIdBefore: null });
    expect(fresh.contextSnapshot).toMatchObject({ [RELAUNCH_LOOP_GUARD_CONTEXT_KEY]: { action: "fresh_session", droppedSessionId: "s1" } });
    await expect.poll(async () => (await issueRow(f)).assigneeAgentId, { timeout: 30_000 }).toBe(f.ctoId);
    expect(await issueRow(f)).toMatchObject({ status: "in_review", assigneeAgentId: f.ctoId });
    expect(await boardActions(f)).toHaveLength(0);
    const [handed] = await handovers(f);
    expect(handed!.details).toMatchObject({
      cause: RELAUNCH_LOOP_HANDOVER_CAUSE, code: ACK_UNCERTAIN, fromAgentId: f.devId, toAgentId: f.ctoId, sourceRunId: fresh.id, handoverInSeries: 1,
    });
    const [note] = await handoverNotes(f);
    expect(note!.body).toBe(relaunchLoopHandoverNote({ agentName: "Dev Unity", failedRunCount: 3, code: ACK_UNCERTAIN }).body.replace("{manager}", "CTO"));
    expect(await guardNotes(f)).toHaveLength(1);
    // The CTO is woken on it; the role is not relaunched: the retry of its failed run does not start.
    await heartbeat.resumeQueuedRuns();
    await heartbeat.drainActiveRunExecutions();
    expect((await db.select().from(agentWakeupRequests)
      .where(and(eq(agentWakeupRequests.agentId, f.ctoId), eq(agentWakeupRequests.reason, "issue_handed_to_manager")))).length).toBeGreaterThanOrEqual(1);
    expect(devLaunches(f)).toHaveLength(5);
    expect(await handovers(f)).toHaveLength(1);
  }, 240_000);

  it("a fresh session that left something behind before it failed is not handed", async () => {
    const f = await seed();
    await openSession(f);
    for (let index = 0; index < 3; index += 1) await turn(f, fail(ACK_UNCERTAIN, { session: "s1" }));
    const fresh = await turn(f, fail(ACK_UNCERTAIN, { session: "s2", comment: true }));
    expect(fresh.contextSnapshot).toMatchObject({ [RELAUNCH_LOOP_GUARD_CONTEXT_KEY]: { action: "fresh_session" } });
    expect(await issueRow(f)).toMatchObject({ status: "in_progress", assigneeAgentId: f.devId });
    expect(await handovers(f)).toHaveLength(0);
    expect(await boardActions(f)).toHaveLength(0);
  }, 240_000);

  it("a role without a manager: the issue is blocked with a Board action, as stranded work is", async () => {
    const f = await seed();
    await db.update(agents).set({ reportsTo: null }).where(eq(agents.id, f.devId));
    await openSession(f);
    await failThroughTheFreshSession(f, "s1", "s2");
    await expect.poll(async () => (await issueRow(f)).status, { timeout: 30_000 }).toBe("blocked");
    expect(await issueRow(f)).toMatchObject({ assigneeAgentId: f.devId });
    expect(await handovers(f)).toHaveLength(0);
    expect(await boardActions(f)).toEqual([expect.objectContaining({ ownerType: "board", status: "active" })]);
    const notes = (await db.select().from(issueComments).where(eq(issueComments.issueId, f.issueId)))
      .filter((row) => row.authorType === "system" && row.body.includes("No manager can receive the issue"));
    expect(notes).toHaveLength(1);
  }, 240_000);

  it("given back by the CTO: the old failure hands nothing again; a new series goes through the fresh session once more; a third is the Board's", async () => {
    const f = await seed();
    await openSession(f);
    await failThroughTheFreshSession(f, "s1", "s2");
    await expect.poll(async () => (await handovers(f)).length, { timeout: 30_000 }).toBe(1);
    // Given back. The role's next run resumes the session of the failed fresh run; one failure hands nothing.
    await giveBack(f);
    await turn(f, fail(ACK_UNCERTAIN, { session: "s2" }));
    expect(await handovers(f)).toHaveLength(1);
    expect(await issueRow(f)).toMatchObject({ status: "in_progress", assigneeAgentId: f.devId });
    // The series starts again on s2: two more failures, a fresh session (the first gesture, once), which fails.
    await turn(f, fail(ACK_UNCERTAIN, { session: "s2" }));
    await turn(f, fail(ACK_UNCERTAIN, { session: "s2" }));
    const fresh = await turn(f, fail(ACK_UNCERTAIN, { session: "s3" }));
    expect(fresh.sessionIdBefore).toBeNull();
    await expect.poll(async () => (await handovers(f)).length, { timeout: 30_000 }).toBe(2);
    expect((await handovers(f))[1]!.details).toMatchObject({ sourceRunId: fresh.id, handoverInSeries: 2 });
    expect((await handoverNotes(f)).filter((note) => note.body.includes("it will not be handed a third time"))).toHaveLength(1);
    expect(await boardActions(f)).toHaveLength(0);
    // Given back again, and the same again: the manager received it twice, the third time is the Board's.
    await giveBack(f);
    await failThroughTheFreshSession(f, "s3", "s4");
    await expect.poll(async () => (await issueRow(f)).status, { timeout: 30_000 }).toBe("blocked");
    expect(await handovers(f)).toHaveLength(2);
    expect(await boardActions(f)).toEqual([expect.objectContaining({ ownerType: "board", status: "active" })]);
  }, 300_000);

  const sourceRunsOf = async (f: Fixture) => (await handovers(f)).map((row) => (row.details as Record<string, unknown>).sourceRunId);
  const runsOf = (f: Fixture, agentId: string) => db.select().from(heartbeatRuns).where(and(
    eq(heartbeatRuns.companyId, f.companyId), eq(heartbeatRuns.agentId, agentId), sql`${heartbeatRuns.contextSnapshot} ->> 'issueId' = ${f.issueId}`,
  )).orderBy(asc(heartbeatRuns.createdAt));

  it("TR-2069 as production ran it: a run of the CTO is in the queue at each failure and the role's own retry waits there too; the issue is handed at once", async () => {
    const f = await seed();
    await turn(f, fail("adapter_failed", { session: "s1" }), { ctoRunAlive: true });
    for (let index = 0; index < 3; index += 1) await turn(f, fail(ACK_UNCERTAIN, { session: "s1" }), { ctoRunAlive: true });
    let retryId = "";
    const fresh = await turn(f, fail(ACK_UNCERTAIN, {
      session: "s2", during: async (runId) => { retryId = (await queueARun(f, f.devId, runId)).id; },
    }), { ctoRunAlive: true });
    expect(fresh).toMatchObject({ status: "failed", errorCode: ACK_UNCERTAIN, sessionIdBefore: null });
    expect(resumedOf(f)).toEqual([null, "s1", "s1", "s1", null]);
    await expect.poll(async () => (await issueRow(f)).assigneeAgentId, { timeout: 30_000 }).toBe(f.ctoId);
    expect(await issueRow(f)).toMatchObject({ status: "in_review", assigneeAgentId: f.ctoId });
    expect(await sourceRunsOf(f)).toEqual([fresh.id]);
    expect(await boardActions(f)).toHaveLength(0);
    expect(await handoverNotes(f)).toHaveLength(1);
    // The CTO's run of the last card was in the queue before the fresh run ended, and started only after the hand-over:
    // it was alive on the ticket when the issue was handed.
    const [handed] = await handovers(f);
    const cardRuns = (await runsOf(f, f.ctoId)).filter((run) => run.createdAt <= fresh.finishedAt! && run.createdAt >= fresh.startedAt!);
    expect(cardRuns).toHaveLength(1);
    expect(cardRuns[0]!.startedAt!.getTime()).toBeGreaterThanOrEqual(handed!.createdAt.getTime());
    // The role's retry never starts: the issue is no longer the role's.
    await heartbeat.resumeQueuedRuns();
    await heartbeat.drainActiveRunExecutions();
    await expect.poll(async () => (await devRuns(f)).find((row) => row.id === retryId)?.status, { timeout: 30_000 }).toBe("cancelled");
    expect(devLaunches(f)).toHaveLength(5);
    expect(await handovers(f)).toHaveLength(1);
  }, 300_000);

  it("the fresh run fails by an error of the run itself, not by the engine's answer: the issue is handed all the same", async () => {
    const f = await seed();
    await openSession(f);
    for (let index = 0; index < 3; index += 1) await turn(f, fail(ACK_UNCERTAIN, { session: "s1" }));
    const fresh = await turn(f, { kind: "throw" });
    expect(fresh).toMatchObject({ status: "failed", sessionIdBefore: null });
    expect(fresh.contextSnapshot).toMatchObject({ [RELAUNCH_LOOP_GUARD_CONTEXT_KEY]: { action: "fresh_session", droppedSessionId: "s1" } });
    await expect.poll(async () => (await issueRow(f)).assigneeAgentId, { timeout: 30_000 }).toBe(f.ctoId);
    expect(await issueRow(f)).toMatchObject({ status: "in_review", assigneeAgentId: f.ctoId });
    expect(await sourceRunsOf(f)).toEqual([fresh.id]);
    expect(await boardActions(f)).toHaveLength(0);
  }, 240_000);

  it("another agent's run holds the issue: nothing is handed, the fresh run says why, and the issue is handed at the end of the next run once that run is over", async () => {
    const f = await seed();
    const qaId = randomUUID();
    await db.insert(agents).values({ id: qaId, companyId: f.companyId, name: "QA", adapterType, status: "idle", adapterConfig: {}, reportsTo: f.ctoId });
    await openSession(f);
    for (let index = 0; index < 3; index += 1) await turn(f, fail(ACK_UNCERTAIN, { session: "s1" }));
    // A run of QA is alive on the ticket when the fresh run ends.
    let qaRunId = "";
    const fresh = await turn(f, fail(ACK_UNCERTAIN, {
      session: "s2",
      during: async () => {
        const now = new Date();
        const [row] = await db.insert(heartbeatRuns).values({
          companyId: f.companyId, agentId: qaId, invocationSource: "automation", triggerDetail: "system", status: "running",
          createdAt: now, startedAt: now, updatedAt: now, contextSnapshot: { issueId: f.issueId, taskId: f.issueId, wakeReason: "issue_commented" },
        }).returning();
        qaRunId = row!.id;
      },
    }));
    expect(fresh).toMatchObject({ status: "failed", errorCode: ACK_UNCERTAIN, sessionIdBefore: null });
    const saidHeld = async () => (await db.select().from(heartbeatRunEvents).where(eq(heartbeatRunEvents.runId, fresh.id)))
      .filter((event) => String(event.message).includes("a run or a lease on the issue still holds it"));
    await expect.poll(async () => (await saidHeld()).length, { timeout: 30_000 }).toBe(1);
    expect(await issueRow(f)).toMatchObject({ status: "in_progress", assigneeAgentId: f.devId });
    expect(await handovers(f)).toHaveLength(0);
    expect(await boardActions(f)).toHaveLength(0);
    // QA's run is over. The CTO answers, the role is started once more and fails empty again: at the end of that run
    // the hand-over is asked again and made, under the fresh run.
    await db.update(heartbeatRuns).set({ status: "succeeded", finishedAt: new Date() }).where(eq(heartbeatRuns.id, qaRunId));
    await turn(f, fail(ACK_UNCERTAIN, { session: "s2" }));
    await expect.poll(async () => (await issueRow(f)).assigneeAgentId, { timeout: 30_000 }).toBe(f.ctoId);
    expect(await issueRow(f)).toMatchObject({ status: "in_review", assigneeAgentId: f.ctoId });
    expect(await sourceRunsOf(f)).toEqual([fresh.id]);
    expect(await saidHeld()).toHaveLength(1);
    expect(await guardNotes(f)).toHaveLength(1);
    expect(devLaunches(f)).toHaveLength(6);
    // Made once: the runs that end on the issue afterwards ask nothing more.
    await heartbeat.resumeQueuedRuns();
    await heartbeat.drainActiveRunExecutions();
    expect(await handovers(f)).toHaveLength(1);
    expect(await boardActions(f)).toHaveLength(0);
  }, 360_000);

  // One answer of the CTO, as in production: its comment wakes the assignee of the ticket, whoever that is by then.
  // While the role is the assignee, that is one more run of the role, which fails as scripted.
  async function ctoAnswers(f: Fixture, session: string): Promise<"role ran" | "role not woken"> {
    if ((await issueRow(f)).assigneeAgentId !== f.devId) {
      await db.insert(issueComments).values({
        companyId: f.companyId, issueId: f.issueId, authorType: "agent", authorAgentId: f.ctoId, body: "Try again, the build is ready.",
      });
      return "role not woken";
    }
    await turn(f, fail(ACK_UNCERTAIN, { session }), { ctoRunAlive: true });
    return "role ran";
  }

  // The question asked after TR-2069: twenty-six `router_interactive_ack_uncertain` in a row in production. With the
  // guard, twenty-six answers of the CTO start the role five times in all. The CTO's run is alive on the ticket at
  // each failure, the one on the fresh session included: the card's wake of the CTO is in the queue as the role fails.
  it("TR-2069 at length: twenty-six answers of the CTO start the role five times, then the issue is the CTO's and nothing loops", async () => {
    const f = await seed();
    await openSession(f);
    const outcomes: string[] = [];
    // The session each run returns: s1 while it is resumed, s2 from the fresh run on.
    for (let answer = 1; answer <= 26; answer += 1) outcomes.push(await ctoAnswers(f, devLaunches(f).length < 4 ? "s1" : "s2"));
    expect(outcomes.slice(0, 4)).toEqual(["role ran", "role ran", "role ran", "role ran"]);
    expect(outcomes.slice(4)).toEqual(Array.from({ length: 22 }, () => "role not woken"));
    // The engine was launched five times: once to open the session, three times on it, once fresh.
    expect(resumedOf(f)).toEqual([null, "s1", "s1", "s1", null]);
    expect((await devRuns(f)).filter((run) => run.startedAt && run.errorCode === ACK_UNCERTAIN)).toHaveLength(4);
    expect(await guardNotes(f)).toHaveLength(1);
    expect(await handovers(f)).toHaveLength(1);
    expect(await boardActions(f)).toHaveLength(0);
    expect(await issueRow(f)).toMatchObject({ status: "in_review", assigneeAgentId: f.ctoId });
    await heartbeat.resumeQueuedRuns();
    await heartbeat.drainActiveRunExecutions();
    expect(devLaunches(f)).toHaveLength(5);
  }, 600_000);

  it("the server stopped before the hand-over: asked later, the issue is handed once, under the fresh run", async () => {
    const f = await seed();
    await openSession(f);
    for (let index = 0; index < 3; index += 1) await turn(f, fail(ACK_UNCERTAIN, { session: "s1" }));
    // The run on the fresh session, as it stands after a stop of the server at its end: failed, marked, nothing handed.
    const now = new Date();
    const [fresh] = await db.insert(heartbeatRuns).values({
      companyId: f.companyId, agentId: f.devId, invocationSource: "automation", triggerDetail: "system", status: "failed", errorCode: ACK_UNCERTAIN,
      createdAt: now, startedAt: now, finishedAt: now, updatedAt: now, sessionIdBefore: null,
      contextSnapshot: { issueId: f.issueId, taskId: f.issueId, wakeReason: "issue_commented", forceFreshSession: true,
        [RELAUNCH_LOOP_GUARD_CONTEXT_KEY]: { version: 1, action: "fresh_session", droppedSessionId: "s1", failedRunIds: ["a", "b", "c"] } },
    }).returning();
    expect(await handovers(f)).toHaveLength(0);
    // Asked directly, as the start of a run asks it; then asked again: one hand-over.
    const woken: string[] = [];
    const ask = () => handOverAfterFreshSessionFailure(db, { enqueueWakeup: async (agentId) => { woken.push(agentId); return null; } },
      { companyId: f.companyId, agent: { id: f.devId, name: "Dev Unity" }, issueId: f.issueId, exceptRunId: randomUUID() });
    expect(await ask()).toBe("handed");
    // Asked again: the issue is the manager's, nothing more is due.
    expect(await ask()).toBe("none");
    expect(woken).toEqual([f.ctoId]);
    expect((await handovers(f)).map((row) => (row.details as Record<string, unknown>).sourceRunId)).toEqual([fresh!.id]);
    expect(await issueRow(f)).toMatchObject({ status: "in_review", assigneeAgentId: f.ctoId });
  }, 240_000);
});
