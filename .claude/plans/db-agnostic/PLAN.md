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

**Decided 2026-10-28 (owner): one transaction per store operation, pipelined into one round trip; `store.transaction(fn)`
for atomic multi-step writes.** Every SQL store operation sends `BEGIN` · `set_config('app.tenant_id' / 'app.tenant_ids' /
'app.system', …, true)` · the statement · `COMMIT` through `pg`'s pipeline mode, so it costs one network round trip. The
settings are read from `RequestContext` at THAT operation, so a `runWithBypassTenantGuard()` section or system mode
inside a request is honoured exactly where it applies. `store.transaction(fn)` runs several operations on one connection
in one transaction, re-applying the current context before each statement.

Why not one transaction per request (measured, A13): it holds a pooled connection for the WHOLE request, including mail,
AI and other external calls — with a pool of 10 and a 200 ms external call that caps a deployment at ~50 requests/s,
against ~5,900 for per-operation; it keeps locks and old row versions alive for the request's lifetime; and after the
first failed statement every later one in the request fails ("current transaction is aborted"), while framework code
today catches database errors and continues — MongoDB without a replica set has exactly per-operation semantics, which
this keeps. On the database side the cost is small: pipelined per-operation is within ~10 % of per-request on a pure
database load and needs fewer round trips per operation (1 vs 1.4) once real network latency dominates.

### 3.9 Configuration: one default, exceptions per model, or none

