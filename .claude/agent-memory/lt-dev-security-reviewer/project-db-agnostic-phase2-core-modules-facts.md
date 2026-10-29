---
name: project-db-agnostic-phase2-core-modules-facts
description: DEV-3830 (db-agnostic phase 2) review 2026-10-28 — user/tenant/api-token/locks/migrate on SQL traced sound; which residuals were judged below bar and why
metadata:
  type: project
---

Phase 2 review (feat/db-agnostic, 12 commits 954c490..93c5a47): zero Critical/High.

**Why:** recorded so the next review re-tests instead of re-deriving, and does not re-report the residuals.

**How to apply — traced sound (re-verify only if the named code changes):**
- `SqlDataStore.updateOne/deleteOne`: `WHERE id = (SELECT id … LIMIT 1 FOR UPDATE) AND <recheck>`, both halves via
  `this.where()` (tenant filter included), all values bound; `quoteIdentifier` is regex-validated.
- API-token SQL paths: `toNeutralFilter` keeps the `user`/`kind`/`tenant` ownership keys; `toInfo` strips
  `secretHash`/`signingKeyEncrypted` (SQL returns them — no `select:false` there); `loadTokenUser` SQL branch deletes
  the same six secret fields the Mongo projection excludes.
- `CoreTenantGuard.identifyThroughRoleGuard()` (ROLE_GUARD token) only adds a user or throws the role guard's own
  401/403 — it runs after the S_EVERYONE early return and cannot grant; NestJS still runs the role guard afterwards.
- Better-Auth refusal keys on `tableName(model) === 'users'`; a working BA project's user model must sit on `users`
  anyway (the mapper writes that collection), so a renamed table is not a realistic bypass.
- Lock formats: system-setup/migration/cron `MongoLockStore` options interoperate with the 12.0.0 docs both ways;
  `PostgresLockStore.tryAcquire` is not re-entrant for the same owner (two anonymous `/system-setup/init` in one process
  → one wins).

**Residuals judged below bar:**
- SQL health-check ping (`HealthIndicatorService.attempt`) puts the pg error message in the public response — same
  terminus mechanism the Mongoose ping already uses (parity).
- `@Tokens('token')` reads the `token` COOKIE before the Authorization header, and legacy `logout()` uses
  `decodeJwt` (unverified) for `deviceId`; the `user.refreshTokens[deviceId]` truthiness check passes for
  `constructor`/`__proto__`. Since DEV-3830 that writes `{ <name>: null }` into the caller's OWN record — no foreign
  account, value null so no prototype pollution. Pre-existing shape.

Related: [[project-db-agnostic-phase0-store-facts]], [[project-hub-config-masking-gaps]].
