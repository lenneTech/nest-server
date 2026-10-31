---
name: offline-sync-phase5-dev3902
description: DEV-3902 hints/purge/syncUpdate review 2026-10-31 — 2 Highs (SSE close listener attached after awaits leaks streams; MySQL syncUpdate after DDL runs autocommitted); rest verified sound
metadata:
  type: project
---

Phase 5 of offline sync (SSE + GraphQL hints, tombstone purge, `runSqlMigration()` syncUpdate), reviewed 2026-10-31
against commit 5fbe5c4 by reading plus one Node probe (resource rule: no e2e).

**Reported High:**
1. `openHintStream()` attached `request.on('close', end)` as its LAST line, after `limit()`, `scopeTenants()`,
   `hintFilter()` (and the auth I/O before the handler). Probed on Node 24: a client that disconnects during those
   awaits gets `close` emitted once, before the listener exists, and never again → hint subscriber, 25 s keepalive
   interval and `liveConnections` entry live until an accepted hint after 30 s or an invalidation; with `?models=x`
   never. Any S_USER, 120/min under the pull limit. The working tree already had a fix during the review (once('close')
   on req+res before registering, `destroyed`/`writableEnded` check after) — checked correct.
2. `applySyncUpdate()` on MySQL/MariaDB relies on `withMysqlSchemaLock`'s TypeORM transaction. A DDL statement earlier
   in the same `runSqlMigration()` list implicitly commits and the session returns to autocommit, so the SELECT FOR
   UPDATE, the counter `UPDATE seq = seq + k`, the `SELECT seq` and every 500-row chunk commit separately: concurrent
   store writes take higher numbers and commit first (pull moves past the migration's rows → lost for good), and a
   write between the counter UPDATE and the SELECT makes the read `seq` too high → duplicate sync_seq. The compiler
   itself knows this (`mysqlSyncTableStatements` issues its own START TRANSACTION after DDL). Fix: bracket each
   syncUpdate with START TRANSACTION / COMMIT on MySQL.

**Verified sound (don't re-derive):** PG syncUpdate advisory key/sequence name identical to the trigger, explicit
sync_seq skips renumbering (`IS DISTINCT FROM` / `<=>`), MySQL counter keyed by table name; `req` close not premature
on bodyless GET behind body-parser (probed); `Cache-Control: no-transform` makes `compression` skip; writes to a
destroyed response do not throw; `revalidate()` never rejects; ResponseModelInterceptor ignores subscriptions (only
query/mutation metadata); horizon monotonic and uncached, advanced before delete; purge runs with no RequestContext
(tenant policy bypassed); CrudService hint hook on all six create/update/delete paths, model-level `changeOrder`.
Probe recipe: plain `node` script in scratchpad, `createRequire('<repo>/package.json')` for express/body-parser,
raw `net` socket destroyed mid-await. See [[offline-sync-phase4-dev3901]], [[review-tree-is-shared-and-mutable]].

**Resolved in DEV-3902 before merge:** (1) listeners on req + res before any end, `destroyed`/`writableEnded` check
after the registration, keepalive ends a destroyed response (mutation `sync-hint-stream-late-close`); (2) the MySQL
branch of `applySqlSyncUpdate()` brackets each syncUpdate with START TRANSACTION / COMMIT, ROLLBACK on error (mutation
`sync-migration-update-autocommit`).
