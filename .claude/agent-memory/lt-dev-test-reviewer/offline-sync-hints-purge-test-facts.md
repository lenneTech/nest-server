---
name: offline-sync-hints-purge-test-facts
description: DEV-3902 review (2026-10-31, 5fbe5c4) — sync hint cases (SSE + GraphQL), tombstone purge, runSqlMigration syncUpdate; why the 7 mutations go red, how strong each "no hint arrives" negative is, and what the purge order test does NOT pin
metadata:
  type: project
---

Reviewed statically (resource rule: no e2e, no mutation runs); unit specs sync-module, statelessness-invariants,
regression-evidence, sync-contract-matrix green locally. CI runs 41239531310 / 41239539235 were still in progress.
Verdict: zero Critical/High.

**Mutations, why each goes red for the right reason:**
- `sync-hints-tenant-unfiltered` / `sync-hints-roles-unchecked`: one `hintFilter()` serves SSE and GraphQL. SyncLocked
  has no `tenantId` field (`tenantScoped = !!schema.path('tenantId')`), so with the role check gone its scope is
  "everywhere" and alice receives it — not filtered a second way by tenant.
- `sync-sse-not-registered`: without registration `getWsConnection(carrier)` is undefined, `invalidateUser` reaches
  nothing (`revalidateWsConnectionsOf` walks the module-global `liveConnections`), stream never ends.
- `sync-migration-update-unversioned`: ONE `UPDATE` statement serves postgres and mysql dialects, so all 5 SQL columns
  go red.
- `sync-purge-without-horizon` (unit) and `sync-purge-continues-past-horizon` (e2e) are byte-identical find/replace.
  The bootstrap purge (`schedulePurge()` runs once at boot, before = now - 90 d) loses its horizon too, so no
  pre-existing horizon can turn the e2e 410 green.
- `sync-hints-redis-not-published`: no ConfigService in multi-replica → hints `{}`, debounce default 250 ms.

**Negative-case strength:** hints-sse (narrowed) and hints-roles use the SAME hint delivered to a sibling subscriber in
the same `deliver()` loop as positive control — robust. hints-tenant uses a separate earlier write + 400 ms settle;
`CrudService.reportSyncChange()` is synchronous BEFORE the HTTP response, so the 20 ms timer starts before the client
sees the response (380 ms of event-loop lag needed, three attempts in a row with retry 2). Deterministic alternative if
ever needed: write B, then A, wait for A — same-delay Node timers fire in insertion order.

**Unit purge order test pins INVOCATION order only:** the mocks push at call time (`async () => calls.push(...)`), so
`Promise.all([advanceHorizon, deleteMany])` would still pass. Statement swap or a dropped call is caught.

**subscribeHints readiness is a fixed 200 ms sleep** after connection_ack — fail-safe (the case asserts the socket got
the positive hint), so a slow setup is a false red, never vacuity.

**Node IncomingMessage `_destroy` emits 'error' only when an 'error' listener exists** — a leaked SSE stream that the
server cuts off does not become an unhandled error.

Related: [[offline-sync-contract-test-facts]], [[offline-sync-datastore-test-facts]].
