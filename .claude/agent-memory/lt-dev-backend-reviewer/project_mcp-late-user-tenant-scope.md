---
name: project_mcp-late-user-tenant-scope
description: 11.43.3 MCP OAuth tenant scoping (scopeLateResolvedUser + CoreTenantGuard.resolveMembershipContext) — what was verified sound, so it is not re-flagged.
metadata:
  type: project
---

Reviewed 2026-10-22 (uncommitted on develop), zero findings.

**Verified sound (don't re-flag):**
- S_EVERYONE branch refactor into `memberTenantContext()` is call-for-call identical (findMembershipCached ->
  isTenantActive short-circuit -> capApiTokenTenantRole ?? undefined).
- `resolveMembershipContext()` parses the header exactly like `canActivate()` (string, <=128, trim, empty -> none);
  no admin bypass, matching the guard's S_EVERYONE branch (which has none either).
- `RequestContextMiddleware` getters read `req.user` / `req.tenantId` lazily, so setting them in the handler works.
- OAuth `loadUser()` returns a plain `{ id, roles }`; every RequestContext consumer (role-guard plugin uses
  `hasRole?.` + `roles?.includes`, audit plugin, `hasTenantRole`) tolerates a plain object.
- Setting `req.user` only tightens: role-guard plugin allows everything when currentUser is empty.
- API-token credentials never reach the controller unauthenticated (`enforceApiTokenRoute` -> 401 via
  `hasApiTokenCredential`).
- Hook/DB throw in the controller path -> Nest 500, same as the guard path (`@Res()` does not disable the filter).
- Registry stays a type-only leaf; madge still the known 6 cycles.

Related: [[project_mcp-oauth-consent-11-42-17]], [[core-controller-override-contract]].
