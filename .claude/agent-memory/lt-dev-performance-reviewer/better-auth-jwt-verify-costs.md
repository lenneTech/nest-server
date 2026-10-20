---
name: better-auth-jwt-verify-costs
description: Measured per-request cost of Bearer-JWT verification (importJWK + jwtVerify ~133 us) and of reading the Better-Auth instance options (plain data property, ~2 ns) — for reviews touching getBaseUrl/verifyJwksToken.
metadata:
  type: project
---

Measured 2026-10-20 (better-auth 1.7.7, jose from node_modules, Apple Silicon, rotated minimums):

- `createBetterAuth()` returns a plain object literal; `instance.options` is the SAME options object
  passed in, as a DATA property (no getter, nothing rebuilt per access). Reading
  `getInstance()?.options?.baseURL` costs ~1.8 ns more than reading `this.config.baseUrl`.
- `verifyJwksToken()` (core-better-auth.service.ts) runs per Bearer request: a `jwks` DB lookup, then
  `JSON.parse` + `importJWK` + `jwtVerify` (EdDSA) ≈ **133 us** per call — the key is NOT cached.
  Any per-request property read next to it is noise (~0.001 %).
- `toWebRequest()` in core-better-auth-api.middleware.ts (also calls getBaseUrl once per proxied
  /iam request) serializes the body and HMAC-signs cookies — likewise dominates any accessor cost.

**Why:** the 11.43.1 getBaseUrl() fix (read instance baseURL so JWT iss/aud match) was flagged as a
hot-path change; it is not a regression. The uncached importJWK is pre-existing and would be the
real lever if Bearer throughput ever matters — only raise it with a measurement in a diff that touches it.

**How to apply:** don't re-measure accessor changes on these paths; cite these numbers. Re-check if
better-auth changes `createBetterAuth()`'s return shape (e.g. turns `options` into a getter/Proxy).
Related: [[better-auth-router-and-openapi-costs]], [[auth-gate-per-request-cost]].
