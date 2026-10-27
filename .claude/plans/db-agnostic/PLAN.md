# Database-agnostic nest-server — the database as a dimension

> **Status:** planned 2026-10-27 against nest-server 12.0.0, revised the same day after the engine evaluation and the
> owner's decision round (§11). Assumptions validated by prototypes (§5, scripts in `prototypes/`).
> **Branch:** `feat/db-agnostic` (recreated from `develop` at 12.0.0; one commit per phase, no PR until the owner asks).
> **Linear:** epic DEV-3827, one sub-issue per phase (DEV-3828 … DEV-3833, phase 6: DEV-3848); downstream DEV-3849
> (lt-dev), DEV-3850 (lt CLI), DEV-3851 (starter + monorepo).
> **Supersedes** the plan of 2026-08-14 (11.34.0, option C + Prisma; preserved as tag `archive/db-agnostic-plan-2026-08`). §4 records why.
> Read this file completely before writing code. The task list without the reasoning produces the wrong thing.

---

## 1. Goal and objective function

The owner's goal, unchanged since August: **one codebase, one security model, one place to fix things — with the
database as a swappable dimension, like REST and GraphQL.** MongoDB stays fully supported and backward compatible for
the ~30 consumer projects and stays the default for new projects; PostgreSQL is the first additional database;
MySQL/MariaDB follow; further databases must be cheap and stable to add later. A project may use one database, several
at once (a default plus exceptions per model), or none.

Three priorities, in this order of non-negotiability:

1. **Security and tenant isolation** hold for every combination of database and engine. Whatever the database or the
   engine can enforce itself is used in addition — for integration and performance — but the guarantee never depends
   on it: the framework's own layer gives the same answer everywhere (§3.4).
2. **Compatibility with NestJS**: everything is wired through NestJS dynamic modules, providers and injection tokens;
   nothing bypasses the DI container. The default SQL engine is the one NestJS documents first (TypeORM).
3. **Configuration stays trivial**: one URL for a single database; exceptions only where a model deviates (§3.9).
   Switching the SQL engine on the same database is a configuration change (§3.10, validated A9).

Anything that makes a second security implementation, a second CrudService pipeline or a "second-class SQL mode"
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
| Kysely | already installed in every project: a hard dependency of `better-auth` (required peer), which runs its SQL adapters on it |

## 3. The design

### 3.1 One CrudService, many stores — the seam sits below the security pipeline

```
 Controller / Resolver / MCP tool / AI tool / project service
                 │
 CrudService / ModuleService.process()     prepareInput → checkRights → serviceFunc → populate
                 │                          → prepareOutput → checkRights      (exists ONCE, DB-free)
                 ▼
 DataStore<T>   neutral port per model: CRUD, count, distinct, upsert, increment, push/pull, transaction,
                 │                       capabilities, native(reason), raw(reason); neutral Where; opaque string ids
                 │                       tenant policy BEFORE every call, tenant row check AFTER every read (§3.4)
     ┌───────────┴──────────────────────────┐
 MongooseDataStore                       SqlDataStore  (one implementation for every SQL database)
 wraps the Model; plugins fire           Where compiler + DDL + catalog introspection per DIALECT
 as today                                (postgres now, mysql/mariadb in phase 6) — engine-neutral SQL text
                                                  │
                                         SqlExecutor port: query · transaction · native · driverPool
                                          ┌───────┼────────┐
                                       TypeORM  Kysely  Drizzle     ← adapter chosen by configuration
                                          └───────┴────────┘
                                         framework pool guard on the driver pool (pg / mysql2)
```

* **The security pipeline is not touched.** `input.helper` (rights engine, 0 Mongo refs), `restricted.decorator`, the
  four interceptors, `RequestContext`, permissions — all already driver-free. Only `serviceFunc` calls the store.
* **Adding a database = a dialect (compiler + DDL + introspection) + a contract run.** Never a new CrudService.
* **Adding an engine = an executor adapter (~150–300 LOC) + a contract run.** The engine never sees a query the
  framework did not compile, so it cannot change semantics or security.

### 3.2 Neutral query language = the Mongo-operator subset the codebase already speaks

`generateFilterQuery()` already emits it, consumers already write it in `{ filterQuery }`. Supported on every driver:
`$eq $ne $gt $gte $lt $lte $in $nin $exists $regex/$options $and $or $nor $not $all $size $elemMatch`, implicit
equality, dot paths into embedded documents, array-contains semantics. Mongo passes the object through untouched (zero
drift). The SQL compiler validates every path against model metadata (`^[A-Za-z_]\w*$` segments, known fields only —
an **identifier allowlist**, because every SQL library had injection advisories on identifiers and JSON paths in
2025–2026), parameterises every value, and **refuses** what it cannot express (`UnsupportedQueryError`) — it never
drops a condition. It emits SQL text plus parameters, not engine objects, which is what makes the engine swappable.
Validated: A2 (28/28), A9 (identical through four engines).

