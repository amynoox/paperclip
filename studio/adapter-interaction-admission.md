# STUDIO-0007 — Save routed input while task interactions remain pending

Status: local implementation, not published or deployed. Validation receipts and
their limitations are recorded below; this is not worker acceptance.

## Problem and boundary

An automatic answer or comment can wake a routed assignee while another required
interaction is still pending, including a card with `continuationPolicy=none`.
The router correctly refuses a new reservation, but that late refusal previously
became a failed provider attempt. The answer/comment must remain durable instead.

The installed adapter may implement an optional **read-only** `getTaskAdmission`
hook. It can only restrict admission; it cannot grant execution, reserve a worker,
answer a question, change an agent or bypass a native gate. The companion router
adapter selects only its configured routed positions and controller environment.
Direct roles and verified non-assignee interaction recipients keep their existing
paths. Existing operators retain their cleanup/restitution path.

The host checks native company/assignee identity and confirms the returned pending
card IDs against native records. Trusted human comment attribution is rebuilt from
stored comments before consulting the adapter; caller prose is not authority.
The router retains its existing ordinary-question and protected-card policy.

## Durable state and races

The existing `agent_wakeup_requests` receipt waits in `deferred_issue_execution`,
with a versioned `adapterInteractionWait` payload. Actor, source, idempotency key,
interaction/comment IDs and each receipt's original context are retained. Waiting
does not mark a response delivered, create a reservation or create a provider run.
An unrelated queued successor cannot turn an undelivered answer into delivery.

The existing deferred-work coordinator reconsiders saved inputs after native
interaction changes and through its bounded reconstruction scan. No new timer or
provider retry is introduced. `continuationPolicy=none` does not create new work:
only an already accepted, saved input can resume. Normal pause, budget, ownership,
permission, dependency and recovery gates remain authoritative. Changed ownership
or a missing adapter contract preserves the receipt and emits a diagnostic; it
does not silently send the input to a different agent.

Admission, promotion, queued claim and dispatch all recheck the restriction. The
router's actual claim remains authoritative if a card appears after preflight.
For that race only, the host advertises `taskAdmissionWaitVersion=1`; the adapter
can report `taskAdmissionWait` **before provider work and after its preparing
transport has settled**. The host requires the hook and verifies native process,
event and receipt evidence. It cancels the unstarted attempt as a named wait,
returns the original/coalesced receipts to the queue, and records no-provider
accounting so the native accounting worker can release the budget hold. This is
neither `exitCode=0` nor a successful provider result. Unknown process outcomes
cannot use this path. Existing environment cleanup remains a prerequisite to
promotion; this code releases no plugin reservation or uncertain resource.

## Upstream search and approval

Search performed on 2026-11-11 against `paperclipai/paperclip`, all PR states.
Relevant searches covered pending interactions, interaction+wake+comment,
interaction+gate, interaction+defer, interaction+admission, question+wake+pending,
decision_pending and the exact router refusal. The expanded pending-interaction
query returned fewer than the requested 100 entries. Candidate diffs were read;
the private dated search receipts remain outside the public repository.

