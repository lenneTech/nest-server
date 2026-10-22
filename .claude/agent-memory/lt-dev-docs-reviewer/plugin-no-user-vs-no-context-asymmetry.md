---
name: plugin-no-user-vs-no-context-asymmetry
description: Mongoose plugins disagree on "request context but no current user" — tenant plugin refuses, role-guard/audit treat it as system work; check which one a doc claim is about
metadata:
  type: feedback
---

When a doc claims what happens to a request that reached a handler WITHOUT `req.user` (late-resolved
credential, public route), split the claim per plugin. They do not key on the same thing:

| Plugin | Keys on | Context present, no user |
|--------|---------|--------------------------|
| `mongooseTenantPlugin` (`shouldBypass` / `resolveTenantFilter`) | `RequestContext.get()` existing, then tenantId/tenantIds/isAdminBypass | **refused** ("Tenant context required") |
| `mongooseRoleGuardPlugin` (`isRoleChangeAllowed`) | `getCurrentUser()` | **allowed** — read as system work |
| `mongooseAuditFieldsPlugin` | `getCurrentUser()?.id` | no createdBy/updatedBy |
| `assertTenantRole()` | currentUser + `fromRequest` | 401 (anonymous) |

**Why:** 11.43.3 review (2026-10-22, MCP OAuth late-resolved user). role-system.md's phrase "no
context = system operation, no filter" is about the tenant plugin with NO context at all; a reader
(or a guide) can easily over-apply it to "no user" and claim tenant data leaked, or the reverse.
`RequestContextMiddleware` reads `req.user` through a lazy getter, so setting `req.user` inside a
handler does reach all four.

**How to apply:** for any "fail-closed" / "was read as system work" claim in a guide, open the four
sites above and confirm the branch per plugin. Related: [[migration-guide-behavior-change-count-trap]].
