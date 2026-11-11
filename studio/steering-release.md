# Steering release: studio.4

`2026.1110.0-studio.4` packages STUDIO-0005 on top of studio.3. The separately
approved Worker Router package must support the prepared process contract and
provider ownership. Version labels alone are not compatibility evidence:
the wrapper checks `supportsPreparedInteractiveProcess`, host control support
and the pinned native Codex artifact before admission. The feature is disabled
by default; release preparation does not change agent configuration.

## Payload and reproduction

`build-steering-overlay.mjs` emits eight server modules, two native Codex modules
and four public declaration files from committed source using TypeScript 7.0.2.
It first recompiles the exact studio.3 predecessors and compares them with the
exported installed files. JavaScript comparison normalizes through esbuild;
declarations permit only platform newline and compiler-map-footer differences.
The manifest records source, baseline and emitted SHA256 values. The emitter's
`noResolve/noCheck` limits output to this approved list; the strict targeted
semantic check remains a separate requirement, not a claim made by emitting.

```sh
STUDIO_TEST_DEPS=/isolated/esbuild-deps STUDIO_TYPE_DEPS=/isolated/typescript-deps \
  node studio/build-steering-overlay.mjs /exported/studio3/node_modules /new/core-output
```

The UI must be a complete build using the repository's original Vite production
configuration, original lockfile dependency versions and full release commit.
A mocked component bundle is not a release artifact. Publish the resulting tree
at the native `@paperclipai/server/ui-dist` location. Keep the previous immutable
asset names available to existing tabs and reject same-name/different-byte
collisions; do not enable a new storage backend for this purpose.

With isolated dependencies resolved from the repository's frozen lockfile and
their native workspace source exports available, reproduce the complete UI:

```sh
PAPERCLIP_BUILD_COMMIT=<full-source-commit> \
  STUDIO_UI_RELEASE_DEPS=/isolated/ui-dependencies \
  STUDIO_UI_RELEASE_OUT=/new/ui-output node studio/build-steering-ui.mjs
```

The builder refuses an existing nonempty output, requires HEAD to match the
browser commit and records every emitted asset hash plus the source/dependency
lock hashes. The native plugins, code splitting and service-worker build ID
remain active. Dependency installation uses frozen resolution with installation
scripts disabled and is separate from building; no CI or service is started.

STUDIO-0001, STUDIO-0003 and STUDIO-0004 compiled hashes must remain unchanged.
No database migration, new runtime dependency, credentials, network exception,
role instructions or skill selection is included. The release may update only
the explicit artifact inventory and native package/build/install metadata.

## Activation and rollback

Use a separate inactive managed payload, fresh verified backups, and the native
install-store lock and atomic manifest/symlink operations. Obtain a fresh idle
snapshot and coordinate the native service stop; do not terminate active work.
Embedded PostgreSQL stops with the service, so run SQL before stop and after
authenticated startup, never treating an unavailable database as an idle result.
After startup verify version, commit, authentication/readiness, artifact hashes,
plugin/adapter loading and protected task/role/configuration state.

Native startup replays saved plugin configuration. If the existing router
advances placementRevision once, accept only that exact, source-explained delta
with every other registry field preserved. New work, a human response or any
unexplained state change requires explicit classification; do not bypass the
guard or claim unchanged counters.

Retain the prior complete executable/UI payload and native install manifest.
On an ambiguous activation result, read the actual symlink and manifest before
deciding whether the flip happened. Rollback must be safely drained and use the
same native lifecycle/install owner, followed by authenticated health and state
verification. No schema rollback, forced provider kill, task reset, message
replay, reservation release or role/skill reset belongs to this procedure.

## Evidence limits

The local integration and failure/ACK/ownership coverage are recorded in
[interactive-adapter-contract.md](interactive-adapter-contract.md). The production
UI build and targeted runtime overlay are not a full rebuild of every server
package. Activation receipts and the targeted Windows/macOS acceptance are
separate evidence; neither follows automatically from compilation or publication.
