# Security Reviewer Memory — nest-server

## Project Context

- [project-npm-files-exposure.md](project-npm-files-exposure.md) — .claude/rules/**/* and CLAUDE.md added to npm files array in 11.22.0; agent-memory and commands are NOT included
- [feedback-typeof-detection.md](feedback-typeof-detection.md) — typeof detection for CoreModule.forRoot() signature; security classification of Type<any>
- [project-ai-module-secret-stripping.md](project-ai-module-secret-stripping.md) — AI module 3-layer apiKeyEncrypted protection + secretFields override fragility; MCP PKCE enforced by SDK
- [project-ai-mcp-oauth-refresh-token-binding.md](project-ai-mcp-oauth-refresh-token-binding.md) — CoreAiMcpOAuthService.exchangeRefreshToken ignores rotating client_id; cross-client token theft risk when ai.mcp.oauth=true
- [project-ai-tool-authorization-chain.md](project-ai-tool-authorization-chain.md) — AI tool authz: role filter always runs, `authorize()` ONLY in plan mode (docs claim otherwise); U+2028 framing; MCP under S_EVERYONE gets NO tenant context → plugin fails closed
- [project-dev2653-authorize-in-auto-mode-impact.md](project-dev2653-authorize-in-auto-mode-impact.md) — DEV-2653 vs lt-crm's 45 authorize()-tools: zero live gaps, authorize() mirrors / services enforce; regression risks named
- [project-betterauth-native-cookie-forwarding.md](project-betterauth-native-cookie-forwarding.md) — BetterAuth's helper vs native-forward cookie paths; SEC-001 ("useSecureCookies:false strips Secure") is FIXED — do not re-report
- [project-betterauth-di-failclosed-and-cycle-triage.md](project-betterauth-di-failclosed-and-cycle-triage.md) — @Optional() auth-instance injection degrades fail-CLOSED (401, not bypass); how to triage madge cycles as TDZ-risky (decorator-arg) vs benign (method-body)
- [project-betterauth-input-false-enforcement.md](project-betterauth-input-false-enforcement.md) — BA `input:false` privesc fix: single chokepoint parseInputData covers create/update/social; keyed on object-KEY not fieldName (shadow-key gap); nest-server native $set path disjoint
- [project-template-render-traversal.md](project-template-render-traversal.md) — UPDATED 2026-07-20: renderTemplate NOW HAS an absolute-path containment guard + Hub sendTestEmail inventory-validates; both old findings FIXED — re-verify before re-reporting
- [project-hub-module-security-model.md](project-hub-module-security-model.md) — Hub cockpit gating mechanics; TOP risks = external-guard dependency (Hub+no-auth=open) and CSRF under cors.allowAll+SameSite=None; roles:false prod guard now exists
- [project-process-diagnostics-helper.md](project-process-diagnostics-helper.md) — writeSync(2) EBADF/EPIPE throw exits 7 and masks the error; signal abdication vs Nest traced; unhandledRejection flips Node's fail-fast default

## Review Methodology

- [project-pnpm-overrides-propagation.md](project-pnpm-overrides-propagation.md) — workspace overrides never reach npm consumers (@nestjs/graphql exact-pins vulnerable ws@8.20.1); override-necessity test recipe; pnpm overrides are downgrade-LOCKS

- [project-e2e-node-env-trap.md](project-e2e-node-env-trap.md) — e2e without NODE_ENV=e2e fabricates 5 bogus BetterAuth "Invalid credentials" failures; reproduces on base branch too, so a control-diff won't catch it
- [project-betterauth-native-cookie-forwarding.md](project-betterauth-native-cookie-forwarding.md) — BetterAuth native-handler paths forward Set-Cookie verbatim, bypass the cookie helper's Secure flag; useSecureCookies:false (11.27.6) drops Secure on 2FA/social/magic-link session cookies
- [project-exception-wire-format.md](project-exception-wire-format.md) — HttpExceptionLogFilter sends `{...exception}` (class `name` is client-visible); `extends HttpException` breaks instanceof vs native Forbidden/Unauthorized
