---
name: ai-module-perf
description: Per-prompt DB query cost and memory characteristics of the AI module (src/core/modules/ai) for performance reviews
metadata:
  type: project
---

Performance profile of the AI module (`src/core/modules/ai/`), reassessed 2026-05-30 on `feature/ai-module` vs `develop`.

**Per-prompt DB query budget (auto mode, no conversation, no budgets, no audit, no learning):** 6–9 reads + 0–1 writes — connection resolution (`listUsable` + `resolve` = 2 reads), optional tenant/user preferences (1–2 reads, tenant memoized), slot fragments (2 reads — see below), optional budget (`resolveLimit` + `getUsage` aggregation = 2 reads when user present), optional audit (1 write when `ai.audit`), optional approved learning hints (1 read when wired).

**Why:** AI prompts are low-frequency (interactive, rate-limited) — absolute query count matters less than per-query cost. With auth + LLM round-trip dominating wall-clock, the DB layer is well within budget.
**How to apply:** When reviewing AI changes, focus on:
1. `CoreAiSlotService.resolveFragments` runs **TWO** separate `find()` calls on `aiSlots` per prompt (enabled rows + disabled rows). These could be merged into a single `find({ tenantId })` followed by a JS partition by `enabled`, halving the per-prompt slot-resolution cost. Also: no tenant-keyed cache exists — slot rows are stable and could be cached with a short TTL or invalidated on slot CUD.
2. `CoreAiConversationService.find()` in `findAiConversations`/`findConversations` returns the **full conversation including the messages array** (up to 500 entries × variable content size). The list UI typically only needs metadata (id, title, connectionId, createdAt). Add a `select` projection that excludes `messages`, or paginate. Critical when a user has many long conversations.
3. `aiConversations` collection has **NO index on `createdBy`** — the `findByOwner` list query becomes a collection scan as conversation volume grows. Add `@UnifiedField({ mongoose: { ref: 'User', type: Schema.Types.ObjectId, index: true } })` on `createdBy`.
4. SSE streaming (`promptStream`) is fake-streaming: `prompt()` runs to completion (`stream: false` is hardcoded in the OpenAI-compatible provider's chat call), THEN the final text is chunked. User waits the full LLM round-trip before the first token. To do real progressive streaming, the provider would need to call `/chat/completions` with `stream: true` and emit tokens as they arrive; the orchestrator's emulated tool-calling protocol then needs a stream-aware JSON delimiter detector.

**What is already correct (do not re-flag) — was flagged in earlier assessments, now resolved:**
- `CoreAiBudgetService.getUsage()` uses a server-side `$group` aggregation (`$sum` + `$ifNull`) — NOT a `find().toArray() + JS .reduce()`. Per-prompt overhead bounded.
- `aiInteractions` has compound indexes `{userId, createdAt}` AND `{tenantId, createdAt}` covering the budget period filter.
- `CoreAiService.loadConversationHistory` calls `CoreAiConversationService.loadRecentMessages` — lean, projected (`createdBy`, `{messages: {$slice: -limit}}`), with explicit owner/admin authorization. Per-turn cost no longer scales with conversation length.
- `appendMessage` uses `$push` with `$slice: -500` (avoids the subdoc-array-through-update OOM rule + caps growth).
- `rateBuckets` Map capped at 5000 with expired-bucket eviction.
- MCP `transports` Map capped at 500 with `lastUsed`-based `evictIfNeeded` + `onclose` cleanup.
- MCP OAuth: NO in-memory state — all artifacts (clients, codes, refresh tokens) live in MongoDB with TTL + unique indexes. `ensureIndexes()` is idempotent (latched via `indexesEnsured`).
- Providers use native `fetch` + `AbortSignal.timeout` (no leaked timers).
- Claude CLI provider: timer cleared in both `error` and `close` handlers; `child.kill('SIGKILL')` on timeout; `child.stdin` EPIPE silently swallowed.
- `listUsable` / `resolve` / preference reads use `.lean()` + `.select()`.
- Preference + budget-limit lookups have `{scope, refId}` compound unique indexes.
- Tenant-preference WeakMap memo in the resolver collapses the 2 tenant-layer reads into 1.
- `@modelcontextprotocol/sdk` lazy-imported (no cost when MCP off).
- Connection model exposes `hasApiKey` (derived from `apiKeyEncrypted` presence); `apiKeyEncrypted` is on the global `secretFields` list — never leaks to clients.
- Capability auto-detection persisted (`detectAndPersistCapabilities`) → not probed every prompt.
- Context-window detection persisted on the connection doc (Ollama probe + known-model heuristic).
- Prompt builder runs `approvedHints` only when `hintService` wired and learning is enabled.

**Known open trade-offs (current, low priority):**
- `approvedHints` runs on every `renderContext` when learning is enabled — bounded, small result set, but no cache. OK while learning rows stay small.
- `aiSlots` has no `{tenantId, enabled}` compound — current `tenantId` single-field index is OK for low slot counts; revisit if a tenant accumulates many overrides.
