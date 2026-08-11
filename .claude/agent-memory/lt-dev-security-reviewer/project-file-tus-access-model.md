---
name: project-file-tus-access-model
description: File/TUS access model after the 11.33.0 rework — roles are now config-driven via Reflect metadata (an override opts out), the file classes carry @SkipTenantCheck() but TUS does NOT, and the canonical checkRights() example leaves the filename route ungated.
metadata:
  type: project
---

# File + TUS access model — state after 11.33.0 (`feat/dev-2985`)

Re-verified 2026-08-10 against `file-roles.helper.ts`, `core-file.controller.ts`, `core-file.resolver.ts`,
`core-file.service.ts`, `tus.module.ts`, `core-tus.controller.ts`, `core-tenant.guard.ts`.
**Supersedes the pre-11.33 version of this note** — items 1 and 3 below were previously recorded as
open and are now fixed. Re-verify before re-reporting either.

## 1. FIXED: downloads are no longer `S_EVERYONE`, and the starter can no longer re-open them

`applyFileRoles(config.file)` (called from `core.module.ts` inside `CoreModule.forRoot()`) rewrites
`Reflect.defineMetadata('roles', …)` on six member FUNCTIONS: the two `CoreFileController` download
handlers and all four `CoreFileResolver` members. `TusModule.forRoot()` does the same for
`handleTus`/`handleTusWithId`. Defaults are `[ADMIN]` (files) and `[S_USER]` (tus). `[]` is rejected
with a warning and falls back to the default — honouring it literally would OPEN the route, because
an all-empty role set reads to the guards as "no roles required".

**The override trap is now the documented escape hatch, not an accident.** Metadata lives on the
function object, so a subclass that re-declares a member opts out of `file.*Roles` entirely. The
starter no longer overrides the download methods.

**How to apply:** when auditing a consumer, `grep -n "override async getFileById\|override async getFile\b"`
in `src/server/modules/file/`. A hit means that route ignores `file.downloadRoles` — check its own `@Roles`.

## 2. FIXED: `@Roles(ADMIN)` on the file routes is no longer satisfiable by a tenant membership role

Both `CoreFileController` and `CoreFileResolver` now carry `@SkipTenantCheck()`, which routes
`CoreTenantGuard` to `skipWithUserRoleCheck(checkableRoles, user, isAdmin)` — i.e. `user.roles`,
never `membership.role`. That closes the cross-tenant read described in
[[project-roles-metadata-merge-semantics]] §3 for the file module.

**`CoreTusController` does NOT carry it.** So a project configuring a non-system `tus.roles`
(e.g. `['admin']`) under multiTenancy has those checked against `membership.role`, while TUS writes
into the same non-tenant-scoped store the file routes read. Asymmetry worth flagging every time.

## 3. STILL OPEN: the canonical `checkRights()` example does not cover the filename route

`README.md` § Access control and the `CoreFileService.checkRights()` JSDoc both open with:

```typescript
if (options?.checkInputType !== 'id' || options.force) { return true; }
```

`GET /files/:filename` and the GraphQL `getFileInfo`/`deleteFile` use `checkInputType: 'filename'`,
so a project copying that example verbatim has **no** per-file rule on those members — they stay on
the coarse role gate alone. The reference `src/server/modules/file/file.service.ts` comment DOES say
"filename reads stay on the role gate", so the two docs disagree. Only bites once `downloadRoles` is
widened past ADMIN.

Related: `getRawFileInfoByName()` consults only S3 + GridFS, while `getFileInfoByName()` also
consults the filesystem store — a filename rule sees a different file set than the download serves.

## 4. Still true: the model layer provides no defense in depth

`CoreFileInfo` is `@Restricted(S_EVERYONE)` on the class and every field, and inherits
`CoreModel.securityCheck() { return this; }`. The route decorator plus `checkRights()` are the only
controls.

## 5. Still true: `lt server permissions` is blind to inherited core routes

The scanner reads `src/server/**` only, and now it is blind to a second thing as well: the effective
roles are written at runtime by `applyFileRoles()`/`TusModule.applyRoles()`, so an AST scan cannot
see them at all. Read `config.env.ts` → `file` / `tus` instead.

Related: [[project-gridfs-and-express-response-facts]], [[project-roles-metadata-merge-semantics]],
[[project-hub-config-masking-gaps]]
