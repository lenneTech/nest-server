---
name: db-agnostic-phase2
description: feat/db-agnostic phase 2 (DEV-3830) review 2026-10-28 — lock formats, Mongo-branch parity, tenant-guard role-guard call verified; one High (createMigrationStore SQL branch hardcodes typeorm)
metadata:
  type: project
---

Phase 2 (core modules on the store port, framework locks on LockStore, SqlStateStore, Hub persistence panel),
reviewed 2026-10-28 against `origin/feat/db-agnostic...HEAD`.

**Verified sound (don't re-derive):** every `usesNeutralStore` / `routedMemberStore` / `tokenStore` / `userStore`
branch leaves the Mongo branch as before (routed store on Mongo is a MongooseDataStore, `mongoosePopulate: true`).
MongoLockStore legacy formats: setup `{_id, claimedAt}` and migration `{lock, owner, acquiredAt}` take over on the
same rule old code applies (timestamp + 60 s / 5 min); new writes stamp the legacy field so old waiters agree;
upsert with `$or` filter is NOT eligible for Mongo's dup-key auto-retry, so 11000 → lost. Cron takeover of an
expired-but-uncollected doc is deliberate (AC "no correctness on a TTL index"). Tenant guard calling ROLE_GUARD
only when `request.user` is missing: role guard runs later anyway, so outcome only changes status codes.

**Reported High:** `createMigrationStore(postgresUrl)` builds `SqlStateStore` without an engine → `'typeorm'`
default → a kysely/drizzle project (typeorm is an optional peer) fails every `migrate` call. Hub path passes
`source.engine` correctly.

**Not reported (Medium):** migration heartbeat `renew()` requires `expiresAt > now`, so after a >60 s heartbeat gap
the lock can never be re-stamped even if nobody took it (old code re-stamped by owner alone).
See [[db-agnostic-phase1]].
