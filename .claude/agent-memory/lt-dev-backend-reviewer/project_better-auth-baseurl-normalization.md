---
name: better-auth-baseurl-normalization
description: better-auth 1.7.x keeps the RAW baseURL on auth.options but signs/verifies JWTs with the ORIGIN on ctx.options; a path in baseURL suppresses the basePath append. Relevant to any getBaseUrl()/iss check review.
metadata:
  type: project
---

Measured 2026-10-20 against better-auth 1.7.7 while reviewing the 11.43.1 `getBaseUrl()` fix (Bearer JWT 401 with only the server `baseUrl` set).

- `betterAuth(opts).options` is the RAW object passed in (`createBetterAuth` returns its parameter). `(await auth.$context).options.baseURL` is `new URL(withPath(raw, basePath)).origin` (context/create-context.mjs) — trailing slash, path, default port and host case are all normalised away.
- The JWT plugin signs AND verifies with `ctx.context.options.baseURL` (plugins/jwt/sign.mjs, verify.mjs), i.e. the origin. Any verifier comparing against the raw string refuses `https://api.example.com/`, `https://example.com/api`, `:443`, uppercase hosts — jose's iss/aud check is exact.
- `withPath()` returns a baseURL that already has a path UNCHANGED (no basePath appended), so a path-shaped baseURL moves Better-Auth's router basePath to that path (`/api` instead of `/api/iam`) — pre-existing, independent of nest-server.
- The web Request URL origin our helpers build (`toWebRequest`, `csrfCheckedRequest`, 2FA native call) only matters to Better-Auth in `validateOrigin()`'s `Origin: null` + `Sec-Fetch-Site: same-origin` branch (inferred from request.url) and the opt-in oauth-proxy plugin; paths always come from `originalUrl`/basePath.

**Why:** the first draft of the 11.43.1 fix returned the raw `instance.options.baseURL`, so only canonical origins matched; the review caught it and the released fix returns `new URL(raw).origin`.
**How to apply:** when a review touches issuer/audience or `getBaseUrl()`, compare against `new URL(raw).origin`, and probe with a trailing-slash and a path-shaped baseUrl. Probe recipe: a vitest config in the scratchpad with `test.root` = repo, `test.dir` = scratchpad (absolute imports of unplugin-swc/vitest/config) — no file in the shared tree. Related: [[project_secure-cookie-auth-link-gating]].
