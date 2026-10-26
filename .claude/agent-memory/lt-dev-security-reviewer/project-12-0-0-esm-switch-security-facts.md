---
name: project-12-0-0-esm-switch-security-facts
description: 12.0.0 package became "type":"module" + own SWC loader + sync loadLocalConfig — traced as security-neutral; the reachability facts and re-check probes
metadata:
  type: project
---

Reviewed 2026-10-26 (12.0.0, uncommitted on develop): ESM package switch, ts-node -> own SWC loader,
`loadLocalConfig` made synchronous. Zero findings. Facts that settle the recurring questions:

- **`loadLocalConfig` is code-only.** `getEnvironmentConfig()` reads `envConfig.loadLocalConfig` BEFORE
  merging `NEST_SERVER_CONFIG` / `NSC__*`, so neither an env var nor a request can point
  `loadLocalConfigFile()` (JSON.parse / createRequire of a cwd-relative path) at a file. Only
  `src/config.env.ts` sets it; the starter sets it nowhere.
- **CLI-only loaders.** `requireFromProject()` (`--store`, `--compiler`), the SWC require hook's patched
  `Module._resolveFilename` and the ESM resolve/load hooks are reached only from `bin/migrate.js`,
  `node -r .../ts-compiler.js` dev starts and the migrate CLI. The Hub's ADMIN "run migrations" uses
  `createRequire(cwd/package.json)(filePath)` with the configured dir — no request input, and a
  `package.json` parent means the `.js -> .ts` resolver retry never fires.
  `migrate-cli`'s run guard is `typeof require !== 'undefined' && require.main === module` — false
  under ESM, so loading the barrel never runs the CLI.
- **No dual-instance guard state.** The two CommonJS directories (`migrate/helpers/`, `bin/`) hold only
  the loader and the `migration.helper` forwarder; no guard / tenant / better-auth registry is
  reachable from them. better-auth and @better-auth/core are ESM-only (single instance).
  `@modelcontextprotocol/sdk` is dual: a CJS consumer throwing its OWN SDK error class from an
  `authorizeConsent()` override fails the SDK's `instanceof` -> 500, i.e. fail-closed.
- **`isBetterAuthHandlerClass()` registry** (replaced the lazy `require()` in `CoreTenantGuard`) has the
  same semantics; a missing registration only means the tenant check is NOT skipped (fail-closed).
- `forRoutes('{*path}')` for `CoreBetterAuthMiddleware` hits the same `isAWildcard()` branch of Nest 12's
  `RouteInfoPathExtractor` as the old `(.*)` (addLeadingSlash first) — equivalent mounting.
- CJS deps imported from ESM dist resolve correctly (probe: `node --input-type=module -e "import * as b
  from 'bcrypt'; ..."` from the repo root — bcrypt/js-sha256/passport-jwt/passport all functions).

**How to apply:** when a later review asks "can request input reach the loader / config require?",
re-verify the merge order in `getEnvironmentConfig()` first — that one ordering is what keeps it
code-only. Related: [[project-template-render-traversal]].
