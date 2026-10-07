---
name: project-betterauth-path-deny-normalization
description: Any path-prefix deny check on req.originalUrl in front of Better-Auth's handler is bypassable with dot segments (./, %2e, ..) because toWebRequest's new URL() normalizes them; what is NOT a bypass; how to probe without touching the repo
metadata:
  type: project
---

**Fact (verified 2026-10-07, better-auth 1.7.7 / better-call 1.4.0 / rou3 0.9.2):** the API middleware
(`core-better-auth-api.middleware.ts`) and the controller catch-all (`handleBetterAuthPlugins`) both decide on the
RAW `req.originalUrl`, but `toWebRequest()` builds `new URL(req.originalUrl, baseUrl)`, which applies WHATWG
dot-segment removal. So `/iam/%2e/open-api/x`, `/iam/./open-api/x`, `/iam/a/../open-api/x`,
`/iam/a/%2e%2e/open-api/x` all reach Better-Auth as `/iam/open-api/x`. `/iam/sign-in/email/../../X` additionally
slips past the middleware via `isControllerHandledPath()` (prefix match) into the `@All('*path')` catch-all.

Found as SEC finding in the 11.42.9 Swagger review: the internally registered `openAPI()` plugin's
`/open-api/generate-schema` was "404-blocked" by such a check and served the full 106 KB schema unauthenticated.

**Not bypasses** (probed): case variants (rou3 is case-sensitive, `/IAM` misses better-call's basePath), `//`
(better-call 404s `/\/{2,}/`), `%2D`/`%2F` (no decoding in better-call/rou3).

**Structural fix that works:** set `metadata.SERVER_ONLY = true` on the plugin endpoint's `options` BEFORE
`betterAuth()` — better-call's `createRouter` skips SERVER_ONLY endpoints, while `auth.api.<endpoint>()` still works.
Better-Auth's own `disabledPaths` also works (checked on the normalized path in its `onRequest`) but can be replaced
by a project's shallow-merged `betterAuth.options`.

**Round 2 (same day) — fix landed and verified:** `serverOnlyPlugin()` in better-auth.config.ts. Every spelling
answers 404 now: canonical, trailing slash, query, `./`, `%2e`, `%2E%2E`, `x/%2e%2e`, `sign-in/email/../../`,
absolute-form `GET http://evil/iam/...` (srvx/WHATWG take the pathname), backslashes, `#` in the target; lowercase
`get` is refused 400 by llhttp. `/iam/reference` too. In-process `auth.api.generateOpenAPISchema()` still works.
The mutation does NOT touch the shared `HIDE_METADATA` (`{scope:'server'}`): it assigns a spread copy, and
openAPI()'s `{method:'GET'}` options are fresh literals per call. better-auth's `checkEndpointConflicts` only LOGS.
Do not re-report the open-api exposure.

**How to apply:** for any new "refuse path X before forwarding" logic in the better-auth module, test `%2e` and
`../` variants with raw `http.request` (supertest/fetch normalize client-side). Probe recipe without editing the
repo: scratchpad vitest config `mergeConfig(<repo>/vitest-e2e.config, { test: { dir: <scratch>, root: <repo>,
include: ['**/*.probe-spec.ts'] } })` plus `ln -s <repo>/node_modules <scratch>/node_modules`, run with
`NODE_ENV=e2e`. Related: [[project-betterauth-native-cookie-forwarding]], [[project-swagger-helper-security-model]].
