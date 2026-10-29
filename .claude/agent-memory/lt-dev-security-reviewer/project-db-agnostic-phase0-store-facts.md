---
name: project-db-agnostic-phase0-store-facts
description: db-agnostic phase 0 (DEV-3828, feat/db-agnostic) — the five policy extractions are verbatim; DataStore surfaces are safe ONLY because no caller passes user input yet; what to re-check in phase 1
metadata:
  type: project
---

Phase 0 review (2026-10-27): the tenant/role-guard/system-role/password/audit decisions moved into
`src/core/common/persistence/policies/*.policy.ts` verbatim (diffed against `develop`; hook bodies
identical, mutations `exclude-schemas-warns-silently` / `cross-tenant-writes-accepted` retargeted and
still match once). Tenant row check = plugin POST hooks on find/findOne/findOneAnd*; it never names
the foreign tenant id (message + log name the model only).

**Why:** the DataStore surfaces have no user-input caller in phase 0 (framework uses only distinct,
pushToArray, pullFromArray), so they were cleared on reachability, not on construction.

**How to apply — re-check these when phase 1/2 routes CrudService reads through the store:**
- `MongooseDataStore.toProjection()` JOINS `select` with spaces into Mongoose's string projection:
  a name carrying `+` reaches a `select: false` path (`+password`), a space splits into two fields.
  Safe only while `select` is compile-time. Store reads are `.lean()` → no Model `securityCheck()`.
- `toMongoFilter()` passes every operator through (`$where`, `$expr`) — Mongoose's own behaviour.
- `store.native(reason)` returns the unwrapped Model (not `SafeModel`), logged at DEBUG only.
- Row check skips rows WITHOUT a `tenantId` key: a projection omitting it disables the after-layer.
- `redactUrl()` keeps a credential fragment for a MALFORMED URL (unencoded `@`, `/`, `?`, `#` in the
  password): `postgres://u:p@ss@h` → `postgres://ss@h`, `postgres://u:pa/ss@h` → `postgres://u:pa`.
  Boot-time log only; below the bar in phase 0.
- `MongoLockStore.tryAcquire` is exclusive (expired-only match + `_id` duplicate key); not wired to
  any consumer until phase 2 — re-check the rolling-deploy format compatibility then.

Related: [[project-hub-config-masking-gaps]] (the `database` URL is masked by value shape like `mongoose.uri`).
