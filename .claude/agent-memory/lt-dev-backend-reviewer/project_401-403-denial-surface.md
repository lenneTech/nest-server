---
name: 401-403-denial-surface
description: The framework denies permission from 5+ layers with inconsistent 401/403 semantics — S_NO_ONE alone has 3 different status codes; map before reviewing any auth-status change
metadata:
  type: project
---

`@lenne.tech/nest-server` denies a request for permission reasons from **five** layers,
and their 401/403 semantics do **not** agree. Anyone reviewing an auth-status change must
map all five, not just the ones in the diff.

| Layer | File | S_NO_ONE | authenticated + lacks right | unauthenticated |
|---|---|---|---|---|
| RolesGuard | `src/core/modules/auth/guards/roles.guard.ts` (:141, :297, :332) | 401 always | 403 | 401 |
| BetterAuthRolesGuard | `src/core/modules/better-auth/better-auth-roles.guard.ts` (:86, :146, :165) | 401 always | 403 | 401 |
| CoreTenantGuard | `src/core/modules/tenant/core-tenant.guard.ts` (:219, :261, :279, :342, :380) | **403 always** | 403 | **403** ("Authentication required" — inverse of RFC 9110) |
| service-layer rights checks | `check()` / `checkRestricted()` / `prepareInput()` | 403 (auth) / 401 (anon) — **since 11.28.0** | 403 | 401 |
| model `securityCheck()` | `src/core/modules/tenant/core-tenant-member.model.ts` (:101, :119) — the only throwing securityCheck in core | n/a | **401** (still) | 401 |

**Why:** PR #559 (11.28.0, `AccessDeniedException`) fixed only the service-layer row. Reviews of
that PR — and of any follow-up — keep having to re-derive this table, which costs a full
cross-file audit each time. Two traps it exposes:

1. **S_NO_ONE has three different status codes** across the layers. Three e2e tests lock the
   guard's 401 in place and must be updated together with any change:
   `tests/stories/better-auth-rest-security.e2e-spec.ts:738`,
   `better-auth-autoregister-false.e2e-spec.ts:219`,
   `better-auth-module-registration.e2e-spec.ts:334`.
2. **`.claude/rules/better-auth.md` only requires RolesGuard ↔ BetterAuthRolesGuard to stay in
   sync with *each other*.** They do. The divergences are guard-layer ↔ service-layer ↔
   securityCheck, which no rule covers — so "both guards agree" is not evidence of coherence.

Also inconsistent: email-verification denial is **403** via `BetterAuthRolesGuard` (S_VERIFIED)
and `CoreTenantGuard` ("Verification required"), but **401** via
`CoreBetterAuthController`/`Resolver` `checkEmailVerification()` (`ErrorCode.EMAIL_VERIFICATION_REQUIRED`).
The 401 is defensible at sign-in (no session yet) but is a landmine for frontends that
auto-logout on 401.

**How to apply:** Before grading any 401/403 change, re-verify this table against current source
(line numbers drift). Judge completeness against *all five* layers — a PR that "centralizes the
401/403 decision" in one layer while leaving the others is an incomplete fix, not a done one.
Related: [[core-errorcode]] — the guards throw translatable `ErrorCode.ACCESS_DENIED`, the
service layer throws raw English strings, for the same logical denial.
