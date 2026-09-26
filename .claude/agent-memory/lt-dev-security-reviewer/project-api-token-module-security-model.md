---
name: project-api-token-module-security-model
description: API-token module (11.41.4, uncommitted 2026-09-26) — how enforceApiTokenRoute decides per kind, what was verified sound, and the one gap found (tenant token passes @Roles(S_SELF)/@Roles(S_CREATOR)-only routes)
metadata:
  type: project
---

# API tokens (`src/core/modules/api-token/`) — review 2026-09-26

**Decision point:** `enforceApiTokenRoute()` (core-api-token.helpers.ts) is called by RolesGuard,
BetterAuthRolesGuard and CoreTenantGuard BEFORE their public-route shortcut. TENANT kind → fully
decided in `assertTenantApiTokenRouteAccess()`, guard returns true. USER kind → scope check, then the
ordinary guard path runs with the user (global roles stripped in `loadTokenUser`).

**Gap reported — FIXED before release** (refused since; mutation `tenant-token-passes-object-level-system-roles`,
unit + per-guard invariant). Original shape: `assertTenantApiTokenRouteAccess`
filters system roles out of `checkable`, so a route whose only roles are object-level (`S_SELF`,
`S_CREATOR`) has nothing to check and a TENANT token is GRANTED. For sessions/user tokens,
BetterAuthRolesGuard enforces `S_SELF` via `params.id`/`args.id` and 403s `S_CREATOR`-only.
Probe: build a class with `@ApiTokenScopes('x') @Roles(RoleEnum.S_SELF)`, call `enforceApiTokenRoute`
with a tenant principal (`createTenantApiTokenPrincipal`) — returns `'tenant'` instead of throwing.
Run with `npx tsx --tsconfig tsconfig.json <file>` importing reflect-metadata by absolute path.

**Verified sound (do not re-litigate without a code change):**
- No core route declares `@ApiTokenScopes` → every framework route (iam, hub, file, tus, mcp, ai)
  denies tokens; exposure is only what a PROJECT opens.
- CoreBetterAuthMiddleware skips on `hasApiTokenCredential` → a cookie riding along never upgrades a
  token request to a session. Invalid prefixed credential → 401 everywhere.
- Token management refuses token callers via symbol-based `getApiTokenContext` (assertPerson +
  model securityCheck). `projectFields` judges a key by its ROOT segment since the review fix, so
  dotted keys (`scopes.0`, `tenant.x`) are dropped like their root.
- `delegatesRolesToTenantGuard()` is strictly narrower than the old `isMultiTenancyActive()` — can
  only fail closed more.
- New assertion-redaction regex in logging.helper is not ReDoS-prone (measured, sub-ms on 64 KB).

Related: [[project-roles-metadata-merge-semantics]], [[project-ai-mcp-oauth-refresh-token-binding]]
