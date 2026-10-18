---
name: project-ai-mcp-oauth-mount-and-consent
description: MCP OAuth router since 11.43.0 is auto-mounted in onModuleInit behind ALL Nest middleware; what that changes (API-token refusal now live, session on req.user); consent-CSRF found and now enforced (no code on GET /authorize)
metadata:
  type: project
---

Verified 2026-10-18 against the 11.43.0 working tree (`CoreAiMcpOAuthInitializer`, SDK 1.32.1).

**Mount position.** `onModuleInit` runs after Nest registered middleware + routes, before the
not-found handler. So on `/authorize`, `/token`, `/register`, `/.well-known/oauth-*`:
`CoreApiTokenMiddleware` (`forRoutes('*')`), `CoreBetterAuthMiddleware` (`forRoutes('(.*)')`),
security headers, RequestContext and the project's CORS all run first. No guards/interceptors.

Consequences:
- The provider's API-token refusal (`getApiTokenContext(res.req.user)` → `AccessDeniedError`) is
  LIVE now; before, the router was unreachable (after init) or saw no `req.user` (before init).
- `res.req.user` carries the Better-Auth SESSION user on a top-level GET (cookie is SameSite=Lax).
- Nest's body parsers (JSON + urlencoded `extended: true`) parse first; the SDK's own parsers are
  skipped. Harmless: every SDK handler zod-validates `client_id`, `code`, `code_verifier`,
  `refresh_token`, `grant_type` as `z.string()` before our native-driver queries — no NoSQL injection.
- CORS: project cors answers preflights first (stricter); SDK `cors()` overwrites ACAO to `*` on
  simple requests, same as standalone. No weakening.
- dual-package `instanceof`: tsconfig `module: commonjs` compiles both lazy `import()`s (router +
  errors) to `require` → same CJS build; vitest → both ESM. Consistent.

**Consent CSRF via dynamic registration — found, then ENFORCED in the framework (same day).**
`/register` is unauthenticated and accepts any https `redirect_uris`. A consent built as the
checklist first described it ("authenticate the user, saveAuthorizationCode, redirect") auto-approved
for any session holder: an attacker registers its own client, sends the victim a link to
`/authorize?...` with its own `code_challenge`, gets the victim's code and redeems it at `/token`.
Reproduced end-to-end on the real SDK router + real provider (scratch probe, 2026-10-18).
Fix: `buildOAuthProvider().authorize` runs `authorizeConsent()` inside an AsyncLocalStorage scope
holding the request method; `saveAuthorizationCode()` → `assertCodeIssuanceAllowed()` refuses any
code saved while answering a non-POST `/authorize` (logged, client gets `server_error`). Pinned by
mutation `mcp-oauth-code-issued-on-get`. Docs now prescribe GET = consent page, POST + CSRF = issue.
A project consent route OUTSIDE `/authorize` is not covered by the guard — review it for POST + CSRF.

**Built-in consent page (reviewed 2026-10-18, same working tree).** `authorizeConsent()` is now a
framework default (GET = page, POST approve + CSRF token = code). Verified sound: token is
`<exp>.HMAC(JSON["mcp_consent",userId,clientId,redirectUri,codeChallenge,exp])` — the `[` keeps it
apart from access-token input (base64url); no other HMAC user of that key (API-token assertions use
per-token random keys, AiCryptoService uses sha256(secret) as AES key). SDK reads params from body on
POST / query on GET only, decision read only on POST, ALS guard backs it. Escaping complete.
Residuals reported at review time, all FIXED the same day: (1) sign-in `<form>`s now `method="post"`
+ `hidden` until the script reveals them (mutation `mcp-oauth-consent-password-form-get`); (2)
double-clickjacking guard `MCP_OAUTH_CONSENT_GUARD_SCRIPT`: Allow rendered `disabled`, a click counts
only after visible + focused + pointer move / key / touch ≥ 600 ms later (mutation
`mcp-oauth-consent-double-clickjacking`); (3) clientId / redirectUri binding now pinned (mutations
`mcp-oauth-consent-client-not-bound` / `-redirect-not-bound`). Account shown first with "use another
account" against a planted session; the planted-session root cause (login CSRF) is fixed too, see
[[project-betterauth-signin-login-csrf]].

**Guard script residual (judged theoretical 2026-10-18):** no logic bypass found (double-click, popunder +
focus(), hold-to-confirm, keyboard all fail: arming needs a pointermove/key/touch >= 600 ms after focus). What remains
is the probabilistic "click rapidly for seconds" game with a predictable Allow position — the user sees the page
>= 600 ms. Also verified: GET with `lt_mcp_consent=approve` + valid token in the query issues nothing; an
array-valued decision (qs extended parser) issues nothing; the "use another account" POST /iam/sign-out works.

**How to apply:** when reviewing a project's `authorizeConsent()` or the AI docs, demand an
explicit per-client approval step (client name + redirect host shown, affirmative POST with CSRF
protection) — never "session present → issue code". Also: the SDK's phase-2 error redirect to a
self-registered redirect_uri is an open redirector (RFC 9700 §4.11.2), low severity.

Related: [[project-ai-mcp-oauth-refresh-token-binding]], [[project-ai-tool-authorization-chain]].
