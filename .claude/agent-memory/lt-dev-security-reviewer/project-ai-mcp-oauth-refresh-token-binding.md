---
name: project-ai-mcp-oauth-refresh-token-binding
description: MCP OAuth refresh-token/code client binding — FIXED (rotateRefreshToken(token, clientId) + findOneAndDelete({clientId, token})); how to re-verify, and the residual code-burn ordering
metadata:
  type: project
---

**FIXED** (verified 2026-10-18, 11.43.0 working tree). `exchangeRefreshToken` now passes the
rotating `client.client_id` to `rotateRefreshToken(token, clientId)`, which deletes atomically via
`findOneAndDelete({ clientId, token })`. A foreign client's refresh token answers `400 invalid_grant`
(SDK `InvalidGrantError` since 11.43.0, a plain `Error` → 500 before).

**Why keep this note:** the binding is a one-argument regression away. Re-verify on any change to
`buildOAuthProvider()` / `rotateRefreshToken()`: the filter must contain BOTH `token` and `clientId`.

Code exchange: also bound since 11.43.0 — `consumeAuthorizationCode(code, clientId)` deletes via
`findOneAndDelete({ clientId, code })`, so a foreign client no longer burns the owner's code
(mutation `mcp-oauth-code-burned-by-foreign-client`).

Only relevant when `ai.mcp.oauth: true`. See [[project-ai-mcp-oauth-mount-and-consent]].
