---
name: trusted-origins-replace-semantics
description: An explicit betterAuth.trustedOrigins REPLACES the derived list (appUrl dropped), cors.allowedOrigins is already merged in, and consumer tests never see an origin 403 (isTest skip) — check every "list it in trustedOrigins" instruction
metadata:
  type: project
---

`buildTrustedOrigins()` (`src/core/modules/better-auth/better-auth.config.ts`) resolves in priority order, and rule 1
**returns the configured list as-is**: setting `betterAuth.trustedOrigins: ['https://other.app']` drops `appUrl`,
`baseUrl` and `cors.allowedOrigins` from Better-Auth's trusted origins (Better-Auth still adds its own `baseURL`).
Rule 4 already merges `cors.allowedOrigins` + `appUrl` + `baseUrl`, so a frontend listed there (the starter's
deployed `CORS_ALLOWED_ORIGINS`) is trusted with no Better-Auth setting at all. Pinned by
`tests/unit/better-auth-trusted-origins.spec.ts` ("explicitly configured (overrides serverCorsConfig)").
The `trustedOrigins` JSDoc in `server-options.interface.ts` says the opposite ("merged with the auto-derived ones")
— pre-existing as of 11.43.0, so it reinforces any doc that tells a reader to "list the origin there".

**Why it matters:** Better-Auth skips its origin/CSRF checks when `isTest()` (`NODE_ENV==='test'` or `TEST` set —
vitest always sets `TEST=true`), so a project that breaks its own trusted origins stays green in every test run and
finds out from production 403s (`INVALID_ORIGIN`). Found in the 11.43.0 review (IAM sign-in started running
`formCsrfMiddleware`; the guide's remedy "must be listed in `betterAuth.trustedOrigins`" would have dropped `appUrl`).

**How to apply:** whenever a guide/README/checklist tells readers to add an origin, check it names
`cors.allowedOrigins` (merge) or says an explicit `trustedOrigins` must include `appUrl` (replace). Related:
[[migration-guide-behavior-change-count-trap]], [[doc-surfaces-for-config-features]].
