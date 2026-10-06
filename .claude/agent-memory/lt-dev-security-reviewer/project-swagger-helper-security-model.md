---
name: project-swagger-helper-security-model
description: setupSwagger() (11.42.7) is documentation-only; what was verified sound, and the one aliasing hazard (mergeRolesMetadata / scopes returned by reference) to re-check if the helper ever writes
metadata:
  type: project
---

`setupSwagger()` / `buildSwaggerDocument()` / `buildApiTokenSwaggerDocument()` (src/core/common/helpers/swagger.helper.ts,
DEV-3352, reviewed 2026-10-06 uncommitted) change no runtime authorization. Zero findings in that review.

Verified sound then (re-verify before relying on it):
- Reads `roles` / `API_TOKEN_SCOPES_KEY` / `SKIP_TENANT_CHECK_KEY` via `Reflect.getMetadata`, never writes. Scope lookup
  (method `??` class) is identical to `assertApiTokenScopes()`.
- `resolveApiTokenConfig()` returns `encryptionKey`, but the helper reads only `.enabled` / `.tenantTokens` — no secret
  reaches the document.
- The API-token view is a `structuredClone` subset, and the full document is ALWAYS served next to it (no option to turn
  the full one off) — so the view cannot widen exposure.
- `SwaggerModule.setup` routes go straight onto the http adapter (no Nest guards) — same as the pre-change main.ts.

**Hazard to re-check if the helper changes:** `mergeRolesMetadata([a, undefined])` returns `a` itself (no copy), and
`describeAccess()` hands the raw `@ApiTokenScopes` metadata array to the consumer's `operationTags` callback as `scopes`.
Any future code that MUTATES either array (push/splice) edits the decorator metadata the guards enforce — triggered by an
unauthenticated GET /swagger. Read-only today, so it was dropped as theoretical.

**How to apply:** a review of a later change to this helper should grep for `.push(` / `.splice(` / `.sort(` on `roles`,
`handlerRoles`, `scopes` before anything else. Related: [[project-api-token-module-security-model]],
[[project-roles-metadata-merge-semantics]].
