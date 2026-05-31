---
name: ai-module-prompt-service-errors
description: CoreAiPromptService and CoreAiSlotService use raw-string ForbiddenException throws while neighbouring AI services already use ErrorCode — actionable cleanup, not a security bug
metadata:
  type: project
---

In the AI module (`src/core/modules/ai/`), most services route exceptions through the
core `ErrorCode` registry (e.g. `CoreAiBudgetService` → `ErrorCode.AI_BUDGET_EXCEEDED`,
`CoreAiConnectionService` → `ErrorCode.AI_NO_CONNECTION`, `CoreAiConnectionResolverService`
→ `ErrorCode.AI_PREFERENCES_UNAVAILABLE`), but **two services still throw raw-string
`ForbiddenException`s**:

1. `src/core/modules/ai/services/core-ai-prompt.service.ts` — 9 raw-string throws
   (`'Sign in to create a prompt.'`, `'Invalid prompt scope "<x>".'`,
   `'Cannot share a prompt with a tenant when no tenant context exists.'`,
   `'Only the owner can modify this prompt.'`, `'Prompt <id> not found.'`,
   `'Sign in to modify a prompt.'`, `'Could not verify prompt ownership: …'`).
2. `src/core/modules/ai/services/core-ai-slot.service.ts` — 5 raw-string throws
   (`'Slot management requires admin role.'`, `'Slot belongs to a different tenant.'`,
   `'Slot <id> not found.'`, `'Only system-slot overrides can be reset.'`).

**Why:** Defines the existing baseline so reviewers don't keep flagging this every PR
without context. The framework has matching codes (`LTNS_01xx` authorization,
`LTNS_04xx` resource-not-found) that could be reused; these strings break the
documented "every throw must use ErrorCode" rule, but they are NOT a security gap.

**How to apply:** When reviewing the AI module, flag these as Medium "consistency
with neighbouring code" findings — not Critical. Propose the concrete mapping:
  - `'Sign in to …'` / `'admin role required'` → `ErrorCode.UNAUTHORIZED` /
    `ErrorCode.ACCESS_DENIED` (HTTP 401/403)
  - `'Slot/Prompt <id> not found'` → `ErrorCode.RESOURCE_NOT_FOUND`
  - `'Invalid scope'` → `ErrorCode.VALIDATION_FAILED`
  - Tenant-context / ownership messages → `ErrorCode.ACCESS_DENIED`

Domain-specific semantics (e.g. "cannot share with a tenant when no tenant context")
are good candidates for new `LTNS_0612+` AI codes if the framework owners want them
i18n-translated like the others.
