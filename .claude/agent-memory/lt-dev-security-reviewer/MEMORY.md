# Security Reviewer Memory — nest-server

## Project Context

- [project-npm-files-exposure.md](project-npm-files-exposure.md) — .claude/rules/**/* and CLAUDE.md added to npm files array in 11.22.0; agent-memory and commands are NOT included
- [feedback-typeof-detection.md](feedback-typeof-detection.md) — typeof detection for CoreModule.forRoot() signature; security classification of Type<any>
- [project-ai-module-secret-stripping.md](project-ai-module-secret-stripping.md) — AI module 3-layer apiKeyEncrypted protection + secretFields override fragility; MCP PKCE enforced by SDK
- [project-ai-mcp-oauth-refresh-token-binding.md](project-ai-mcp-oauth-refresh-token-binding.md) — CoreAiMcpOAuthService.exchangeRefreshToken ignores rotating client_id; cross-client token theft risk when ai.mcp.oauth=true
- [project-betterauth-native-cookie-forwarding.md](project-betterauth-native-cookie-forwarding.md) — BetterAuth native-handler paths forward Set-Cookie verbatim, bypass the cookie helper's Secure flag; useSecureCookies:false (11.27.6) drops Secure on 2FA/social/magic-link session cookies
