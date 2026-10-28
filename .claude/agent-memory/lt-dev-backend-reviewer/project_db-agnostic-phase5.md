---
name: db-agnostic-phase5
description: feat/db-agnostic phase 5 (DEV-3833) review 2026-10-28 — MongoDB optional; 2 Highs on the null-connection / no-Mongoose paths that no suite runs (function defaults on DeclaredSchema, AI budget + MCP OAuth store lookup via connection.models)
metadata:
  type: project
---

Phase 5 (compat leaf `common/persistence/mongo/*`, optional peers, `NoMongoConnectionModule`, stand-in models,
`CorePersistenceModule.forFeature()` providing model tokens itself, `sample`), reviewed 2026-10-28.

**Coverage gap that explains both Highs:** the `postgres` e2e project keeps `mongoose` configured (config.env.ts), so
the connection is NEVER null there. The null-connection path is exercised only by `check:without-mongodb`
(`scripts/lib/without-mongodb.app.mjs`: no AI, model defaults are scalars). Probe any "works without MongoDB" claim
yourself.

**Reported High:**
1. `SqlDataStore.applyFunctionDefaults()` calls `options.schema.path()`; without Mongoose the schema is a
   `DeclaredSchema` (no `path`) → every insert of a model with a function default (`default: Date.now`, Mixed `{}`) is
   a TypeError. Probed against dist with `scripts/lib/without-mongodb.hooks.mjs`.
2. `CoreAiBudgetService.interactionsSqlStore()` and `CoreAiMcpOAuthService.sqlStore()` find the store via
   `this.connection?.models[...]` → null connection → fall back to `this.connection.db` → TypeError (`/ai/usage`,
   budgets, every MCP OAuth endpoint). `fileMetadataCollection()` shows the fix shape (`getRegisteredDataStore()`).

**Verified sound (don't re-derive):** compat tokens identical to @nestjs/mongoose; `createForClass` provider shape
identical to `createMongooseProviders`; mongoose/@nestjs/mongoose/better-auth adapter loaded via createRequire are the
same instances as static imports (mongoose CJS, the other two ESM-only `default` exports → require(esm) shares cache);
`type: Object` / `[Object]` == Mixed through @nestjs/mongoose (Object() → {} → Mixed); Mongoose drops
`$unset/$set: {x: undefined}` (SQL skip matches; `$inc: undefined` CastErrors on Mongo, skipped on SQL — lenient only);
SQL `sample` wraps the page then `ORDER BY random() LIMIT`, totalCount unaffected like the Mongo facet; file
controller resolves before streaming so the GridFS fallthroughs with `files === undefined` are not reachable via HTTP.
Hook blocks `DROP DATABASE` in Bash — probe without a DB (call `store['beforeInsert']` directly). See [[db-agnostic-phase4]].

**Status:** both Highs FIXED 2026-10-28 in the same review — `computedDefault()` in `declared-schema.view.ts` (the SQL store computes function defaults of a declared schema), `getModelStore()` in `persistence-runtime.registry.ts` (registered store without a connection). `check:without-mongodb` now inserts a model with `default: Date.now` and a Mixed default; mutations `declared-default-not-computed`, `model-store-needs-connection`.
