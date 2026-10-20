---
name: better-auth-jwt-key-and-baseurl-facts
description: better-auth 1.7.7 facts for reviewing JWT/JWKS tests — which jwks row signs, why a test-inserted epoch key is safe, why request-URL host is irrelevant under a static baseURL, and the probe that proves an issuer-refusal case
metadata:
  type: reference
---

Verified 2026-10-20 against better-auth 1.7.7 while reviewing the 11.43.1 `getBaseUrl()` fix
(`tests/better-auth-jwt-issuer.e2e-spec.ts`).

**Signing key selection** (`node_modules/better-auth/dist/plugins/jwt/sign.mjs` → `resolveSigningKey`,
`adapter.mjs`): without overrides it takes `getLatestKeyByAlg(primaryAlg) ?? getLatestKey()` — filter
`k.alg === alg || (k.alg == null && configAlg === alg)`, drop expired, sort `createdAt` DESC, take [0].
So a test-inserted verification key with `createdAt: new Date(0)` and no `alg` is a candidate but
never the newest once any real key exists (one is minted by the first sign-in). Better-Auth's mongodb
adapter maps `_id` → `id`, so a test doc's own `id` field is invisible to Better-Auth but is exactly
what nest-server's `verifyJwksToken()` looks up first (`findOne({ id: kid })`, fallback `_id`).

**Request URL host is irrelevant** when `options.baseURL` is a static string: `getBaseURL()`
(`dist/utils/url.mjs`) returns `withPath(url, path)` before ever reading the request. The router and
origin-check middleware use only the PATHNAME. So changing the base passed to `toWebRequest()`
(`core-better-auth-api.middleware.ts`) or `csrfCheckedRequest()` changes nothing Better-Auth decides —
do not demand a test for it unless a dynamic `baseURL` config or the oauth-proxy/captcha plugin is in play.

**Proving an issuer-refusal case is not vacuous:** in a scratch copy (see [[scratch-copy-mutation-check]])
delete `audience: baseUrl,` / `issuer: baseUrl,` from `jwtVerify()` in `verifyJwksToken()`. The
2026-10-20 run turned ONLY the refusal case red (`expected 200 to be 401`), the accept cases stayed green.
Not a registered mutation — the registered one (`jwt-issuer-ignores-server-base-url`) pins the
baseURL source, not the claim check.
