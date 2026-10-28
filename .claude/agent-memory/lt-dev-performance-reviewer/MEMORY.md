# lt-dev Performance Reviewer Memory

## Project
- [AI Module Performance Profile](ai-module-perf.md) — per-prompt DB query budget + memory characteristics of src/core/modules/ai; what to re-check vs what's already correct.
- [Hub Module Performance Profile](hub-module-perf.md) — admin cockpit: verified zero-cost gating + single-poller model; the 5 low-severity findings to re-check as it evolves.
- [API-Token Module Performance Profile](api-token-module-perf.md) — per-request cost with feature off/on (ns-level), token-request DB budget, bounded Map/rate-limit structures.
- [Migrate Module Performance Profile](migrate-module-perf.md) — boot/CLI-only (no HTTP path); the per-migration state save is deliberate crash-safety, do NOT flag as N+1.
- [Persistence layer (db-agnostic) costs](persistence-layer-db-agnostic-costs.md) — measured: tenant post-read row check 16-89 ns/row (~1-4 % of hydrate), ObjectId tag check faster than instanceof.
- [SQL store perf profile](sql-store-perf-profile.md) — phases 1-4: Mongo path ~7 ns; owner conns FIXED; BA sign-up tx starves pool; phase 4 conversation full-read measured (below bar).

## Request Path
- [Auth-gate per-request cost](auth-gate-per-request-cost.md) — the global BetterAuth middleware already authenticates PUBLIC routes; gating adds ~0 lookups, but adds a double-verify failure path and kills shared-cache eligibility.
- [CoreUserService.update() query budget](core-user-update-query-budget.md) — per-call queries incl. IAM name/email syncs; login/token-refresh never pass names, so syncs are not per-login.

## Build & Startup
- [SWC/CJS TDZ + CI Gap](swc-cjs-tdz-and-ci-gap.md) — circular-import crashes hit `nest start -b swc` but NOT CI (vitest's unplugin-swc misses it); includes the cycle-triage rule.

## Micro-costs (measured, reusable)
- [ConfigService.get cost](config-service-get-cost.md) — measured 152 ns/call (rfdc factory rebuilt every call); `getFastButReadOnly` is the 79 ns option. Only matters inside loops.
- [GridFS verify + stream costs](gridfs-verify-and-stream-costs.md) — COUNT_SCAN is index-only but O(chunks); connect/close ~43 ms/file; `pipe()` leaks the source on client abort; `process.exit()` truncates piped stdout at 64 KB.
- [S3 upload path costs](s3-upload-paths-costs.md) — measured: lib-storage read-ahead ~20 MiB flat; SDK never retries stream bodies; known-length PUT capped at 5 GiB on AWS.
- [Body-parser wrapper costs](body-parser-wrapper-costs.md) — measured: wrapper ~8-16 ns/req; swap runs after parser+router registration; 413 log fires only after body-parser drains.
- [TUS end() normalizer + hook costs](tus-end-normalizer-costs.md) — measured: ~150 ns/req, hooks run per REQUEST not per chunk; HEAD via http.Agent exhausts ports here.
- [Response.clone + EJS costs](response-clone-and-ejs-costs.md) — measured: async-identity ~42 ns, `clone().json()` ~10 us small / 2.7 ms at 512 KB, cached EJS render ~3 us.
- [Redaction regex costs](redaction-regex-costs.md) — redactSensitiveText is O(n²) on crafted input (JWT rule 23 ms @6 KB); per-caller caps; mailbox copy mode redacts before truncating.
- [check-mutations parallelism costs](check-mutations-parallelism-costs.md) — measured: npx 239ms vs .bin 41ms, worktree add ~190ms; the cited 1.87x predates CHECK_LOW_RESOURCE=1 and needs re-measuring.
- [check-overrides + dep-bump costs](check-overrides-and-dep-bump-costs.md) — measured: guard ~1.2-2s/run (own audit + registry spawn), 71s outage stall + error-envelope false green, pnpm 11 ignores npm_config_registry.
- [Better-Auth router + openAPI costs](better-auth-router-and-openapi-costs.md) — router rebuilt per /iam call (~54 us); SERVER_ONLY endpoints skip addRoute; bench by rotated minimums under load.
- [scan-secrets + bridge normaliser costs](scan-secrets-and-bridge-normaliser-costs.md) — measured: Check 8 ~2ms/added line + ~100ms/cue line, --all ~57s baseline; oxfmt idempotence proven with real oxfmt.
- [Mongoose CastError filter costs](mongoose-cast-error-filter-costs.md) — measured: APP_FILTER free off the error path; walk ~1 ms/10k nodes; array CastError.value → 3x Set build (~2x JSON.parse).
- [MCP OAuth consent + sign-in Request costs](mcp-oauth-consent-and-signin-request-costs.md) — measured: Web Request on sign-in ~2.7 us, cached import() ~2 us, consent render ~6 us; findOneAndDelete({clientId,code}) rides {code:1}.
- [Path regex + ESM switch costs](path-regex-and-esm-switch-costs.md) — `/\/+$/` on req path O(n²) ~120-150 ms @16 KB URL (URL counts toward maxHeaderSize; FIXED: normalizeIamRoutePath); callerDirectory ~6 us.
- [Better-Auth JWT verify costs](better-auth-jwt-verify-costs.md) — measured: Bearer verify ~133 us (importJWK uncached + DB jwks lookup); instance.options is a plain data prop (~2 ns).

## Test Pipeline
- [e2e low-resource CI trigger](e2e-low-resource-ci-trigger.md) — load signal fires on EVERY CI build (own unit step); A/B measured the 2-worker cap at +25 % e2e time, so it is skipped on github-hosted runners (not on GitLab).

## Memory & Process
- [Heap Ceiling + Sync stderr](heap-ceiling-and-sync-stderr.md) — measured: `--max-old-space-size=4096` is a no-op on 32GB hosts; bare `node` in prod is correct (cgroup auto-sizing); `writeSync(2)` blocks forever on a stalled pipe.
