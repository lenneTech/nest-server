---
name: offline-sync-clients-skew-test-facts
description: DEV-3903 review (2026-10-31, cfab12d) — clock-skew suite's MongoDB columns cannot fail (skew 5 s < derived W 30/90 s), two proven fold races in tests/clients/sync-client.mjs, and which client scenarios are deterministic
metadata:
  type: project
---

Reviewed statically plus two scratch repros of the shared client (fake fetch, SqliteStore, no server); unit specs
sync-client + sync-client-scenarios green. E2E not run (resource rule).

**Reported High (check before re-reporting):**
- `tests/sync-clock-skew.e2e-spec.ts`: SKEW_MS 5000, no `sync.pull.windowSeconds` → MongoDB columns use the DERIVED W
  (standalone 30 s, rs lifetime+30 = 90 s). Next run restarts at runStart − W, so an app-clock regression (insert
  stamp via `new Date()` instead of `mongoServerNow()`, or `readClock()` → `Date.now()`) loses nothing: every write is
  stamped ≥ commit − 5 s > runStart − W. Fix: pin windowSeconds (2, like the contract suite) or skew > 90 s, plus a
  registered mutation. SQL columns are clock-independent by construction (sequence), still test cross-process races.
- `sync-client.mjs` push: lists the outbox in one `store.run`, stamps `sentAt` in a SECOND one from the stale
  snapshot. `Promise.all([sync(), update(id)])` → fold lost on server AND locally (pull overwrites, same version);
  `Promise.all([sync(), remove(draft)])` → draft created on the server and re-pulled. IndexedDB `put` would also
  resurrect removed items.
- Fold guard is `!sentAt`, which is RESET after a failed send / `retry`: a later edit folds into an item the server
  already recorded under that mutationId → recorded outcome `applied`, the edit silently dropped (repro: response lost
  after the server applied it).

**Verified sound:** Node two-tabs IS deterministic — SqliteStore's per-path queue makes both tabs list the outbox
before either marks/sends, so both POST U and C; a broken mutation-id dedupe would give version 3 (merge strategy on
title). PWA two-tabs relies on near-simultaneous `online` events (not asserted, but practically always both send).
expired-session 401 is real (`needsLogin` only set on 401). Node cleared-storage asserts the fresh store is empty
(new file path, the rmSync is cosmetic); PWA relies on `deleteDatabase` success. Contract refactor onto
`bootSyncTestApp` / `syncTestDatabase` is behaviour-preserving (same imports order, labels changed only).

**How to apply:** for a skew test, the skew must exceed the window the pull tolerates; for an offline client, select
and mark the push chunk in one local transaction and fold only into never-attempted items.

Related: [[offline-sync-contract-test-facts]], [[offline-sync-datastore-test-facts]].
