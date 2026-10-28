---
name: project-db-agnostic-phase3-better-auth-sql-facts
description: DEV-3831 (Better-Auth on SQL) review 2026-10-28 — what was traced sound, and the one missed reader (MCP OAuth loadUser reads Mongo `users`)
metadata:
  type: project
---

Phase 3 review (feat/db-agnostic, d1546e4..e5c5446): one High, no Critical.

**Why:** so the next review re-tests the named spots instead of re-deriving the whole SQL auth path.

**How to apply — the one finding (re-check whether it was fixed):**
- `CoreAiMcpOAuthService.loadUser()` (`src/core/modules/ai/services/core-ai-mcp-oauth.service.ts`) reads roles from the
  MongoDB `users` collection. With Better-Auth on SQL the OAuth `sub` is a SQL row id → null → every MCP OAuth call 401
  (fail closed); with a retained pre-migration Mongo copy (same ids) roles come from the stale copy. MCP OAuth suites are
  NOT in `IAM_SQL_TEST_INCLUDE` (`vitest.include-globs.mts`), so nothing catches it. Grep recipe for missed readers:
  `grep -rn "collection('users')" src/core` and check each has a SQL branch.

**Traced sound (re-verify only if the named code changes):**
- Better-Auth output on the shared `users` row is filtered to DECLARED fields by the adapter factory
  (`@better-auth/core/dist/db/adapter/factory.mjs` `transformOutput`) — framework secret columns never reach `/iam/*`.
- `withSqlStorage()` keeps `input:false` (field spread); Better-Auth's input schema = additionalFields + plugin
  fields only. The privilege-escalation spec runs in every `iam-sql-<engine>` project.
- Session tokens stay `generateId(32)` from Better-Auth's RNG (`internal-adapter.mjs` createSession);
  `advanced.database.generateId` (ObjectId hex) only feeds row ids — same as the Mongo adapter.
- `updateUserAsSystem` (role-guard bypass) has exactly one caller: system setup, after count==0 + claim lock.
- Tenant GUC is `set_config(…, true)` (transaction-local) — Better-Auth sharing the app pool inherits no scope.
- Tenant-isolated users table on SQL: anonymous count hits the tenant safety net (throws) → fail closed; Better-Auth
  itself cannot run there (RLS raises), so the config is non-functional rather than exploitable.

Related: [[project-db-agnostic-phase2-core-modules-facts]], [[project-betterauth-input-false-enforcement]].
