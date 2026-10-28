# Security Reviewer Memory — nest-server

## Project Context

- [project-npm-files-exposure.md](project-npm-files-exposure.md) — .claude/rules/**/* and CLAUDE.md added to npm files array in 11.22.0; agent-memory and commands are NOT included
- [feedback-typeof-detection.md](feedback-typeof-detection.md) — typeof detection for CoreModule.forRoot() signature; security classification of Type<any>
- [project-ai-module-secret-stripping.md](project-ai-module-secret-stripping.md) — AI module 3-layer apiKeyEncrypted protection + secretFields override fragility; MCP PKCE enforced by SDK
- [project-ai-mcp-oauth-refresh-token-binding.md](project-ai-mcp-oauth-refresh-token-binding.md) — FIXED: refresh rotation bound via findOneAndDelete({clientId, token}); re-verify recipe + code-burn residual
- [project-ai-mcp-oauth-mount-and-consent.md](project-ai-mcp-oauth-mount-and-consent.md) — 11.43.0 auto-mount behind all Nest middleware; API-token refusal now live; consent-CSRF enforced; built-in consent page reviewed (no-JS GET pw fallback, double-clickjack, binding test gaps)
- [project-ai-tool-authorization-chain.md](project-ai-tool-authorization-chain.md) — AI tool authz: role filter always runs, `authorize()` ONLY in plan mode (docs claim otherwise); U+2028 framing; MCP S_EVERYONE: tenant only via membership; OAuth late-scoped since 11.43.3 (sound)
- [project-dev2653-authorize-in-auto-mode-impact.md](project-dev2653-authorize-in-auto-mode-impact.md) — DEV-2653 vs lt-crm's 45 authorize()-tools: zero live gaps, authorize() mirrors / services enforce; regression risks named
- [project-betterauth-signin-login-csrf.md](project-betterauth-signin-login-csrf.md) — sign-in/sign-up login CSRF FIXED (bypass matrix probed); verify-email auto-sign-in still plants; isTest() skips checks
- [project-betterauth-native-cookie-forwarding.md](project-betterauth-native-cookie-forwarding.md) — helper vs native-forward cookie paths; SEC-001 + advanced-merge footgun FIXED; helper mirrors BA Secure since 11.42.12
- [project-betterauth-di-failclosed-and-cycle-triage.md](project-betterauth-di-failclosed-and-cycle-triage.md) — @Optional() auth-instance injection degrades fail-CLOSED (401, not bypass); how to triage madge cycles as TDZ-risky (decorator-arg) vs benign (method-body)
- [project-betterauth-input-false-enforcement.md](project-betterauth-input-false-enforcement.md) — BA `input:false` privesc fix: single chokepoint parseInputData covers create/update/social; keyed on object-KEY not fieldName (shadow-key gap); nest-server native $set path disjoint
- [project-template-render-traversal.md](project-template-render-traversal.md) — UPDATED 2026-07-20: renderTemplate NOW HAS an absolute-path containment guard + Hub sendTestEmail inventory-validates; both old findings FIXED — re-verify before re-reporting
- [project-hub-module-security-model.md](project-hub-module-security-model.md) — Hub cockpit gating mechanics; TOP risks = external-guard dependency (Hub+no-auth=open) and CSRF under cors.allowAll+SameSite=None; roles:false prod guard now exists
- [project-process-diagnostics-helper.md](project-process-diagnostics-helper.md) — writeSync(2) EBADF/EPIPE throw exits 7 and masks the error; signal abdication vs Nest traced; unhandledRejection flips Node's fail-fast default
- [project-gridfs-and-express-response-facts.md](project-gridfs-and-express-response-facts.md) — GridFS 0 chunks for 0-byte file; res.json() keeps preset Content-Type; pipe() leaks source on abort; exit() truncates stdout; res.end(cb) dead on pre-end abort
- [project-roles-metadata-merge-semantics.md](project-roles-metadata-merge-semantics.md) — @Roles OR-merges: method S_EVERYONE DEFEATS class ADMIN; CoreTenantGuard differs; @Roles(ADMIN) satisfiable by a tenant membership role named 'admin'
- [project-file-tus-access-model.md](project-file-tus-access-model.md) — UPDATED for 11.33.0: roles now config-driven via Reflect metadata (override opts out), file classes got @SkipTenantCheck() but TUS did NOT; canonical checkRights example still skips the filename route
- [project-hub-config-masking-gaps.md](project-hub-config-masking-gaps.md) — maskConfigDeep LEAKS a password-only URI (`redis://:pw@host`) and `s3.accessKeyId`; carries the one-liner to re-test rather than eyeballing the regex
- [project-rate-limit-store-asymmetry.md](project-rate-limit-store-asymmetry.md) — RedisRateLimitStore has NO key cap while the in-memory one carefully does; both key on an unconditionally trusted X-Forwarded-For
- [project-redact-misses-reset-password-urls.md](project-redact-misses-reset-password-urls.md) — **FIXED 11.36.1**; kept for the probe + the "a redaction rule only knows the URL shapes it was told about" lesson
- [project-betterauth-ratelimit-not-presence-implies-enabled.md](project-betterauth-ratelimit-not-presence-implies-enabled.md) — **FIXED 11.36.1**; kept for the two-layer lesson (configure() AND the middleware mount) + the probe
- [project-api-token-module-security-model.md](project-api-token-module-security-model.md) — API tokens: enforceApiTokenRoute per kind; tenant token passed S_SELF/S_CREATOR-only routes; 11.42.14 AuthGuard branch sound, dead in starter
- [project-swagger-helper-security-model.md](project-swagger-helper-security-model.md) — setupSwagger (11.42.7) is doc-only; token view can't widen exposure; metadata-array aliasing hazard to re-check
- [project-betterauth-path-deny-normalization.md](project-betterauth-path-deny-normalization.md) — raw-path deny checks before Better-Auth's handler bypassable via `%2e`/`../`; SERVER_ONLY fix LANDED + verified 11.42.9; probe recipe
- [project-tus-protocol-dispatch-facts.md](project-tus-protocol-dispatch-facts.md) — tus/srvx ignore X-HTTP-Method-Override, llhttp 400s lowercase methods; Location is requester-only, not persisted
- [project-route-authguard-redundant-under-global-guard.md](project-route-authguard-redundant-under-global-guard.md) — route AuthGuard(BETTER_AUTH) beside non-S_EVERYONE @Roles is decision-neutral; ts-node (not tsx) probe recipe
- [project-cast-error-filter-security-model.md](project-cast-error-filter-security-model.md) — CastError filter (11.42.16) clean: $in value is one element, Map path `m.$*`, falsy-filter fallback, ~1.3 ms walk at 100 kB
- [project-betterauth-baseurl-jwt-issuer.md](project-betterauth-baseurl-jwt-issuer.md) — getBaseUrl() from instance.options.baseURL: security-neutral (JWT iss + CSRF traced); trailing-slash 401 residual; SWC probe recipe
- [project-12-0-0-esm-switch-security-facts.md](project-12-0-0-esm-switch-security-facts.md) — 12.0.0 ESM/SWC-loader/loadLocalConfig traced neutral: config read before env merge, CLI-only loaders, no dual guard state
- [project-ws-connection-ack-echoes-extra.md](project-ws-connection-ack-echoes-extra.md) — pre-existing: onConnect `return extra` = connection_ack payload (own user + headers); probe + fix if it ever carries secrets
- [project-db-agnostic-phase0-store-facts.md](project-db-agnostic-phase0-store-facts.md) — DEV-3828 policies verbatim; DataStore select/filter/native safe only by no-caller; phase-1 re-check list
- [project-db-agnostic-phase2-core-modules-facts.md](project-db-agnostic-phase2-core-modules-facts.md) — DEV-3830 user/tenant/token/locks on SQL traced sound; health-ping + logout deviceId residuals below bar
- [project-db-agnostic-phase3-better-auth-sql-facts.md](project-db-agnostic-phase3-better-auth-sql-facts.md) — DEV-3831 BA-on-SQL traced sound; MCP OAuth loadUser missed-reader finding FIXED in phase 4
- [project-db-agnostic-phase4-ai-file-sweep-facts.md](project-db-agnostic-phase4-ai-file-sweep-facts.md) — DEV-3832: sweep ignores partialFilterExpression (data loss); OAuth/file/AI store paths sound; conversation-append IDOR below bar
- [project-db-agnostic-phase5-mongo-optional-facts.md](project-db-agnostic-phase5-mongo-optional-facts.md) — DEV-3833: null connection breaks JWT verify, AI budget, MCP OAuth stores (fail closed), all FIXED 2026-10-28; DB-less probe recipe
- [project-db-agnostic-phase6-mysql-facts.md](project-db-agnostic-phase6-mysql-facts.md) — DEV-3848: MySQL update compiler prototype pollution (`__proto__` path → tenant bypass); app-account check blind to roles; container probe recipe

