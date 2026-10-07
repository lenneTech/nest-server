---
name: better-auth-router-and-openapi-costs
description: Measured Better-Auth 1.7.7 per-request router rebuild cost, what a plugin adds per request (endpoints vs hooks), and the openAPI() generator boot cost — reuse when a diff adds a Better-Auth plugin
metadata:
  type: project
---

Measured 2026-10-07 (better-auth 1.7.7, Node 24, M-series) while reviewing 11.42.9, which registers
`openAPI({ disableDefaultReference: true })` on every instance to feed `setupSwagger()`.

## Better-Auth rebuilds its whole router on EVERY `auth.handler()` call

`dist/auth/base.mjs`: `handler` calls `router(handlerCtx, options)` per request, which runs
`getEndpoints()` (reduce-spread over all plugins' endpoints) + `toAuthEndpoints()` + better-call
`createRouter()`. Measured **~54 us per call** with jwt + twoFactor + passkey (52 endpoints).
Only `/iam/*` requests pay it: `auth.handler` is called by `CoreBetterAuthApiMiddleware` (forwarded
paths) and three places in `CoreBetterAuthController`. The global `CoreBetterAuthMiddleware` uses
`auth.api.*`, whose wrappers are built ONCE in `createBetterAuth()`.

**Per added endpoint: ~0.2 us** on that rebuild (openAPI's 2 endpoints: 54.24 -> 54.62 us, interleaved,
15 rounds). A first, non-interleaved handler bench showed +6 us — that was noise; bench `router()`
directly via `better-auth/dist/api/index.mjs` with interleaved rounds.

## What a plugin costs per request depends on its SHAPE, not its presence

| Plugin member | Per-request cost |
|---|---|
| `endpoints` only | ~0.2 us/endpoint on the `/iam` router rebuild, nothing elsewhere |
| `hooks.before/after` | evaluated on every `auth.api.*` call AND every handler call (`getHooks()` flatMaps plugins per call) |
| `middlewares`, `onRequest`, `onResponse` | every `/iam` handler call |
| `schema` | new collections/indexes |

`openAPI()` (dist/plugins/open-api/index.mjs) has endpoints only — no hooks, no middleware, no init,
no schema. **How to apply:** read the plugin's returned object before scoring it; endpoint-only
plugins are not a finding.

## openAPI generator (`auth.api.generateOpenAPISchema()`)

~5.4 ms first call, ~1.9 ms warm; 47 paths, ~105 KB as JSON. **DB-free** with the mongo adapter:
`toAuthEndpoints` awaits `ctx.checkSchema?.()`, but only the kysely adapter registers a schema check,
and the generator reads endpoint metadata only. nest-server runs it once in
`CoreBetterAuthService.onApplicationBootstrap()` and keeps the result.

## Server-only endpoints (`metadata.SERVER_ONLY`) — round 2, same day

better-call 1.4.0 `createRouter()` already checks `endpoint.options?.metadata?.SERVER_ONLY` for EVERY
endpoint on each rebuild and `continue`s before `addRoute`. Marking a plugin's endpoints server-only
(nest-server's `serverOnlyPlugin()`) is therefore strictly cheaper than routing them: same
`getEndpoints`/`toAuthEndpoints` work, two fewer `addRoute`s. The route then 404s through
`auth.handler` however the path is spelled (`/./`, `%2e%2e`), and `auth.api.<x>()` still works.
The boot-time session-middleware scan over `auth.api` (`sessionGuardedOperations()`) is ~11 us.

**Bench trap on this shared machine:** load average hit 57 on 12 cores during review (playwright,
other agents). Medians then swing +-15 us on a ~60 us op and invert sign between runs. Use
rotated order (ABC/BCA/CAB...) and compare MINIMUMS; script `router-bench-r2b.mjs` pattern. Check
`uptime` before trusting any delta.

Related: [[auth-gate-per-request-cost]], [[config-service-get-cost]], [[tus-end-normalizer-costs]]
