---
name: ai-module-false-doc-claims
description: Two claims the nest-server AI-module docs historically got wrong — AiTool.authorize() as a general enforcement layer, and @modelcontextprotocol/sdk as a peer/optional dep. Both now corrected in the live surfaces as of 11.32.2; keep the technical facts, verify new surfaces stay consistent.
metadata:
  type: project
---

Distinct from [[ai-module-doc-coverage-gaps]] (missing coverage): these were statements the docs
**asserted and the code contradicted**. As of **11.32.2 both are corrected in the primary/live
surfaces** (verified 2026-07-24) — the technical facts below are still load-bearing, but do NOT
re-flag the surfaces listed as "now consistent" without re-checking; they read correctly.

## 1. `AiTool.authorize()` runs in PLAN MODE only

`CoreAiService.authorizeCall()` has exactly **one** call site: `runPlan()` (the pre-flight loop over
the planned steps). `executeToolCall()` never calls it, so **auto mode** (the default) skips it
entirely, and `CoreAiMcpService.mcpCallTool()` goes straight from `toolRegistry.forUser(user).find()`
to `tool.execute()` — no `authorize()`, and **no confirmation gate either** (the
`mutating`/`destructive` flags are simply not consulted over MCP).

**Why it still matters:** a tool whose ownership/tenant check lives only in `authorize()` is unguarded
for most callers. Data-level checks belong inside `execute()`, routed through `CrudService` with
`context.serviceOptions`.

**Now consistent (do not re-flag):** `IAiTool.authorize` JSDoc (`interfaces/ai-tool.interface.ts:97`,
"Runs in PLAN MODE ONLY"), the `destructive`/`mutating` JSDoc in the same file (adds the explicit
"No confirmation gate over MCP" caveat at the flag-definition site — landed in the 11.32.3 working
tree), README security callout (~:436-440, qualifies `authorize()` as plan-mode-only) + README
:502-513, INTEGRATION-CHECKLIST (:182, :201 "No confirmation gate over MCP"),
`.claude/rules/configurable-features.md` AI row, and **migration guide `11.32.1-to-11.32.2.md` §5**
(documents the correction verbatim, incl. the MCP-no-gate note).

**Not re-verified this pass (may still describe authorize() loosely):** the `authorize()` mentions in
`models/core-ai-mode.model.ts`, `core-ai-tool-grant.model.ts`, `core-ai-tool-policy.model.ts`,
`interfaces/ai-hook.interface.ts`, and the README `TransferFundsTool` example. Check these before
asserting the correction is total.

## 2. `@modelcontextprotocol/sdk` is a REGULAR dependency, not a peer/optional one

`package.json` → `dependencies["@modelcontextprotocol/sdk"]`. It reaches **both** consumption modes:
npm consumers transitively, and vendor-mode via the lt CLI's `convertCloneToVendored()`. The lazy
`import()` in `CoreAiMcpController` is a *startup-cost* optimization, not an optional-dependency
contract — a failure there is a resolution problem (now surfaced as `#LTNS_0901`).

**Now corrected (do not re-flag):** `INTEGRATION-CHECKLIST.md:191` ("No install step needed… regular
dependency"), `README.md:549-553`, and migration guide `11.32.1-to-11.32.2.md` §6.

**Still historical:** `migration-guides/11.25.x-to-11.26.0.md` likely retains the old "peer-style
optional dependency" wording — that is a frozen release-notes artifact, not a live doc; leave it.

## How to apply

Grep for `authorize(` and `modelcontextprotocol` across README / INTEGRATION-CHECKLIST /
`.claude/rules/configurable-features.md` / current migration guide / module JSDoc on **every**
AI-module review. The point is no longer "hunt for standing contradictions" (the primary surfaces are
fixed) but "confirm a NEW surface didn't reintroduce the old framing." A correction in a code comment
or error message is still not proof the user-facing docs match — but in this area they now do.

**Generalization worth carrying:** when a diff adds a *pattern* doc with an "Applied to" table
(e.g. the "Numeric Sentinel Pattern"), verify every listed example against code. `multiTenancy.cacheTtlMs`
was listed as a `0`-sentinel example but defaults to `30000`, treats `undefined` as *enabled*, and does
not degrade cleanly on `NaN` — a pattern generalized from one wrong example is worse than none.