## Review Methodology

- [project-check-overrides-unusable-fix-residual.md](project-check-overrides-unusable-fix-residual.md) — unusableFixConsumers (landed 11.42.5): backport, second parent, importers edge, second consumer version must all RE-TEST
- [project-check-overrides-pnpm11-outage-shapes.md](project-check-overrides-pnpm11-outage-shapes.md) — pnpm 11 audit-failure shapes + registry env facts; false "ok" (926b691) and skipped suppression checks (40073c2) both FIXED; re-run recipe
- [project-pnpm-overrides-propagation.md](project-pnpm-overrides-propagation.md) — overrides never reach npm consumers; THREE exact-pin leaks (ws, js-yaml, @graphql-tools/utils@12.0.0); docs/security-overrides.md must be updated; `pnpm audit --prod` triage for ignoreGhsas

- [project-e2e-node-env-trap.md](project-e2e-node-env-trap.md) — e2e without NODE_ENV=e2e fabricates 5 bogus BetterAuth "Invalid credentials" failures; reproduces on base branch too, so a control-diff won't catch it
- [project-betterauth-cookie-vs-body-token.md](project-betterauth-cookie-vs-body-token.md) — **FIXED 11.36.3**; why isJwtShaped() is sound (no dots in better-auth ids) + where the refusal is still silent
- [project-check-mutations-tooling-risks.md](project-check-mutations-tooling-risks.md) — **all 3 risks FIXED 11.36.3**; keeps the git option-injection probe + the one residual ordering window
- [project-exception-wire-format.md](project-exception-wire-format.md) — HttpExceptionLogFilter sends `{...exception}` (class `name` is client-visible); `extends HttpException` breaks instanceof vs native Forbidden/Unauthorized
- [Primitive @Body/@Args args skip validation](project-primitive-body-args-bypass-validation.md) — metatype String ⇒ MapAndValidatePipe returns objects untouched; live $ne-injection in resetPassword + createPasswordResetToken
- [Cross-repo: CLI patch hoist + public scanner](reference-cross-repo-hoist-and-public-scanner.md) — relocatePatches source-side symlink caveat (below bar); scanner --print superset, CI has no denylist; `--all` skips untracked files
- [lt-dev permissions.json = global auto-allow](reference-lt-dev-permissions-json-global-allow.md) — `lt claude plugins` writes every pattern into ~/.claude/settings.json; the existing broad entries are an owner decision (2026-10-06), do not report
- [Windows .cmd spawn quoting](reference-windows-cmd-spawn-quoting.md) — simulate win32 spawnargs on macOS; cmd vs CRT parser; trailing-backslash class; cmd-shim quirks
- [e2e-run-slots shared /tmp model](project-e2e-run-slots-shared-tmp-model.md) — wx+unlink closes the symlink write; squatted-dir FIFO hang on the read path is pre-existing, below bar
- [IAM name sync + _bsontype facts](project-iam-name-sync-and-bsontype-facts.md) — DEV-3821 email-keyed name write sound (unique email premise); `name` undeclared → never in responses; bson refuses `_bsontype`
