# Database-agnostic nest-server — the database as a dimension

> **Status:** planned 2026-10-27 against nest-server 12.0.0, assumptions validated by prototypes (§5).
> **Branch:** `feat/db-agnostic` (recreated from `develop` at 12.0.0; one commit per phase, no PR until the owner asks).
> **Linear:** epic DEV-3827, one sub-issue per phase (DEV-3828 … DEV-3833).
> **Supersedes** the plan of 2026-08-14 (11.34.0, option C + Prisma; preserved as tag `archive/db-agnostic-plan-2026-08`). §4 records why.
> Read this file completely before writing code. The task list without the reasoning produces the wrong thing.

---

## 1. Goal and objective function

The owner's goal, unchanged since August: **one codebase, one security model, one place to fix things — with the
database as a swappable dimension, like REST and GraphQL.** MongoDB stays fully supported and backward compatible for
the ~30 consumer projects; PostgreSQL is the first additional database; further databases (MySQL/MariaDB, SQLite,
others) must be cheap and stable to add later. **Compatibility with NestJS has top priority**: everything is wired
through NestJS dynamic modules, providers and injection tokens, nothing bypasses the DI container.

Anything that makes a second security implementation, a second CrudService pipeline or a "second-class Postgres mode"
loses against this objective, however convenient.

## 2. Where 12.0.0 stands (re-measured 2026-10-27, not inherited)

| Fact | Value |
|---|---|
| `src/core` | 373 files, 77,459 LOC |
| Files importing a Mongo package | 76 (+11 coupled without importing) |
| Lines touching a Mongo API | ~1,302 (1.7 %) — the coupling is thin but sits in security, identity and atomicity |
| CrudService | 35 public methods, 13 with neutral signatures; `ServiceOptions` carries `populate`, `collation`, `select`, `dbModel` |
| Services extending CrudService | `CoreUserService` + 11 AI services. Tenant, API token, Better-Auth, file, TUS, setup, cron, migrate, Hub, MCP OAuth use Models or the driver directly |
| Mongoose plugins | tenant 430 LOC (fail-closed `ForbiddenException`, rewrites aggregate stages), role guard, system role, audit, password, id |
| Native driver | 19 files; Better-Auth alone 36 `.collection(` call sites, shared `users` collection with nest-server's User |
| Atomicity | 0 transactions, 0 change streams; 4 duplicate-key detections (2 on message text), 7 upsert claims, 2 `findOneAndDelete` single-use; 7 check-then-act races |
| TTL indexes | 5, two of them carry correctness (cron lease release, MCP OAuth code expiry) |
| Populate | only via `db.helper` `popAndMap/setPopulates` driven by GraphQL selection; 5 `ref:` declarations repo-wide |
| Tests | 94 of 294 test files reach Mongo directly; 460 raw `users/session/account` accesses |
| Mongo switch-off | impossible today: `MongooseModule.forRoot` always loaded (`core.module.ts:430`) |

Full inventory: `research-coupling.md` (session scratchpad, 2026-10-27); summarised where needed below.

## 3. The design

### 3.1 One CrudService, many stores — the seam sits below the security pipeline

```
 Controller / Resolver / MCP tool / AI tool / project service
                 │
 CrudService / ModuleService.process()     prepareInput → checkRights → serviceFunc → populate
                 │                          → prepareOutput → checkRights      (exists ONCE, DB-free)
                 ▼
 DataStore<T>   neutral port per model: CRUD, count, distinct, upsert, increment, push/pull,
                 │                       transaction, capabilities; neutral Where; opaque string ids
     ┌───────────┴─────────────┐
 MongooseDataStore          SqlDataStore (Kysely)
 wraps the Model;           dialect: postgres (now) | mysql | sqlite (later)
 plugins fire as today      policies applied in the store + DB-enforced floor (RLS, CHECK)
```

* **The security pipeline is not touched.** `input.helper` (rights engine, 0 Mongo refs), `restricted.decorator`, the
  four interceptors, `RequestContext`, permissions — all already driver-free. Only `serviceFunc` calls the store.
