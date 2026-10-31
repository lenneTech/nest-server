---
name: offline-sync-spec-review-traps
description: Offline-sync epic DEV-3819 — phases 1-3 (DEV-3898/3899/3900) plan, protocol and implementation claims that disagree with code; re-check in DEV-3901+
metadata:
  type: project
---

Reviewed `docs/offline-sync-protocol.md` + `.claude/plans/offline-sync/PLAN.md` on 2026-10-29 (commit 9b03053 plus
the author's working-tree fixes). All five were fixed in the plan/protocol text before the merge (E1 now routes the
conditional change through `CrudService.update()` via `expectedVersion`, E2 reads `$type: 'null'` and lets push see
tombstones, §3.6 no longer claims NOT NULL, protocol §6.2 chains `baseVersion`). These are the traps worth re-checking
in the IMPLEMENTATION when phases 2-6 land:

- **The conditional change has no pipeline path.** PLAN E1 says "`updateOne({ id, version })`, no new method", but push
  must go through `CrudService.update()`, which is `findById` → `mergePlain(stored, input)` → `updateById(id, …)` /
  `findByIdAndUpdate(id, merged)` keyed on id alone (crud.service.ts ~l.659). It also writes the whole stored record
  back, so a stored `version` lands in `$set` next to the policy's `$inc` (MongoDB/MySQL refuse two operators on one
  path). Check that phase 3/4 adds a version-conditioned CrudService write.
- **SQL never has NOT NULL except `id`** (both schema compilers, header comments). "Relax NOT NULL for required
  fields" is a non-existent migration; `required` is validation-only.
- **Mongo partial index vs read filter:** `{ deletedAt: null }` cannot use a partial index on `{ $type: 'null' }`
  (COLLSCAN, probed MongoDB 8.2.3); `$type: 'null'` compiles to `IS NULL` on PG and MySQL. Fixed in E2 in the working
  tree the same day — make sure the implementation uses the same expression for index and reads.
- **E2 `includeTombstones` "only pull and cleanup"** contradicts protocol §6.3/§7 (push answers `conflict` with the
  tombstone, re-delete `applied`) — push needs tombstones too.
- **`baseVersion` of a second queued change is undefined** ("absent for a record the client created" + "an id taken by
  a visible record = repeated create → conflict"): offline create-then-edit and edit-twice yield false conflicts.
- DEV-3819 requirement trace (protocol §14) checked complete against the ticket text (27 requirements). The ticket
  says "kein Mongoose-Plugin"; E1/E2 put the policies on MongoDB into plugin hooks like the tenant policy — read as the
  port's implementation, not sync code; not flagged.

**Phase 2 (DEV-3899, reviewed 2026-10-31, commit 99c69f4)** — decision: SQL = C1d (trigger counter taken last),
MongoDB = C2 (`syncAt: '$$NOW'` + window W from `transactionLifetimeLimitSeconds`), live filter `{ deletedAt: null }`,
one id format per model. Traps found in the text, re-check in phase 3/4 code:

- **"upsert for inserts" on MongoDB** (PLAN §3.4 consequences; prototype `targets.mjs` writeDoc C2) — an
  `updateOne({ _id }, pipeline, { upsert: true })` on a taken id UPDATES the existing doc (version reset to 1) instead of
  E11000, which E6's server-id retry and protocol §3 conflict/`ID_UNAVAILABLE` rely on. The filter must never match.
- **Per-(model, tenant) counter vs scalar cursor** — header-less requests carry `tenantIds` (all memberships,
  `core-tenant.guard.ts` `resolveUserTenantIds`), so one `sync_seq > cursor` over several independent counters skips
  the lower tenant's changes. Needs a per-tenant position, a single-tenant pull, or one counter per model.
- Stale "both formats per model" survived the one-format decision: protocol §7 `INVALID_ID` "neither accepted format",
  the §5.2/§6.2/§6.6 examples mixing uuidv7 + ObjectId in one model, PLAN §3.2 "accepted id formats (both)".
- §3.9 says "the CrudService emits" hints while E5/§11/Phase 5/protocol say the store — dropped as Medium (hints optional).
- `summarize.mjs` parses stdout LOGS, not `--out` JSON (silent empty output); README's replica-set block 2 runs after
  block 1's `docker rm -f` and leaves `transactionLifetimeLimitSeconds: 3` set.

**Phase 3 (DEV-3900, reviewed 2026-10-31, commit b1cd584)** — implementation landed; traps found, re-check in DEV-3901:

- **`includeTombstones` is not honoured everywhere it is documented**: the MongoDB `pre('aggregate')` hook unshifts
  the live `$match` unconditionally, so `CrudService.findAndCount(…, { includeTombstones })` drops tombstones on MongoDB
  only (probed: find 2, aggregate 1); `update()` / `delete()` never forward it although `ServiceOptions` JSDoc says
  they "match" tombstones.
- **Existing MongoDB model → sync has no safeguard** (SQL has: boot stops on the unique index, `ADD COLUMN … DEFAULT 1`
  + numbering): the rewritten partial index keeps Mongoose's auto name `email_1`, `init()` rejects with "existing index
  has the same name" and Mongoose swallows it — the old full unique index stays, so the SECOND tombstone of that model
  fails E11000 `{ email: null }`. Pre-existing docs have no `version`/`syncAt`: hydrated reads show the default 1, a
  lean compare sees undefined → every `expectedVersion` 409s, `doc.save()` → DocumentNotFoundError.
- **Status:** both fixed in DEV-3900 before the merge — the aggregate hook reads the flag, the `ServiceOptions` comment
  now says reads only (update/delete answer 404 for a tombstone), and MongoDB refuses an unprepared collection at boot
  (`assertSyncCollectionReady`); `.claude/rules/persistence.md` names the migration.
- Probe recipe that works: `npx tsx <scratchpad>.mts` from the repo root, `createRequire('<repo>/package.json')` for
  mongoose, `await import('<repo>/src/core/common/persistence/mongo/sync-schema.plugin.ts')` for the plugin.

Probe recipe: the Bash hook refuses any command whose text contains `dropDatabase` — write the probe with the Write
tool, name the DB per the e2e run scheme (`nest-server-e2e-run-<ts>-p<pid>-…`) so the startup sweep collects it, and
clean with `deleteMany`. See [[executable-doc-recipes]].
