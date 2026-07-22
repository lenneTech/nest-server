---
name: ai-module-false-doc-claims
description: Two claims the nest-server AI-module docs keep getting wrong — that AiTool.authorize() is a general enforcement layer, and that @modelcontextprotocol/sdk is a peer/optional dep the consumer must install
metadata:
  type: project
---

Distinct from [[ai-module-doc-coverage-gaps]] (missing coverage): these are statements the docs
**assert and that the code contradicts**. Both have now been corrected in *some* surfaces and left
standing in others, so re-verify rather than assuming a fix propagated.

## 1. `AiTool.authorize()` runs in PLAN MODE only

`CoreAiService.authorizeCall()` has exactly **one** call site: `runPlan()` (the pre-flight loop over
the planned steps). `executeToolCall()` never calls it, so **auto mode** (the default) skips it
entirely, and `CoreAiMcpService.mcpCallTool()` goes straight from `toolRegistry.forUser(user).find()`
to `tool.execute()` — no `authorize()`, and **no confirmation gate either** (the
`mutating`/`destructive` flags are simply not consulted over MCP).

**Why it matters:** a tool whose ownership/tenant check lives only in `authorize()` is unguarded for
most callers. Data-level checks belong inside `execute()`, routed through `CrudService` with
`context.serviceOptions`.

**Surfaces that still describe `authorize()` as generally enforced** (verify before grading):
`src/core/modules/ai/README.md` security callout (~:426, "Tool role-filtering, `authorize()`, … are
enforced backend-side regardless"), the `IAiTool.authorize` JSDoc in
`interfaces/ai-tool.interface.ts` ("used by plan mode **and recommended for data-level checks**"),
and the `authorize()` mentions in `models/core-ai-mode.model.ts`, `core-ai-tool-grant.model.ts`,
`core-ai-tool-policy.model.ts`, `interfaces/ai-hook.interface.ts`. The README's only `authorize()`
code example (`TransferFundsTool`) puts the ownership check *exclusively* in `authorize()`.

## 2. `@modelcontextprotocol/sdk` is a REGULAR dependency, not a peer/optional one

`package.json` → `dependencies["@modelcontextprotocol/sdk"]`. It reaches **both** consumption modes:
npm consumers transitively, and vendor-mode via the lt CLI's `convertCloneToVendored()` in
`lenneTech/cli/src/extensions/server.ts`, which merges **every** upstream dependency into the
project's own `package.json` and additionally backfills bare specifiers found in dynamic `import()`
calls. The lazy `import()` in `CoreAiMcpController` is a *startup-cost* optimization, not an
optional-dependency contract — a failure there is almost always a resolution problem.

**Surfaces that still tell consumers to install it:** `src/core/modules/ai/INTEGRATION-CHECKLIST.md`
(`pnpm add @modelcontextprotocol/sdk` + "peer-style optional dependency"),
`src/core/modules/ai/README.md`, and `migration-guides/11.25.x-to-11.26.0.md` (its troubleshooting
row quotes a 503 message string that no longer exists in the code).

## How to apply

Grep for `authorize(` and `modelcontextprotocol` across README / INTEGRATION-CHECKLIST /
`.claude/rules/configurable-features.md` / `migration-guides/` / module JSDoc **every** AI-module
review. A correction landing in the code comments or an error message is not evidence the
user-facing docs were updated — in this repo they usually were not.

**Generalization worth carrying:** when a diff adds a *pattern* doc with an "Applied to" table
(e.g. the "Numeric Sentinel Pattern" in `.claude/rules/configurable-features.md`), verify every
listed example against code. `multiTenancy.cacheTtlMs` was listed as a `0`-sentinel example but
defaults to `30000`, treats `undefined` as *enabled*, and does not degrade cleanly on `NaN` — a
pattern generalized from one real example is worse than no pattern doc.
