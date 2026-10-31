---
name: offline-sync-phase4-dev3901
description: DEV-3901 sync module review 2026-10-31 — 2 Highs (push conflict replies bypass sync roles; pull/findVisible pair content and version/position from two reads); claims, keyset, epochs verified sound
metadata:
  type: project
---

Phase 4 of offline sync (CoreSyncModule: pull, push, conflicts, client ids, resync), reviewed 2026-10-31 on
`feature/dev-3901-offline-sync-4-sync-modul` (commit a35b18f), by reading only (resource rule: no e2e).

**Reported High:**
1. `findVisible()` reads via `service.get()` WITHOUT `roles`, and `applyItem()` answers a create on an existing id with
   `conflict` + record before any role check (also stale-baseVersion update/delete: `assertVersion` runs before
   `process()`). Any S_USER with an id reads records whose sync pull/create roles (default: ADMIN only — the
   `SyncLocked` e2e fixture) refuse them; a user whose pull role was withdrawn keeps reading by the ids they hold.
2. `pull()` takes content from `readChanges()` (CrudService.find) and version + cursor position from a LATER
   `readSystemFields()` store read. A write between the two: item = old data with new version, and if it is the last
   consumed record the cursor jumps to its new seq/syncAt, skipping every record in between (permanent on SQL; on
   MongoDB for records older than runStart − W). Same pairing in `findVisible()` for conflict replies. Fix direction:
   system fields (keyset) first, content second.

**Status: both fixed in the same review.** The pull reads positions and system fields first through the store
(`readPositions()`), the content second (`readContents()`, CrudService with the pull roles); `findVisible()` reads the
system fields first and the content with the pull roles, a refusal answering like an unknown id. Contract cases
`pull-change-between-reads` and `push-without-pull-roles` with registered mutations.

**Verified sound (don't re-derive):** Mongo keyset `(syncAt,_id)` + end-of-run `runStart − W` (s ≥ commit − W >
runStart − W); mutation claim/busy/takeover on `attempt`; lww/merge/custom reapply loop; epoch snapshot before
`mergePlain` in both update paths + key alignment with `accessState`; createId paths; no-sync behaviour unchanged;
cursor HMAC; push CSRF rules; `RequestContext` tenant getters are lazy (controller `scopeTenants` works).
Note: on MongoDB `usesNeutralStore` is FALSE (MongooseDataStore has `mongoosePopulate`), so CrudService runs its
Mongoose path there. `check()` roles use global `user.roles` only (tenant roles fail closed). See
[[offline-sync-phase3-dev3900]].
