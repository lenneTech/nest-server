---
name: sql-store-perf-profile
description: Measured costs of the db-agnostic SQL store (feat/db-agnostic, phases 1+2) - Mongo-path overhead, update-compiler blow-up, boot owner connections, RLS leakproof facts, phase-2 lock/tenant/token paths, how to measure without DROP
metadata:
  type: project
---

Measured 2026-10-28 on `feat/db-agnostic` (phase 1, DEV-3829), local Postgres 18.6 test container (port 5440).

- **MongoDB path overhead of the neutral branches**: `usesNeutralStore` (getter → cached derived store → frozen capabilities) ~5 ns/call, no allocation after first access. CRUD on Mongo is unaffected; engines (`pg`, `typeorm`, `kysely`, `drizzle-orm`) are only lazy `import()`ed.
- **postgres-update.compiler `withParents()` / `inc()` reference the running column expression twice** → statement size 2^n for n nested `$set` paths (depth ≥ 2 below the column) or n nested `$inc` paths (any depth) on ONE jsonb column. Measured: 14 `$set` paths → 2.7 MB, 1.8 s; 16 → 10.8 MB, 8.2 s; 20 → 172 MB. One-level `$set` (`col.flag`) stays linear. Only project code via `DataStore.updateById()` reaches it; `CrudService.update` writes whole top-level fields. FIXED 2026-10-28: the running expression is bound once through a subquery (`UpdateCompiler.bind()`, unique aliases), pinned by `tests/unit/persistence-sql-update.spec.ts` (mutation `sql-update-expression-doubles`).
- **Boot: one owner executor per SQL model**, all opened concurrently (Nest `Promise.all` over providers), each parked on `pg_advisory_xact_lock` holding its connection. Measured 40 models → peak 40 owner connections (33 even when booting alone). FIXED 2026-10-28: one owner executor per source (maxConnections 1), released in `onApplicationBootstrap` (mutations `sql-owner-connection-per-model`, `sql-owner-held-after-boot`).
- **Populate on SQL is per record in `find()`** because `process()` loops per item (untouched code); identical query count to Mongo's per-document populate, so parity, not a regression. `findAndCount` passes the items array → batched.
- **RLS leakproof (PG 18)**: `texteq`, `text_lt/ge`, `float8*`, `timestamptz*`, `booleq` are leakproof → id/tenant/scalar indexes usable under FORCE RLS; `jsonb_contains`, `jsonb_eq`, `textregexeq` are NOT → GIN/jsonb predicates on tenant-isolated tables run as filters after the tenant index.

**Phase 2 (DEV-3830), reviewed 2026-10-28 — zero Critical/High.** Settled, re-check only if the file changed:
- `ModuleService.dataStore` now does `getStoreForModel()` (WeakMap.get on the model function) first: ~7 ns hit or miss.
- `CoreApiTokenService.userStore()` calls `moduleRef.get(getStoreToken('User'), { strict: false })` per token request; on a
  consumer whose User model is NOT registered via `CorePersistenceModule` that is a throw+catch: measured ~3.2 us (hit ~42 ns).
- `CoreTenantGuard.identifyThroughRoleGuard()` runs only on a non-`S_EVERYONE` route with no `request.user`. IAM: the
  middleware identifies, so no extra pass; anonymous: one role-guard run that throws the same 401. Legacy JWT +
  multiTenancy: a full second auth pass (2x passport verify + 2x `userService.get()`) — but the base answered that config
  401 on every tenant route, so no working deployment regresses. Medium at most; a fix would let the APP_GUARD pass skip
  when this request was already authenticated.
- Cron lease per tick: same round trips as before (Mongo `insertOne` -> `updateOne` upsert, `ensureLeaseIndex` cached;
  SQL: cached `defaultLockStore()` promise). `lt_locks` has NO `expires_at` index: the 10-min sweep is a seq scan, bounded
  to ~2h10m of per-tick leases (1 h TTL + 1 h grace).
