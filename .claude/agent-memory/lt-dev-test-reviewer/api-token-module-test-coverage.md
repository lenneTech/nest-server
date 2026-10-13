---
name: api-token-module-test-coverage
description: Coverage state of src/core/modules/api-token after the first review (2026-09-26, uncommitted on develop) — mass-assignment filter and the "tokens never manage tokens" backstop untested; which layer really produces each 403
metadata:
  type: project
---

API-token module (USER + TENANT tokens, `@ApiTokenScopes` deny-by-default) as first reviewed 2026-09-26, uncommitted on `develop` on top of d1b9f00. Verify against current specs before reusing — remediation may have landed.

**Gaps found (reported High) — both CLOSED before release** (mutations `api-token-update-rebinds-tenant`,
`api-token-dotted-key-bypasses-projection`, `api-token-service-accepts-token-callers`; the service-level
case drives a real narrowed USER token through `service.authenticate()`):
- `PROTECTED_FIELDS` / `projectFields()` in `core-api-token.service.ts` is the ONLY barrier on the UPDATE paths (`commonUpdate` spreads project fields into `$set`; model has no `immutable`), and the reference management controller forwards `@Body() body: any` raw. No spec sends `tenant` / `user` / `kind` / `revokedAt` in a payload, so dropping a key from the set stays green while it would let a tenant admin move a tenant token into a foreign tenant or turn it into a user token of any user.
- `'a token can never manage tokens'` (api-token.e2e-spec) is vacuous for its claim: the management controller has no `@ApiTokenScopes`, so the guard's deny-by-default answers 403 before `assertPerson()` runs, and it uses a TENANT token, for which the backstop is redundant anyway. The load-bearing case is a restricted/capped USER token on a released management route.

**Not flagged, but unexercised:** all api-token stacks run `multiTenancy.cacheTtlMs: 0`, so the cap-dependent `resolveUserTenantIds` cache bypass (`capped ? 0 : ttl`) and every production-default cache interaction are never hit. The kind gate in `findUsableToken` (userTokens/tenantTokens false) has no test either.

**Isolation facts that held up:** every stack uses its own `deriveTestDbUri` DB (immune to the jwks wipe, see [[e2e-isolation-model]]); `bootApiTokenIamApp` REPLACES ConfigService via `setConfig(reInit)` before forRoot merges (see [[configservice-singleton-in-tests]]); the process-wide tenant-guard counter (`core-tenant-guard.registry.ts`) is released on `app.close()`.

**Route-level AuthGuard (11.42.14 review, 2026-10-13):** global APP_GUARDs run BEFORE a route's `@UseGuards(AuthGuard(...))`, so in the assembled e2e stack every 403 for a token comes from the role/tenant guards — the AuthGuard's own `enforceApiTokenRoute()` call is provable only in the standalone unit describe (`api-token-guard-invariants.spec.ts`). `RolesGuard extends AuthGuard(JWT)`, `RefreshTokenGuard extends AuthGuard('jwt-refresh')`: AuthGuard changes reach both via `super.canActivate`. Verified in a scratch copy: dropping strategy gating turns only the JWT_REFRESH case red (load-bearing, not vacuous — unregistered passport strategy would also reject, but the token branch resolves true first).

**How to apply:** for any "X can never do Y" test, trace which layer produced the status code — an earlier deny-by-default layer often satisfies the assertion before the protection named in the title is reached.
