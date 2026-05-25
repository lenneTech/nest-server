# AI Module — Implementation Plan (temporary)

> **DELETE THIS FILE when all backend phases are done.** It exists only to allow
> cross-session continuation. Branch: `feature/ai-module`.

## Goal

A reusable, extensible AI-assistant layer in `@lenne.tech/nest-server`. Users prompt
from the frontend; the API enriches the prompt, talks to a configurable LLM (local
or external, mittwald OpenAI-compatible), lets the model call **backend tools**
(MCP-style) to read/manipulate data with the **caller's permissions**, and returns a
structured answer. LLM connections + API keys are **database-backed** (admin CRUD,
encrypted). Also exposable as a real **MCP server** for external clients.

Frontend is built LAST, in separate repos: `nuxt-base-starter` + `nuxt-extensions`.

## Architecture decision — internal orchestrator vs. external CLI (Claude Code / OpenCode)

**Decision: keep the INTERNAL orchestrator as the primary, user-facing runtime.
Use MCP only to OPTIONALLY expose the same tools to external CLIs.** Do NOT delegate
the user-facing execution to an external CLI process.

Rationale, weighed against the priorities (esp. #1 secure execution):

- Claude Code and OpenCode are **single-user, per-developer CLIs** with an
  **interactive approval** model (OpenCode's "Plan agent" is read-only and asks
  before bash/edits). They are not multi-tenant servers and their permission model
  is "a human approves at the terminal" — not "enforce *this* user's exact
  rights per request across many concurrent tenants".
- **Goal #1 (secure execution respecting all rules):** our backend MUST be the
  thing that executes tools, because permission/`@Restricted`/`securityCheck`/tenant
  enforcement lives in `CrudService` + `ServiceOptions`. Running an external CLI per
  request would move the trust boundary into a process whose per-request, per-user
  scoping we'd have to re-prove every time (token mapping, process isolation,
  concurrency). In-process execution with the exact user's `ServiceOptions` is the
  strongest guarantee.
- **Goal #2 / #5 (no unwanted/partial actions, pre-flight detection):** we need a
  hook to *plan → validate ALL permissions → execute atomically*. An external CLI
  doesn't expose that; our orchestrator does (plan mode below).
- **Prompt-injection surface:** an external coding CLI carries broad capabilities
  (shell, fs). End users must only ever reach *registered* tools — in-process.
- **Ops:** a direct LLM API call per request beats spawning/managing CLI processes
  per prompt in a multi-tenant API.

We **borrow the concepts** from these CLIs (plan mode, approval/permission gating,
MCP) and implement them in-process. The MCP server (Phase 7) remains the bridge for
the complementary case: a developer/admin driving the system's tools from Claude
Code/OpenCode — with the *same* in-backend permission enforcement.

## Conventions

- TDD for every phase (unit in `tests/unit/ai*.spec.ts`, e2e in `tests/ai*.e2e-spec.ts`).
- Commit after each green phase; push if possible.
- Run `pnpm run lint:fix`, `pnpm run format`, `pnpm run build` before each commit.
- Keep `src/core/modules/ai/**` self-contained (vendor-mode: no imports outside `src/core/`).
- Fixed package versions only. New runtime deps → also note for CLI `vendor-runtime-deps.json`.
- Update `README.md`, `INTEGRATION-CHECKLIST.md`, `.claude/rules/configurable-features.md`, `FRAMEWORK-API.md` (auto).

## DONE (committed)

- [x] **Phase 0 — Foundation**: providers (`ILlmProvider`, `OpenAiCompatibleProvider`, `LlmProviderFactory`), tool registry (`AiToolRegistry`, `IAiTool`, `AiTool`), DB connections (`CoreAiConnection` + `CoreAiConnectionService` + `AiCryptoService`, AES-256-GCM, never returns key), orchestrator (`CoreAiService`, emulated tool-calling agent loop, rate-limit, audit hook), models/inputs, GraphQL resolver + REST controller, `CoreAiModule.forRoot` (autoRegister + overrides), `ai` config in `IServerOptions`, `CoreModule` wiring, exports, example User tools (`src/server/modules/ai/`), docs, tests (unit 7/7 + e2e 6/6, full suite 85/85).

## DONE — Backend phases (committed)

