---
name: project-file-tus-access-model
description: File/TUS access model facts — the starter RE-DECLARES @Roles(S_EVERYONE) on the inherited download routes so a core-only decorator fix never reaches generated projects; TUS stays anonymous; CoreFileInfo offers zero model-layer defense; and `lt server permissions` is blind to inherited core routes.
metadata:
  type: project
---

# File + TUS access model — what a decorator fix in `src/core/` does and does not reach

Verified 2026-08-10 while reviewing the 11.32.x file-module hardening (download routes and all four
`CoreFileResolver` members moved from `S_EVERYONE` to `ADMIN`).

## 1. The starter re-declares the decorators — a core-only fix does NOT propagate

`nest-server-starter/src/server/modules/file/file.controller.ts:59-60` and `:74-75` `override` the
two inherited download methods **purely to attach Swagger decorators**, and in doing so re-declare
`@Roles(RoleEnum.S_EVERYONE)`. Because method-level roles OR-merge and `S_EVERYONE` short-circuits
the guard (see [[project-roles-metadata-merge-semantics]]), every project generated from the starter
keeps the public download route no matter what `src/core/` says.

**How to apply:** when a review changes a decorator on an *overridable* core member, always grep the
starter (and any other Grund-Repo) for a subclass that re-declares it. "Fixed in core" is not
"fixed in the stack".

## 2. TUS remains fully anonymous, and now asymmetric

`core-tus.controller.ts:25-26,42-43,68-69` is `@Roles(S_EVERYONE)` on class AND both `@All` handlers;
`TusModule.forRoot()` defaults to enabled with `maxSize: 50 GB`. `CoreTusService` writes into the
**same** GridFS bucket `'fs'` as `CoreFileService` (both hardcode/default `bucketName: 'fs'`).
`tests/stories/tus-upload.story.test.ts` has an explicit test asserting anonymous upload works.
`@tus/server` also routes `GET /tus/:id` to a `GetHandler` that streams bytes back when the store
supports `read()` (`@tus/file-store` does).

Net: after the download hardening, anyone may WRITE into the file store and only admins may READ it.

## 3. The model layer provides no defense in depth

`CoreFileInfo` is `@Restricted(RoleEnum.S_EVERYONE)` on the class and on every field, and inherits
`CoreModel.securityCheck() { return this; }` (`core-model.model.ts:132-134`). The route decorator is
the ONLY control — any future widening exposes all metadata unfiltered.

Also: the download routes call `this.fileService.getFileInfo(id)` / `getFileStream(id)` with **no**
`serviceOptions`, so a `CoreFileService.checkRights()` override (which the README recommends for
per-file rules) receives no `currentUser`. The only escape hatch is `RequestContext.getCurrentUser()`
(ALS, set by `RequestContextMiddleware`). And `createFile()` accepts no `metadata`, while
`CoreFileInfo` has no `metadata` field — so "authorize against the file's metadata" is not reachable
through the framework's own API.

## 4. `lt server permissions` is blind to inherited core routes

The scanner reads `src/server/**` only. Running it on this repo reports the FileController's three
own methods at ADMIN and never mentions the inherited `GET /files/id/:id` / `GET /files/:filename`.
That is how the `S_EVERYONE` downloads survived; it stays true after the fix.

**How to apply:** never treat a clean `lt server permissions` run as coverage for routes that come
from a `Core*` base class. Grep the base class separately.

Related: [[project-gridfs-and-express-response-facts]], [[project-roles-metadata-merge-semantics]]
