---
name: ai-module-doc-coverage-gaps
description: Recurring documentation gaps observed when the AI module landed in nest-server — exported features that exist in code/index but are not mentioned in README/INTEGRATION-CHECKLIST/migration-guide
metadata:
  type: project
---

When reviewing the v11.26.0 AI module, the docs scored high on the headline features (LLM connections, encryption, tools, plan mode, budgets, MCP) but consistently failed to mention several exported, public-API features:

- **Lifecycle hooks** (`IAiHook`, `AiHookBase`, `AiHookRegistry`) — fully exported in `src/core/modules/ai/index.ts`, used to gate/observe the agent loop, but zero mentions in README/INTEGRATION-CHECKLIST/migration-guide/configurable-features.md.
- **Tool grants** ("remember my decision" — `CoreAiToolGrantService`, `CoreAiToolGrant`) — full CrudService with conversation/user/tenant scope, used in `CoreAiService` to skip confirmation gates, but not mentioned in any docs.
- **Named modes** (`CoreAiMode`, `CoreAiModeService`, `modeService` override) — exported, but not mentioned in any docs.
- **Multi-modal attachments** (`LlmAttachment` in `llm-provider.interface.ts`, `attachments` on `CoreAiPromptInput`, providers translate to native vision payloads) — mentioned in change summaries but missing from README/INTEGRATION-CHECKLIST/migration-guide.
- **Advanced perf flags** `ai.compaction` (default `true`, LLM-driven context compaction) and `ai.deferToolSchemas` (search_tools meta-tool) — fully JSDoc'd in `IAi` but missing from README/migration-guide.
- **`ai.claudeCli.{bin,extraArgs,maxBudgetUsd}`** — actively read by `ClaudeCliProvider`, mentioned by name in README, but NOT declared as a typed property in `IAi` (untyped config).
- **`ai.allowedBaseUrlHosts`** SSRF allowlist — well-JSDoc'd in IAi but not mentioned in README/INTEGRATION-CHECKLIST/migration-guide.

**Why:** The README/INTEGRATION-CHECKLIST were written before later features (hooks, grants, modes, attachments, compaction) landed and weren't updated when those features merged. The interface JSDoc is the only doc that stayed in sync.

**How to apply:** For an AI module review, audit each `export * from` line in `src/core/modules/ai/index.ts` and grep README/INTEGRATION-CHECKLIST/migration-guide for each exported public name. Stale `.claude/rules/configurable-features.md` AI row is also typical: it had `aiPromptTemplates` / `promptTemplateService` / `/ai/prompt-templates` after the rename to `aiSlots` / `slotService` / `/ai/slots` shipped, contradicting README + INTEGRATION-CHECKLIST + migration guide.

Related: [[doc-surfaces-for-config-features]], [[framework-api-generator-allowlist]].