- [x] **Phase 3 — Audit persistence** (`CoreAiInteraction` + service + `ai.audit` + admin endpoints). Commit `ea4afa0` (pushed).
- [x] **Phase 4 — Multi-turn conversations** (`CoreAiConversation` + `CoreAiMessage` + `$push` append + history load + owner-scoped CRUD). Commit `78cb0f1` (local).
- [x] **Phase 5 — SSE streaming** (`promptStream` action/token/final + `POST /ai/stream`). Commit `41f5444` (local).
- [x] **Phase 6 — Destructive-action confirmation** (`IAiTool.destructive`, `input.confirm`, `requiresConfirmation`/`pendingActions`, `delete_user` example). Commit `b98d248` (local).
- [x] **Phase 7 — MCP server** (`CoreAiMcpService` role-filtered list/call + `CoreAiMcpController` Streamable HTTP + `ai.mcp`, lazy `@modelcontextprotocol/sdk`, Bearer auth via `@CurrentUser`). Unit + e2e (401) green.

> **Push note:** commits from Phase 4 onward are LOCAL only — the SSH key dropped
> from the agent mid-session (`Permission denied (publickey)`). Run `git push` once
> the key is available. Phases 0 + 3 are already on `origin/feature/ai-module`.

## TODO — remaining + new phases (priority order matches the goals)

Goals (priority): (1) secure execution respecting all rules, (2) protection against
unwanted actions (esp. bulk data mutation), (3) best automation, (4) best LLM
information supply, (5) detect missing rights BEFORE the first step → abort early.

### Phase 9 — Plan mode: pre-flight permission validation + atomic multi-step  [Goals 1,2,3,5]
- [ ] `input.mode?: 'auto' | 'plan'` (default configurable via `ai.defaultMode`).
- [ ] `IAiTool.authorize?(args, context): Promise<boolean | { allowed; reason? }>` — a
      NON-mutating permission/dry-run check. Default falls back to registry role check.
- [ ] `IAiTool.mutating?: boolean` (create/update/delete). `destructive` stays the stronger flag.
- [ ] Plan flow: one LLM call returns the full ordered plan `{plan:[{name,arguments}],summary}`
      → **pre-flight `authorize()` ALL** planned actions → if ANY denied: execute NOTHING,
      return a translated error (de/en) naming the offending action(s) (`denied`,
      `deniedActions`) → else execute sequentially, feeding results forward.
- [ ] `CoreAiResponse`: add `plan?`, `denied?`, `deniedActions?`.
- [ ] Tests: all-permitted plan executes; one-forbidden plan executes nothing + translated error.

### Phase 10 — Confirmation policy for mutating actions  [Goals 1,2]
- [ ] `ai.confirmation.mutating: { default: boolean (admin default), enforced: boolean }`.
- [ ] `input.requireConfirmation?: boolean` — client override, honored only when NOT enforced.
- [ ] Effective = `enforced ? true : (input.requireConfirmation ?? default)`. A `mutating`
      tool halts (requiresConfirmation/pendingActions) when effective && !`input.confirm`.
      `destructive` always requires confirm (unifies Phase 6).
- [ ] Tests: admin default on/off, client override honored, enforced cannot be overridden.

### Phase 11 — Client metadata  [Goal 4]
- [ ] `input.metadata?: JSON` (current URL, navigation steps, console logs, …).
- [ ] PromptBuilder injects a "Client context" section (size-capped, sanitized).
- [ ] Test: metadata reaches the system/context messages.

### Phase 12 — Automatic prompt enrichment  [Goal 4]
- [ ] PromptBuilder adds: (a) "Your permissions" (user roles + accessible tool names),
      (b) API/tool description (already via catalog — make explicit), (c) optional system
      documentation via `ai.documentation` (string) or overridable `getDocumentation()` hook.
- [ ] Test: enriched system prompt contains the user's roles + documentation.

### Phase 8 — Cost/budget  [Goal 2]
- [ ] `ai.budget?: { maxTokensPerDay?, maxPromptsPerDay?, perTenant? }`; track usage
      (reuse `aiInteractions`); enforce in orchestrator before a run; expose remaining.
- [ ] Test: exceeding the budget blocks a run with a translated message.

### Phase 7b — MCP full handshake e2e + OAuth
- [ ] **MCP full handshake e2e** with a real Bearer token (auth bootstrap):
      initialize → tools/list (role-filtered) → tools/call → cross-user isolation.
- [ ] **MCP OAuth 2.1** dynamic client registration (`mcpAuthRouter`, OAuth provider,
      MongoDB TTL collections, mount in main.ts) — hardening beyond Bearer.

### Finalization
- [ ] Update README / INTEGRATION-CHECKLIST / configurable-features / FRAMEWORK-API.
- [ ] Full `pnpm test` green. **Delete this plan file** + final commit.
- [ ] **Frontend** (separate repos `nuxt-base-starter` + `nuxt-extensions`) — NOT here.

