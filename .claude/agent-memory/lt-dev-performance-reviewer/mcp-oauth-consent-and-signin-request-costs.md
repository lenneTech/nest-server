---
name: mcp-oauth-consent-and-signin-request-costs
description: Measured costs of the 11.43.0 MCP OAuth consent flow (render, CSRF token, lazy SDK error import, ALS) and of handing Better-Auth a Web Request on api.signInEmail/signUpEmail — reuse instead of re-measuring
metadata:
  type: project
---

Measured 2026-10-18 (Node 24.12, better-auth 1.7.7, load avg ~7.8) while reviewing the uncommitted
11.43.0 work on `develop` (MCP OAuth auto-mount + built-in consent page + sign-in login-CSRF fix).

| Operation | Cost | Where it runs |
|---|---|---|
| `csrfCheckedRequest()`: `new Headers` + 5 header copies + `new URL` + `new globalThis.Request` | ~2.7 us | every IAM sign-in / sign-up. The path is dominated by scrypt (~76 ms), so this is ~0.004 % |
| `import()` of an already-loaded module (`loadOAuthErrors()`) | ~2 us (+ ~1 us `new XxxError` vs `new Error`) | OAuth refusals only. Under tsc `module: commonjs` it compiles to `require()` and hits the cache |
| `AsyncLocalStorage.run(async fn)` | ~210 ns over the bare call | per `/authorize`. Node 24 = AsyncContextFrame, so an extra ALS instance adds NO per-async-resource cost process-wide (that was the Node <=22 async_hooks model) |
| `renderMcpOAuthConsentPage()` | ~6 us, 5.3 KB (consent) / 5.9 KB (sign-in) | per `/authorize`, which the SDK limits to 100 per 15 min per IP (express-rate-limit, `unref()`'d timers) |
| consent CSRF sign (`randomBytes(16)` + HMAC) | ~2.7 us | per consent render |

**Better-Auth `api.*` with `request:` (1.7.7), verified by reading dist:**
- `toAuthEndpoints` → `dispatchAuthEndpoint`: no rate limiter (rate limiting is on the router path
  only), no extra DB read. `asResponse` defaults to `isRequestLike(request)`, hence `asResponse: false`.
- `dispatchAuthEndpoint` always sets the `headers` KEY (`input.headers ? new Headers(...) : void 0`),
  so better-call's `"headers" in context` wins and it never reads cookies from `request.headers`.
- `formCsrfMiddleware` / `validateOrigin`: array match against `trustedOrigins` (nest-server passes an
  array, so the async `trustedOrigins(request)` callback branch is unreachable). Cost is O(#origins).

**DB:** `consumeAuthorizationCode` moved to `findOneAndDelete({ clientId, code })`. The unique
`{ code: 1 }` index is used for the equality on `code`; `clientId` is a residual filter over at most 1
doc. Not a missing-index finding. Boot adds no DB work (`onModuleInit` = secret check; indexes are
latched and created on the first write).

**How to apply:** none of these are findings at their current call frequency. Re-check only if a diff
moves consent rendering or `loadOAuthErrors()` onto a per-MCP-request path (e.g. into
`verifyAccessToken`'s success branch). Related: [[ai-module-perf]], [[better-auth-router-and-openapi-costs]],
[[auth-gate-per-request-cost]].
