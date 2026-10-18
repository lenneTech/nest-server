---
name: project_mcp-oauth-consent-11-42-17
description: 11.43.0 MCP OAuth auto-mount + built-in consent + IAM sign-in CSRF — what was probed, what holds, and the two config gaps reported (oauthBaseUrl origin, global prefix).
metadata:
  type: project
---

Reviewed 2026-10-18 (uncommitted on develop). Router is mounted in `CoreAiMcpOAuthInitializer.onModuleInit`,
i.e. after Nest middleware + routes and before the not-found handler (Nest 11.2.7 `init()` order verified).
The consent page reads `req.user` set by `CoreBetterAuthMiddleware`.

**Reported (High), check whether fixed before re-flagging:**
- `ai.mcp.oauthBaseUrl` on another origin: `/authorize` is served on that origin, Better-Auth trusts only
  its baseURL origin + appUrl, so the consent page's sign-in fetch gets 403 INVALID_ORIGIN (probed: trustedOrigins
  `["http://localhost:3000","http://localhost:3001"]`, sign-in from `https://mcp.example.test` -> 403).
- `setGlobalPrefix('api')`: Nest registers wildcard middleware only under the prefix, so `req.user` is never set on
  root `/authorize` (signed-in agent still gets the sign-in view), and `data-auth-base="/iam"` posts to a 404.

**Verified sound (don't re-flag):** `asResponse: false` overrides Better-Auth's request-implied Response
(`to-auth-endpoints.mjs`); formCsrf only demands an Origin with Sec-Fetch-* or a cookie, so non-browser clients pass;
browser-origin breakage is documented in the migration guide §5; consent token binding; GET code refusal via ALS;
no new import cycles (madge: the known 6).

**How to probe without touching the tree:** scratch spec + a config that imports `vitest-e2e.config` by absolute path
and overrides `test.dir`/`include`; decorators do not compile outside the repo root (call `Module({...})(Cls)`).
Related: [[project_core-controller-override-contract]].
