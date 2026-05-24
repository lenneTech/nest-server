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

## Remaining / follow-up

- [ ] **MCP full handshake e2e** with a real Bearer token (needs auth bootstrap):
      initialize → tools/list (role-filtered) → tools/call → cross-user isolation.
      Currently covered by a unit test (logic) + an HTTP 401 e2e + app-boot.
- [ ] **MCP OAuth 2.1** dynamic client registration (hardening beyond Bearer).
- [ ] **Phase 8 — cost/budget** (optional): per-user/tenant token budget in `ai.budget`.
- [ ] **Finalization**: delete this plan file + final commit once the above are decided.
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
