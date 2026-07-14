# Security Reviewer Memory — nest-server

## Project Context

- [project-npm-files-exposure.md](project-npm-files-exposure.md) — .claude/rules/**/* and CLAUDE.md added to npm files array in 11.22.0; agent-memory and commands are NOT included
- [feedback-typeof-detection.md](feedback-typeof-detection.md) — typeof detection for CoreModule.forRoot() signature; security classification of Type<any>
- [project-ai-module-secret-stripping.md](project-ai-module-secret-stripping.md) — AI module 3-layer apiKeyEncrypted protection + secretFields override fragility; MCP PKCE enforced by SDK
- [project-ai-mcp-oauth-refresh-token-binding.md](project-ai-mcp-oauth-refresh-token-binding.md) — CoreAiMcpOAuthService.exchangeRefreshToken ignores rotating client_id; cross-client token theft risk when ai.mcp.oauth=true
- [project-betterauth-native-cookie-forwarding.md](project-betterauth-native-cookie-forwarding.md) — BetterAuth's helper vs native-forward cookie paths; SEC-001 ("useSecureCookies:false strips Secure") is FIXED — do not re-report
- [project-betterauth-di-failclosed-and-cycle-triage.md](project-betterauth-di-failclosed-and-cycle-triage.md) — @Optional() auth-instance injection degrades fail-CLOSED (401, not bypass); how to triage madge cycles as TDZ-risky (decorator-arg) vs benign (method-body)

## Review Methodology

- [project-e2e-node-env-trap.md](project-e2e-node-env-trap.md) — e2e without NODE_ENV=e2e fabricates 5 bogus BetterAuth "Invalid credentials" failures; reproduces on base branch too, so a control-diff won't catch it
