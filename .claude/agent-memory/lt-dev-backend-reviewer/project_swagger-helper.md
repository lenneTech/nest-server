---
name: project_swagger-helper
description: setupSwagger() (11.42.7, common/helpers/swagger.helper.ts) — what was verified to match the guards, and the token-view tenant-header gap found in review (2026-10-06).
metadata:
  type: project
---

`setupSwagger()` maps every operation to its handler via the DEFAULT operationId
(`<Controller>_<method>[_<version>|_<httpMethod>]`) and reads the same metadata as the guards.
Reviewed 2026-10-06 (uncommitted, DEV-3352). Verified sound, don't re-derive:
- `isPublic` = role guards' rule (`!roles.some(Boolean) || S_EVERYONE`) AND, under multiTenancy,
  CoreTenantGuard's "method-level system roles beat class-level" rule. Scopes: `handler ?? class`,
  identical to `assertApiTokenScopes()`. `@SkipTenantCheck` = `getAllAndOverride` order.
- Handler = `registeredClass.prototype[name]`, class = registered subclass — same pair as
  `context.getHandler()/getClass()`, so inherited Core* handlers and runtime-written roles (hub, file,
  tus, permissions) are read correctly (document is built lazily on first request).
- Probe recipe that works: boot `dist/server/server.module.js` with NODE_ENV=local and a throwaway
  `MONGODB_URI`, call `buildSwaggerDocument(app, opts, cfg)`; drop the DB with the `mongodb` driver
  (mongosh is not installed). 140 ops, 24 public, `structuredClone` of the doc OK.

**Gap reported (High):** the API-token view strips the `TenantHeader` parameter "because a tenant
token carries its tenant" — but an UNRESTRICTED USER token (default: `tenantId` optional at creation)
selects its tenant by that header exactly like a session (tests/api-token.e2e-spec.ts ~732-742), and
without it a tenant-role route answers 403 "Insufficient role". Fixed in the tree DURING the review
(14:59): the view keeps the header while `userTokens` is on (`keepsTenantHeader`), pinned by a spec
case "keeps the tenant header while personal tokens exist". On a re-review, check it survived.

**Also fixed before release (found by a probe against the real ServerModule, not by the spec):**
a handler serving several paths (`@Get([...])`) gets the operationId `<method>[<index>]` per path
(@nestjs/swagger `swagger-explorer.js`, `isAlias`), which `resolveHandler()` could not map — the 16
Hub page routes stayed unenriched (documented as protected although they are `S_EVERYONE`) and logged
one WARN each. The `[n]` suffix is now stripped before resolution, pinned by an `@Get(['archive',
'history'])` spec case.

**11.42.8:** the `search` operation `@All()` emits was skipped too — the helper iterated a fixed
`HTTP_METHODS` list that has no `search`. It was dropped in the 11.42.7 review as "below the bar,
Swagger UI does not render it", which was wrong: it stays in `/api-docs-json`, and `operationTags`
did not reach it, so a consumer's SEARCH operation landed in its own tag group. Operations are now
read from the path item (everything except `$ref`/`summary`/`description`/`servers`/`parameters` and
`x-*`). The Better-Auth pass-through `handlePluginRoutes` (`@All('*path')`) is `@ApiExcludeEndpoint()`
since 11.42.8 — eight useless `/iam/{path}` operations before.

Dropped as below the bar (don't re-raise without new facts): class S_EVERYONE + method S_NO_ONE
documented public (no such route exists); legacy `/auth/refresh-token` documented public (needs the
refresh token, Swagger cannot send it anyway); "allowed with scope" on ADMIN-only or manager-only
routes that tenant tokens / role-stripped user tokens cannot pass (the line states the scope
condition, roles apply as for sessions). Related: [[project_api-token-module]].
