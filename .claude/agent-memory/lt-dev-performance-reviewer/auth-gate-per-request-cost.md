---
name: auth-gate-per-request-cost
description: What flipping a route from @Roles(S_EVERYONE) to a real role actually costs per request — the global BetterAuth middleware already paid most of it; the genuinely new costs are the double-verification failure path and the loss of shared-cache eligibility.
metadata:
  type: project
---

Derived 2026-08-10 while reviewing the file-module download gating (`GET /files/id/:id`,
`GET /files/:filename` → `@Roles(ADMIN)`). Re-usable for every future "make this route
non-public" change; do not re-derive the middleware chain.

## The counter-intuitive part: the auth work was ALREADY happening on public routes

`CoreBetterAuthMiddleware` is registered `forRoutes('(.*)')`
(`core-better-auth.module.ts`) — it runs on **every** request, public or not, and
populates `req.user` whenever a cookie/Bearer token is present. `S_EVERYONE` only
short-circuits the **guard** (`return true` before `getRequest()`), never the middleware.

So gating a previously public route adds **~0 DB round-trips** for a request that carries a
valid credential: the guard just reads the `req.user` the middleware already built.

**How to apply:** do not score a public→gated change as "+1 session lookup per request".
Score the delta against what the global middleware already does. The real deltas are below.

## Per-request auth cost (unchanged by gating, but this is the baseline to know)

| Credential | Work per request |
|---|---|
| none | ~0 (middleware bails, guard 401s) |
| session cookie | 1 aggregation on `session` (`$match {token}` on the `{token:1}` index + `$lookup users`) — **never cached** — plus 1 `users.findOne`, **cached 15 s / 500 entries** in `CoreBetterAuthUserMapper` |
| Bearer JWT | 1 `jwks.findOne` (**no index on `jwks`**, tiny collection) + `importJWK()` **per request, no key cache** + asymmetric `jwtVerify` + `getActiveSessionForUser` + the cached `users.findOne` |

The **session aggregation is the uncached one**. A page with N images = N of them. The user
lookup cache does not absorb it. `USER_CACHE_TTL_MS` is **0** under `VITEST` / `PLAYWRIGHT` /
`LT_DEV_ACTIVE` / `NODE_ENV=test|e2e` — so no e2e timing ever exercises the cached path.

## Genuinely new cost 1: double verification on the FAILURE path

Middleware fails → `req.user` unset → `BetterAuthRolesGuard.verifyToken()` re-runs
`extractTokenFromRequest` + `verifyAndLoadUser` **from scratch**, and
`BetterAuthTokenService` has **no cache** (unlike the user mapper). Worst case per rejected
request: 2× JWT verify, 2× session aggregation, up to 3 additional `users.findOne`
(`loadUserFromSessionResult` tries email → iamId → `_id` in sequence).

This only bites expired/garbage credentials — i.e. exactly a credential-stuffing or
stale-token flood. Under `S_EVERYONE` that path did not exist for the route at all.

## Genuinely new cost 2: shared-cache eligibility

An auth-gated route that sets **no** `Cache-Control` is worse than a public one that sets
none: a reverse proxy/CDN keyed on URL can store and replay a now-privileged body. As of
11.32.4 the file controller sets only `Content-Type` + `Content-Disposition` — no
`Cache-Control`, no `ETag`, no `Last-Modified`, no `Accept-Ranges`. Any route moved behind a
role needs at minimum `Cache-Control: private, no-store`.

**How to apply:** treat "add `Cache-Control: private`" as part of the definition-of-done for
any public→gated route change, not as a separate optimization.

## Test-suite note: fixed `wait(150)` after an awaited HTTP call is never the right primitive

The awaited response means the write is committed (single-node mongod, no replication lag),
and the user-mapper cache is disabled under `VITEST` — so sleeps added "to let the role
update settle" are pure cost. Worse, they are load-fragile in the opposite direction: the
e2e run governor's low-resource mode raises timeouts precisely because the box is contended,
and a fixed sleep does not scale with it. Poll for the condition (session doc present,
`roles` array updated) instead.

Related: [[gridfs-verify-and-stream-costs]]
