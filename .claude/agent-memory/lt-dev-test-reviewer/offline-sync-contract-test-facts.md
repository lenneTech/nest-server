---
name: offline-sync-contract-test-facts
description: DEV-3901 sync contract matrix (7 columns, 40 cases) reviewed 2026-10-31 at a35b18f — the 7 sync-* mutations checked statically non-vacuous, the derived window W that no test asserts, and which refusal pairs hold
metadata:
  type: project
---

`tests/sync-contract.e2e-spec.ts` + `tests/helpers/sync-contract-matrix.ts` run `/sync/{model}` over HTTP on mongodb,
mongodb-rs (one-node set, port 27019), postgres × typeorm/kysely/drizzle, mysql, mariadb. Reviewed statically only
(resource rule: no e2e runs); CI runs 41231801431 / 41231909303 were still in progress.

**Reported High:** the derived pull window W (`mongoChangeWindowMs()` / `readChangeWindow()` in
`mongo/sync-schema.plugin.ts`: standalone 30 s, replica set lifetime + 30 s) is asserted by NO test. `configFor()`
pins `sync.pull.windowSeconds: 2` for every column and `CoreSyncService.readClock()` discards `clock.windowMs` whenever
that is set, so any W derivation (even 0) leaves all cells green. The rs column has no late-commit transaction case,
although testing.md says the rs exists for exactly that. Check whether a `pull-window-derived` cell / a late-commit
case was added before re-reporting.

**Status:** fixed in the same review — cell `pull-window-derived` (mongodb: 30 s; mongodb-rs: the server's
`transactionLifetimeLimitSeconds` × 1000 + 30 s; IMPOSSIBLE on SQL), mutation `sync-window-ignores-transaction-lifetime`.
A late-commit transaction case on mongodb-rs was not added.

**Checked non-vacuous (why):** pull-skips-security-check (no other layer runs securityCheck on the plain items; HTTP
interceptor sees plain objects), cursor-ignores-user (fingerprint also carries the user → 410 `access`, case wants
`invalid`), scope-move (lodash `merge` mutates the stored object, so `return stored` sees the new owner),
create-drops-client-id (reply echoes item.id, but the pull `get(id)` is undefined), push-update-without-roles (input
fields S_EVERYONE, only the sync roles refuse bob), header-less-pull (403 → rest() throws), uuid-range (every
continuation builds `_id: {$gt}`, not only same-millisecond boundaries).

**Masked but covered elsewhere:** the e2e `text/plain` push gets 400 from the unparsed body (pushItems), not
necessarily from the Content-Type check; `tests/unit/sync-module.spec.ts` pins that check directly.

**How to apply:** for a clock-ordered sync model, a test-only override of a derived safety value must be paired with
one cell that asserts the derived value itself.
