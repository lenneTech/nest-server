---
name: ai-module-perf
description: Per-prompt DB query cost and memory characteristics of the AI module (src/core/modules/ai) for performance reviews
metadata:
  type: project
---

Performance profile of the AI module (`src/core/modules/ai/`), assessed 2026-05-25 on the AI-module branch vs `develop`.

**Per-prompt DB query budget (auto mode, no conversation):** connection resolution (`listUsable` + `resolve` = 2 reads) + budget (`assertWithinBudget`: up to 2 scopes × [`resolveLimit` + `getUsage`]) + `attachBudgetSummary` (`resolveLimit` + `getUsage`). Budget queries run even when no budget is configured because `attachBudgetSummary` is unconditional and `resolveLimit` queries before the unlimited short-circuit.

**Why:** AI prompts are low-frequency (interactive, rate-limited), so absolute query count matters less than per-query cost.
**How to apply:** When reviewing AI changes, focus on (1) `CoreAiBudgetService.getUsage()` — it does `.find().toArray()` + JS `.reduce()` over `aiInteractions`, NOT a `$group` aggregation, so it loads ALL of the user's interaction docs for the current period into memory each prompt. Cost grows with audit volume. A `$group`/`$sum` aggregation or a cumulative counter would bound it. (2) `aiInteractions` has `userId` index + tenant-plugin `tenantId` index but NO `createdAt` index and no `{userId, createdAt}` / `{tenantId, createdAt}` compound — the period filter (`createdAt >= start`) is not index-covered. (3) `loadConversationHistory` uses `conversationService.get()` (hydrated, full `process()` + `securityCheck` over the whole `messages` subdoc array) — not lean, no `$slice`/projection — so cost grows with conversation length on every turn.

**What is already correct (do not re-flag):** `appendMessage` uses `$push` (avoids the subdoc-array-through-update OOM rule); `rateBuckets` Map capped at 5000 with expired-bucket eviction; MCP `transports` Map capped at 500 with lastUsed-based `evictIfNeeded` + `onclose` cleanup; MCP OAuth artifacts are DB-backed with TTL + unique indexes (no in-memory state); provider uses native `fetch` + `AbortSignal.timeout` (no leaked timers); `listUsable`/`resolve`/preference reads use `.lean()` + `.select()`; preference + budget-limit lookups have `{scope, refId}` compound unique indexes; tenant-preference WeakMap memo in the resolver genuinely dedupes the 2 tenant-layer reads into 1; `@modelcontextprotocol/sdk` is lazy-imported (no cost when MCP off); `check-security.interceptor.ts` now gates `JSON.stringify` behind `config.debug` (confirmed perf win). See [[check-security-interceptor-debug-gate]] if written.
