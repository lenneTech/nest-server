---
name: project-betterauth-signin-login-csrf
description: Login CSRF on /iam/sign-in|sign-up (controller skipped Better-Auth's formCsrfMiddleware) — FIXED 2026-10-18 via csrfCheckedRequest(); note the isTest() skip when re-verifying; scratch e2e probe recipe
metadata:
  type: project
---

Verified at runtime 2026-10-18 (11.43.0 working tree): `POST /iam/sign-in/email` with
`Content-Type: application/x-www-form-urlencoded` and `Origin: https://evil.example` answers 200 and
sets `iam.session_token` (SameSite=Lax). Browsers accept Lax cookies on a cross-site TOP-LEVEL
navigation response, so an attacker form can plant the attacker's session. text/plain answers 400.

**Why:** `CoreBetterAuthController.signIn` calls `api.signInEmail({ body })` server-side with no
request headers, so Better-Auth's own origin check never sees the browser's Origin. Pre-existing,
not tied to one diff. It matters most on the MCP consent page: a planted session turns a victim's
own "connect Claude" into authorizing the ATTACKER's account (page shows the account in a muted line).

**FIXED (same day, 11.43.0 working tree):** the controller now passes
`request: this.csrfCheckedRequest(req, path)` (Origin, Referer, Sec-Fetch-* — not the cookie) plus
`asResponse: false` to `api.signInEmail` / `api.signUpEmail`; refusals answer 403 ACCESS_DENIED.
Pinned by `tests/better-auth-signin-csrf.e2e-spec.ts` (mutations `iam-sign{in,up}-csrf-check-skipped`).

**Second review (2026-10-18, runtime probe, disableOriginCheck:false):** refused (403, no cookie): cross-site
nested-navigate / no-cors, `Origin: null` alone or + cross-site navigate, evil Referer only, same-site foreign
subdomain. Accepted: API origin same-origin cors (consent script), `Origin: null` + `Sec-Fetch-Site: same-origin`
(no-referrer form; Better-Auth infers the origin from the forwarded Request URL = baseUrl), trusted app same-site
navigate. Passing `request` changes nothing else: better-call takes headers from `ctx.headers` (empty, key present),
body from `body`; `ctx.request` only reaches the CSRF middleware and the (ignored) `_request` of email callbacks.

**NOT every planting path is closed** (pre-existing, Better-Auth default, below the bar): `GET /iam/verify-email`
with `autoSignInAfterVerification` (nest-server default `true`, token 24 h) signs the clicker in to the account the
token belongs to, replacing a session with a different e-mail. An attacker forwards its own unverified sign-up link.
On the MCP consent page this is mitigated only by the account line shown first. Do not repeat "root cause fixed".

**How to apply:** when re-verifying, remember Better-Auth skips origin/CSRF checks under a test runner
(`skipOriginCheck: isTest()`) — a probe must set `betterAuth.options.advanced.disableOriginCheck: false`
or it reports the hole as open/closed wrongly. Any NEW direct `api.*` call of a CSRF-protected endpoint
needs the same request (see `.claude/rules/better-auth.md` §10).

Probe recipe (no repo files): a scratch `vitest.probe.config.ts` that `mergeConfig`s the repo's
`vitest-e2e.config.ts` with `test.dir=<scratch>`, `include: ['**/*.probe.ts']`; import EVERYTHING
(vitest/config → `node_modules/vitest/dist/config.js`, supertest, mongodb, src, tests/helpers) by
ABSOLUTE path, run from the repo root with `NODE_ENV=e2e`. Boot via `bootApiTokenIamApp(apiTokenIamConfig(...))`.
Related: [[project-ai-mcp-oauth-mount-and-consent]].
