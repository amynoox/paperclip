# Interactive adapter prototype contract

Local prototype only, based on `7ca4f1808`. No deployment or active configuration
change is authorized by this artifact. `experimentalLiveSteering === true` is
required in the admitted execution configuration; absent/false preserves CLI.
The companion SSH wrapper now provides a bounded provider owner for the approved
native Codex 0.166.0 artifacts. The complete local steering path has been exercised
with the real executable, preparation, HTTP route and PostgreSQL. This is a local
candidate, still disabled by default and not deployed. Worker-platform acceptance
and any activation require the separately authorized validation/deployment steps.

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

## Upstream review and provider ownership

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
false proof in the first prototype. The completed companion replaces that proof:
its controlled launcher resolves and hashes a native binary against the embedded
compatibility manifest, starts it directly, and reports its actual PID/close on a
private descriptor not inherited by the provider. The supervisor requires the
matching run/nonce/launcher identities and verifies PID absence before reporting
stop. Opaque scripts, changed launchers, unknown binaries, surviving providers,
missing receipts and ambiguous transport loss remain failures. No operator flag
can substitute for this evidence. Linux-musl/Windows-PE executables were run
locally; the macOS manifest entry is not a macOS acceptance result.

The launcher is required in interactive mode even when the project MCP plan is
empty. A native exec-only Git check flag is translated into the corresponding
repository preflight rather than passed as an unsupported app-server argument.
Worker Git resolution, native instructions/auth/MCP configuration and execution
policy still use the existing owners. Unsupported options fail explicitly.
Both phases of one bounded MCP continuation reuse the exact stopped provider's
cumulative usage counter for the same run/thread. A new invocation resuming an
older thread waits up to one second after `thread/resume`, before `turn/start`,
for the provider's cumulative snapshot. The returned thread and terminal-turn
identity must match; a snapshot in the response's input batch is reconciled too.
The normal inter-run path and its two MCP phases pass with the real executable,
each billing only its own usage. If that snapshot is absent, invalid or too late,
the turn remains unpriced and the existing completeness guard can refuse MCP
refresh. This conservative exceptional case is retained explicitly: historical
usage is never billed again or inferred after the new turn starts.

## Local validation and precise limits

Validation is intentionally reported by boundary, rather than treating every
fixture as a real worker:

- The original 17 route/boundary tests remain green. Those tests extract the
  exact HTTP handler and use inert DB/preparation ports; they are regressions,
  not the integration evidence below.
- One full native-preparation test runs the complete Codex execute module and
  verifies instructions, MCP configuration, policy, identity and usage mapping.
- Five PostgreSQL tests build the entire actual issues router and run native
  migrations on disposable PostgreSQL 18.1 databases. Real access/identity,
  queue locks, run-event allocation and ACK persistence cover delivery, concurrent
  duplicates, stale revisions, ambiguous delivery after owner replacement,
  rollback after durable ACK, and an unrelated company's denied access.
- Seven React/ReactDOM/jsdom tests render the actual queue component with real
  DnD. They cover available/unavailable capabilities, pending ACK, error recovery
  without automatic interruption, and unchanged explicit legacy interruption.
  Decoration, empty attachments and disabled auto-send helpers are declared
  doubles; this is not a full browser application test.
- One composed test runs PostgreSQL and the real HTTP route through the host
  control owner, public plugin index, complete native Codex preparation,
  worker-Git resolution, HOME staging, callback bridge, controlled launcher and
  the official Codex 0.166.0 Linux executable. It sends a message through the
  HTTP queue, observes same-turn provider acceptance, consumes it only after
  durable ACK, and verifies normal provider stop, native HOME/bridge cleanup and
  transport settlement. The seeded Git head/profile/content remain unchanged.

The composed test replaces only the SSH wire with local Ubuntu WSL executing
the unchanged native shell commands. A synthetic Responses server binds only
WSL loopback; no external model is contacted. Authentication session setup,
controller admission/lease IPC and agent/scratch projection callbacks are
explicit fixtures. Their receipts do not establish real projection collection,
Unity/CUA closure or router resource restitution. Unrelated HTTP service ports
fail if used; real dispatcher/scheduler execution is outside this harness.

The companion's independent tests also execute the public adapter with the real
Windows Codex binary, including adversarial ownership/cancellation cases, the two
MCP phases, and a synthetic MCP tool actually listed/called with its result
delivered back to the model. An independent preseeded provider/thread is also
resumed in a new invocation, followed by the MCP phase; both phases account for
40 input and 8 output synthetic-fixture tokens. The previous inter-run accounting
failure was reproduced before correction and remains part of the review record.
Those are not KitWright or desktop acceptance tests.

`typecheck.mjs` runs TypeScript 7.0.2 in strict mode against actual adapter-utils,
the full native Codex execute module and its source dependency graph, the host
owner and queue selector. It uses isolated dependencies and the existing pinned
ACPX declaration patch, with no replacement `any` declarations. This targeted
semantic check passes. All changed TS/TSX owners also pass esbuild syntax
compilation. The whole server/UI TypeScript workspace and full production build
were not run. No LAN SSH, macOS desktop, Unity, KitWright or real task acceptance
test was run. The initial pnpm dependency-resolution failure remains a failed
preliminary attempt, not a passing check. PostgreSQL uses the source-pinned
postgres 3.4.9 patch, not an unpatched substitute.

Reproduce from the repository root with prepared local dependencies:

```sh
STUDIO_TEST_DEPS=/path/to/http-fixture-deps node studio/steering-tests/build.mjs
STUDIO_TEST_DEPS=/path/to/http-fixture-deps node --test studio/steering-tests/steering.test.mjs studio/steering-tests/prepared-boundary.test.mjs
STUDIO_TYPE_DEPS=/path/to/typescript-deps STUDIO_PLUGIN_TEST_DEPS=/path/to/plugin-deps node studio/steering-tests/typecheck.mjs
```

For the complete integration prerequisites and build order, see
[`steering-tests/fixtures/README.md`](steering-tests/fixtures/README.md). Configure
the PostgreSQL URL only in the test environment and use a short isolated scratch
path on Windows (native SQLite lock files do not tolerate every long path).
The local WSL facade launches its shell with `nohup` to avoid a fixture-only
SIGHUP race when `wsl.exe` exits; it does not edit the native SSH payload.

No release/version pin was changed and no deployment or publication was made.
Discarding the local prototype branch leaves the deployed system unchanged.
Local provider ownership and full steering integration are now demonstrated for
the stated artifacts and fixtures. Before production adoption, qualify the
existing worker transports and contexts in the approved Windows/macOS pilot.
Local success does not enable the feature or retrofit a running CLI execution.
