---
name: ai-mcp-oauth-refresh-token-binding
description: MCP OAuth refresh-token rotation in CoreAiMcpOAuthService.exchangeRefreshToken does not validate the rotating client matches the issuing client — cross-client token theft risk when ai.mcp.oauth is enabled
metadata:
  type: project
---

`CoreAiMcpOAuthService.buildOAuthProvider().exchangeRefreshToken` is wired as `async (_client, refreshToken) => { const rotated = await this.rotateRefreshToken(refreshToken); … }`. The underscore-prefixed `_client` is the authenticated rotating client passed in by `mcpAuthRouter` (the MCP SDK verifies the rotating client via `client_id` + optional `client_secret` upstream), but our provider DOES NOT compare `rotated.clientId === _client.client_id`. By contrast `exchangeAuthorizationCode` DOES enforce `stored.clientId !== client.client_id ⇒ throw 'invalid_grant'`. Asymmetric.

**Why this matters (OAuth 2.1 §4.13.2 / §7.4):** refresh tokens MUST be bound to the client they were issued to. Without the comparison, Client A that somehow obtains Client B's refresh token (compromised storage, log leak, browser cache, prior request) can rotate it into Client A's session and use the resulting access token to impersonate Client B's user (subject `sub` is preserved in the new access token).

**How to apply:** flag every change to `buildOAuthProvider()` / `rotateRefreshToken()`. The fix is to add a `if (rotated.clientId !== client.client_id) throw new Error('invalid_grant')` check inside `exchangeRefreshToken`, ideally inside `rotateRefreshToken` itself by passing the rotating clientId as a second argument and using it in the `findOneAndDelete` filter (`{ token, clientId }`). Also revisit `exchangeAuthorizationCode` if its check is ever loosened — currently correct.

Only relevant when `ai.mcp.oauth: true`; without OAuth the MCP controller uses Bearer/session tokens that bind to a session, not a client.
