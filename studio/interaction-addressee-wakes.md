# Verified pending-interaction addressee admission

STUDIO-0006 reuses official [Paperclip PR #14378](https://github.com/paperclipai/paperclip/pull/14378)
on the existing studio.4 source. The integration was published as studio.5 on
2026-11-11. Deployment verification and a live agent response are separate
acceptance steps; the latter remains pending in the receipt below.

## Problem and owning boundaries

A pending question can name a responder who is not the task assignee. The native
interaction route creates that responder's wake, but the queued-run ownership
gate treated it as a stale assignment and cancelled it before execution. Adapter
configuration cannot repair this native admission decision.

The reused patch verifies the stored card's company, issue, named agent and
pending status. A distinct verified fact passes only the relevant ownership and
review-participant gates. The ordinary claim and the adopted-comment claim both
recheck the card with `FOR UPDATE NOWAIT` inside their issue/run claim transaction.
A concurrent verdict therefore either precedes the claim or makes it defer; it
cannot silently revoke authority between the final read and the claim write.
Existing pause, dependency, budget, execution-recovery and response permissions
remain in their native owners. This is permission to answer a current card, not
permission to take over its task.

If authority expires, the native cancellation and a deduplicated redelivery
receipt preserve adopted human comments. The existing deferred-work coordinator
re-admits them through normal comment admission, including owner changes and
owners without run history. No new timer, external service or permission is added.

## Upstream provenance and integration

Search: 2026-11-11, `paperclipai/paperclip`, all states. Complete relevant queries
returned 9/9 PRs for `"interaction_pending"`, 17/17 for
`"issue_assignee_changed" "interaction"`, and 56/56 for
`"interaction" "non-assignee"`. Inspected alternatives included #15991, #16914,
#17643, #17861, #13211, #11939 and #18907. #14378 was selected for its locked
claim-time verification and comment preservation; smaller gate-only exemptions
did not cover that race. The private search receipt is retained outside Git.

- Reviewed PR head: `e70c3129049d488b8c3eedbbb9dddc837645b34b`.
- PR base: `f0006c77838fe2c2294376c38368669eb90b26f2`.
- Original author: Rick7C2 (`1856877+Rick7C2@users.noreply.github.com`).
- Relevant original commits: `b8e0aa852dc4253437d2ae71e14bc2eed58fd4cc`,
  `8f9348e86965d7e085ab02a87b8b38bbfc081214`,
  `1f35660ffc00c92cd20d107fcc6dc5772ac5a16d`,
  `814c577bcdf1d46d194a28b727b7958519d24f90`.
- Original merge resolutions: `d9ad41be6ef0359962722e593439718a5d6cf89b`
  and `ae218879cc8896506dad028e6fdd3d7e9a91574f`.
- Downstream baseline: `10b89f1aaa7d859d921ffa225b93af71b173d862`.

The eight issue/dispatch/heartbeat/doc files are taken from the PR's complete
reviewed diff. Its unrelated `tests/runner-e2e/workflow-target.test.ts` fixture
change is excluded. Three queue.ts context conflicts were mechanical: retain the
newer baseline's `allowsDependencyBlockedWake`, `dependencyResolvedWakePayloadSql`
and `isDependencyResolvedWakePayload` names, and add the upstream imports and
redelivery branch alongside them. No additional behavior is invented here.

## Validation and limits

Local validation completed on 2026-11-11:

- Native policy suite: **70 passed, zero failed**. Running the same tests against
  the previous policy reproduces **two failures** (verified addressee ownership
  and review-participant admission); those negative-control results are retained.
- Real local PostgreSQL 18.1, with native migrations and disposable test databases:
  **27 passed, zero failed**. Five cases exercise the dispatch PostgreSQL adapter;
  22 exercise the assembled heartbeat queue and its real database transactions.
  They cover ordinary and adopted-comment claims, stale/resolved/missing/wrong
  interaction authority, `NOWAIT` lock contention, reassignment, deleted comments,
  deduplicated redelivery and queued-comment coalescence. The other **151 cases
  are intentionally excluded** by the `addressee|interaction_pending|reassigned issue`
  name filter; they are not skipped because PostgreSQL is unavailable.
- Strict TypeScript 7.0.2 semantic checking of policy and its tests passes. The four
  runtime modules compile with esbuild 0.28.2. No whole-server semantic typecheck
  or full-workspace test/build is claimed.

The heartbeat suite substitutes its ordinary test adapter execution and telemetry
boundaries. Native dispatch, heartbeat owners, database reads/writes and row locks
are real; no provider, worker, live ticket or production API is exercised.

Vitest runs real source files. Its isolated configuration disables discovery of
unrelated missing sparse-worktree tsconfig references for test transpilation;
this is not a semantic typecheck. Initial missing-dependency, sparse-module and temporary-directory
sandbox failures ran no test and are retained separately from passing results.
The isolated dependency pool resolves the pinned Cursor/Connect protobuf-v1 family
separately from protobuf-v2 consumers, as required by the upstream lockfile.

This patch recognizes the original `interaction_pending` wake. It does not claim
to fix every rewritten scheduled-retry identity (#15991 addresses a separate
part of that contract). A card with continuation policy `none` still does not
automatically resume another agent after its response. No old cancelled run is
rewritten and no human question is answered administratively.

## Delivery, rollback and retirement

There is no schema migration, package/version pin change or role reconfiguration.
The runtime delta comprises run-dispatch `domain/policy`, `adapters/postgres`,
its `index`, and heartbeat `queue`. Keep all earlier studio overlays unchanged.
`studio/build-interaction-addressee-overlay.mjs` compiles only these four modules
from committed, verified source. Set `STUDIO_BUILD_DEPS` to an isolated directory
containing esbuild 0.28.2 and pass a new output directory. It emits
`interaction-addressee-build.json` with source, upstream and compiled hashes;
installed-baseline verification is deliberately false until deployment preparation.
No SDK, adapter, UI, schema or earlier overlay is rebuilt by this builder.

Each release must be compared against the installed baseline, with drained
native task execution, verified backup and authenticated readback. Only the authorized validation owner may request a fresh
normal delivery; local fixtures do not establish a live response.

Rollback restores the previous managed runtime while drained and preserves the
database, comments, interaction and run receipts. Retire STUDIO-0006 when the
pinned upstream includes equivalent verified addressee and locked-claim behavior
and passes the same negative, race and redelivery regressions.


## Deployment receipt — 2026-11-11

Version `2026.1110.0-studio.5`, source
`cb231052e2dbd28de86052538a3d0ed6ed422e6c`, was verified active at
**08:01:25 UTC**. The source was reviewed in [downstream PR #2](https://github.com/amynoox/paperclip/pull/2).
Authenticated health and startup recovery were ready. The four installed modules
matched the compiled hashes from that committed source. The 70 policy and 27
PostgreSQL tests above are the **97 local targeted cases**, not live acceptance.

A fresh native database backup was read back in full; its compressed integrity
and SQL format were checked before stopping the service. No schema migration
was run. The previous managed installation was retained. UI, SDK, adapter, database
package and earlier overlay hashes were preserved, including packages used by
other installed plugins. The router plugin and external adapter remained at
`0.29.18`. This update did not install or update another plugin.

Configuration, permissions, instructions, skills and pending interactions were
preserved. The run count was **1,251 before and after**, with **zero new runs**.
The registry placement revision advanced once during the normal configuration
replay; the other compared registry fields were preserved. This is not a claim
that the whole registry was byte-identical.

Five historical SSH cleanup records were preserved. Their associated runs had
ended successfully, their recorded local transport PIDs were absent, and no
current task execution or ownership was admitted through this exception. Fresh
task execution and any new lease still blocked cutover. Background probes alone
were not treated as active task execution. The update did not clean those records
or establish that every historical remote process had exited.

Private backups and raw operational receipts remain outside Git. The authorized
validation owner was notified to check one normal delivery to the named responder.
That live response was **not yet validated at this publication checkpoint**.
No wake, provider call, worker test, gameplay result or full autonomous workflow
acceptance is claimed by this deployment receipt.
