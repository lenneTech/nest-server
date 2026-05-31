---
name: ai-module-secret-stripping
description: AI module 3-layer apiKeyEncrypted protection; secretFields now MERGES with defaults (11.26.0 fix — fragility resolved); MCP PKCE enforced by SDK
metadata:
  type: project
---

AI module (`src/core/modules/ai/`) protects the connection API key via THREE independent layers; understand all three when reviewing AI/secret changes.

**Why:** API keys for LLM providers are stored encrypted (AES-256-GCM) in `aiConnections.apiKeyEncrypted` and must never reach any client. The module was designed with redundant stripping so a single misconfiguration does not leak the key.

**How to apply (the three layers):**
1. `CoreAiConnection.securityCheck()` sets `this.apiKeyEncrypted = undefined` AND derives `hasApiKey` — this is the PRIMARY strip for Model-instance responses and runs regardless of config. `apiKeyEncrypted` is intentionally NOT `@Restricted` so it survives `checkRestricted` long enough for `securityCheck` to read it.
2. `apiKeyEncrypted` is in the `CheckSecurityInterceptor` default `secretFields` (check-security.interceptor.ts) — the fallback for PLAIN objects (`.lean()`, spreads).
3. Plain-object paths (`listUsable`, `resolve`) are system-internal and either `.select()` a field set WITHOUT the key, or are never returned to clients (the decrypted key in `resolve()` only flows to the provider `fetch`).

**RESOLVED in 11.26.0 (commit on develop after 0a3380d):** `CheckSecurityInterceptor` now MERGES (union via `[...new Set([...defaults, ...globalSecretFields])]`) project `security.secretFields` with framework defaults instead of replacing them (check-security.interceptor.ts). A project can now only ADD secret fields, never drop `password`/`apiKeyEncrypted`/etc. The previously-flagged fragility (layer 2 silently disabled by a custom list omitting `apiKeyEncrypted`) is closed. Migration guide 11.25.x-to-11.26.0.md documents the behavior change (you can no longer expose a built-in secret field by omission). Verify in future reviews that this merge is NOT reverted — it strictly strengthens stripping and cannot weaken it.

Related: MCP OAuth uses PKCE enforced by the `@modelcontextprotocol/sdk` token+authorize handlers (schema requires `code_challenge` + `code_challenge_method: S256`), not by the custom `verifyPkce` (which is belt-and-suspenders).
