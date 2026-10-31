---
name: project-offline-sync-phase5-dev3902-facts
description: DEV-3902 sync hints (SSE + GraphQL) + tombstone purge review 2026-10-31 — one High (SSE stream leaks when the client closes before the late req.on('close')); hint authz, tenant scope, purge, Redis traced sound
metadata:
  type: project
---

Reviewed commit 5fbe5c4 (`feature/dev-3902-offline-sync-5-hinweiskanal-und-tombstone-purge`) on 2026-10-31.

**Reported (High, DoS):** `CoreSyncService.openHintStream()` attaches `request.on('close', end)` only AFTER the
controller's `await limit()` / `scopeTenants()` / `hintFilter()`. A client that sends `GET /sync/hints` and closes at
once makes Node emit req `close` during those awaits; a later listener never fires (probed on Node v24.12.0: late
listener `false`, `req.destroyed`/`res.destroyed` `true`, writes do not throw). Subscriber Set entry, `liveConnections`
entry and a 25 s keepalive interval then stay forever. With `models=<unknown>`, `accepts()` never matches, so
`ensureWsConnectionCurrent()` (the only self-heal besides invalidations naming the user) never runs. About 5 KB/leak on
bare Node; bounded only by the per-user pull limit (120/min). Fix: check `request.destroyed || response.destroyed`
after registration and end; listen on `response` 'close'; keepalive ends a destroyed response.

**Traced sound (do not re-derive):**
- `hintFilter`: `checkRights(undefined, user, { roles: pull })` as pull does; scope from `allowedTenantIds()` —
  context present + no tenant → `[]` (fail closed); `undefined` (everywhere) only for no multiTenancy, excludeSchemas,
  bypass, adminBypass, or NO context. SSE context = lazy getters over `req` (scopeTenants writes `req.tenantIds`).
  GraphQL: graphql-ws context is `extra` (no `req`), so `buildWsRequestContext()` always installs a context; resolver
  failure → `{}` → `[]`.
- Header-less tenant roles resolve against `user.roles` (checkRoleAccess without tenantRole), same as pull.
- Re-check: SSE shim `reauthenticate: () => undefined` is truthy → every re-check terminates; registered in
  liveConnections (shim has `once`), invalidations by userId/iamId/email reach it. GraphQL: wrapper re-checks per event;
  graphql-ws `return()`s a subscribe result that resolves after close (isAsyncGenerator needs `.return`).
- Payload `{ model, at }` only; unknown `models` silently never match (no oracle). WS handshake refuses API tokens
  (not JWT / BA session); SSE route has no `@ApiTokenScopes` → refused like pull. Pull/hints have no Origin check
  (push only) — same class.
- Purge: `deletedAt` is a declared Date path (sync-schema.plugin), `matchLive` uses `$and`, `$lt` never matches null;
  `advanceHorizon` forward-only (`$lt` guard) and runs before the delete; lease Redis NX EX / SQL / cron-locks.
- Redis `receive()` validates model string, finite `at`, string tenantId; origin dedupe. `syncUpdate` set/where are
  developer SQL by contract, identifiers quoted.

**Below bar:** hints reveal colleague activity timing on `sync.scope` (per-user) models; unbounded concurrent open
streams per user (same as WebSockets); purge boundary window (transaction length / W at the 90-day edge).

Related: [[project-offline-sync-phase3-dev3900-facts]], [[project-offline-sync-spec-dev3898-facts]]

**Resolved in DEV-3902 before merge:** the fix above, pinned by `tests/unit/sync-module.spec.ts` (mutation
`sync-hint-stream-late-close`).
