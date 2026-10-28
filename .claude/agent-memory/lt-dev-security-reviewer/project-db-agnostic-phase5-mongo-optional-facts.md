---
name: project-db-agnostic-phase5-mongo-optional-facts
description: DEV-3833 (db-agnostic phase 5, MongoDB optional) review 2026-10-28 — null-connection callers that broke (JWT verify, AI budget, MCP OAuth stores), what was traced sound, probe recipe without a database
metadata:
  type: project
---

Phase 5 review (feat/db-agnostic, 5bb1369..782e00e): no security hole, three fail-CLOSED breaks on PostgreSQL alone.

**Why:** `NoMongoConnectionModule` injects `null` for `@InjectConnection()` whenever `usesMongoDb()` is false (a
`database` default with no project `mongoose` config). Every e2e config in this repo sets `mongoose` explicitly, so ONLY
`scripts/check-without-mongodb.mjs` runs with a null connection — and it covers CRUD, cookie session, file storage only.

**How to apply — the findings (re-check whether fixed):**
- `CoreBetterAuthService.verifyJwtToken()`: `if (kid && this.connection)` gates the SQL-capable `verifyJwksToken()` →
  every Better-Auth JWT (Bearer and `lt-jwt-token` cookie) is anonymous on PG-only. Same shape:
  `core-better-auth-challenge.service.ts` `if (!this.connection) enabled = false` (passkey challenge mapping off).
- `CoreAiBudgetService.interactionsSqlStore()` / `CoreAiMcpOAuthService.sqlStore()` resolve the store via
  `this.connection?.models[name]` → undefined → Mongo path → `null.db` TypeError (budget: every prompt 500 with a finite
  limit; OAuth: register/getClient/codes/refresh all 500). Fix shape = `getRegisteredDataStore(name)` fallback, as
  `fileMetadataCollection()` does.
- Grep for the class: `grep -rn "connection?.models\|kid && this.connection\|!this.connection)" src/core`.

**Probe recipe without a DB** (a PreToolUse hook blocks any command text containing the SQL drop-database phrase):
scratch `.mjs` run as `node -r ./src/core/modules/migrate/helpers/ts-compiler.js <file>` from the repo root; resolve
bare packages via `createRequire('<repo>/package.json')` + `pathToFileURL`; import `src/**/*.ts` by absolute path;
`Object.create(Service.prototype)` + `defineProperty(…, 'connection', { value: null })`; `setBetterAuthSqlStore()` /
`registerDataStore()` with fakes.

**Traced sound:** connection-level security plugins still attach (forFeature uses `connection.model()`); descriptor
parity spec (`toEqual` over shipped models) covers `select:false`/unique/index of the declared-schema view; `sample` is
integer-validated and a bound param; unavailable store / stand-in / null-connection derefs all THROW (tenant guard,
system setup count, API-token loadTokenUser, MCP loadUser → null) — none caught into "allow"; `HexObjectId` regex-validates
before `FilesystemFileHelper.filePath`; update compiler skipping `undefined` matches `mergePlain` + Mongoose.
`isTenantActive` gets `connection: undefined` on PG-only — the documented Mongo example throws (fail closed), not opens.

Related: [[project-db-agnostic-phase4-ai-file-sweep-facts]], [[project-db-agnostic-phase3-better-auth-sql-facts]].

**Status:** FIXED 2026-10-28 in the same review — JWKS verified without a connection (`if (kid)`), the challenge service stays on with the SQL store, AI budget / MCP OAuth / conversation attribution through `getModelStore()`. Pinned by `tests/unit/sql-paths-without-connection.spec.ts` (mutations `jwks-verify-needs-connection`, `passkey-challenge-needs-connection`, `model-store-needs-connection`).
