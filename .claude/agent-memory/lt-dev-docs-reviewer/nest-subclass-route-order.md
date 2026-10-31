---
name: nest-subclass-route-order
description: A subclass re-declaring a `:param` handler shadows an inherited static route on the same controller (Nest 12, Express) — check documented "extend and re-declare" recipes whenever a static route is added
metadata:
  type: project
---

NestJS 12.3 registers routes in `MetadataScanner.getAllMethodNames()` order: the subclass prototype's OWN methods
first, then the parent's. `routeResolutionStrategy` defaults to `'declaration'` (`'specificity'` is opt-in on
`NestFactory.create`), and Express matches first-registered. So when a core controller declares `@Get('static')` before
`@Get(':param')` and a doc tells projects to "extend it and re-declare the `:param` handler" (e.g. to add
`@ApiTokenScopes()`), the subclass's `:param` route wins and the static route becomes unreachable — the base-class
"declared before" comment only holds for the base class.

**Why:** found in DEV-3902 (`CoreSyncController.hints` vs README's re-declare-`pull()` recipe); no test subclasses the
controller, so nothing catches it.

**How to apply:** when a diff adds a static route to a controller that has a parametric one, grep its README /
JSDoc / INTEGRATION-CHECKLIST for "re-declare" / "extend" recipes and check whether they re-declare the parametric
handler. Source: `node_modules/@nestjs/core/metadata-scanner.js`, `nest-application.js` `registerRouter()`.

**Resolved in DEV-3902:** the hints route moved to `CoreSyncHintsController`, registered before `CoreSyncController`
(`tests/unit/sync-hints-route.spec.ts`, mutation `sync-hints-route-after-model`). A separate controller listed first is
the fix to reach for, since the module controls that order and a project subclass cannot.
