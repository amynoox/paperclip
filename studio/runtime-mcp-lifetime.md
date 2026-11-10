# STUDIO-0001: four-day run MCP credentials

The downstream default lifetime for new `heartbeat_run` MCP gateway tokens is
96 hours. Both assigned runtime delivery and managed Codex gateway delivery use
this limit. The upstream baseline is `2026.1110.0-nightly.0`.

The runtime still owns the token. Subject, company, agent, gateway/profile and
allowed actions do not change. Existing per-call authorization and terminal
revocation remain in place. The public API still cannot mint a `heartbeat_run`
token. No refresh service, broad credential, database migration or permission
grant is added. A run exceeding four days still reaches the expiry boundary.

This affects newly issued tokens only. Existing credentials keep their recorded
expiry and revocation. Never resurrect an expired or revoked credential or edit
production token rows to extend it. Resume through ordinary native admission
after the original provider and collection obligations have been reconciled.

## Local checks and limits

`node --test studio/runtime-mcp-lifetime.test.mjs` executes the owning TypeScript
functions with synthetic database and mint dependencies. It checks both issuing
paths, immutable assignment refusal, unavailable and disabled delivery, and
company/run-scoped revocation. It does not exercise PostgreSQL or a worker.

The existing `server/src/__tests__/heartbeat-runtime-mcp-servers.test.ts` suite
also checks both persisted expiry bounds and terminal revocation through gateway
authentication. That integration suite requires the complete workspace and
embedded PostgreSQL. Record whether it ran; do not substitute a focused pass for
that claim. A real long-running acceptance remains separate.

## Artifact and rollback

`studio/build-runtime-overlay.mjs` takes the exact published upstream JavaScript
module and creates a small runtime overlay. It checks the base SHA-256, verifies
that the TypeScript source has exactly the corresponding downstream change, and
records source commit and before/after hashes. The overlay is not a full rebuild
of upstream dependencies. Run the focused tests against both source and generated
module, then syntax-check the artifact.

Activate the overlay only in a separate copy of the pinned upstream payload,
with a downstream version/build receipt and retained original payload. Preserve
all active-work and recovery obligations. A return to the original payload changes
future minting to the upstream default; already minted credentials retain their
stored lifetime and still have the native revocation path. Rollback must not
restore an older database or discard newer task evidence.

Retire this patch when an upstream run-credential lifetime or renewal mechanism
meets the required long-run behavior and preserves the same authority boundaries.