```ts
// MongoDB exactly as today — nothing to change
mongoose: { uri: 'mongodb://…' }

// One SQL database: one line. Driver from the URL scheme, engine defaults to TypeORM
database: 'postgres://app@db/app'

// Default plus exceptions
database: {
  url: 'postgres://app@db/app',                       // default source for every model — the APP role
  ownerUrl: 'postgres://owner@db/app',                // schema changes only (boot / migrate) — the table OWNER
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
* **Two roles on every SQL source, in every environment (decided 2026-10-28, owner: "local, test and production as alike as
  possible").** `url` connects as the application role — owns no table, has neither `BYPASSRLS` nor superuser — so RLS
  cannot be disabled or bypassed from the application's connection. It is NOT a defence against SQL injection: the
  tenant scope is a setting (`set_config('app.tenant_scope', …)`) that any statement on that connection may write, so
  injected SQL could give itself the system scope. Injection is kept out by binding every value as a parameter (the
  compilers never write a value into the SQL text); RLS covers the forgotten filter and the query outside the
  framework, not a hostile statement. `ownerUrl` owns the schema
  and is used only for schema evolution. The boot refuses an application role that is superuser, has `BYPASSRLS` or owns
  a framework table — locally exactly as in production. The test infrastructure and `lt dev` (DEV-3850) create both
  roles automatically, so the separation costs nothing locally.
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
| A13 | transaction granularity with RLS | Postgres 18, primary-key read on a FORCE-RLS table as a non-owner role, two runs: bare statement 222 µs/op · per operation naive (4 round trips) 806–816 · combined (3) 589–598 · **per operation pipelined (1) 324–340, 10.9–12.1 k ops/s** · per request with 5 operations 279–302, ~15.7 k ops/s on a pure database load. Per request holds a connection for the request's whole duration (`prototypes/18-tx-granularity.mjs`) |

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

**Decided while implementing phase 1 (2026-10-28):**
* *Transactions (step 3):* no unit of work per request — per operation, pipelined (§3.8). The scope of every statement
  is `resolveTenantScope()` (tenant policy), read at that statement. `DataStore.transaction(fn)` is NOT on the port
  yet; the executor has it. It arrives with its first consumers in phase 2.
* *Pool guard:* besides the A10 cases, it listens for `error` while a connection is checked out (pg-pool listens only
  on idle ones; in pipeline mode a query timeout destroys the socket and the unlistened error ended the process) and
  adds a pool `error` listener where the engine has none (Kysely, Drizzle). Engine error wrappers are unwrapped, so
  every engine fails with the same pg error (Drizzle's wrapper printed the parameters).
* *Schema:* table = the MongoDB collection name in snake_case (`mongoose.pluralize()` — phase 5 must replace that
  dependency); strings `COLLATE "C"` (byte-wise like MongoDB); every column nullable (the database does not enforce
  `required`, as on MongoDB); unique indexes `NULLS NOT DISTINCT` → **PostgreSQL ≥ 15**, checked at boot; partial
  indexes compiled from `partialFilterExpression` (`$type` added to the compiler, DDL literals as escape strings); GIN
  for single-field array/JSON indexes; text/2dsphere/hashed reported, not created; TTL indexes become plain indexes —
  **no TTL sweeper yet** (phase 2, with the cron leases). The schema runner serialises with a transaction-scoped
  advisory lock rather than the `LockStore` (DDL is transactional; the lock ends with it). A table that stops being
  tenant-isolated keeps its RLS and the boot stops until a migration removes it (fail closed).
* *Routing:* the model registry is process-wide, so each SQL model's table is migrated when ITS store is created
  (idempotent under the lock), not for every registered model — tests boot several applications per process.
* *Neutral CrudService:* `update` writes the stored record merged with the input back, as on MongoDB (minus id and
  update time); `samples` and Mongoose-only APIs refuse with `UnsupportedCapabilityError`; a collation is not applied
  (warned once). A service given only `@InjectStore()` runs on MongoDB too.
* *Claims:* `PostgresLockStore` (its table `lt_locks` travels with every SQL schema). A neutral `upsert` on the store
  port is NOT done — its consumers (system setup, cron) move in phase 2.
* *Observation, not changed (pre-existing, identical on both stores):* `CorePersistenceModel` carries
  `@Restricted(S_EVERYONE)` on the class; with `mergeRoles` a field restriction is OR-ed with the class roles, so
  `@Restricted(ADMIN)` on a field of a model without its own class restriction is visible to everyone. The user model
  sets `@Restricted(ADMIN)` on its class. For the owner to decide whether the default should change.

### Phase 2 — Core modules on SQL (DEV-3830)
User (unique email, partial reset-token index, token maps as JSON), Tenant (+ `isTenantActive` with a neutral
handle), API tokens, system setup (`LockStore`), cron leases (`LockStore` + explicit expiry), error codes, health check
(SQL ping indicator), permissions (nothing to do), Hub (driver-aware panels incl. a persistence panel: model → source →
database → engine → capabilities; Mongo-only panels report `available: false`), migrate module on SQL.

**Decided while implementing phase 2 (2026-10-28, autopilot — every point is an assumption recorded on DEV-3830):**
* *Proof:* a core module parity matrix (`tests/helpers/core-module-matrix.ts`) runs the modules through REST and
  GraphQL on MongoDB and on PostgreSQL (default engine). Its PostgreSQL column signs in through the legacy endpoints:
  Better-Auth keeps its users in MongoDB until phase 3, and **the boot refuses a user model (table `users`) on SQL while
  Better-Auth is enabled** — the split let the system setup count Better-Auth's empty `users` and create an admin
  anonymously. Phase 3 lifts that refusal and gives the IAM suites their PostgreSQL column; phase 5 runs the whole suite.
* *Routing of existing services:* a service that only received `@InjectModel()` follows its model's routed store
  (`bindStoreToModel`, keyed by the model INSTANCE, so per application); the Mongoose model of a model routed to SQL
  refuses every data method with a named error. The core's MongoDB branches stay unchanged; SQL branches sit beside them.
* *Port:* `updateOne` and `deleteOne` (atomic first match: locking sub-select plus re-check), `updateMany`, `deleteMany`,
  `updateById(…, { timestamps: false })`.
* *Locks:* on MongoDB the three framework locks keep their 12.0.0 documents (`MongoLockStore` options `keyField` and
  `legacyTimestamp`), so an old and a new replica contend for one document — proven both ways per lock against the
  quoted 12.0.0 code. On SQL they share `lt_locks`, namespaced, swept an hour after expiry. **The migration run lock on
  PostgreSQL is a transaction-scoped advisory lock, not the `LockStore`**: it ends with its connection, so a replica
  killed mid-run leaves nothing to break, and it needs no table before the first migration.
* *Found and fixed (pre-existing, also on MongoDB):* a legacy logout never ended the device's refresh token
  (`update()` merges, so a deleted map key survived — ended devices are written as `null` now); with legacy JWTs the
  tenant guard ran before the role guard and answered every tenant route with 401 (it now lets the role guard identify
  the caller first).
* *Not changed:* `getSetupStatus()` / `createInitialAdmin()` still count and write `users` through the MongoDB
  connection — they create the admin through Better-Auth, which phase 3 moves.
* *From the phase 2 review:* the routed-model guard also covers `$save` (Mongoose's separate reference that
  `insertOne()` writes through), `where`, `$where` and `findAndCount`; `store()` in `isTenantActive` throws for a model
  not registered through `CorePersistenceModule.forFeature()` instead of answering `undefined` (fail closed);
  `SqlStateStore` without an engine uses the first installed one, because the CLI cannot read `database.sqlEngine`; the
  Hub refuses to show or run migrations while `lt_migrations` is empty and the MongoDB collection is not.

### Phase 3 — Better-Auth on SQL (DEV-3831)
Better-Auth's Kysely adapter on the configured engine's driver pool, `user` → `users` mapping (snake_case), ObjectId-hex
ids, Better-Auth migrations inside the framework's migration flow; user mapper, token service, challenge service and
backfills behind an `IamUserStore` with Mongo (current code moved) and SQL implementations; the full Better-Auth story
suites green on both databases.

**Decided while implementing phase 3 (2026-10-28, autopilot — every point is an assumption recorded on DEV-3831):**
* *Where Better-Auth lives:* it follows the users table. `DataSourceRuntime.iamStorage()` finds the model whose table is
  `users`; on a SQL source Better-Auth gets that source's application `pg` pool and builds its own Kysely on it, so
  the core imports no Kysely. A split of the users across two databases is impossible by construction — the phase 2
  boot refusal is gone. Legacy-auth projects (`betterAuth: false`) were never affected.
* *One row per user:* Better-Auth's `user` maps to the framework's `users` table (snake_case everywhere, the plugins'
  tables too, ObjectId-hex ids, so a Better-Auth user id IS the framework's id and `iamId` equals it). Its required
  columns (`name`, `email_verified`) are added nullable before its migrator runs, so a row the user model writes alone
  stays valid; the schema planner treats them as foreign columns, not as undeclared ones.
* *Schema:* Better-Auth validates its schema when the instance is created, so its migrations run first, as the owner,
  under the framework's schema lock, followed by grants and the safe-role check — inside the boot, not as a separate
  migration file.
* *`IamUserStore` was not built as planned:* the MongoDB code stays where it is and a SQL branch sits beside it
  (`BetterAuthSqlStore`, reached through an import-free registry leaf). Moving the MongoDB code would have touched every
  MongoDB path without changing what it does. On the per-request path only `BetterAuthMongoUsers` knows what an ObjectId
  is (`tests/unit/iam-request-path-ids.spec.ts`).
* *Passkey challenges on SQL* are Better-Auth verification values (identifier prefix `lt-passkey-challenge:`), not a
  framework table.
* *Proof:* every IAM suite runs on MongoDB and on PostgreSQL with each engine (vitest projects `iam-sql-<engine>`, the
  neutral helper `tests/helpers/iam-test-db.ts`); `tests/better-auth-storage-paths.e2e-spec.ts` covers the four paths
  the stories pass either way.
* *Found and fixed (pre-existing, also on MongoDB):* the API middleware looked for the passkey challenge cookie as
  `better-auth.better-auth-passkey`, while Better-Auth names it after its cookie prefix (`iam.better-auth-passkey`) — no
  mapping was stored and no `challengeId` returned, so a client without cookies could not finish a passkey ceremony; it
  now asks the instance for the name. `passkey.webAuthnChallengeCookie` was passed to the plugin at the top level, where
  the plugin ignores it; it goes to `advanced` now.

* *From the phase 3 review:* the migration status counts in SQL — Better-Auth's `findMany()` stops at 100 rows without
  a limit and had capped it at 100 migrated users; the MCP OAuth layer reads a token subject's roles from the SQL
  `users` table (it read MongoDB: nobody, or a stale copy); the IAM test projects' global setup starts the containers
  itself and never throws (vitest runs every project's setup before any test and before the root one).
* *Accepted:* Better-Auth keeps its transactions on PostgreSQL, so a sign-up holds an application-pool connection while
  the password is hashed and a burst of sign-ups makes other queries wait (~1.3 s at 100 concurrent). Standard
  Better-Auth behaviour, atomic sign-up; a configurable pool size or a pool of Better-Auth's own is a follow-up.

### Phase 4 — Files, TUS, AI, MCP OAuth (DEV-3832)
File/TUS metadata store neutral (S3 + filesystem on SQL; GridFS Mongo-only, derived-driver rule extended); AI module's
11 models via CrudService on both databases, its 3 schema-less collections as tables, aggregates replaced by named
store methods, TTL correctness replaced by explicit expiry predicates + sweeper on the cron lease.

**Decided while implementing phase 4 (2026-10-28, autopilot — every point is an assumption recorded on DEV-3832):**
* *AI module:* its 11 models are registered through `CorePersistenceModule.forFeature()` and every service uses its
  `dataStore` — one code path on both databases, the Mongoose plugins still fire on MongoDB. An upsert is
  `upsertRecord()` (update, else insert, retry on a duplicate key); a conversation is trimmed to its last 500 messages
  by `pushToArray(…, { slice: -500 })`; a prompt hint's counter rises atomically (`$inc`). The port gained `sum()`
  (the budget aggregation: MongoDB `$group`, SQL `count`/`sum`, across tenants as before) and `find(…, { exclude })`
  (MongoDB's `-field` projection, never combined with `select`).
* *MCP OAuth:* clients, codes and refresh tokens are three framework models (`autoIndex: false`); on MongoDB the
  service keeps its native collections and TTL index, on SQL it uses their stores. A code is refused on read once it is
  older than ten minutes, on both databases, whatever any sweep did; refresh tokens keep their unlimited lifetime.
* *Expiry sweep, not a TTL monitor:* a TTL is a plain index on SQL. `scheduleExpirySweep()` runs at boot and every 15
  minutes, on one replica per interval (a lease in the default SQL source's `lt_locks`, never released; on a MongoDB
  default every replica sweeps, which is harmless — a sweep only deletes what has expired), and fails open.
  `CorePersistenceLifecycle` sweeps every routed SQL table whose model declares a TTL (MongoDB's rule: date + TTL in
  the past, no date never), `CoreBetterAuthService` expired sessions and verification values when Better-Auth runs on
  SQL. MongoDB keeps its TTL indexes and gets no sweep — the decision comment had the sweep on both; it is redundant
  there, since every reader checks the expiry and the indexes delete.
* *File metadata:* two framework models (`CoreS3File`, `CoreFilesystemFile`, `autoCreate`/`autoIndex` off so a store
  nobody writes to grows no collection) registered by `CoreModule`; `fileMetadataCollection()` answers the native
  collection or a collection-shaped view of the routed store, and is the ONLY way the file service, the TUS hand-off
  and the Hub reach that metadata. Without `file.storage`, metadata on SQL derives `'filesystem'` instead of GridFS.
* *Table names:* a hyphen in a collection name becomes an underscore (`s3-files` → `s3_files`); before, such a model
  could not be routed to SQL at all.
* *Proof:* the AI suite and both MCP OAuth suites run in the `iam-sql-<engine>` projects (neutral helper
  `tests/helpers/ai-test-stores.ts`; the tenant suite on a PostgreSQL database of its own, because its `multiTenancy`
  differs); the file parity matrix has the columns `filesystem@postgres`, `s3@postgres` and `gridfs@postgres`
  (IMPOSSIBLE in every case), executed at the service and the HTTP layer.

### Phase 5 — PostgreSQL first-class, Mongo optional, release (DEV-3833)
Reference server bootable on Postgres; CI matrix `db: [mongodb, postgres]` running the full e2e suite (one engine per
CI job, all three engines in the parity matrix); `mongoose`/`@nestjs/mongoose`/`mongodb` become optional peers,
`MongooseModule` only when configured, `@UnifiedField` without a static `@nestjs/mongoose` import; docs (README,
REQUEST-LIFECYCLE, configurable-features, native-driver-security, CLAUDE.md, `docs/choosing-a-database.md`,
`.claude/rules/persistence.md`), migration guide for the release (MINOR); downstream tickets (§10).

**Decided while implementing phase 5 (2026-10-28, autopilot — every point is an assumption recorded on DEV-3833):**
* *Both databases in one CI job, not a matrix:* the `postgres` vitest project runs every e2e suite outside
  `POSTGRES_E2E_EXCLUDED` (MONGODB-ONLY or OWN-DATABASES, each with its reason, guarded by
  `tests/unit/postgres-e2e-coverage.spec.ts`) with the default engine, a PostgreSQL database per test file (two suites
  with different `multiTenancy` sharing one stop each other's boot); the IAM suites run on Kysely and Drizzle too.
  `pnpm test` / `test:ci` run all projects, so the existing Build job covers both databases; a job matrix would add a
  second install and build for no additional coverage. Revisit when the Build job's wall time hurts.
* *Optional MongoDB through a compat leaf, not a second set of decorators:* `common/persistence/mongo/` loads the three
  packages synchronously through `createRequire()` from the package's location (decorators run at class definition;
  `require(esm)` and `import` share one instance). The framework's `Schema`/`Prop`/`SchemaFactory`/`InjectModel`/…
  record each declaration and apply `@nestjs/mongoose`'s where installed; without Mongoose a descriptor comes from the
  record through a view that reproduces Mongoose's paths and indexes (`declared-schema.view.ts`), and the descriptor
  spec proves both sources agree for every shipped model. `UnifiedField` needed no change beyond using the compat
  `Prop`. The pluralizer is Mongoose's legacy rules, copied (MIT) — a project's own `mongoose.pluralize()` still wins
  where Mongoose is installed.
* *MongoDB only when a source uses it:* `CoreModule` imports `MongooseModule.forRoot()` only for a MongoDB source;
  otherwise `NoMongoConnectionModule` provides `null` for the connection token. Before, a `database` URL without
  explicit `mongoose` still connected to the fallback URI — a breaking change, in the migration guide.
  `CorePersistenceModule.forFeature()` provides the model tokens itself (`@nestjs/mongoose`'s provider shape); without
  a connection the token is a stand-in that refuses data access, and the model runs on its routed store.
* *`database: false`* runs without any database: stores of registered models refuse with the reason (the framework
  registers its file metadata, so there always are some), Better-Auth is refused at boot.
* *`$set` with `undefined`* is skipped by the SQL update compiler, as Mongoose does — the phase-4 call-site workaround
  is now the store's behaviour (matrix case `update-undefined-ignored`).
* *`samples`* (`findAndCount`) runs on SQL as `ORDER BY random() LIMIT n` over the page (port option `sample`).
* *Proof of the optional peers:* `pnpm run check:without-mongodb` (in `check`, against `dist/` with the packages made
  unresolvable by module hooks) and `--package` (publish path: the tarball installed with npm into a project that does
  not declare them; the step fails if any reaches `node_modules`).

### Phase 6 — MySQL / MariaDB (DEV-3848)
MySQL dialect for compiler, DDL and introspection; claim via `INSERT IGNORE` + conditional `UPDATE`; JSON value
mapping; before- and after-layer only, documented as such; write guard via triggers on session variables evaluated as
a database floor; parity matrix columns MySQL and MariaDB per engine (an engine that cannot serve a dialect is declared
IMPOSSIBLE with its reason).

**Decided while implementing phase 6 (2026-10-28, autopilot — every point is an assumption recorded on DEV-3848):**
* *One store, two dialects:* `MysqlDataStore extends SqlDataStore` and overrides only how statements are written; the
  policies, the record mapping and the row check stay one implementation. What differs per source at runtime (schema,
  role check, store, leases) is a `SqlDialect` (`sql/sql-dialect.ts`); the runtime never asks for the driver name.
  Shared schema pieces (`tableName`, `shortName`, `LOCK_MODEL`, the change types) moved to `sql/sql-schema.shared.ts`,
  re-exported from the PostgreSQL modules.
* *All three engines on one `mysql2` pool* the framework creates (TypeORM through its `driver` option, Kysely's
  `MysqlDialect`, Drizzle's `mysql2` client), so every connection gets the session before its first statement: the full
  `sql_mode` (strict, never `NO_BACKSLASH_ESCAPES` — the driver escapes with backslashes), UTC, an unbounded
  `group_concat_max_len`. `$n` placeholders become `?` outside quoted text; an array or object parameter is refused
  (the driver would expand it). No engine is IMPOSSIBLE: 6 columns, 480 cells with MongoDB and PostgreSQL.
* *"Any array item matches" is `(SELECT COUNT(*) FROM JSON_TABLE(…)) > 0`, never `EXISTS`:* MySQL 8.4 turns an
  `EXISTS` over a `JSON_TABLE` that reads the outer row into a semi-join that finds nothing (mutation
  `mysql-where-exists-semijoin`, 10 parity cases). JSON equality is `= CAST(? AS JSON)` on MySQL, `JSON_EQUALS()` on
  MariaDB; comparisons cast inside a `CASE` on `JSON_TYPE()` (strict mode turns a failed cast in a write into an error).
* *No `RETURNING`:* a write that answers with the record runs in a transaction — the write, then the read of the row
  it locked. `updateOne()` / `deleteOne()` pick their row with `SELECT … FOR UPDATE LIMIT 1` in that transaction, which
  is findOneAndUpdate's guarantee without PostgreSQL's retry.
* *Conflicting update paths are refused* (MongoDB's own rule): one expression per column — a top-level operator, or one
  `JSON_SET` / `JSON_REMOVE` over all nested paths with a merge-patch skeleton for missing parents. PostgreSQL chains
  them; MySQL would need the running value twice per operator.
* *Strings:* `varchar(255)` when the field is part of an index that is CREATED, otherwise `longtext`; `utf8mb4_bin`
  everywhere. A longer value is refused with 400, never cut. Making an existing field indexed is a type change, i.e. a
  migration. An index over more than InnoDB's 3072 bytes (four text fields — `ai_slots`) indexes a prefix of each text
  column when it is a lookup index and is refused when unique (mutation `mysql-long-index-not-prefixed`).
* *Unique treats a missing value as a value* for string kinds through a virtual column `IFNULL(col, CHAR(0))` carrying
  the index (mutation `mysql-unique-null-distinct`); sparse unique keeps MySQL's own NULL handling, which is MongoDB's
  sparse behaviour. A non-string unique field admits several records without a value; a partial unique index is not
  created (notice) — neither occurs in the framework's models.
* *No row-level security, and no trigger guard either:* prototype 19 measured a BEFORE INSERT/UPDATE/DELETE guard on
  session variables against the store's path (4000 writes, 8 concurrent): −17 to −28 % write throughput on MySQL 8.4,
  −47 to −49 % on MariaDB 11.8, p50 up to doubled (the scope has to be set and reset around every write on a pinned
  connection). It stops a scope-less native write and a write into a foreign tenant — and not a native READ of every
  tenant, not a scope a previous caller left on a pooled connection, not native code that sets the variable itself. A
  floor that leaves the larger leak open and that the code it targets can step over is not worth halving MariaDB's
  writes. Isolation is the store's on these databases; the boot says so once per source (mutation
  `mysql-isolation-warning-missing`), the persistence matrix declares `native-api-tenant-refused` DIFFERENT-BY-DESIGN
  for the six columns and asserts the complement.
* *Two accounts:* the application account gets `SELECT, INSERT, UPDATE, DELETE` on the database once (covers every
  later table); the boot refuses one that may alter, drop, index, trigger or grant (mutation
  `mysql-app-account-ddl-accepted`), a server older than the tested MySQL 8.4 / MariaDB 11.8, and a URL scheme naming
  the other server.
* *Schema runs under `GET_LOCK`, not in one transaction:* DDL commits on its own in MySQL. A failing statement is named
  in the error; the statements before it stay, and the next boot plans and completes the rest. `runSqlMigration()` is
  not atomic there for the same reason (documented).
* *Better-Auth is refused at boot* while the user model lives on MySQL / MariaDB (mutation `mysql-iam-not-refused`):
  its adapter is not wired for the dialect. The legacy auth path runs there (core-module matrix, 2 columns).
* *No full e2e suite on MySQL:* the parity matrices carry the contract (persistence 6 columns, core modules 2 columns,
  where parity 2 columns), plus schema, lease, migration-state and wiring suites per server. Revisit if a MySQL project
  hits a gap the matrices did not.
* *Driver details that cost a run each:* Drizzle's session reads DATETIME as text (the store parses it as UTC —
  mutation `mysql-drizzle-datetime-local`); `mysql2` parses MariaDB's JSON columns through the extended type metadata
  but not `JSON_TABLE` items; it names error numbers from MySQL's list, where MariaDB's 4025 (failed CHECK) is another
  error, so errors are mapped by number and server; MariaDB refuses an outer reference in a derived table, so
  `pushToArray({ position })` merges three arrays instead of ordering a union.
* *Found in review, fixed:* a unique index on null sentinels cannot serve a filter on the column, so every lookup by
  such a field (API token per request, MCP OAuth code, sign-in by e-mail) scanned the table and `updateOne()` locked all
  of it — such an index now comes with a lookup index over the plain columns. A new unique index on an existing table
  carries its sentinel column in its own migration (separately, the refused boot never added it). `pushToArray()` with
  two or three modifiers runs one statement per stage in a transaction (nested, MySQL 8.4 refuses the outer reference
  in a `JSON_TABLE` argument). The update compiler built its merge-patch skeleton from path segments on plain objects:
  `meta.__proto__.bypassTenantGuard.x` reached `Object.prototype` and switched tenant isolation off for the process —
  `__proto__`, `constructor` and `prototype` are refused as path segments on every SQL database, and the skeleton has
  no prototype. Vendor projects declare every SQL package the core names in an `import()` (TS2307 otherwise).

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
* SQL transactions: one per store operation, pipelined into one round trip; `store.transaction(fn)` for atomic multi-step writes (§3.8, A13).
* Two roles on every SQL source in every environment: application role (`url`) and owner (`ownerUrl`), checked at boot (§3.9).