Typed as `Where<T>` (own type, not Mongoose's `QueryFilter`), so the public signatures stop importing mongoose while
the syntax consumers know keeps working.

### 3.3 Model metadata is the single source

A `ModelMetadataRegistry` holds a neutral `FieldDescriptor` per field: kind (string, number, boolean, date, id, ref,
json, enum), array, nested type, optional, default, unique, index, sparse/partial, enum values, ref target +
cardinality, `select: false`, `lowercase`/`trim`, TTL, `renamedFrom`, and the model's data source. Two sources, merged:

1. **`@UnifiedField`** records the descriptor itself (it already knows type, array, nested type, enum, optional,
   roles) and interprets its `mongoose:` option keys that matter (`unique`, `index`, `default`, `ref`, `enum`,
   `select`, `lowercase`, `trim`, `expires`).
2. **Fallback: the class's Mongoose schema** (`SchemaFactory.createForClass`, works without a connection). Fields
   declared with a plain `@Prop()` — common in consumer projects — are derived from `schema.paths`, the same
   reverse-engineering the Hub's ERD already does. Existing models therefore work on SQL without being edited.

**Order (decided while implementing phase 0):** phase 0 derives the descriptor from the Mongoose schema only — it
already contains both `@UnifiedField({ mongoose })` and plain `@Prop()` declarations, exactly as MongoDB stores them,
and a second source that must agree would add risk without adding coverage while Mongoose is always present. The
`@UnifiedField` source arrives in phase 5, when Mongoose becomes optional; the descriptor snapshot over every core and
reference model (`tests/unit/persistence-model-descriptor.spec.ts`) is what proves both sources agree. Probed on
Mongoose 9: `type: Types.ObjectId` (the bson class) reports as `Mixed`, so a reference is recognised by its `ref`
option, never by its type; a nested class without `@Schema` is stored as `Mixed` and therefore described as JSON.

The SQL side builds tables from the descriptors: scalar → column (snake_case), declared nested object/array and
`isAny` → JSON (`jsonb` on Postgres), ref → indexed text column (no hard FK across modules — keeps core modules
swappable), `createdAt`/`updatedAt` columns, compound indexes from the class options, `tenant_id` leading in every
compound index of a tenant-scoped table. Value mapping (e.g. MariaDB returns JSON as a string, A11) is done by the
store from the descriptor, never left to an engine.

### 3.4 Security and tenancy: three layers, every database, every engine

The decision logic of the tenant, audit, role-guard, system-role and password plugins moves into pure functions
(`common/persistence/policies/`). The Mongoose plugins become thin adapters that call them — their behaviour is pinned
by the existing plugin suites and registered mutations. The SQL store calls the same functions around every
operation. **A security fix lands in one function and reaches every database and every engine.**

| Layer | What it does | MongoDB | PostgreSQL | MySQL / MariaDB |
|---|---|---|---|---|
| **Before** (framework, identical everywhere) | tenant filter, write stamping, foreign-tenant refusal, safety net, audit, password, role guard, system-role refusal | plugins (calling the policy functions) | store (same functions) | store (same functions) |
| **Database** (used wherever it exists) | enforcement below the application, also for native and raw access | — | RLS: `FORCE ROW LEVEL SECURITY`, non-owner app role without `BYPASSRLS`, guard function raising `42501` without context, `WITH CHECK` on writes, system-role `CHECK` | evaluated in phase 6: write guard via triggers on session variables (no row-level read isolation exists in these databases) |
| **After** (framework, identical everywhere) | **tenant row check**: every row the store returns for a tenant-scoped model must carry a tenant id from the allowed set, else 403 — new, on every database including MongoDB; then the unchanged output pipeline: `prepareOutput`, `checkRights`, `@Restricted`, `securityCheck()`, `CheckResponseInterceptor`, `CheckSecurityInterceptor` | yes | yes | yes |

The store also adds the `WHERE tenant_id …` predicate on Postgres although RLS enforces it: the predicate lets the
planner use the tenant index, and the before-layer guarantee must not depend on the database layer. RLS policies call
the guard function as `(SELECT app_current_tenant())` so it is evaluated once per statement (initplan), not per row.

**Every behaviour of today's tenant plugin, and its counterpart:**

| Today (Mongoose plugin) | Before-layer (all databases) | PostgreSQL in addition |
|---|---|---|
| Read filter `{ tenantId }` / `{ tenantId: { $in: tenantIds } }` on find, findOne, count, distinct | store adds `tenant_id = $n` / `= ANY($n)` | RLS `USING` |
| Filter on update/delete/`findOneAnd*`/`replaceOne`/bulk operations | store adds the predicate | RLS `USING` |
| Stamp `tenantId` on create (save, insertMany, bulk insert) | store stamps | RLS `WITH CHECK` |
| Refuse a foreign `tenantId` on create, and moving a row (also via `$set` / `$setOnInsert`) | same `assertOwnTenant`, 403 | RLS `WITH CHECK` |
| Safety net: tenant-scoped data without a valid context → 403 | same function, same `ForbiddenException` | guard function → `42501` → 403 |
| Admin bypass without header sees all; `runWithBypassTenantGuard()`; no `RequestContext` = system work | same decisions, sent to the database as an explicit system mode | system mode per transaction |
| `excludeSchemas` incl. its warning | same config, same warning | no policy for excluded tables |
| `estimatedDocumentCount()` refused in a tenant context | any store estimate refused the same way | — |
| Aggregation: `$match` prepended, `$out`/`$merge` refused, `$lookup`/`$unionWith`/`$graphLookup` secured | no pipeline on SQL; populate and joins go model by model through the store, each with its own policy | RLS filters **every table of a join**, also in native and raw SQL |
| Context must not leak into the next operation | `set_config(…, true)` per transaction + framework pool guard (A10) | validated (A3, A9, A10) |

Outside the plugin, `CoreTenantGuard`, the role hierarchy, `isTenantActive`, the cache with its Redis invalidation,
the WebSocket tenant context, `assertTenantRole`, tenant API tokens and the AI tool registry are already
database-independent; only their data access moves onto the store (phase 2; file and TUS metadata with `tenantId` in
phase 4).

**Pool hygiene is framework-owned (A10).** Under a client-side query timeout, TypeORM 1.1.2 hands broken connections
back to the pool (the pool then hangs) and Kysely 0.29.7 hands back a connection still inside the dead transaction —
the next request read the previous transaction's `app.tenant_id`. Drizzle fixed the same class in `1.0.0-rc.5` (#6114,
#6341; the 0.45 line is still affected). The framework therefore wraps the driver pool of every adapter: a client
returned inside a transaction or with a query in flight is released with an error, so the pool destroys it. Validated
for all four executors; becomes a contract case per adapter with a registered mutation.

### 3.5 Opaque string ids

The core treats ids as strings everywhere (`IdType` / `StringOrObjectId` lose their `mongoose` import; id validation
asks the driver). Default id format on SQL: **ObjectId-hex generated in the app** — one wire format across the fleet,
validators/URLs/tests unchanged, a Mongo→SQL data move keeps every id. `uuidv7` as a later option.

### 3.6 Honest capabilities instead of a lowest common denominator

`store.capabilities` (`transactions`, `aggregatePipeline`, `mongoosePopulate`, `rawFilterArm`, `gridfs`, `rls`,
`textSearch`, `changeFeed`, `idType`). Features ask the store, never the driver name. An unavailable capability
**fails at boot when configured** (same rule as the file-storage driver), and at the call with a named error otherwise.
A transaction spanning two data sources is IMPOSSIBLE and refused.

| | MongoDB | PostgreSQL | MySQL / MariaDB (phase 6) |
|---|---|---|---|
| 13 neutral CrudService methods, filter DSL, paging, sort, count | yes | yes | yes |
| `find*/findOne*/read*` with `{ filterQuery }` | yes | yes — the subset of §3.2 | yes — the subset of §3.2 |
| Rights engine, interceptors, REST + GraphQL | yes | yes | yes |
| `pushToArray` / `pullFromArray` incl. `$slice` | yes | yes (atomic JSONB, A5) | yes (JSON functions, to validate) |
| Populate | Mongoose populate | batched `IN` follow-up reads | batched `IN` follow-up reads |
| `aggregate()` | yes | no → native engine API (§3.11) | no → native engine API |
| Transactions | only on a replica set | yes, per request (needed for RLS) | yes, per request |
| Tenant isolation in the database | — | RLS | — (before + after layers only) |
| GridFS | yes | no → S3 / filesystem (driver derivation) | no → S3 / filesystem |
| Better-Auth | `mongodbAdapter` | its Kysely adapter on the configured engine's driver pool (A6, A8) | same |
| `$exists` on a column | present vs. absent | `IS NOT NULL` — DIFFERENT-BY-DESIGN | same |

### 3.7 Infrastructure stores

Framework infrastructure gets narrow stores, each with a Mongo and a SQL implementation and **one** contract suite:
`LockStore` (`tryAcquire(key, owner, ttl)`/`renew`/`release`; system-setup claim, migration lock, cron lease — replaces
the E11000 string matching; SQL: `INSERT … ON CONFLICT … WHERE expires_at < now()` on Postgres, `INSERT IGNORE` +
conditional `UPDATE` on MySQL, A4/A11), migration state, single-use tokens with an **explicit expiry predicate** (MCP
OAuth codes, passkey challenges — never rely on a TTL monitor for correctness).

### 3.8 Transactions and request context

A unit of work per request lives in `RequestContext` (ALS): HTTP middleware, GraphQL WebSocket events, cron ticks.
On SQL every request runs its store calls inside one transaction that first sets `app.tenant_id` / `app.tenant_ids` /
`app.system` with `set_config(…, true)` (transaction-local, PgBouncer-safe, validated not to leak — A3, A9, A10). On
Mongo the unit of work is a no-op unless a replica set is configured.

### 3.9 Configuration: one default, exceptions per model, or none

```ts
// MongoDB exactly as today — nothing to change
mongoose: { uri: 'mongodb://…' }

// One SQL database: one line. Driver from the URL scheme, engine defaults to TypeORM
database: 'postgres://app@db/app'

// Default plus exceptions
database: {
  url: 'postgres://app@db/app',                       // default source for every model
  sqlEngine: 'typeorm',                               // 'typeorm' (default) | 'kysely' | 'drizzle'
  sources: { logs: 'mongodb://…/logs' },              // further sources, same shorthand rules
  models: { AuditEntry: 'logs' },                     // the exceptions: model → source
}

// No database at all (stateless service, gateway)
database: false
```

* Schemes: `mongodb://`, `mongodb+srv://` → MongoDB; `postgres://`, `postgresql://` → PostgreSQL; `mysql://` → MySQL;
  `mariadb://` → MariaDB. A source may carry its own `sqlEngine`.
* A model may also declare its source in code (`@PersistedModel({ dataSource: 'logs' })`). Precedence:
  **config > decorator > default**, so operations can move a model without a code change.
* `mongoose` alone keeps today's behaviour (it is the default source). When `database` sets a default and the project
  ALSO configures `mongoose` explicitly, that MongoDB becomes the additional source `mongoose` (a hybrid project needs
  no extra key). Only the project's own `mongoose` counts: `CoreModule.forRoot()` always merges a fallback URI in, so
  "both configured → boot error", as first planned, would have refused every project that sets `database`.
* Connection URLs appear in errors and logs as scheme + host only — never with credentials, path or options.
* Boot validation: unknown source names, a model needing a capability its source lacks, an engine configured but not
  installed, an engine on a dialect it does not support — each fails the boot with a named error. The boot logs one
  line per model: model → source → database → engine.
* SQL engines and drivers (`typeorm`, `kysely`, `drizzle-orm`, `pg`, `mysql2`) are **optional peer dependencies**,
  lazy-loaded (pattern of `ioredis`/`@aws-sdk`). `@nestjs/typeorm` is not required: the framework registers its own
  providers; TypeORM runs with `synchronize: false`, asserted at boot.

### 3.10 The SQL engine is an adapter (validated A9)

The `SqlExecutor` port has four members: `query(text, params)`, `transaction(fn)`, `native` (the engine's own handle,
bound to the current transaction) and `driverPool` (for Better-Auth). Everything that must behave identically — query
compilation, policies, RLS settings, schema evolution, locks, pool hygiene — lives above it. Consequences, all
validated with one store scenario and four executors (`16-engine-switch.mjs`):

* **Engine switch on the same database = configuration only.** Tables stay identical because the framework owns the
  schema. CrudService, REST, GraphQL, policies, RLS, Better-Auth and raw SQL keep working.
* **Database switch** (MongoDB ↔ SQL): configuration for a new project; existing data needs a data move (a later
  export/import tool over the store port can do it, ids survive by §3.5).
* **Not automatic, by definition:** project code written against one engine's native API (§3.11).

Engines offered: **TypeORM 1.1** (default), **Kysely 0.29**, **Drizzle `1.0.0-rc.5`** (exact pin; re-pinned at each
RC and at GA after the contract matrix is green; Drizzle 0.45 is excluded because of the open pool-leak fix).

### 3.11 Native access in three tiers

| Tier | API | Before-layer | Database layer | After-layer |
|---|---|---|---|---|
| 1 | CrudService / `DataStore` | yes | yes | tenant row check + output pipeline |
| 2 | `store.native(reason)`: the engine's own API (Mongoose Model, TypeORM EntityManager/QueryBuilder, Kysely, Drizzle with tables generated from the metadata), bound to the store's transaction | Mongo: plugins yes; SQL: no | Postgres RLS yes (same connection, A9) | HTTP interceptors yes |
| 3 | `store.raw(reason)` / `getNativeConnection(reason)`: raw driver / SQL | no | Postgres RLS yes | HTTP interceptors yes |

`reason` is mandatory and logged, as `getNativeConnection(reason)` is today. On MySQL/MariaDB tiers 2 and 3 have no
database floor: a native query on a tenant-scoped table must filter by tenant itself — documented, and a review rule
in the lt-dev reviewers. Parameters only; identifiers never from user input.

### 3.12 Schema evolution is framework-owned and safe by default

No engine's own tooling is used for schema changes (A12: TypeORM `synchronize` lost data on rename and type change,
MikroORM guessed renames wrong, `drizzle-kit push` disables RLS, none of them takes a migration lock we can rely on).
The framework compiles DDL per dialect from the descriptors and reads the current state from the catalog with plain
SQL (indexes included — Kysely's introspection has none, A11).

| Change | Handling |
|---|---|
| New table, new optional or defaulted column, new index, widened type, RLS policies | automatic, serialised by `LockStore`, logged |
| Renamed field | only when declared: `@UnifiedField({ renamedFrom: 'oldName' })` — never guessed |
| Removed field | column kept, reported once at boot; dropped only by an explicit migration |
| Narrowed type, `NOT NULL` without default, changed uniqueness | never automatic: `migrate:create --sql` writes a reviewable migration; the boot refuses to start while the schema needs it |
| Flexible structures | declared nested types and `isAny` live in JSON columns and need no DDL when their shape changes |

## 4. Comparison with the earlier approaches — and the decisions

| Question | Plan 2026-08 (option C) | nest-base (donor) | This plan | Why |
|---|---|---|---|---|
| Where is the seam? | two `CrudService` implementations sharing upper layers | services call Prisma directly | **one CrudService over a store port** | the pipeline exists once; a third database is a dialect, not a third CrudService |
| Why was the port rejected in August? | leaks at the raw `filterQuery` arm, `aggregate`, `populate` | — | the raw arm **is** the neutral language (A2); `aggregate` is a declared capability; populate gets a neutral implementation | the objection is answered by evidence |
| SQL engine | Prisma | Prisma 7 | **configurable adapter: TypeORM (default), Kysely, Drizzle** | see the evaluation below |
| Tenancy | gate experiment, maybe not in v1 | RLS declared but bypassed (superuser/owner role, no FORCE, never tested) | **in from the start**: three layers (§3.4), RLS done right, row check after every read, pool hygiene | A3, A9, A10 |
| Atomic claims | `LockStore`, Prisma `upsert` not atomic | advisory lock (pool-unsafe) | `LockStore` with conditional upsert | A4, A11 |
| IDs | pay down `IdType` drift | v4/v7 UUIDs mixed | opaque strings + ObjectId-hex on SQL | one wire format |
| Metadata | neutral record from `@UnifiedField` | Prisma schema | `@UnifiedField` record **+ Mongoose-schema fallback** | existing `@Prop` models work on SQL unedited |
| Schema changes | Prisma migrate | Prisma migrate | **framework-owned safe evolution** (§3.12) | A12 |
| Test strategy | file-storage parity matrix as model | static `check:rls` that never fails | **persistence parity matrix** (EXECUTED / IMPOSSIBLE / DIFFERENT-BY-DESIGN per cell, one column per database × engine) + RLS tests as the non-owner app role | a capability nobody asserts is indistinguishable from a bug |

**Engine evaluation (2026-10-27).** Candidates: every option on docs.nestjs.com/data (TypeORM, Drizzle, Mongoose,
Sequelize, Prisma recipe, MikroORM) plus Kysely. Ten weighted criteria, seven weighting profiles, every score with its
evidence in `prototypes/14-decision-matrix.mjs`. TypeORM 1.1 leads six of seven profiles (base profile 78.4, Kysely
69.3, Prisma 68.3, Drizzle RC 63.2, MikroORM 60.6); with NestJS weighted at zero, TypeORM and Kysely tie (74.6 / 74.5).
Excluded: **Prisma** (client and schema generated per project at build time, our models exist at runtime),
**MikroORM** (one maintainer with 73 % of commits, critical SQL injection and prototype pollution in 2026, wrong rename
guesses), **Sequelize** (6.37.8 the only release in twelve months, maintainers wanted). Because the engine became an
adapter (A9), the choice decides only the default and what projects use natively; Kysely and Drizzle are offered as
well. **TypeORM's MongoDB support is not an advantage**: "basic" by its own docs — no query builder, no relations, no
transactions (silently no-ops), no hook that sees a query filter. Mongoose stays.

**Kept from August:** the objective function, the abort criteria idea (§8), the no-regret ordering (LockStore, ids,
metadata first), the parity-matrix discipline, the non-negotiable constraints (§9), the downstream list (§10).
**Harvested from nest-base:** the RLS mechanism (`SET LOCAL` per transaction) — enforced and tested this time; narrow
storage interfaces per infrastructure feature with contract tests; the outbox claim pattern for the later queue work.
**Avoided from nest-base:** decorative RLS, features on a second client no production path uses, a different
"no tenant" answer per layer, type-only authorization.

## 5. Validated assumptions (prototypes, 2026-10-27; scripts and how to run them: `prototypes/README.md`)

| # | Assumption | Result |
|---|---|---|
| A1 | the SQL packages load via `require()` from CommonJS | PASS (no top-level await) |
| A2 | Mongo-operator subset compiles to SQL with identical results | **28/28 identical** against MongoDB incl. `$ne`/`$nin` with missing fields, `null`, array semantics, dot paths, `$elemMatch`, `$nor`, `$not`, dates, regex; 1 DIFFERENT-BY-DESIGN (`$exists` on a column with explicit `null`); unknown field, injected path segment, `$where`, `$text`, positional path refused |
| A3 | RLS fail-closed | PASS 10/10: tenant sees only its rows; raw SQL filtered; **missing context raises `42501`** on a reused pooled connection and for raw SQL; foreign insert/update refused; system mode explicit; no leak to the next transaction; app role cannot disable RLS |
| A4 | atomic claim / lease | PASS: 20 × 16 parallel workers → exactly one winner each; expired lease taken over by exactly one; token-scoped release |
| A5 | atomic JSONB push/pull | PASS: 50 concurrent capped pushes keep exactly 30; 40 concurrent pushes all land; pull by scalar and by object condition |
| A6 | Better-Auth on Postgres | PASS: migrator plans `users/session/account/verification`; sign-up/sign-in; 24-hex ids; snake_case columns; framework columns coexist; `roles` `input:false` stays `[]` |
| A7 | own metadata→DDL + additive diff is small | PASS: create 5 statements, diff v1→v2 3 statements, re-diff 0, required column without default refused (~60 LOC) |
| A8 | the three engines carry the store path | TypeORM 1.1.2: runtime `EntitySchema`, compiled `Where` 28/28, Better-Auth on its pg pool, raw path 0.83–0.99× of `pg` (repository path 1.1–2.1×); Kysely 0.91–1.49×; Drizzle RC ≈ `pg` and 28/28, claim and RLS `42501` |
| A9 | engine switch by configuration | PASS for `pg`, TypeORM, Kysely, Drizzle with identical store code: parity vs MongoDB, rollback, native handle on the store's transaction (sees its `set_config`), transaction-local reset, native builder, driver pool for Better-Auth |
| A10 | pool hygiene under query timeouts | without guard: TypeORM leaks (pool hangs, 2 connections idle in transaction), Kysely poisons (next query saw the dead transaction's tenant), Drizzle rc.5 and careful `pg` pass; **with the framework pool guard all four pass** |
| A11 | MySQL 8.4 / MariaDB 11.8 | Drizzle, TypeORM, Kysely: JSON round trip + containment, rollback, atomic claim pass; MariaDB returns JSON as a string (store maps by descriptor); Kysely's migrator lock holds under 6 concurrent boots; TypeORM's migrations take no lock |
| A12 | engine schema tooling on existing data | TypeORM `synchronize`/`migration:generate`: silent data loss on rename and type change; MikroORM: wrong rename guesses; `drizzle-kit`: refuses ambiguous changes without hints (good) but disables RLS on push (#4948) and has no lock (#874) → framework-owned evolution (§3.12) |

## 6. Phases

Every phase: TDD, `pnpm run check` green, the test count never drops, every behaviour fix pinned by a registered
mutation, review, the owner's test approval, one commit pushed to `feat/db-agnostic`. Phases 0–4 change **nothing**
for a MongoDB project (the existing tests are the proof); only phase 5 carries a breaking change.

### Phase 0 — Groundwork, MongoDB only, zero behaviour change (DEV-3828)
1. `ModelMetadataRegistry` + `FieldDescriptor` from `@UnifiedField` and the Mongoose-schema fallback; unit tests over
   every core model (descriptor snapshot) and the reference server's models.
2. Data-source configuration (§3.9): parsing (shorthand, object, `false`), source registry, model → source resolution
   (config > decorator > default), legacy `mongoose` as default source, boot validation and boot log. SQL sources are
   recognised and refused with a named error until phase 1.
3. Opaque ids: `IdType`/`StringOrObjectId` without `mongoose` imports; `isValidId()` via the active driver;
   `id.helper` stays a leaf.
4. Policies extracted from the five security plugins into pure functions — the tenant policy with every behaviour of
   §3.4's table; plugins delegate; all plugin suites and mutations unchanged and green.
5. `DataStore<T>` port, `Where<T>` type, capability flags, `MongooseDataStore`; `CrudService`/`ModuleService` call the
   store internally; `@InjectStore` + `CorePersistenceModule.forFeature` (Mongo delegation); `mainDbModel` stays;
   `store.native(reason)` / `store.raw(reason)` with logging.
6. Tenant row check after every store read (§3.4), on MongoDB too; existing tests unchanged, registered mutation.
7. `LockStore` (Mongo implementation) replacing the system-setup claim, the migration lock and the cron lease;
   contract suite with an N-worker race.
8. Persistence parity matrix scaffold (`tests/helpers/persistence-matrix.ts`) with the Mongo column filled, the tenant
   behaviours of §3.4 as matrix cases.

**Decided while implementing phase 0 (both keep the phase-0 gate "no change for MongoDB"):**
* *Step 5:* the CrudService's find/get/create/update/delete stay on their Mongoose-document path behind the store's
  `mongoosePopulate` capability. Switching MongoDB to lean neutral records now would change hydration, schema
  defaults, getters and populate for every consumer. Operations with identical semantics (`distinct`, `pushToArray`,
  `pullFromArray`) already run through `this.dataStore`; phase 1 adds the neutral path for SQL stores, and the parity
  matrix proves both paths answer alike. `dataStore` is a getter that follows `mainDbModel`, because a subclass may
  assign the model after `super()`.
* *Step 6:* the tenant row check is the tenant plugin's post hooks on MongoDB, so it covers every Mongoose read
  (CrudService, direct model calls, populate, the store) — not only reads through the store.
* *What a MongoDB project can notice after phase 0* (no behaviour change on a correct path; listed for the phase-5
  migration guide): `IdType` / `StringOrObjectId` take a structural `ObjectIdLike` instead of `Types.ObjectId`; a
  read that returns a foreign tenant's row now fails with 403 instead of returning it; `ModuleService` has a
  `dataStore` getter; `database` may carry the MongoDB URL instead of `mongoose.uri` (review finding: it was accepted
  but not connected — fixed, mutation `database-mongodb-url-not-connected`).
* *Open for phase 1:* `@PersistedModel({ dataSource })` is recorded but not read yet — model routing arrives with the
  second source; `MongooseDataStore` joins `select` into Mongoose's string projection, so a field name starting with
  `+` must be refused before any caller passes non-constant names.
* *Step 7:* `LockStore` + `MongoLockStore` + contract suite land now; the three consumers (system-setup claim, cron
  lease, migration lock) switch in phase 2 together with their SQL path. Their documents are read by OLDER replicas
  during a rolling deploy (`{ lock: 'lock' }` for migrations, `_id` + `expiresAt` for cron, `claimedAt` for setup); a
  format change in phase 0 would let an old and a new replica both believe they hold the lock. Phase 2 designs that
  compatibility once per consumer.

### Phase 1 — SQL core on PostgreSQL with three engine adapters (DEV-3829)
1. `SqlExecutor` port + adapters TypeORM (default; `synchronize: false` asserted), Kysely, Drizzle (`1.0.0-rc.5`
   exact); optional peers, lazy; engine selection from config; providers via Nest DI, tokens in leaves.
2. Framework pool guard on every adapter's driver pool; contract case "timed-out transaction" per adapter
   (registered mutation).
3. Per-request unit of work in `RequestContext`, `set_config` tenant/system settings, explicit system mode.
4. `Where` compiler → SQL text + parameters (Postgres dialect), identifier allowlist from metadata.
5. Schema evolution (§3.12): DDL per dialect, catalog introspection incl. indexes, safe-change policy, `renamedFrom`,
   `LockStore`-serialised runner, `migrate:create --sql`, generated RLS policies.
6. `SqlDataStore`: CRUD, sort/skip/limit, `findAndCount` without `$facet`, distinct, JSONB push/pull/slice, increment,
   upsert/claim, neutral populate (batched `IN`), Postgres error → HTTP mapping (`23505` unique → 400 like E11000,
   `22P02` invalid id → 404/400 like `MongooseCastErrorFilter`), tenant row check.
7. RLS floor + system-role `CHECK`; the API connects as a non-owner role.
8. Postgres test container in `scripts/test-infra.mjs` (pinned image, own port), per-run database under the existing
   drop guard; parity matrix: Postgres × {TypeORM, Kysely, Drizzle} columns, the whole CrudService contract and the
   tenant suite green in every column.

### Phase 2 — Core modules on SQL (DEV-3830)
User (unique email, partial reset-token index, token maps as JSON), Tenant (+ `isTenantActive` with a neutral
handle), API tokens, system setup (`LockStore`), cron leases (`LockStore` + explicit expiry), error codes, health check
(SQL ping indicator), permissions (nothing to do), Hub (driver-aware panels incl. a persistence panel: model → source →
database → engine → capabilities; Mongo-only panels report `available: false`), migrate module on SQL.

### Phase 3 — Better-Auth on SQL (DEV-3831)
Better-Auth's Kysely adapter on the configured engine's driver pool, `user` → `users` mapping (snake_case), ObjectId-hex
ids, Better-Auth migrations inside the framework's migration flow; user mapper, token service, challenge service and
backfills behind an `IamUserStore` with Mongo (current code moved) and SQL implementations; the full Better-Auth story
suites green on both databases.

### Phase 4 — Files, TUS, AI, MCP OAuth (DEV-3832)
File/TUS metadata store neutral (S3 + filesystem on SQL; GridFS Mongo-only, derived-driver rule extended); AI module's
11 models via CrudService on both databases, its 3 schema-less collections as tables, aggregates replaced by named
store methods, TTL correctness replaced by explicit expiry predicates + sweeper on the cron lease.

### Phase 5 — PostgreSQL first-class, Mongo optional, release (DEV-3833)
Reference server bootable on Postgres; CI matrix `db: [mongodb, postgres]` running the full e2e suite (one engine per
CI job, all three engines in the parity matrix); `mongoose`/`@nestjs/mongoose`/`mongodb` become optional peers,
`MongooseModule` only when configured, `@UnifiedField` without a static `@nestjs/mongoose` import; docs (README,
REQUEST-LIFECYCLE, configurable-features, native-driver-security, CLAUDE.md, `docs/choosing-a-database.md`,
`.claude/rules/persistence.md`), migration guide for the release (MINOR); downstream tickets (§10).

### Phase 6 — MySQL / MariaDB (own ticket)
MySQL dialect for compiler, DDL and introspection; claim via `INSERT IGNORE` + conditional `UPDATE`; JSON value
mapping; before- and after-layer only, documented as such; write guard via triggers on session variables evaluated as
a database floor; parity matrix columns MySQL and MariaDB per engine (an engine that cannot serve a dialect is declared
IMPOSSIBLE with its reason).

## 7. Effort (rough, new + touched LOC)

Phase 0 ~2,800 · Phase 1 ~5,000 · Phase 2 ~3,000 · Phase 3 ~2,500 · Phase 4 ~3,000 · Phase 5 ~2,000 · Phase 6 ~2,500
+ downstream.

## 8. Gates and abort criteria

* **After phase 1:** the whole CrudService contract and the tenant suite pass on Postgres with **every** engine with
  the **same** observable semantics as on MongoDB (403 without context, 0 rows for a foreign tenant, refused foreign
  writes, no context leak under timeouts). If not: stop and report — an "equal status" label on a second-class mode is
  the worst outcome available. The same gate applies to phase 6 for MySQL/MariaDB.
* **Phase 0 must not change Mongo behaviour.** Any existing test that has to be edited (not extended) to stay green is
  a stop-and-explain, not a quiet fix. The tenant row check only refuses rows the plugin would already have filtered.
* **A capability nobody can implement on a database or engine** is declared IMPOSSIBLE in the matrix with a reason —
  never left out.
* **An engine update** (each Drizzle RC, every minor of TypeORM/Kysely) is taken only with the full matrix green.

## 9. Non-negotiable constraints

1. `pnpm run check` green after every step; test count never drops.
2. Every behaviour fix ships with a test observed failing without it (registered mutation, `check:mutations`).
3. Never weaken an assertion to get green; a deliberately changed expectation is said out loud.
4. `src/core/` stays self-contained; ESM rules (`.js` specifiers, no `require`/`__dirname`/`import.meta`, no top-level
   await, `import type`); DI tokens in import-free leaves (`check:swc-tdz`, `typecheck:vendor`, `check:esm`).
5. Optional peers stay lazy; a project using neither Redis, S3 nor SQL installs nothing extra and behaves as before.
6. No `@ts-ignore`, no lint disables, no skipped tests.
7. Comments explain WHY, in English, and are true.
8. The reference server (`src/server`) exercises every new seam as code.
9. The CLAUDE.md "High-Frequency Path" rules are rewritten per database in phase 5 — they currently tell developers to
   bypass CrudService **because** the Mongoose plugins still fire; on SQL the store, not a plugin, applies the policies.
10. No engine-specific import outside its adapter; security never depends on an engine feature.

## 10. Downstream (cross-repo tickets; phase 5 unless noted)

* **nest-server docs for AI agents** (shipped with the package): `docs/choosing-a-database.md` with a fixed decision
  procedure — an external requirement wins; PostgreSQL on relational/reporting/financial signals or when tenant
  isolation in the database is wanted; MongoDB (the default) for document-shaped or changing data; hybrid only with a
  concrete reason and its costs named; MySQL/MariaDB only when required, stating "tenant isolation in the application
  only"; `database: false` for stateless services; engine TypeORM unless the team asks for Kysely or Drizzle; ask when
  the signals are ambiguous and record the decision (database, engine, date, reason) in the project's CLAUDE.md.
  `.claude/rules/persistence.md` with the code rules (tiers, data source per model, `renamedFrom`, native-access
  duties).
* **lt-dev plugin:** a "choosing a database" reference in `generating-nest-servers`; the database question in the
  decision round and in `architect` (new projects, new modules with their own storage needs); review rules in
  `backend-reviewer` and `security-reviewer` (native SQL without parameters, native access to tenant tables on
  MySQL/MariaDB without a tenant filter, `synchronize`, engine imports in the core); the SessionStart hook shows
  database and engine; `nest-server-updating` knows both databases.
* **lt CLI:** `lt fullstack init --database … --sql-engine …`; module/object templates and `lt server addProp` emit the
  neutral form (`CorePersistenceModule`, `@InjectStore`); `lt dev up` starts Postgres and sets `NSC__DATABASE__URL`;
  vendor mode: subsystem-aware copy so a SQL vendor project does not receive the Mongoose driver as its own code;
  `vendor-runtime-deps.json` gains the SQL peers.
* **nest-server-starter / lt-monorepo:** Postgres variant (compose service, config, migrations folder).

## 11. Decisions (owner, 2026-10-27)

* SQL engine as a configurable adapter: **TypeORM 1.1 default, Kysely and Drizzle offered from phase 1**; Drizzle on
  an exact `1.0.0-rc.5` pin until GA (on PostgreSQL no functional restriction was found for our use).
* **Security and tenant isolation first**: what the database or engine can enforce is used in addition; the
  framework's before- and after-layers guarantee the same answer on every database and engine.
* **Tenant row check after every read, on every database including MongoDB.**
* **MongoDB stays the default** for new projects without clear signals; re-evaluated once PostgreSQL has proven itself
  in a real project.
* Mongo-operator subset as the neutral query language (§3.2) — fits every engine, because the framework compiles it.
* ObjectId-hex default ids on SQL (§3.5).
* Several data sources per project, a default plus exceptions per model, or none (§3.9).
* Framework-owned safe schema evolution (§3.12); no engine's `synchronize` or migration generator.
* snake_case columns with explicit mapping (Better-Auth mapped accordingly, A6).
* No hard foreign keys across modules; refs are indexed text columns.
* RLS mandatory for tenant-scoped tables on Postgres; the API connects as a non-owner role.
* Commits: local per TDD step, pushed as one commit per phase.
