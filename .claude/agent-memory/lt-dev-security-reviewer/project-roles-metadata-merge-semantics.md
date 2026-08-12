---
name: project-roles-metadata-merge-semantics
description: How class-level and method-level @Roles() actually combine across the three guards — OR-merge means a method-level S_EVERYONE DEFEATS a class-level ADMIN, CoreTenantGuard uses different (method-precedence) semantics for system roles, and @Roles(ADMIN) is satisfiable by a TENANT membership role literally named 'admin'.
metadata:
  type: project
---

# @Roles metadata merge — three guards, two different rules

Verified 2026-08-10 against `roles.guard.ts`, `better-auth-roles.guard.ts`, `core-tenant.guard.ts`,
`core-tenant.helpers.ts` and confirmed empirically with the file e2e suite.

## 1. OR-merge: a method-level `S_EVERYONE` defeats a class-level `ADMIN`

`mergeRolesMetadata([handlerRoles, classRoles])` (`core-tenant.helpers.ts:17`) **concatenates** —
it is not an override. `@Roles(ADMIN)` on the class + `@Roles(S_EVERYONE)` on the method yields
`['s_everyone', 'admin']`, and both `RolesGuard.canActivate` (`roles.guard.ts:148`) and
`BetterAuthRolesGuard.canActivate` (`better-auth-roles.guard.ts:99`) then short-circuit to
`return true` **before any authentication runs**. The class-level restriction is inert.

Consequence for review: **never read a class-level `@Roles` as a floor.** Any method-level role
widens. `@Roles(S_USER)` on a method under a class `@Roles(ADMIN)` means "any logged-in user",
not "admin". `S_NO_ONE` is the only role that narrows.

## 2. `CoreTenantGuard` uses a DIFFERENT rule for system roles

`core-tenant.guard.ts:226-229` builds two sets: `roles` (OR-merged, for real-role checks) and
`systemCheckRoles = methodRoles.length > 0 ? methodRoles : roles` — **method-takes-precedence**
for `S_EVERYONE` / `S_USER` / `S_VERIFIED`. So the same decorator pair can be read one way by the
roles guard and another way by the tenant guard. When auditing, check both.

## 3. `@Roles(RoleEnum.ADMIN)` is NOT "system admin only" under multiTenancy

`RoleEnum.ADMIN === 'admin'` (a plain string). With multiTenancy active:

- `RolesGuard.handleRequest` (`roles.guard.ts:317`) **passes every non-system role through** to
  `CoreTenantGuard` instead of denying.
- With an `X-Tenant-Id` header, `CoreTenantGuard` checks `checkRoleAccess(['admin'], undefined, membership.role)`
  — i.e. against the **tenant membership role only**, `user.roles` is ignored (guard doc §"Tenant
  context rule").
- A tenant member whose `membership.role` is literally `'admin'` therefore satisfies
  `@Roles(RoleEnum.ADMIN)` (exact match), and with a custom hierarchy containing `admin`
  (the example in `.claude/rules/role-system.md`) so does anything at a higher level.

**How to apply:** whenever a route is gated with `@Roles(RoleEnum.ADMIN)` to protect a resource with
NO tenant scoping (GridFS `fs.files` is accessed via the native `mongo.GridFSBucket`, entirely
outside Mongoose → the tenant plugin never runs), flag it: in a multi-tenant project a workspace
"admin" can then read across tenants. Remediation is an explicit `user.roles.includes(ADMIN)` check
or a role name that cannot collide.

Related: [[project-file-tus-access-model]], [[project-hub-module-security-model]]
