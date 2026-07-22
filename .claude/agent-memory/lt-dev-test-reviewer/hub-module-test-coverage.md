---
name: hub-module-test-coverage
description: Coverage state of src/core/modules/hub (operator cockpit) at first review 2026-07-20 — mutating actions (cron/deleteFile/migrations) untested, collector crash-safety branches have no unit specs; testability facts that make closing them cheap
metadata:
  type: project
---

Hub module (`src/core/modules/hub`) test coverage at first review, uncommitted on `develop`, 2026-07-20 (HEAD 916439b). Verify against current specs before reusing — remediation may have landed.

**Strong already:** permission matrix (anon→401 across ALL 18 sidecars, non-admin→403, admin→200 across pages+sidecars), CSRF header + confirm keyword + audit line (via clearCollector), secret masking, CSP-nonce match, cursor-based trace reads (anti-pollution). Thorough unit specs for the pure helpers: ring-buffer, hub-mask, hub-shell (CSP/escape), hub-mermaid, hub-command-shape, hub-config, core-hub-mailbox.

**Untested then (the real gaps):**
- **Mutating actions execution** — only `clearCollector` (queries) is happy-pathed. `controlCron` (start/stop/trigger + unknown-action 400 + confirm=name), `deleteFile` (missing-confirm 400, invalid-id, not-found, filename-mismatch, actual delete), `runMigrations`/`rollbackMigration` (confirm RUN/DOWN + execution) have NO test. The `wrap()` domain-error→400 mapping is untested. Generic CSRF+confirm guards ARE proven via clearCollector, so only the per-action bodies + per-action confirm keywords are open.
- **Collector crash-safety branches** — no dedicated spec for `HubLogBufferService`, `HubQueryProfilerService`, `HubTraceBufferService`, `HubTraceMiddleware`. The swallow paths (`safe()`, delegating-logger try/catch, middleware record try/catch), self-heal, owner-checked detach (multi-app), pending-map eviction (`HUB_QUERY_PENDING_LIMIT`), monitorCommands-off warn branch, and the pure-ish fns `isExcluded`/`routePattern`/`collapseParams`/`graphqlOperation` are only e2e-happy-path'd, never unit-tested.
- **Sources error-degradation** — `CoreHubSourcesService` getCron/getErrorCodes/getRoutes/getAi/getAuthMigration each have a try/catch→`available:false` branch. Only the ABSENCE path (module not present) is tested (story: error-code disabled; hub-config: enabled). The THROW path is untested.
- **`/hub/mailbox/:seq/html`** — only reached behind an early-`return` guard; the reliably-captured welcome test-mail action (story ~L419) never follows up by fetching the body, so this sandboxed-render endpoint may not run in a given pass.
- **`CoreHubModule.forRoot` runtime-metadata pollution fix** — the unconditional `Reflect.defineMetadata(PATH_METADATA/roles)` overwrite (+ `roles:false` clears) is only IMPLICITLY covered by hub-config.e2e sequential app boots; the reverse leak (custom path lingering after switching back to default) is not explicitly asserted. module.spec only checks forRoot shape + prod capture guard.

**Testability facts (survive refactors only if re-verified):**
- The masking sentinel is a TRUE positive: `SECRET_OR_PRIVATE_KEY_LOCAL` (config.env.ts L402) IS the real e2e JWT secret, so `not.toContain(sentinel)` genuinely proves masking — do not "simplify" it away.
- `deleteFile` has a cheap happy path: upload a GridFS file via the existing FileModule, then DELETE with the filename as confirm — no fixture plumbing needed.
- Sources error-branches close with a mock `ModuleRef.get` returning a stub whose method throws — no real module needed.
- Story uses 9 fixed `await wait()` sleeps (150–400 ms) for async propagation — latent flaky vector; currently green, mitigated by cursor reads + find-by-unique-content. The mailbox capture test's `toBeGreaterThanOrEqual` is trivially true (weak); real capture proof is the later test-mail action + the unit spec.
- `hub-client-js.helper.ts` (610 lines) is a browser-JS template string — legitimately Playwright territory, NOT a backend unit-test gap.

See [[e2e-isolation-model]] for the shared-DB flake model (pre-existing file/server/auth-scenarios flakes are environmental, verified identical with/without Hub).