| PR | Reviewed head | Disposition |
|---|---|---|
| #8578 | `02eb6fce152b8ef2a37689861d556405f0bf47c7` | Missing-comment follow-up with wake-capable policies; not these admissions. |
| #17849 | `3e39a598deaab669945c531a21a40a9b3840cc97` | Review-participant recovery tail; not an assignee wait for `none` cards. |
| #14701 | `ed1b3d7a739583799310c102575407a10324485d` | Blocked-card throttle; this issue need not be blocked. |
| #8711 | `a127490c002b7ba6fc0d6ae72cabe2bea938264c` | Pending-card context, without admission deferral. |
| #8721 | `e082abb085b6c1a5615eacc2b18365f062eed7da` | Timer/checkout suppression for review and wake-assignee policies. |
| #12525 | `d2c81f8b10a060bcd0e7a51987301f49f51490fa` | Watchdog/child-completion loop handling, not saved input admission. |
| #15397 | `37470bcc70dfcdf1f66683ae4a62254e1550cde7` | Authenticated human-comment supersession, no durable router wait. |
| #6497 | `fcf815d54e707dacfe60f5325183cc2ae73034eb` | Stale interaction monitor, not answer/comment admission. |
| #20204 | `64ddd2d38d27670885450e43794394b01f81abc5` | Held conversation answer after restart, not a new routed reservation. |
| #20179 | `5a8c8c95805336749756d6e59de9256cc54aadd2` | Publishing an answer during an approval hold, not provider admission. |
| #19787 | `2733222e0361ab9bd385bd60a59dfe65f86012a4` | Reviewed chat-binding contention and attribution, not router restrictions. |
| #19600 | `675914f0fa9b5eb1d2c9c8fcd448e0669d0c4836` | Explicit native continuation after completion, not legacy routed automatic wakes. |
| #9720 | `928bcb0c07676e3d31e7da365f68d7927e77ccdb` | Blocked comment triage without the required admission contract. |
| #9721 | `c056d10737d2f4e395aa259e01e469bc82d16daf` | Blocked mention triage without the required admission contract. |

No reviewed candidate covers this boundary as a compatible targeted reuse.
The owner explicitly approved the custom wake correction and its small read-only
companion contract. This is a bounded search conclusion, not a claim about every
unrelated upstream PR. Existing STUDIO-0006 non-assignee authorization is retained.

## Compatibility, rollback and limits

No database migration, role setting, permission or company policy changes.
Existing receipt payloads remain valid. Old adapters have no hook and retain their
old behavior; the new adapter keeps a named failure on an old host, rather than
returning an ignored deferred field. Deployment must therefore coordinate host
and adapter versions. This local work does not change the published version.

Before rolling back to a host without this contract, inspect/drain these saved
waits or retain this queue owner. An older generic deferred-queue reader does not
understand the marker and could attempt the old failing behavior. Never delete
the saved input as a rollback shortcut. A missing hook on this host leaves it
saved for an operator to resolve.

An older coalesced receipt without its own original context is not reconstructed
from the run's merged context: the attempt is retained rather than borrowing
another author's authority. Such pre-existing malformed state needs explicit
operator reconciliation. Normal post-Stop, pause and issue-release queue owners
leave versioned adapter waits to their dedicated promotion path.

## Local validation

- 24 targeted PostgreSQL/runtime/delivery cases passed; 258 unrelated cases were
  intentionally filtered. These include real native admission transactions,
  original receipt promotion, pause and ownership changes, coalesced provenance,
  queued and dispatch-time races, uncertain process rejection, retained cleanup,
  and response delivery acknowledgement. Providers are mocked.
- 32 companion adapter cases passed, including passive policy checks, co-op,
  protected human cards, retained operators, the claim race and old-host failure.
- Eight additional native queue regressions passed (80 filtered), covering
  non-assignee recipients, former-owner handoff, pauses and saved messages. One
  post-Stop recovery regression passed (83 filtered): the normal input resumes
  while an adapter-owned input remains saved for its own admission owner.
- Strict TypeScript 7.0.2 checking of the adapter contract passed; esbuild 0.28.2
  transformed all ten changed production modules. This is not a full host build.
- The expanded assembled-heartbeat run encountered eleven failures in existing
  provider-start tests; two representative cases reproduced on an unmodified reference
  worktree. The simulated runs stayed `running` before provider events. Their
  cause remains unresolved in this local harness, so the complete assembled
  regression suite is **not** claimed to pass. The other nine failing cases were
  not run as baseline controls; the two controls do not establish their cause.
  An intermediate new provenance
  test also ran against a cached earlier module; the clean targeted rerun passed.
- Full-service semantic checking is not established: the isolated dependency
  tree lacks several pinned SDK/runner declarations and reports unrelated
  existing errors. Contract-only type checking and module transformation are
  reported separately, not substituted for that missing check.

No provider/worker, live Paperclip ticket, deployment or end-to-end LAN validation
has been performed here. The composed local tests substitute only external
adapter/provider boundaries and use disposable local PostgreSQL databases.
