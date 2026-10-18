---
name: mcp-oauth-test-facts
description: Facts for reviewing MCP OAuth / consent / IAM login-CSRF tests (11.43.0) — which registered mutation is only a proxy, SDK per-router rate limits, the isTest() CSRF skip, and what was verified red from a scratch copy
metadata:
  type: project
---

First review of the 11.43.0 MCP OAuth rework (2026-10-18): built-in consent page, `CoreAiMcpOAuthInitializer`
mounting in `onModuleInit`, login-CSRF fix in `CoreBetterAuthController`. Verdict: zero Critical/High test
findings; suite deterministic (unit 3x, e2e 3x incl. `--retry=0`).

- **Mutation `mcp-oauth-mounted-after-not-found-handler` is a PROXY.** It renames `onModuleInit` to
  `onApplicationBootstrap`, but the class already has a sync `onApplicationBootstrap()` (Better-Auth
  warning) — the later class member wins, so the mutant mounts NOTHING (404 for a different reason). The
  real defect (mount in bootstrap, behind Nest's not-found handler) was checked separately from a scratch
  copy: the discovery case goes red with `expected 404 to be 200`. Test is sound; the registry entry
  describes a mechanism it does not reproduce.
- **IAM CSRF mutations verified per case:** `iam-signin-csrf-check-skipped` turns BOTH sign-in refusal
  cases red (200 vs 403), `iam-signup-csrf-check-skipped` the sign-up case (201 vs 403). Not vacuous
  because the spec sets `betterAuth.options.advanced.disableOriginCheck: false` — Better-Auth defaults
  `skipOriginCheck: isTest()` (create-context.mjs), so any OTHER spec asserting a CSRF/origin refusal
  without that flag is green with the protection removed.
- **Better-Auth always trusts its own baseURL origin** (`getTrustedOrigins` pushes `new URL(baseURL).origin`),
  which is what lets the consent page's same-origin `fetch('/iam/sign-in/email')` pass the now-active check.
- **MCP SDK auth router rate limits are per router instance:** `/register` 20/hour, `/token` 50/15 min,
  `/authorize` 100/15 min. A spec sharing one app across many cases can hit `/register`; the lifecycle spec
  boots a fresh app per case, the e2e spec registers 3 times.
- **Module-level registries in these specs:** `setMountedMcpOAuth` (cleared by the initializer's
  `onApplicationShutdown` only for its own mount — direct `mountAiMcpOAuth`/`mountAiMcpOAuthRouter` calls
  on stub apps leak it to the end of the file; harmless only because later cases don't read it) and
  `setBetterAuthTokenService` (try/finally + afterEach). Check source ORDER, like [[configservice-singleton-in-tests]].
- `issuedCodes()` in the lifecycle spec reads the memory connection's `aiMcpOAuthCodes` docs — verify the
  name still matches `codesCollection` if it changes, or every "no code issued" assertion goes vacuous.

Related: [[ai-module-test-coverage]], [[scratch-copy-mutation-check]].
