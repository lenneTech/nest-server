---
name: authguard-api-token-claim-scope
description: Since 11.42.14 a route-level AuthGuard(JWT|BETTER_AUTH) admits API tokens via enforceApiTokenRoute(); its "never opens what the role guards refuse" doc claim covers route policy, not a USER token's @Roles check
metadata:
  type: project
---

Since 11.42.14 (reviewed uncommitted 2026-10-13) `AuthGuard(JWT | BETTER_AUTH)` accepts a token that
`CoreApiTokenMiddleware` authenticated and calls `enforceApiTokenRoute()` itself. JWT_REFRESH and custom
strategies still never accept one. docs/REQUEST-LIFECYCLE.md says it "never opens a route the role
guards would refuse, even where it runs without one".

That claim fully holds for deny-by-default, scopes, tenant binding and the TENANT-token role decision.
For a USER token, `enforceApiTokenRoute()` returns USER and leaves `@Roles` to the guard's ordinary
checks. AuthGuard has no such checks, so with NO role guard registered (IAM-only mode with Better-Auth
off) a released `@Roles(ADMIN)` route admits any USER token holding the scope. That configuration has
no sessions and enforces `@Roles` for nobody, so in 2026-10-13 I judged it below High and dropped it.

**Why:** a future docs review will read the sentence as absolute and either re-flag it or certify it.
**How to apply:** if a later diff adds a role check to AuthGuard, or makes a role-guard-less
configuration with sessions possible, re-evaluate the claim. Also re-evaluate if a doc starts telling
projects to rely on AuthGuard alone for `@Roles`. Related: [[api-token-tenant-token-lifetime]].
