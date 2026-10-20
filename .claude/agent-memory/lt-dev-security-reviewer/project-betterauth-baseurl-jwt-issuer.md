---
name: project-betterauth-baseurl-jwt-issuer
description: getBaseUrl() returns the origin of instance.options.baseURL (11.43.1) — security-neutral for JWT iss/aud and all CSRF call sites; why the raw value was not enough; probe matrix + recipe
metadata:
  type: project
---

Reviewed 2026-10-20 (uncommitted on develop, after 11.43.0): `CoreBetterAuthService.getBaseUrl()` now returns
the origin of `getInstance().options.baseURL` when it is a non-empty string, else `config.baseUrl || 'http://localhost:3000'`.

**Security verdict: neutral.** Facts that settle it (better-auth 1.7.7):
- `instance.options` is the object passed to `betterAuth()`; per-request baseURL inference (unset or dynamic
  `{ allowedHosts }`) happens on a COPY (`auth/base.mjs` handlerCtx.options, `context/helpers.mjs`
  resolveRequestContext). So getBaseUrl() can never return a request/Host-derived value.
- `verifyJwksToken()` = signature against a DB `jwks` key by kid, then jose exact `iss`/`aud` match
  (`issuer !== undefined` → presence + includes). getBaseUrl() never returns ''. Only JWKS signer in 1.7.7 is
  the jwt plugin (`/token` session-bound, `signJWT` endpoint is serverOnly; no oidc/mcp plugin in 1.7.7).
- The URL origin of the synthesized requests (csrfCheckedRequest, toWebRequest, 2FA native call) matters to
  Better-Auth only in `validateOrigin`'s `Origin: null` + `Sec-Fetch-Site: same-origin` inference — a
  browser-only header pair meaning "initiator IS the target origin". Now infers the real API origin, exactly
  what Better-Auth's own handler infers. 2FA `Origin: req.headers.origin || baseUrl` runs only AFTER the
  first `api.signInEmail` passed the real-header CSRF check.

Runtime matrix (server baseUrl https://api.x, disableOriginCheck:false): 403 for null+same-site,
null+cross-site, null alone, no-origin+cross-site cors, no-origin+same-origin cors, evil Referer; 200 for
null+same-origin (also with a client X-Forwarded-Host — csrfCheckedRequest does not forward it).

**Functional residual of the first draft (reported, not security; fixed in 11.43.1 before release):** Better-Auth signs with `ctx.context.options.baseURL` =
`new URL(baseURL).origin` (create-context.mjs:86) while getBaseUrl() returns the RAW string → a baseUrl with a
trailing slash (`https://api.x/`) still yielded 401 on every Bearer JWT (e2e-proven). Fixed by returning the origin; pinned by the trailing-slash variant of `tests/better-auth-jwt-issuer.e2e-spec.ts`.

**How to apply:** don't re-derive the above on the next baseUrl change — re-check only if better-auth's
base.mjs/create-context changes. Probe recipe extension for [[project-betterauth-signin-login-csrf]]: a scratch
e2e config with `test.dir` outside the repo must set `plugins = [swc.vite({ jsc: { parser: { syntax:
'typescript', decorators: true }, transform: { legacyDecorator: true, decoratorMetadata: true } } })]`
(import `node_modules/unplugin-swc/dist/index.js`), else SWC fails "Expression expected" on decorators.
Drop the probe DB afterwards (failed runs keep it). In zsh never `echo ====` (=-expansion error).
