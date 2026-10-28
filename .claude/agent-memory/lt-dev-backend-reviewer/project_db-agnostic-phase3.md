---
name: db-agnostic-phase3
description: feat/db-agnostic phase 3 (DEV-3831, Better-Auth on SQL) review 2026-10-28 — *OnSql parity, schema path, passkey cookie verified; High: Better-Auth adapter.findMany caps at 100 rows (getMigrationStatusOnSql)
metadata:
  type: project
---

Phase 3 (Better-Auth follows the `users` table onto SQL; `BetterAuthSqlStore` via the leaf
`core-better-auth-sql.registry.ts`), reviewed 2026-10-28 against `origin/feat/db-agnostic...HEAD`.

**Reported High:** `BetterAuthSqlStore.credentialUserIds()` calls Better-Auth's `ctx.adapter.findMany()` without a
`limit`; the adapter factory (`@better-auth/core/dist/db/adapter/factory.mjs` ~l.609) then applies
`advanced.database.defaultFindManyLimit ?? 100`. Probed with the memory adapter: 150 accounts → findMany 100, count 150.
So `getMigrationStatusOnSql` caps usersWithIamAccount/fullyMigratedUsers at 100 → canDisableLegacyAuth never true,
false lockout warning in `CoreLegacyAuthDeprecationInitializer`. **Any new `adapter.findMany` without explicit limit
is the same bug** — check for it in later phases. (`deleteUserChallenges` has it too but has no caller.)

**Verified sound (don't re-derive):** schema path (advisory xact lock on one owner conn, BA migrator on a second,
grants after; no-owner path verifies only; BA's getMigrations never destroys the pool; second boot no-op); passkey
cookie name = `createAuthCookie(advanced.webAuthnChallengeCookie).name` matches the plugin; nuxt-extensions already
sends `challengeId`; Mongo branches of token service/mapper/service behave as before; SQL store reads `password`
(no `select:false` on users). See [[db-agnostic-phase2]].
