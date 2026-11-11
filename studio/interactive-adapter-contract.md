# Interactive adapter prototype contract

Local prototype only, based on `7ca4f1808`. No deployment or active configuration
change is authorized by this artifact. `experimentalLiveSteering === true` is
required in the admitted execution configuration; absent/false preserves CLI.
The companion SSH wrapper currently rejects even explicit opt-in before claiming
a reservation or spawning a process: a trustworthy cross-platform provider owner
is not yet available. Local fixtures demonstrate the control flow, not readiness
for activation. This prototype must not be deployed as a working steering fix.

The host injects `registerInteractiveControl(control)` into the adapter context.
It binds ownership to the actual company/run and revokes it on cancellation and
execution settlement. The adapter does not supply a company or run to register.
The function returns an idempotent disposer; one control may own a run at a time.

```
control.protocol = 'adapter_interactive_v1'
control.snapshot(): { activeTurnId: string | null, steering: boolean }
control.steer({ expectedTurnId, correlationId, message, signal })
  -> Promise<{ turnId, correlationId }>
```

Snapshot is synchronous, local, content-free, and reflects provider events.
Steer acknowledges only a matching provider `turn/steer` response. It must not
start a successor turn, interrupt, replay a request, or claim remote termination.
The host serializes correlation identities, preserves uncertain deliveries,
records ACK with the native run-event allocator before consuming queue entries,
and keeps company, audience, fresh-session and queue revision checks unchanged.
The queue uses the explicit `adapter_interactive_v1` protocol, never a fabricated
native Runner session. Missing ownership/capability keeps the queue unavailable.
That protocol is saved in the admitted run profile. A detached port or an MCP
phase gap does not reinterpret the run as legacy or offer automatic Interrupt.
Previously admitted CLI runs cannot gain this capability from a later config edit.

A content-free attempted-delivery receipt is committed before provider dispatch.
Its stable run/message identity prevents replay after a controller restart. The
in-memory promise ledger spans registration phases of the same adapter execution.
An ambiguous response stays pending; it is never automatically retried. A late
matching acknowledgement can be persisted and reconciled without resending.
The event allocator is native; the receipt protocol is explicitly an adapter
protocol, not fabricated Runner events. Adapter-origin event callbacks cannot
submit these host-only receipt event types. No table or migration is added.

The wrapper may install `codexPreparedProcess({ runId, target, command, args,
options, resumeSessionId, model })` only after host opt-in. The native Codex
adapter invokes it at the existing fully prepared process boundary, preserving
auth, Git context, instructions, MCP, home and prompt preparation. It returns the
same process result shape. `supportsPreparedInteractiveProcess = true` is the
native module compatibility marker; the wrapper fails closed if absent.

Interactive execution owns its request/process timeouts. CLI inactivity kills
and automatic fresh-session fallback are disabled only for this hook. The
transport must preserve cancellation and prove remote provider stop before
calling `options.onProcessStopped`; SSH client close alone is insufficient.
Without that proof, native collection stays unconfirmed and router holds remain.
The native Codex finally blocks also preserve remote projections, temporary home,
runtime configuration and bridge until that proof. Provider shutdown is distinct
from Unity/CUA shutdown and task resource restitution; an MCP continuation may
legitimately retain those applications and its reservation.
No new port, permanent worker service, credential or permission is introduced.

Owners: fork owns context/types, lifecycle registry, queue route and UI capability
projection, native Codex preparation hook and durable ACK. Worker Router owns the
opt-in wrapper, framed ephemeral SSH supervisor/app-server transport, protocol
translation, MCP launcher and verified-stop evidence. Validation uses local
fixtures only; provider/platform/SSH production qualification remains outstanding.

## Upstream review and remaining blocker

The 2026-11-11 review covered 16 fully paginated searches across all states,
412 unique PRs and 21 inspected candidates. Relevant native queue/steering and
remote Runner changes (#12111, #12638, #12834, #13275, #13354, #15015, #16486,
#16978, #17380, #19450, #19970) were already ancestors of the base. Open PRs
#18856 (`53ba0044`) and #18858 (`7ea338a6`) introduce a broader native harness
contract, not a compatible hook for the current SSH CLI wrapper. Closed,
unmerged #7686 does not supply this same-turn contract. No complete compatible
PR was identified in that search; this is not a claim about every future PR.

PR #15120 (`77d46732f7943b3539dbf3d312f3fd3532dfb99c`) tracks SSH sessions and
stops them with Linux `/proc` scans and signals. Its documented `untracked` case
includes macOS, and a process that changes session and removes the run environment
is outside its proof. It does not establish Windows-native provider ownership
behind WSL either. This prototype does not import its scanners or termination.
Existing public SSH process helpers lack the required durable provider identity;
the persistent session owner in execution-target belongs to the sandbox transport.
EOF, a wrapper exit and an app-server turn completion do not establish provider
shutdown. A local adversarial wrapper detached a provider and reproduced that
false proof; the companion wrapper now fails closed before admission.

## Local validation and precise limits

`studio/steering-tests/build.mjs` bundles the actual owner/selector/UI normalizer
and extracts the exact existing queue lock and HTTP steering handler. Seventeen
Node tests pass: twelve route/queue/correlation scenarios and five native Codex
invocation/finally boundary scenarios. Express uses loopback; the transactional
DB and identity services are fixtures. Filesystem, preparers, provider and SSH in
the boundary cases are inert. This does not execute the full preparation workflow
or a PostgreSQL transaction. Independent host review has six additional tests.

`typecheck.mjs` runs TypeScript 7.0.2 in strict mode against actual adapter-utils,
the full native Codex execute module and its source dependency graph, the host
owner and queue selector. It uses isolated dependencies and the existing pinned
ACPX declaration patch, with no replacement `any` declarations. This targeted
semantic check passes. All changed TS/TSX owners also pass esbuild syntax
compilation. The entire server/routes/UI dependency graph, full workspace build,
PostgreSQL integration, browser UI, native provider, LAN and real acceptance tests
were not run. The initial pnpm command stopped during dependency resolution with
registry EACCES before reaching TypeScript; it is not a passing check.

Reproduce from the repository root with prepared local dependencies:

```sh
STUDIO_TEST_DEPS=/path/to/http-fixture-deps node studio/steering-tests/build.mjs
STUDIO_TEST_DEPS=/path/to/http-fixture-deps node --test studio/steering-tests/*.test.mjs
STUDIO_TYPE_DEPS=/path/to/typescript-deps STUDIO_PLUGIN_TEST_DEPS=/path/to/plugin-deps node studio/steering-tests/typecheck.mjs
```

No release/version pin was changed and no deployment or publication was made.
Discarding the local prototype branch leaves the deployed system unchanged.
Before any activation, the missing provider ownership must be resolved and
qualified, then the full route/DB/UI and actual provider/SSH contract verified in
a separately authorized pilot. Keep the real opt-in guard closed until then.
