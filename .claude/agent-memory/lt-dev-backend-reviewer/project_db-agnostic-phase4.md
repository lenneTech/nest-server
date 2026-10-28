---
name: db-agnostic-phase4
description: feat/db-agnostic phase 4 (DEV-3832) review 2026-10-28 — AI/MCP OAuth/file metadata on the store port verified; High: SQL writes `$set: { x: undefined }` as NULL where Mongoose strips it (AI prompt tenantId → RLS 403)
metadata:
  type: project
---

Phase 4 (AI services + MCP OAuth stores + S3/filesystem file metadata on the routed store, `sum()`, `exclude`,
`upsertRecord()`, expiry sweep), reviewed 2026-10-28 against `origin/feat/db-agnostic...HEAD`.

**Reported High:** `compilePostgresUpdate` turns `$set: { field: undefined }` into `"field" = NULL`; Mongoose ≥ 6
strips undefined keys (probed: cast `$set` loses the key). `CoreAiPromptService.create()` / `update()` (scope
change) pass `tenantId: undefined` for scope `user` → on SQL with multiTenancy + tenant header the UPDATE violates
the RLS WITH CHECK → 42501 → 403, after the insert already committed (orphan row, owner_id NULL, which then blocks
that prompt `name` for everyone via the NULLS NOT DISTINCT (ownerId, name) unique index). **Any converted
`mainDbModel` call that passes possibly-undefined `$set` values is the same bug** — check for it in later phases.

**Verified sound (don't re-derive):** Mongo branches of every AI service equivalent (MongooseDataStore wraps the same
model, plugins fire; `toRecord` gives `id` — no caller still reads `_id`); unique indexes back every `upsertRecord`
(SQL uses NULLS NOT DISTINCT; DuplicateKeyError carries code 11000); `sqlFileCollection` covers every op the file
helpers/TUS/Hub call (findOne sort, find limit/sort, countDocuments, deleteOne, insertOne keeps the ObjectId as id);
no local consumer assigns `s3Files`/`filesystemFiles`. Tenant plugin hooks `aggregate`, so Mongo `sum()` is scoped.
Probe pattern: tsx `.mts` in scratchpad, plain `mongoose.Schema` + `describeSchema()` (decorated model classes fail
under esbuild: no decorator metadata). See [[db-agnostic-phase3]].