## Superseded detail (original phase specs, kept for reference)

### Phase 3 — Audit persistence (`AiInteraction`)
- [ ] `CoreAiInteraction` persistence model (`aiInteractions`): userId, connectionId, prompt, responseText, actions (name/success), iterations, usage, createdAt. `@Restricted(ADMIN)`; user may read own (securityCheck S_SELF on userId).
- [ ] `CoreAiInteractionService extends CrudService`.
- [ ] Override `CoreAiService.audit()` to persist when `ai.audit` enabled (presence/boolean). Use direct `Model.create` (system-internal).
- [ ] Admin query endpoints (`findAiInteractions`, `getAiInteraction`) in resolver/controller.
- [ ] Config: `ai.audit?: boolean` (default false). Wire model in `CoreAiModule`.
- [ ] Tests: prompt creates an interaction record; non-admin cannot list others'.

### Phase 4 — Multi-turn conversations (`AiConversation`)
- [ ] `CoreAiConversation` model (`aiConversations`): userId, title, messages[] (role/content/createdAt), connectionId. Owner-scoped (S_CREATOR/S_SELF).
- [ ] `CoreAiConversationService extends CrudService` (use `pushToArray` for messages — NEVER pass subdoc arrays through update()).
- [ ] `CoreAiService.prompt`: if `input.conversationId`, load prior messages into the LLM context; append the new user + assistant turns after the run.
- [ ] Endpoints: create/list/get/delete own conversations.
- [ ] Tests: 2-turn conversation keeps context; messages appended via pushToArray; ownership enforced.

### Phase 5 — Streaming (SSE)
- [ ] Optional `ILlmProvider.stream()` (async iterable of text chunks); implement for OpenAI-compatible (`stream: true`, parse SSE).
- [ ] `CoreAiService.promptStream()`: run the tool loop non-streamed (need full JSON to parse tool calls), then stream the FINAL answer tokens; emit `action` events + `token` events + `done`.
- [ ] REST SSE endpoint `POST /ai/stream`. (GraphQL subscription `aiStream` optional.)
- [ ] Tests: SSE endpoint streams tokens + a final done event (supertest, `Accept: text/event-stream`).

### Phase 6 — Destructive-action confirmation
- [ ] `IAiTool.destructive?: boolean`. When a destructive tool is called without `input.confirm`/`confirmedActions`, the orchestrator returns a `requiresConfirmation` response listing the pending action instead of executing.
- [ ] `CoreAiPromptInput.confirm?: boolean` (or `confirmedTools?: string[]`).
- [ ] `CoreAiResponse.requiresConfirmation?` + `pendingActions?`.
- [ ] Tests: destructive tool blocked until confirmed; non-destructive unaffected.

### Phase 7 — MCP server (A+B) — the explicit "B" ask
- [ ] Add `@modelcontextprotocol/sdk` (fixed version) as optionalDependency + devDependency; lazy `import()` so core stays lean. Note for CLI `vendor-runtime-deps.json`.
- [ ] `CoreAiMcpController` at `ai.mcp.path` (default `/ai/mcp`), `@Roles(S_EVERYONE)`, manual bearer-token auth → resolve user (reuse `BetterAuthTokenService` / JWT) → role-filtered tools from `AiToolRegistry`.
- [ ] `CoreAiMcpService`: McpServer-per-session factory, registers `registry.forUser(user)` tools (execute with user serviceOptions), Streamable HTTP transport, session map with TTL eviction.
- [ ] Config `ai.mcp?: boolean | { path?, enabled? }` (default disabled). Wire in `CoreAiModule` (only when enabled).
- [ ] Tests: 401 without token; init handshake; tools/list reflects role filter; tools/call executes; cross-user isolation. (supertest SSE per `mcp-integration` guide.)
- [ ] Decide auth depth: start with Bearer (existing tokens); full OAuth 2.1 dynamic registration is a later hardening step (document).

### Phase 8 — Cost/budget (optional, if time)
- [ ] Per-user/tenant token budget in `ai.budget`; enforce in orchestrator; expose usage.

## Finalization
- [ ] Update README + INTEGRATION-CHECKLIST + configurable-features for all new features.
- [ ] `pnpm run build` (regen FRAMEWORK-API), full `pnpm test` green.
- [ ] **Delete this file** + commit.
- [ ] Frontend (separate repos) — NOT in this branch.
