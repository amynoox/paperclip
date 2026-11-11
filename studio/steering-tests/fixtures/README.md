# Local full-path fixtures

These files are test-only ports for the native integration test. They do not
contact a worker, start a network SSH client, import credentials, or attest that
a provider stopped. Provider ownership is verified by the shipped plugin.

- `child-process.mjs` accepts only the explicitly configured synthetic `.invalid`
  SSH host, checks a marker in the isolated home, then executes the unchanged
  native shell payload in local Ubuntu WSL. SCP is refused. `nohup` prevents the
  local `wsl.exe` shell lifetime from introducing a transport-only SIGHUP.
- `responses-client.mjs` / `responses-server.mjs` keep the deterministic model
  endpoint inside WSL, bound to `127.0.0.1`; its control channel is local stdio.
- `responses-fixture.mjs` emits deterministic Responses events and exposes the
  observed requests. It is a synthetic model, not a reasoning-quality test.
- `build-public-native-harness.mjs` bundles the actual public plugin entry. It
  imports the real native Codex execute/preparation bundle and its Git helpers.
  Controller IPC, agent/scratch projection and the SSH wire remain explicit
  fixtures. The provider-stop verifier is never replaced.

The caller supplies local paths through `STUDIO_PLUGIN_TEST_DEPS` (the isolated
plugin checkout with test dependencies), optional `STUDIO_PLUGIN_SOURCE`,
`STUDIO_WSL_NODE` (the local Linux Node executable), and `STUDIO_CODEX_LINUX`
(the pinned official Linux Codex executable). No binary or private receipt is
checked into this directory. Set `STUDIO_LOCAL_CHILD_PROCESS` to this directory's
`child-process.mjs` while building both native and public bundles; the facade's
own child-process import remains native.

Actual PostgreSQL/HTTP, full native preparation, the real Codex executable and
the controlled launcher are exercised by the composed test. Authentication
session setup and controller admission are fixtures, and local WSL is not proof
of an actual worker's SSH, macOS desktop, Unity or KitWright behavior.

## Reproduction

Use Node 24 with isolated dependency directories. `STUDIO_TEST_DEPS` supplies
esbuild; `STUDIO_DB_TEST_DEPS` supplies drizzle-orm 0.45.2, postgres 3.4.9 with
the repository's exact `patches/postgres@3.4.9.patch`, Express 5.1.0 and Zod 4;
`STUDIO_UI_DEPS` supplies the source-pinned React/DnD dependencies, jsdom 30 and
`@opentelemetry/api`. `STUDIO_TYPE_DEPS` supplies TypeScript 7.0.2, Node typings
and the source-pinned ACPX declarations with their existing patch. Retain the
isolated lockfiles and artifact hashes; do not install into a production tree.

Set `PAPERCLIP_TEST_POSTGRES_ADMIN_URL` to a disposable local PostgreSQL 18.1
cluster and `PAPERCLIP_TEST_POSTGRES_TEMPLATE=0`. The native database helper
creates and drops each test database with actual migrations. Never use an
instance or worker database. Set `STUDIO_INTEGRATION_SCRATCH` to a short, private
local path on Windows to avoid native SQLite path-length limits.

With the environment above supplied, run from the fork root:

```sh
node studio/steering-tests/build-database-integration.mjs
node --test studio/steering-tests/database-integration.test.mjs
node studio/steering-tests/build-native.mjs
node studio/steering-tests/fixtures/build-public-native-harness.mjs
node --test studio/steering-tests/full-integration.test.mjs
node studio/steering-tests/build-ui.mjs
node --test studio/steering-tests/ui-integration.test.mjs
node studio/steering-tests/typecheck.mjs
```

The plugin's generated `dist/native/adapter-mcp.cjs` must be built from the
matching companion source beforehand. `STUDIO_CODEX_LINUX` must point to the
approved official 0.166.0 binary; its hash is enforced by the real launcher.
The composed fixture creates its own Git repository/profile, provider home and
synthetic token. It never reads a user's account authentication.

Normal completion closes the native callback bridge and local Responses server.
An intentionally uncertain/failing run can preserve its bridge, as production
does. Test cleanup must use only the exact synthetic root/marker and recorded
PID after confirming that PID's command line belongs to that root; never shut
down WSL or kill unrelated processes. Preserve failure receipts separately from
the final successful run. The original short fixture failures (missing run
token, WSL shell lifetime, absent synthetic Git repository and long Windows
SQLite path) were fixed in the harness without weakening runtime guards.
