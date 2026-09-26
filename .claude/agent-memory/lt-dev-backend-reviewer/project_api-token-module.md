---
name: project_api-token-module
description: API-token module (11.41.4, src/core/modules/api-token) — how deny-by-default is enforced, what was verified sound, and the S_SELF/S_CREATOR gap (closed before release).
metadata:
  type: project
---

`apiTokens` adds USER and TENANT tokens (reviewed 2026-09-26, uncommitted on `develop`). The whole
route policy lives in ONE function, `enforceApiTokenRoute()` (core-api-token.helpers.ts), called by
RolesGuard, BetterAuthRolesGuard and CoreTenantGuard BEFORE their public-route shortcut. Anything
not behind a Nest guard (Express routers mounted with `app.use`, Better-Auth native `/iam/*`) does not
see `@ApiTokenScopes()` — the MCP OAuth consent has its own `getApiTokenContext(res.req.user)` check.

Verified sound in that review (don't re-derive from scratch): secretHash/signingKeyEncrypted are
`select:false` AND stripped by `toInfo()` on every return path; all management filters are built from
validated values (24-hex regex, `String(currentUser.id)`, typeof-string tenantId); user-token users
have global roles stripped via `resolveGlobalAndTenantRoles` (unknown project roles are KEPT — by
contract, only ADMIN + `globalOnlyRoles` are "global"); role guards now delegate to the tenant guard
only while `core-tenant-guard.registry` counts one (module onModuleInit + guard constructor).

**Gap — CLOSED before the 11.41.4 release** (the security reviewer reported it High; now refused and
pinned by mutation `tenant-token-passes-object-level-system-roles`). Before the fix, for a TENANT token,
`assertTenantApiTokenRouteAccess` checks only non-system roles, so a route whose merged roles are
exclusively `S_SELF`/`S_CREATOR` passes the guard for ANY target id — BetterAuthRolesGuard's guard-level
S_SELF comparison is skipped because TENANT returns early. Scopes are shared by both kinds, so a tenant
manager can mint a tenant token for a scope meant for "own profile" routes. Becomes reportable the
moment a project or `src/server` opens an S_SELF-only route with `@ApiTokenScopes`. A route guarded
ONLY by object-level system roles now refuses tenant tokens; an OR with a tenant role still resolves.

**Why:** saves re-auditing the same surface; flags where a future diff would turn the gap real.
**How to apply:** on any diff touching api-token helpers or adding `@ApiTokenScopes` to S_SELF/S_CREATOR
routes, check the refusal is still in place (the mutation guards it). Related: [[project_401-403-denial-surface]].