- `SqlDataStore.updateOne` no-match = UPDATE + EXISTS (2 round trips vs Mongo's 1); retries bounded at 3.
- Below the bar but worth re-checking if the Hub is ever enabled in production: the migrations panel polls every 5 s and,
  on a SQL default source, `SqlStateStore.loadAsync()` opens a fresh OWNER connection + `CREATE TABLE IF NOT EXISTS` per
  poll (Mongo reuses the app connection).

**Phase 3 (DEV-3831, Better-Auth on SQL), reviewed 2026-10-28 — two High findings:**
- Better-Auth gets the framework's SHARED app pool (`app.driverPool`, max 10). For a pg pool Better-Auth's Kysely adapter
  sets `transaction = true`, and `/sign-up/email` runs entirely inside `runWithTransaction` — scrypt hash included
  (`sign-up.mjs`, better-auth 1.7.13). Measured (pg 8.23, PG 18 container, framework scrypt params): 100 concurrent
  sign-ups → an unrelated `SELECT 1` waits 1.3 s (FIFO behind the burst, ~14 ms per queued sign-up) vs 17 ms max with
  the hash outside a tx. Mongo has no adapter transactions (`mongodbAdapter(db)` without client). Password reset hashes
  BEFORE its tx; sign-in has none. Script pattern: pool + BEGIN/scrypt/COMMIT vs probe query, no schema needed.
- Better-Auth's adapter `findMany` without `limit` returns at most 100 (`defaultFindManyLimit ?? 100`, factory.mjs;
  proven with the memory adapter: 150 stored → 100). Any framework `adapter.findMany` that means "all rows" is capped.
- Settled, sound: `session.token` unique, `session.user_id`, `account.user_id`, `verification.identifier` indexes are
  created by Better-Auth's migrator on table creation; `users` gets `ux email`, partial `ix iam_id` from the Mongoose
  indexes (so mapSessionUser's 3-way `$or` is a BitmapOr); runtime schema check cached after first clean result;
  Better-Auth's `findVerificationValue` deletes ALL expired verification rows (seq scan, no expires_at index on SQL).
- Derive the users-table SQL indexes: `node -r ./src/core/modules/migrate/helpers/ts-compiler.js script.mjs` importing
  `UserSchema` + `describeSchema` + `desiredTable` (tsx lacks decorator metadata → CannotDetermineTypeError).

**Phase 4 (DEV-3832, AI + MCP OAuth + file metadata on the store, expiry sweep), reviewed 2026-10-28 — zero Critical/High.**
- `loadRecentMessages()` lost its server-side `$slice: -limit` (reads up to 500 messages, slices in JS). Measured
  (mongoose 9.11, local mongod): per turn +1 ms at 500x1.5 KB, +7.6 ms at 500x8 KB, +40 ms at 300x50 KB (14 MB doc);
  sync BSON parse 1.4 / 5.8 / 21 ms. Below the bar because `appendMessage()` ALREADY returns the full document twice per
  turn (`findByIdAndUpdate` returns the doc; now lean, was hydrated) — the read adds ~1/3, it does not create the class.
  Bench script pattern: scratchpad `conv-bench.mjs` (old sliced+2x hydrated push vs new full+2x lean push).
- Expiry sweep: one `DELETE ... WHERE ttl_field < now - ttl` per SQL TTL table (index derived from the TTL index), lease
  `expiry-sweep:<key>` 900 s in lt_locks, unref timer, first run at bootstrap not awaited. Better-Auth sweep = adapter
  `deleteMany` (single DELETE, no limit) on `session`/`verification` — no `expires_at` index there, seq scan per 15 min.
- `CoreFileService.s3Files`/`filesystemFiles` are getters now: `db.collection()` (new handle) or a closure object per
  access, µs. `ensureFilenameIndex` keys by namespace, SQL `createIndex` is a no-op. `sqlFileCollection.find` drops
  `projection` (harmless, small rows). Budget `sum()` on SQL hits `(user_id|tenant_id, created_at)` compound indexes.
- `upsertRecord()`: Mongo 1 trip (exists) / 2 (insert); SQL updateOne-miss = UPDATE+EXISTS, so 3 on insert. Only admin
  preference set + tool-grant confirm use it.

**How to measure without DROP** (the PreToolUse hook blocks `DROP DATABASE`): register models whose fields collide on one column (`fooBar` + `foo_bar`) so `desiredTable()` throws inside the owner transaction after the lock → everything rolls back, nothing is created. Hold `pg_advisory_lock(hashtext('lenne.tech:schema'))` from a side connection to simulate another replica migrating. Scripts ran via `node_modules/.bin/tsx` as `.mts` with absolute imports of `src/**.ts`.

Related: [[persistence-layer-db-agnostic-costs]]
