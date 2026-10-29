---
name: offline-sync-spec-review-traps
description: Offline-sync epic DEV-3819 (phase 1 DEV-3898, 2026-10-29) — plan/protocol claims that disagree with 12.1 code; re-check them in phases 2-6 reviews
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

Probe recipe: the Bash hook refuses any command whose text contains `dropDatabase` — write the probe with the Write
tool, name the DB per the e2e run scheme (`nest-server-e2e-run-<ts>-p<pid>-…`) so the startup sweep collects it, and
clean with `deleteMany`. See [[executable-doc-recipes]].
