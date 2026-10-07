---
name: better-auth-middleware-path-guard-facts
description: How a path-prefix guard in CoreBetterAuthApiMiddleware is (and is not) pinned — which layer answers, which variants Better-Auth's router normalizes, why the controller catch-all copy is effectively unreachable
metadata:
  type: project
---

Facts verified 2026-10-07 (better-auth 1.7.7) while reviewing the 11.42.9 `/iam/open-api/*` → 404 guard.

**Outcome (same day):** the review DID find the bypass end to end — `/iam/sign-in/email/../../open-api/…`
slips past the middleware via the `CONTROLLER_HANDLED_PATHS` prefix and reaches the controller catch-all,
whose copy has the same flaw, so "controller copy unreachable" below is wrong for dot-segment paths. The
path guard was replaced by marking the plugin's endpoints `SERVER_ONLY` (`serverOnlyPlugin()`); the e2e
spec now sends the variants raw via `http.request`. A bypassable guard on an unauthenticated route is a
finding even when the leaked content looks harmless — grade it, do not skip it.

**Which layer answers.** `CoreBetterAuthApiMiddleware` is mounted on `${basePath}/*path` whenever
`betterAuthService.isEnabled()`. A forwarded request that Better-Auth 404s falls through `next()` to the
controller's `@All('*path')`, which forwards AGAIN. So a guard copied into
`CoreBetterAuthController.handleBetterAuthPlugins()` is defense in depth only: with the middleware intact
an e2e request never reaches it, and under a global prefix the forwarded URL keeps the prefix so
Better-Auth's router 404s anyway. An e2e `GET` therefore pins the MIDDLEWARE copy only — expected, not a gap.

**Better-Auth endpoints are HTTP-exposed unless marked.** `openAPI()`'s `/open-api/generate-schema` has
no SERVER_ONLY metadata (200 over `auth.handler`), so a 404 assertion on it is real evidence. The
`/reference` page throws NOT_FOUND itself under `disableDefaultReference: true` — a 404 assertion there
pins that OPTION, not the middleware guard. The reference page embeds the schema (does not fetch it).

**Router normalization (probed via `auth.handler(new Request(...))`).** `//x`, upper-case, and `%2D`
variants → 404 (rou3 is literal). But `toWebRequest()` builds `new URL(req.originalUrl, baseUrl)`, and
the WHATWG URL parser resolves `/./` and `/../` — so a string-prefix check on `req.originalUrl`
(`relativePath.startsWith(...)`) is bypassable by dot-segments (`curl --path-as-is`). Applies equally to
`CONTROLLER_HANDLED_PATHS` and the reset-password path list (pre-existing). Inferred end-to-end, verified
at router level only.
**How to apply:** when a diff adds a path guard here, grade the consequence of the bypass, not just the
guard's presence; a probe script must live inside the repo (node resolves `better-auth` from cwd) — copy
from the scratchpad, run, delete.
