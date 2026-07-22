---
name: project-ai-tool-authorization-chain
description: What actually enforces AI tool authorization in nest-server (role filter everywhere, authorize() ONLY in plan mode), plus the untrusted-framing and MCP-503 reachability facts
metadata:
  type: project
---

Verified 2026-07-22 against `src/core/modules/ai/` on `develop` (v11.32.2 working tree).

## The real enforcement chain for AI tool calls

Layers that ALWAYS run:
1. `CoreAiService.resolveRunContext` → `this.toolRegistry.forUser(currentUser)` (`core-ai.service.ts:249`) — role filter, runs BEFORE the system prompt / tool catalog is built.
2. `executeToolCall` → `availableTools.find(t => t.name === call.name)` (`core-ai.service.ts:942`) — re-check against the same filtered set; miss → `TOOL_NOT_AVAILABLE`.
3. `confirmationRequiredFor(tool, input)` — reads the `tool.destructive` / `tool.mutating` FLAGS, never the description text.
4. `SearchToolsAiTool.execute` → `registry.forUser(context.currentUser)` (`search-tools.tool.ts:43`).
5. MCP path → `toolRegistry.forUser(user)` (`core-ai-mcp.service.ts:59`).
6. The tool's own `execute()` routing through CrudService with the user's serviceOptions.

**Layer that does NOT always run — `IAiTool.authorize()`:** the only invocation is
`authorizeCall` (`core-ai.service.ts:701`), called exclusively from `runPlan`
(`core-ai.service.ts:565`). Auto mode (the DEFAULT, `ai.defaultMode: 'auto'`) and the MCP
path never call it. The interface JSDoc is honest ("used by plan mode"); several README /
INTEGRATION-CHECKLIST / `server-options.interface.ts` passages are not — they list
`authorize()` alongside the role filter as if it were unconditional.

**Why:** a tool author who puts an ownership/data-level check in `authorize()` after reading
those docs gets NO enforcement in the default mode.
**How to apply:** when a diff claims "authorization is enforced by the role filter and each
tool's `authorize()`", flag it. When reviewing a new tool, ownership checks belong inside
`execute()` (via CrudService + serviceOptions), not in `authorize()` alone.

## Prompt-catalog changes are advisory only

Anything that alters what the SYSTEM PROMPT tool catalog *says* (e.g.
`ai.deferToolSummaryChars` truncation) cannot grant access — layers 1/2/3 above are
independent of the description text. Also note `buildToolSchemas` sends the UNTRUNCATED
`t.description` in `body.tools` whenever `capabilities.nativeTools`
(`openai-compatible.provider.ts:74`), regardless of `deferToolSchemas`.

## `appendClientContext` untrusted framing — what it does and does not stop

Both `input.context` and `input.metadata` enter as `role: 'user'` with an UNTRUSTED label
prefix, `JSON.stringify`-ed and `capText`-capped at 4000 (cap trims the TAIL, so the label
cannot be stripped).

`JSON.stringify` escapes `\n` / `\r` / `\t` but **NOT U+2028 / U+2029** — those are valid raw
inside JSON strings and pass through, giving an attacker a real line-break primitive for a
fake "end of untrusted block" banner. There is also no per-request nonce delimiter.
**How to apply:** do not accept "JSON.stringify escapes newlines" as proof that a
delimiter-breakout is impossible.

## MCP 503 reachability

`CoreAiMcpController.handlePost` calls `resolveUser` and returns 401 (lines 48-52) BEFORE the
lazy `import('@modelcontextprotocol/sdk/...')`, so `mcpUnavailable()`'s 503 body is
authenticated-only. The body is a static literal; the `Error` goes only to `logger.error`.
**How to apply:** do not re-report the MCP 503 hint as unauthenticated information disclosure.

## MCP + multi-tenancy: `@Roles(S_EVERYONE)` short-circuits ALL tenant context

`CoreAiMcpController` is `@Controller('ai/mcp')` + `@Roles(RoleEnum.S_EVERYONE)`.
`CoreTenantGuard`'s S_EVERYONE branch **returns true immediately** — it only enriches
`request.tenantId`/`tenantRole` when BOTH `X-Tenant-Id` is present AND `request.user` was
already populated by the BetterAuth middleware. It never calls `resolveUserTenantIds()` and
never sets `isAdminBypass` (those are at guard lines ~347/387/599, all AFTER the early return).

Consequence chain for every MCP tool call touching a `tenantId` schema:
`RequestContext` has no `tenantId`, no `tenantIds`, no `isAdminBypass` →
`mongooseTenantPlugin.resolveTenantFilter()` hits its SAFETY NET and throws
`ForbiddenException('Tenant context required…')`. **Fail-CLOSED, not a cross-tenant leak.**

Two corollaries worth remembering:
- With `ai.mcp.oauth: true` the OAuth token is only resolved inside the CONTROLLER
  (`resolveUser` → `oauthService.loadUser`), i.e. AFTER the guard ran with `request.user`
  unset. So an OAuth MCP client can never acquire tenant context, even sending `X-Tenant-Id`.
  MCP is effectively inert against tenant-scoped domain tools in that configuration.
- The same early return applies to a global `RoleEnum.ADMIN` over MCP — no admin bypass either.

**How to apply:** when triaging "MCP has no `authorize()` and no confirmation gate", check
whether the project is multi-tenant first. If it is, the tenant plugin already blocks the
domain tools, and the residual MCP exposure is limited to NON-tenant-scoped models
(e.g. `User`, anything in `multiTenancy.excludeSchemas`) and to project-specific
`RequestContext.tenantId`-free code paths.

Related: [[project-ai-module-secret-stripping]], [[project-ai-mcp-oauth-refresh-token-binding]],
[[project-dev2653-authorize-in-auto-mode-impact]].
