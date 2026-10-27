---
name: db-agnostic-phase0
description: feat/db-agnostic phase 0 (DEV-3828) review 2026-10-27 — five policies verified identical to develop's plugins; `database` MongoDB URL accepted by the boot guard but never wired (High, reported)
metadata:
  type: project
---

Phase 0 of the database-agnostic work (branch `feat/db-agnostic`, Linear DEV-3828), reviewed 2026-10-27.

**Verified identical to develop (don't re-derive):** audit, password, role-guard, system-role policies are
verbatim moves (incl. bulkWrite branches, `$each`, hasCreatedBy/hasUpdatedBy). Tenant policy = old
`shouldBypass`/`resolveTenantFilter`/`resolveSingleTenantId`/`assertOwnTenant`; `estimatedDocumentCount` same.
`isWellFormedId` == `length === 24 && ObjectId.isValid` for strings; `getStringId` by `_bsontype` gives the same hex.
`distinct`/`pushToArray`/`pullFromArray` through `MongooseDataStore` keep operators and lean `findByIdAndUpdate`.

**New behaviour on MongoDB:** tenant row check as plugin post hooks (find/findOne/findOneAnd*). Built from the
same decision order as the read filter, so it only fires where the filter did not hold. False-positive shapes
(populated or array `tenantId`, ObjectId membership `tenant`) checked against local consumers 2026-10-27: none use
them — all `tenantId` fields and membership `tenant` are `String`.

**Reported High:** `database: 'mongodb://…'` (or `{ url }`) without `mongoose` passes `assertDataSourcesSupported`,
but `MongooseModule.forRoot` gets the fallback `NSC__MONGOOSE__URI || mongodb://localhost/nest-server-default`
(probed via a vitest spy on `MongooseModule.forRoot`, scratchpad config + node_modules symlink).

**How to apply:** on a re-review, check whether that case is now wired or refused, and focus on the
phase-1+ SQL store rather than re-verifying the policy moves. See [[review-tree-is-shared-and-mutable]].