* **Adding a database = a store + a query compiler + a schema compiler + a contract run.** Never a new CrudService.

### 3.2 Neutral query language = the Mongo-operator subset the codebase already speaks

`generateFilterQuery()` already emits it, consumers already write it in `{ filterQuery }`, MikroORM uses the same
vocabulary for SQL. Supported on every driver: `$eq $ne $gt $gte $lt $lte $in $nin $exists $regex/$options $and $or
$nor $not $all $size $elemMatch`, implicit equality, dot paths into embedded documents, array-contains semantics.
Mongo passes the object through untouched (zero drift). The SQL compiler validates every path against model metadata
(`^[A-Za-z_]\w*$` segments, known fields only), parameterises every value, and **refuses** what it cannot express
(`UnsupportedQueryError`) — it never drops a condition. Validated: §5 A2.

Typed as `Where<T>` (own type, not Mongoose's `QueryFilter`), so the public signatures stop importing mongoose while
the syntax consumers know keeps working.

### 3.3 Model metadata is the single source

A `ModelMetadataRegistry` holds a neutral `FieldDescriptor` per field: kind (string, number, boolean, date, id, ref,
json, enum), array, nested type, optional, default, unique, index, sparse/partial, enum values, ref target +
cardinality, `select: false`, `lowercase`/`trim`, TTL. Two sources, merged:

1. **`@UnifiedField`** records the descriptor itself (it already knows type, array, nested type, enum, optional,
   roles) and interprets its `mongoose:` option keys that matter (`unique`, `index`, `default`, `ref`, `enum`,
   `select`, `lowercase`, `trim`, `expires`).
2. **Fallback: the class's Mongoose schema** (`SchemaFactory.createForClass`, works without a connection). Fields
   declared with a plain `@Prop()` — common in consumer projects — are derived from `schema.paths`, the same
   reverse-engineering the Hub's ERD already does. Existing models therefore work on SQL without being edited.

The SQL side builds tables from the descriptors: scalar → column (snake_case), declared nested object/array and
`isAny` → `jsonb`, ref → `text` + index (no hard FK across modules — Medusa-style links keep core modules swappable),
`createdAt`/`updatedAt` columns, compound indexes from the class options.

### 3.4 Persistence policies are extracted, not duplicated

The decision logic of the tenant, audit, role-guard, system-role and password plugins moves into pure functions
(`common/persistence/policies/`). The Mongoose plugins become thin adapters that call them — their behaviour is pinned
by the existing plugin suites and registered mutations. The SQL store calls the same functions around every
operation. **A security fix lands in one function and reaches every driver.**

| Policy | Mongo (unchanged behaviour) | SQL |
|---|---|---|
| Tenant scope | plugin adds `{tenantId}` filter, throws `ForbiddenException` without context | store adds the same filter + **RLS floor**: `FORCE ROW LEVEL SECURITY`, app role without `BYPASSRLS`, guard function raising `42501` without context (mapped to `ForbiddenException`), explicit system mode for cron/migrations/seeds |
| Audit fields | plugin stamps `createdBy`/`updatedBy` | store stamps via the same function |
| Password hashing | plugin bcrypt(sha256) | store via the same function |
| Role guard | plugin strips unauthorised `roles` changes | store via the same function |
| System roles | plugin refuses introduced `s_*` | store via the same function + `CHECK` constraint on `roles` |

### 3.5 Opaque string ids

The core treats ids as strings everywhere (`IdType` / `StringOrObjectId` lose their `mongoose` import; id validation
asks the driver). Default id format on SQL: **ObjectId-hex generated in the app** — one wire format across the fleet,
validators/URLs/tests unchanged, a Mongo→PG data move keeps every id. `uuidv7` as a later option.

### 3.6 Honest capabilities instead of a lowest common denominator

`store.capabilities` (`transactions`, `aggregatePipeline`, `mongoosePopulate`, `rawFilterArm`, `gridfs`, `rls`,
`textSearch`, `changeFeed`, `idType`). Features ask the store, never the driver name. An unavailable capability
**fails at boot when configured** (same rule as the file-storage driver), and at the call with a named error otherwise.

| | MongoDB | PostgreSQL |
|---|---|---|
| 13 neutral CrudService methods, filter DSL, paging, sort, count | yes | yes |
| `find*/findOne*/read*` with `{ filterQuery }` | yes | yes — the subset of §3.2 |
| Rights engine, interceptors, REST + GraphQL | yes | yes |
| `pushToArray` / `pullFromArray` incl. `$slice` | yes | yes (atomic JSONB, validated) |
| Populate | Mongoose populate | batched `IN` follow-up reads (what Mongoose populate does) |
| `aggregate()` | yes | no → `getQueryBuilder(reason)` (Kysely) as the SQL escape hatch |
| Transactions | only on a replica set | yes, per request (needed for RLS) |
| Multi-tenancy | plugin | policy + RLS |
| GridFS | yes | no → S3 / filesystem (driver derivation) |
| Better-Auth | `mongodbAdapter` | built-in Kysely adapter on the same Kysely instance |
| `$exists` on a column | present vs. absent | `IS NOT NULL` — DIFFERENT-BY-DESIGN (SQL has no "absent") |

### 3.7 Infrastructure stores

Framework infrastructure gets narrow stores, each with a Mongo and a SQL implementation and **one** contract suite:
`LockStore` (`tryAcquire(key, owner, ttl)`/`renew`/`release`; system-setup claim, migration lock, cron lease — replaces
the E11000 string matching), migration state, single-use tokens with an **explicit expiry predicate** (MCP OAuth codes,
passkey challenges — never rely on a TTL monitor for correctness).

### 3.8 Transactions and request context

A unit of work per request lives in `RequestContext` (ALS): HTTP middleware, GraphQL WebSocket events, cron ticks.
On SQL every request runs its store calls inside one transaction that first sets `app.tenant_id` / `app.tenant_ids` /
`app.system` with `set_config(…, true)` (transaction-local, PgBouncer-safe, validated not to leak). On Mongo the unit
of work is a no-op unless a replica set is configured.

### 3.9 Driver selection and NestJS wiring

* Config: `database: { driver: 'postgres', url, schema?, idType?, pool? }`. Absent + `mongoose` config → MongoDB,
  exactly as today (presence-implies-enabled, no breaking change).
* `CorePersistenceModule.forFeature([Project, …])` registers models neutrally (delegates to
  `MongooseModule.forFeature` on Mongo); `@InjectStore(Project)` injects the store, analogous to `@InjectModel`.
  `ModuleService` accepts `store` next to `mainDbModel`; on Mongo `mainDbModel` stays available, so no consumer has to
  change anything.
* SQL libraries (`kysely`, `pg`) are **optional peer dependencies**, lazy-loaded at bootstrap (pattern of
  `ioredis`/`@aws-sdk`); configured-but-missing fails the boot with a named error. Mongo becomes optional only in the
  last phase (MINOR with migration guide).

## 4. Comparison with the earlier approaches — and the decision

| Question | Plan 2026-08 (option C) | nest-base (donor) | This plan | Why |
|---|---|---|---|---|
| Where is the seam? | two `CrudService` implementations sharing upper layers | services call Prisma directly | **one CrudService over a store port** | the pipeline exists once; a third database is a store, not a third CrudService |
| Why was the port rejected in August? | leaks at the raw `filterQuery` arm, `aggregate`, `populate` | — | the raw arm **is** the neutral language (28/28 parity, A2); `aggregate` is a declared capability; populate gets a neutral implementation | the objection is answered by evidence |
| SQL toolkit | Prisma | Prisma 7 | **Kysely** (+ own metadata→DDL via Kysely's schema builder and introspection) | Prisma: codegen schema file vs. `@UnifiedField` as single source, Prisma 7 no Mongo, v8 still RC, client extensions do not see `$queryRaw`, Better-Auth peer ≤ 7. Kysely: dynamic, dialect-portable, ESM and `require()`-able (A1), Better-Auth's own engine — one instance, one pool (A6) |
| MikroORM? | — | — | **not adopted** | runs (A7) but brings 11 MB, Node ≥ 22.17, a unit-of-work model the plain-object pipeline does not want, `varchar(255)` defaults, and a second policy engine (filters) competing with ours. Kysely's introspection gives a dialect-neutral differ for additive migrations; destructive changes are hand-written migrations anyway |
| Tenancy | gate experiment, "decide separately", maybe not in v1 | RLS declared but bypassed (superuser/owner role, no FORCE, never tested) | **in from the start**: shared policy + RLS floor done right | A3 answered the August gate question: missing context raises `42501` for query builder **and** raw SQL, foreign rows read as 0 rows exactly like the Mongo filter |
| Atomic claims | no-regret item: `LockStore`, Prisma `upsert` not atomic | advisory lock (pool-unsafe) | `LockStore` with `INSERT … ON CONFLICT … WHERE expires_at < now() RETURNING` | A4: 20 rounds × 16 workers, exactly one winner; stale takeover by exactly one |
| IDs | pay down `IdType` drift | v4/v7 UUIDs mixed | opaque strings + ObjectId-hex on SQL | one wire format; no data-migration id map |
| Metadata | neutral record from `@UnifiedField` | Prisma schema | `@UnifiedField` record **+ Mongoose-schema fallback** | existing `@Prop` models work on SQL unedited |
| Better-Auth | "touching its storage: not no-regret" | `prismaAdapter` | built-in Kysely adapter on the shared instance, `user` mapped onto `users` | A6: ObjectId-hex ids, snake_case mapping, `input: false` holds |
| Test strategy | file-storage parity matrix as model | static `check:rls` that never fails | **persistence parity matrix** (EXECUTED / IMPOSSIBLE / DIFFERENT-BY-DESIGN per cell) + RLS tests as the non-owner app role | a capability nobody asserts is indistinguishable from a bug |

**Kept from August:** the objective function, the abort criteria idea (§8), the no-regret ordering (LockStore, ids,
metadata first), the parity-matrix discipline, the non-negotiable constraints (§9), the downstream list (§10).
**Harvested from nest-base:** the RLS mechanism (`SET LOCAL` per transaction) — enforced and tested this time; narrow
storage interfaces per infrastructure feature with contract tests; the outbox claim pattern for the later queue work.
**Avoided from nest-base:** decorative RLS, features on a second client no production path uses, a different
"no tenant" answer per layer, type-only authorization.

## 5. Validated assumptions (prototypes, 2026-10-27, Postgres 18 + MongoDB 7, scripts in the session scratchpad)

| # | Assumption | Result |
|---|---|---|
| A1 | `kysely`, `pg`, `better-auth` load via `require()` from CommonJS | PASS (no top-level await) |
| A2 | Mongo-operator subset compiles to SQL with identical results | **28/28 identical** against MongoDB incl. `$ne`/`$nin` with missing fields, `null`, array semantics, dot paths, `$elemMatch`, `$nor`, `$not`, dates, regex; 1 DIFFERENT-BY-DESIGN (`$exists` on a column with explicit `null`); unknown field, injected path segment, `$where`, `$text`, positional path refused |
| A3 | RLS fail-closed | PASS 10/10: tenant sees only its rows; raw SQL filtered; **missing context raises `42501`** on a reused pooled connection and for raw SQL; foreign insert/update refused; system mode explicit; no leak to the next transaction; app role cannot disable RLS |
| A4 | atomic claim / lease | PASS: 20 × 16 parallel workers → exactly one winner each; expired lease taken over by exactly one; token-scoped release |
| A5 | atomic JSONB push/pull | PASS: 50 concurrent capped pushes keep exactly 30; 40 concurrent pushes all land; pull by scalar and by object condition |
| A6 | Better-Auth on Postgres, shared Kysely instance | PASS: migrator plans `users/session/account/verification`; sign-up/sign-in; 24-hex ids; snake_case columns; framework columns coexist; `roles` `input:false` stays `[]` |
| A7 | own metadata→DDL + additive diff is small | PASS: create 5 statements, diff v1→v2 3 statements, re-diff 0, required column without default refused (~60 LOC prototype); MikroORM alternative also works (see §4) |

## 6. Phases

Every phase: TDD, `pnpm run check` green, the test count never drops, every behaviour fix pinned by a registered
mutation, review, the owner's test approval, one commit pushed to `feat/db-agnostic`. Phases 0–4 change **nothing**
for a MongoDB project (the existing ~5,900 tests are the proof); only phase 5 carries a breaking change.

### Phase 0 — Groundwork, MongoDB only, zero behaviour change (DEV-3828)
1. `ModelMetadataRegistry` + `FieldDescriptor` from `@UnifiedField` and the Mongoose-schema fallback; unit tests over
   every core model (descriptor snapshot) and the reference server's models.
2. Opaque ids: `IdType`/`StringOrObjectId` without `mongoose` imports; `isValidId()` via the active driver;
   `id.helper` stays a leaf.
3. Policies extracted from the five security plugins into pure functions; plugins delegate; all plugin suites and
   mutations unchanged and green.
4. `DataStore<T>` port, `Where<T>` type, capability flags, `MongooseDataStore`; `CrudService`/`ModuleService` call the
   store internally; `@InjectStore` + `CorePersistenceModule.forFeature` (Mongo delegation); `mainDbModel` stays.
5. `LockStore` (Mongo implementation) replacing the system-setup claim, the migration lock and the cron lease;
   contract suite with an N-worker race.
6. Persistence parity matrix scaffold (`tests/helpers/persistence-matrix.ts`) with the Mongo column filled.

### Phase 1 — SQL driver core on PostgreSQL (DEV-3829)
1. `database` config, `CoreSqlModule` (Kysely + `pg` pool, optional peers, lazy), per-request unit of work in
   `RequestContext`, explicit system mode.
2. Schema compiler (descriptors → Kysely schema builder) + additive differ (Kysely introspection) + SQL migration
   runner (state table + `LockStore`) + `migrate:create --sql` generating reviewable migration files.
3. `SqlDataStore`: CRUD, `Where` compiler (§3.2), sort/skip/limit, `findAndCount` without `$facet`, distinct, JSONB
   push/pull/slice, increment, upsert/claim, neutral populate (batched `IN`), Postgres error → HTTP mapping
   (`23505` unique → 400 like E11000, `22P02` invalid id → 404/400 like `MongooseCastErrorFilter`).
4. Policies in the store + RLS floor (policies generated for tenant-scoped tables, app/system roles, guard function)
   + system-role `CHECK`.
5. Postgres test container in `scripts/test-infra.mjs` (pinned image, own port), per-run database under the existing
   drop guard; parity matrix Postgres column: the whole CrudService contract green on both drivers.

### Phase 2 — Core modules on SQL (DEV-3830)
User (unique email, partial reset-token index, token maps as JSONB), Tenant (+ `isTenantActive` with a neutral
handle), API tokens, system setup (`LockStore`), cron leases (`LockStore` + explicit expiry), error codes, health check
(SQL ping indicator), permissions (nothing to do), Hub (driver-aware panels; Mongo-only panels report
`available: false`), migrate module on SQL.

### Phase 3 — Better-Auth on SQL (DEV-3831)
Kysely adapter on the shared instance, `user` → `users` mapping (snake_case), ObjectId-hex ids, Better-Auth migrations
inside the framework's migration flow; user mapper, token service, challenge service and backfills behind an
`IamUserStore` with Mongo (current code moved) and SQL implementations; the full Better-Auth story suites green on
both drivers.

### Phase 4 — Files, TUS, AI, MCP OAuth (DEV-3832)
File/TUS metadata store neutral (S3 + filesystem on SQL; GridFS Mongo-only, derived-driver rule extended); AI module's
11 models via CrudService on both drivers, its 3 schema-less collections as tables, aggregates replaced by named store
methods, TTL correctness replaced by explicit expiry predicates + sweeper on the cron lease.

### Phase 5 — Postgres as a first-class target, Mongo optional, release (DEV-3833)
Reference server bootable on Postgres (`NSC__DATABASE__DRIVER=postgres`); CI matrix `db: [mongodb, postgres]` running
the full e2e suite; `mongoose`/`@nestjs/mongoose`/`mongodb` become optional peers, `MongooseModule` only when
configured, `@UnifiedField` without a static `@nestjs/mongoose` import; docs (README, REQUEST-LIFECYCLE,
configurable-features, native-driver-security, CLAUDE.md), migration guide for the release (MINOR); downstream tickets
(§10).

## 7. Effort (rough, new + touched LOC)

Phase 0 ~2,500 · Phase 1 ~4,000 · Phase 2 ~3,000 · Phase 3 ~2,500 · Phase 4 ~3,000 · Phase 5 ~2,000 + downstream.

## 8. Gates and abort criteria

* **After phase 1:** the whole CrudService contract and the tenant suite must pass on Postgres with the **same**
  observable semantics (403 without context, 0 rows for a foreign tenant, refused foreign writes). If not: stop and
  report — an "equal status" label on a second-class mode is the worst outcome available.
* **Phase 0 must not change Mongo behaviour.** Any existing test that has to be edited (not extended) to stay green is
  a stop-and-explain, not a quiet fix.
* **A capability nobody can implement on a driver** is declared IMPOSSIBLE in the matrix with a reason — never left
  out.

## 9. Non-negotiable constraints

1. `pnpm run check` green after every step; test count never drops.
2. Every behaviour fix ships with a test observed failing without it (registered mutation, `check:mutations`).
3. Never weaken an assertion to get green; a deliberately changed expectation is said out loud.
4. `src/core/` stays self-contained; ESM rules (`.js` specifiers, no `require`/`__dirname`/`import.meta`, no top-level
   await, `import type`); DI tokens in import-free leaves (`check:swc-tdz`, `typecheck:vendor`, `check:esm`).
5. Optional peers stay lazy; a project using neither Redis, S3 nor Postgres installs nothing extra and behaves as before.
6. No `@ts-ignore`, no lint disables, no skipped tests.
7. Comments explain WHY, in English, and are true.
8. The reference server (`src/server`) exercises every new seam as code.
9. The CLAUDE.md "High-Frequency Path" rules are rewritten per driver in phase 5 — they currently tell developers to
   bypass CrudService **because** the Mongoose plugins still fire; on SQL the store, not a plugin, applies the policies.

## 10. Downstream (cross-repo, phase 5 tickets)

* **lt CLI:** module/object templates and `lt server addProp` emit the neutral form (`CorePersistenceModule`,
  `@InjectStore`); `lt fullstack init --db postgres`; vendor mode: subsystem-aware copy so a Postgres vendor project
  does not receive the Mongoose driver as its own code; `vendor-runtime-deps.json` gains the SQL peers.
* **nest-server-starter:** Postgres variant (compose service, config, migrations folder).
* **lt-dev plugin:** generating-nest-servers / nest-server-updating know both drivers.

## 11. Decisions taken in this plan (owner may revise)

* Kysely, not Prisma/MikroORM/Drizzle (§4).
* Mongo-operator subset as the neutral query language (§3.2).
* ObjectId-hex default ids on SQL (§3.5).
* snake_case columns with explicit mapping (Better-Auth mapped accordingly, A6).
* No hard foreign keys across modules; refs are indexed text columns.
* RLS mandatory for tenant-scoped tables on Postgres; the API connects as a non-owner role.
