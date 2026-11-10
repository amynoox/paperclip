# Plugin invocation lifecycle (STUDIO-0003)

The nightly `2026.1110.0-nightly.0` can retain a completed event's invocation
for fifteen minutes. During that time, legitimate calls from an unscoped plugin
controller are denied. A global scheduled job also receives no invocation of
its own. Its nested calls therefore fail when another invocation is active.
Changing plugin configuration or updating the SDK alone does not fix both ends
of this host/worker protocol.

## Upstream provenance and review

Reviewed on 2026-11-10 against upstream
`179694de7dc700aa5b4d0ab58fe8531cd8119f93`. Both source PRs were open and unmerged.

| Source | Reviewed head | Attribution | Disposition |
| --- | --- | --- | --- |
| [PR #15925](https://github.com/paperclipai/paperclip/pull/15925) | `59cf44a3ac2a479ef6e9795acd16b8e85954e974` | Josh Cox (`joshuacox`) | Reuse SDK settlement and host retirement, with the separately approved guard below. |
| [PR #9368](https://github.com/paperclipai/paperclip/pull/9368) | `4558c6fc38cd08b2d977b740ce61aea1d03e7dbb` | `adamteale/paperclip`; commits attributed to `paperclip-agent`, with Claude Sonnet 4.6 co-authorship in the source commit | Reuse native invocation for global jobs and configured-company resolution. |

These are focused patch applications, not merges of the contributors' older
branches. The rebase retains the current `providerSpanBudget` in the job context
and expected test result, and preserves newer fixture methods. These are
mechanical compatibility changes. Original PR links, authors and immutable heads
remain recorded here and in commit trailers.

Other reviewed candidates were #11571 (broader company-job design and migration),
#17797 (`23000f7e11dec74c433b11a40d42d7054c9d01d1`, detached asynchronous context),
#10580 (`6758221d6ce9f5a957d895fd1e5afe685e9d0a0e`, detached context only), and
#8159 (`1329672c7b0dae8bb5a9f64952395a26880e1f32`, startup grace). They do not
replace these two focused lifecycle repairs. See also upstream issue #15765.

## Approved downstream guard

Unmodified #15925 accepts settlement for any active invocation ID known to the
worker. A local negative control showed that a false settlement of a live
agent-origin request could remove its origin restriction for a later proactive
company call. Request invocations must remain owned by their response lifecycle.

The host now records whether it minted an invocation for a notification. Only
such entries accept `paperclip.invocationSettled`. Ordinary requests cannot be
retired by this notification. Unknown, repeated and already retired IDs do not
retire another invocation. Existing invalid-scope rejection and TTL fallback
remain in place.

The owner explicitly approved this narrow guard on 2026-11-10 after review of
the isolated patch and failing regression. A current all-state upstream search
for `invocationSettled`, `invocationSettled notification`, `15925`, and
`plugin settlement in:title` found no matching notification-only guard. The
settlement search returned #15925; related results included #17797 and unrelated
#9744. This approval does not authorize other downstream behavior changes.

## Authority boundaries

Global jobs receive a host-issued invocation with the native empty-company
sentinel. Calls with an explicit company are restricted to the plugin's
configured companies. Instance operations retain their existing capability
checks. `companies.list` is an explicit exception: with the existing
`companies.read` capability it retains global company discovery, as it already
does outside an invocation. This does not grant arbitrary company business data.
Company-state wildcard access remains denied. No manifest capability, token,
company assignment or agent permission is added.

## Reproducible local checks

Use Node 24. Install the pinned isolated dependencies and run:

```sh
cd studio/scope-tests
npm ci --ignore-scripts
npm test
```

Fourteen local protocol tests passed. They run real host-manager code, the real
published SDK gate and local child-process JSON-RPC. Synthetic data services and
stubs isolate unrelated logging, tracing, login and idle-service dependencies.
Cases include old-host/old-SDK negative controls; live and failed event handlers;
concurrent jobs; explicit company and capability denial; global discovery;
state-wildcard denial; false settlement of an active agent request; two events;
duplicate/unknown settlement; and rejection of retired invocation IDs.

The same fourteen tests passed against the generated runtime modules. The full
server/SDK Vitest suites and database integration suite were not run in this
sparse checkout. Existing upstream test additions are retained. The fifteen-minute
TTL expiry itself was not accelerated or newly tested. No real workload or worker
test was run. A passing protocol test is not end-to-end operational qualification.

## Artifact, deployment and rollback

After committing the tested source, build against the exact published modules:

```sh
node studio/build-invocation-overlay.mjs \
  /path/to/upstream/plugin-worker-manager.js \
  /path/to/upstream/worker-rpc-host.js /path/to/new-output-directory
```

The builder checks both input hashes, compares normalized baseline TypeScript
functions with the published runtime functions, and emits only the corresponding
changed functions. It checks that the current source matches `HEAD` and records
that commit, both input/output hashes and `fullBuild:false`. This is a minimal
verified overlay, not a full workspace build. Deploy host and SDK together in a
separate managed payload. Preserve STUDIO-0001's 96-hour token lifetime. Do not
mutate the running payload in place or perform a database migration.

Before activation, inspect all companies' active runs, transports and pending
plugin delivery/admission state. Repairing a scheduler can make old work runnable.
A chat-level hold is not a native pause. Preserve evidence and reconcile obsolete
requests through supported native/plugin actions before a drained activation.

Keep a verified instance backup, fresh native database backup, previous managed
payload and previous plugin artifact. Check authenticated version/commit,
runtime hashes, resolved SDK and unchanged settings after activation. Roll back
through the native install/plugin mechanisms only while drained; never restore
an old database or overwrite new work. Confirm rollback health and versions.

For a future upstream update, reassess both source PRs and the guard. Retire this
patch only when the upstream host and SDK pass the same lifecycle and negative
authorization tests. Preserve the patch record and the reason for retirement.
