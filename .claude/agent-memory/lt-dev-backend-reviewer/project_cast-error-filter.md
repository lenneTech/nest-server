---
name: project-cast-error-filter
description: MongooseCastErrorFilter (11.42.16) — Nest global-filter contract per transport, verified in node_modules; what was checked and found sound
metadata:
  type: project
---

`MongooseCastErrorFilter` (APP_FILTER from CoreModule, `security.mongooseCastErrorFilter`) maps a CastError
whose value is in route params / top-level GraphQL args to 404, query/body/nested input to 400, else 500.
Reviewed 2026-10-17, zero Critical/High.

Nest 11 facts verified in node_modules (reuse for any future global filter):
- HTTP `ExceptionsHandler`: a matched filter MUST reply itself; no fallback to BaseExceptionFilter.
- GraphQL `ExternalExceptionsHandler`: a truthy return becomes the field value (graphql-js throws an
  Error value); `undefined` falls through to `ExternalExceptionFilter` (log + rethrow).
- WebSocket gateways: `ExceptionFiltersContext.getGlobalMetadata()` returns `[]` — APP_FILTER and
  useGlobalFilters never reach gateways, so a filter that returns nothing for `ws` swallows nothing.
- Order: globalFilters = [APP_FILTERs in container order (ROOT module first, then imports), then
  useGlobalFilters], reversed before `find()`. So useGlobalFilters wins, but CoreModule's APP_FILTER
  SHADOWS a consumer's root-module APP_FILTER for the same type (e.g. Sentry's SentryGlobalFilter).
  No local lt project had an APP_FILTER on 2026-10-17 — re-check before calling it unproven again.

**Why:** these contracts are invisible from the filter source and easy to get backwards.
**How to apply:** when a diff adds/changes an exception filter, check these four points first, then
look for consumer APP_FILTERs (`grep -rln APP_FILTER ~/code/lenneTech --exclude-dir=node_modules`).
