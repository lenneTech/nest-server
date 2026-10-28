# Persistence Rules (MongoDB and PostgreSQL)

These rules apply to every model, service and query — in `src/core/` and in projects. The design is in
`.claude/plans/db-agnostic/PLAN.md` while the plan is active; which database a project uses is decided by
`docs/choosing-a-database.md`; the configuration reference is the "Data Sources" row of
`.claude/rules/configurable-features.md`.

## One pipeline, one store per model

`CrudService` runs every call through the same security pipeline (`process()`) and hands the database work to the
model's **data store** (`DataStore<T>`, `common/persistence/data-store.interface.ts`): `MongooseDataStore` on MongoDB,
`SqlDataStore` on PostgreSQL. A model reaches its store by being registered with
`CorePersistenceModule.forFeature([{ name, schema, model }])`; `database` routes it to a source.

| Do | Never |
|---|---|
| Register a model with `CorePersistenceModule.forFeature()` | `MongooseModule.forFeature()` for a model that may live in SQL — it stays on MongoDB and nothing routes it |
| Declare models with the framework's `Schema`, `Prop`, `SchemaFactory`, `InjectModel` (from `@lenne.tech/nest-server`, or `common/persistence/mongo/mongoose-compat.js` inside the core) | Import them from `@nestjs/mongoose` in the core — the core must load where MongoDB's libraries are not installed (`pnpm run check:without-mongodb`) |
| Reach a model through `this.dataStore` in a `CrudService`, or `@InjectStore(Model)` elsewhere | Call `this.mainDbModel.find(…)` — on a model routed to SQL the Mongoose model refuses every data method (`routed-model.guard.ts`) |
| Write ids as 24-hex strings (`generateId()`, `newObjectId()`, `isObjectIdLike()`) | `new Types.ObjectId()` / `instanceof Types.ObjectId` in the core — Mongoose may not be installed |
| Query with the Mongo-operator subset the SQL compiler supports (`$eq $ne $gt $gte $lt $lte $in $nin $exists $type $regex $not $and $or $nor $elemMatch $all $size`, dotted paths) | Build an aggregation pipeline for something the port offers (`count`, `sum`, `distinct`, `find` with `sort` / `skip` / `limit` / `sample`) |

## MongoDB's libraries are optional peers (12.1.0+)

`mongoose`, `@nestjs/mongoose` and `mongodb` are loaded through `common/persistence/mongo/mongo-packages.ts` — never by
a static value import in `src/core/`. `import type` is fine (erased), and so is the compat module, which records each
declaration and applies the real decorator where Mongoose is installed.

| Need | Use |
|---|---|
| The packages, where a feature cannot work without them (GridFS, a MongoDB migration) | `requireMongoPackages('<feature, in configuration words>')` — throws `MongoPackagesMissingError` naming what to install |
| Whether they are there | `optionalMongoPackages()` / `hasMongoPackages()` |
| A GridFS bucket | `createGridFsBucket(db, { bucketName })` |
| A Mongoose query check | `isMongooseQuery(value)` |
| An inline schema (no class) | `createSchema(definition, options)`; free-form fields `{ type: Object }` |
| An ObjectId field type in a decorator | `objectIdType()` |

Where Mongoose is not installed, a model's descriptor comes from what its decorators recorded
(`mongo/model-declarations.ts`), read through `mongo/declared-schema.view.ts`, which builds paths and indexes exactly
as Mongoose would. `tests/unit/persistence-model-descriptor.spec.ts` proves both sources agree for every shipped
model — **a new model the framework ships goes into `SHIPPED_MODELS` there.**

`CoreModule` connects MongoDB only when a source uses it (`usesMongoDb()`); otherwise `NoMongoConnectionModule`
provides `null` for the connection token, and `@InjectConnection()` receives `null`. A service that uses the connection
on its MongoDB path checks it.

## Native access in three tiers

| Tier | API | What still protects the data |
|---|---|---|
| 1 | `CrudService` / `DataStore` | everything: before-layer policies, database layer (RLS on PostgreSQL), tenant row check, output pipeline |
| 2 | `store.native(reason)` — the engine's own API, bound to the store's transaction | MongoDB: the Mongoose plugins. PostgreSQL: row-level security (same connection). HTTP interceptors |
| 3 | `store.raw(reason)` / `getNativeConnection(reason)` | PostgreSQL: row-level security. HTTP interceptors. Nothing else |

`reason` is mandatory and logged. Parameters only — an identifier (table, column) never comes from user input. On
MySQL / MariaDB (phase 6) tiers 2 and 3 have no database floor: a native query on a tenant-scoped table filters by
tenant itself.

## High-frequency paths

The "use direct Mongoose in system-internal hot paths" advice in `CLAUDE.md` applies to MongoDB, where the Mongoose
plugins still fire on `Model.create()` / `findByIdAndUpdate()`. The database-neutral form of the same advice is the
data store: `this.dataStore.insert()`, `updateById()`, `findById()`, `pushToArray()` skip `process()` (no cloning, no
output pipeline) and keep every policy — on MongoDB through the plugins, on PostgreSQL in the store. Prefer the store in
new code; it is the fast path on both databases.

## Schema on PostgreSQL

The framework creates and evolves tables from the model descriptors when a store is created, as the **owner** role:
new tables, columns, indexes and grants are applied; anything that could lose or reject data (type change, new unique
index, a rename collision, a table losing tenant isolation) stops the boot with the suggested statements — write a
migration (`migrate create <name> --sql`, `runSqlMigration()`). Declare a renamed field with
`@UnifiedField({ renamedFrom: 'oldName' })`. Never enable an engine's own `synchronize` or migration generator.

## Tests

A suite proves a behaviour on both databases: the `e2e` vitest project runs it on MongoDB, the `postgres` project on
PostgreSQL (`.claude/rules/testing.md`). Read and prepare data through `tests/helpers/iam-test-db.ts` or the
application's stores — never through a MongoDB client of the suite's own, which reads the wrong database on
PostgreSQL. A contract with several implementations is a matrix (`tests/helpers/persistence-matrix.ts`).
