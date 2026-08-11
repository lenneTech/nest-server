---
name: core-file-resolver-untested
description: CoreFileResolver is exported but registered in NO module in this repo; src/server has a hand-copied duplicate FileResolver — so every CoreFileResolver change has zero test coverage here.
metadata:
  type: project
---

`CoreFileResolver` (`src/core/modules/file/core-file.resolver.ts`) is exported from `src/index.ts`
but is **not a provider in any module** in this repo. `src/server/modules/file/file.resolver.ts`
does **not extend it** — it is a hand-copied duplicate with the same four members
(`getFileInfo`, `deleteFile`, `uploadFile`, `uploadFiles`).

Consequence: the GraphQL file tests in `tests/file.e2e-spec.ts` exercise the SERVER resolver only.
Any change to `CoreFileResolver` — including its `@Roles` — is shipped to consumers **completely
untested**. The two classes have already drifted (`uploadFiles` returns `[CoreFileInfo]` in core vs
`Boolean` + filesystem writes in server).

Contrast: `CoreFileController` IS extended by `src/server/modules/file/file.controller.ts`, so its
routes are covered by e2e.

**Why:** noticed while reviewing the 2026-08-10 change that flipped four `CoreFileResolver` members
from `S_EVERYONE` to `ADMIN` (anonymous `deleteFile` was reachable on any GraphQL-enabled consumer).
**How to apply:** for `CoreFileResolver` changes, do not accept "e2e is green" as coverage. Ask for a
decorator-metadata unit assertion (`Reflect.getMetadata('roles', CoreFileResolver.prototype.deleteFile)`)
— that is the only guard that works without registering the resolver.
