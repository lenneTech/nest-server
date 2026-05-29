# AI Module

An extensible AI-assistant layer for `@lenne.tech/nest-server`. Users send prompts
from the frontend; the API optimizes/enriches the prompt, talks to a configurable
LLM (local or external), and lets the model call **backend tools** to read and
manipulate data — MCP-style — before returning a structured answer.

## Highlights

- **Database-backed LLM connections** (`CoreAiConnection`) — endpoints, models and
  **encrypted API keys** are managed at runtime (admin CRUD; later a frontend
  settings area), not in `config.env.ts`.
- **Vendor-agnostic provider abstraction** (`ILlmProvider`) — swap local runtimes
  and hosted backends via config. Ships with a dependency-free `fetch`-based
  provider for the OpenAI-compatible chat API (a de-facto standard, not a vendor).
- **Capability gradations** — each backend declares its `capabilities`
  (`nativeTools`, `jsonResponse`, `systemPrompt`); the orchestrator compensates
  across the whole spectrum (full native → none = emulated). No backend is special-cased.
- **Tool registry** (`AiToolRegistry`) — a global registry of backend capabilities
  the LLM may call. Tools self-register from any module and are filtered by the
  caller's roles.
- **Emulated tool calling** — for backends without native function calling, the
  tool catalog is injected into the system prompt and tool calls are parsed from
  the model's JSON output. Native tool calling is used transparently when supported.
- **Security first** — tools execute through `CrudService` with the caller's
  permissions, so `@Restricted`, `securityCheck()` and tenant context all apply.
  The LLM can never escalate beyond what the user is allowed to do.

## Architecture

```
Frontend prompt
   │  aiPrompt (GraphQL) / POST /ai/prompt (REST)   @Roles(S_USER)
   ▼
CoreAiService (orchestrator / agent loop)
   │  1. rate-limit → resolve connection (DB) → build provider
   │  2. filter tools by the user's roles
   │  3. loop: LLM call → execute tool calls (CrudService, user perms) → feed back
   ▼
ILlmProvider ── OpenAiCompatibleProvider (any OpenAI-compatible endpoint) / custom providers
   ▼
CoreAiResponse { text, actions[], data, usage, iterations }
```

## Configuration

Presence of the `ai` block enables the module (omit to disable, `{ enabled: false }`
to keep config but disable). See `IAi` in `server-options.interface.ts`.

```typescript
// config.env.ts
ai: {
  encryptionSecret: process.env.NSC__AI__ENCRYPTION_SECRET, // 32+ chars in prod
  maxIterations: 5,
  rateLimit: { max: 20, windowSeconds: 60 },
  systemPrompt: 'You are a helpful assistant for …',
  contextWindow: 8192,            // fallback when a connection has no detected window
  maxToolResultChars: 12000,      // cap a tool-results payload fed back to the model
  promptLearning: { autoApply: false }, // governed self-improvement (admin approves hints)
  // Optional one-time seed of a default connection (DB is the source of truth):
  defaultConnection: {
    name: 'Default LLM',
    baseUrl: process.env.AI_BASE_URL,    // any OpenAI-compatible endpoint
    model: process.env.AI_MODEL,
    apiKeyEnv: 'AI_API_KEY',             // prefer env over an inline apiKey
    supportsNativeTools: false,          // set per the backend's actual support
    supportsJsonResponse: false,
  },
}
```

### Capabilities (vendor-agnostic)

The module makes no assumptions about a specific vendor. Each connection declares
what its backend supports via `supportsNativeTools` and `supportsJsonResponse`:

- Both **true** → native function calling + JSON mode are used directly.
- **false** → the module compensates: tool calling is emulated via the system
  prompt and JSON is requested in-prompt and parsed defensively.
- **undefined** (omitted) → **auto-detected** by probing the endpoint (see below).

This covers the full spectrum — from feature-rich hosted models with native tools
to minimal local runtimes or gateways with no native tool/JSON support — without
naming or special-casing any provider. Add entirely different backends/protocols by
registering a builder on `LlmProviderFactory`.

> **Emulated-mode limitation (weak models):** In emulated tool calling the model
> is _asked_ (via the system prompt) to emit a `tool_calls` request before acting.
> Weaker models sometimes ignore this and reply with a natural-language "done"
> message **without** actually emitting the tool call. This is a _false positive_
> (the tool never ran — no `actions` are recorded and no confirmation gate is
> shown), **not** a security issue: a tool can only execute by going through the
> backend's `executeToolCall()` + confirmation gate, so the model can never trigger
> a real (or unconfirmed) side-effect by merely claiming success. For workflows
> that depend on reliable, action-heavy tool use, prefer a connection whose backend
> supports **native** tool calling (`supportsNativeTools: true`).

#### Capability auto-detection

Leave `supportsJsonResponse` / `supportsNativeTools` **undefined** to let the module
detect them automatically (explicit `true`/`false` is always authoritative and is
never probed). Detection runs in two complementary ways:

- **Eager (on create):** when a connection is created with an undefined flag, the
  endpoint is probed once and the result is persisted. Best-effort — a probe failure
  never blocks the create.
- **Lazy (on first prompt):** if a flag is still undefined at prompt time (e.g. the
  eager probe was not possible, or the connection was seeded), the orchestrator probes
  once, persists, and uses the result. Until then the safe emulated baseline applies.
- **On demand:** admins can re-probe via `detectAiConnectionCapabilities` /
  `POST /ai/connections/:id/detect-capabilities` (e.g. after changing `baseUrl`/`model`).

The probe is provider-agnostic best effort: `response_format: json_object` is sent
(2xx → JSON supported); a trivial tool with `tool_choice: 'required'` is sent (2xx
returning a `tool_calls` result → native tools supported; a `4xx` or a silent ignore
→ unsupported). Override `OpenAiCompatibleProvider.detectCapabilities()` for custom
backends, or implement the optional `ILlmProvider.detectCapabilities()` in your own provider.

### Backend examples (external, local, CLI)

The same module connects to all of these — the only differences are the connection's
`providerType`, `baseUrl`/`model` and which provider builder is registered:

| Backend                 | How to connect                                                                                                                                                                                                                                               | Tools                                   |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------- |
| **External** (hosted)   | Built-in `openai-compatible` provider. `baseUrl` = the vendor's OpenAI-compatible endpoint, `apiKey` set.                                                                                                                                                    | native or emulated (auto-detected)      |
| **Local** (e.g. Ollama) | Built-in `openai-compatible` provider. `baseUrl: 'http://localhost:11434/v1'`, any `apiKey` (Ollama ignores it). A tool-capable model (e.g. `qwen2.5`) supports native tools — set `supportsNativeTools: true` explicitly if the auto-probe is conservative. | native or emulated                      |
| **Claude Code CLI**     | Opt-in `ClaudeCliProvider` (shells out to the local `claude` CLI). `providerType: 'claude-cli'`, `model` = a Claude alias (`opus`/`sonnet`/`haiku`).                                                                                                         | emulated (the CLI is run **tool-free**) |

`openai-compatible` is registered out of the box. For the CLI, register the provider
once (e.g. in a consumer module's `onModuleInit`) — it is **not** auto-registered:

```typescript
import { ClaudeCliProvider, LlmProviderFactory } from '@lenne.tech/nest-server';

@Module({ providers: [] })
export class AiProvidersModule implements OnModuleInit {
  constructor(private readonly factory: LlmProviderFactory) {}
  onModuleInit() {
    this.factory.registerBuilder('claude-cli', (conn) => new ClaudeCliProvider(conn));
  }
}
```

Then create a connection with `providerType: 'claude-cli'`. The provider invokes
`claude -p --output-format json --tools "" --system-prompt <orchestrator-prompt>`:
Claude Code runs **with all of its own tools disabled**, so it cannot read files or
run shell commands — it is a pure text generator and the orchestrator emulates tool
calling and executes tools itself through `CrudService` with the caller's permissions.
`spawn` uses an argument array (no shell), the conversation is piped via stdin, and
the child runs in a temp dir so no `CLAUDE.md`/settings leak into the context. See
`ClaudeCliProvider` for the full security model and the optional `ai.claudeCli` config.

## Connections (DB configuration)

Connections live in the `aiConnections` collection and are managed by admins via
GraphQL (`findAiConnections`, `getAiConnection`, `createAiConnection`,
`updateAiConnection`, `deleteAiConnection`) or REST (`/ai/connections*`).

- The API key is **AES-256-GCM encrypted at rest** (`AiCryptoService`) and **never
  returned** — responses expose only `hasApiKey: boolean`.
- Patch semantics for `apiKey`: a value sets it, `''` clears it, omitting it leaves
  it untouched.
- `resolve(id?)` returns a runtime `ResolvedAiConnection` (with the decrypted key)
  for the orchestrator — system-internal, never sent to clients.
- One connection can be `isDefault`; the service keeps it unique.
- Each connection declares its capabilities (`supportsJsonResponse`,
  `supportsNativeTools`) so the orchestrator compensates for backends without
  native tool calling / JSON output (emulated tool calling via the system prompt).

## Connection selection (resolution chain)

When several connections exist the system picks one via a **prioritized, fully
overridable chain** (`CoreAiConnectionResolverService`). No connections at all →
AI handling is effectively disabled (the orchestrator returns a translated
"unavailable" response). Exactly one connection → it is the implicit default.

Availability can be **restricted per tenant** (`tenantIds` on the connection; empty
= available to all). A connection's availability is the gate for the "soft" layers;
the mandatory ("hard") layers win regardless.

Resolution order (ascending priority — a later layer overrides an earlier one):

| #   | Layer                     | Source                                       | Type |
| --- | ------------------------- | -------------------------------------------- | ---- |
| 1   | Global default            | connection `isDefault`                       | soft |
| 2   | Tenant default            | preference `scope:'tenant'`, not enforced    | soft |
| 3   | User default              | preference `scope:'user'`                    | soft |
| 4   | Client selection          | `input.connectionId`                         | soft |
| 5   | Tenant-enforced           | preference `scope:'tenant'`, `enforced:true` | hard |
| 6   | Admin-enforced global     | connection `enforced`                        | hard |
| 7   | Admin-enforced per tenant | connection `enforcedTenantIds`               | hard |
| 8   | Code override             | `serviceOptions._aiConnectionId`             | hard |

- **Tenant/user defaults & tenant-enforced** live in the `aiConnectionPreferences`
  collection (`CoreAiConnectionPreferenceService`), keyed uniquely by `(scope, refId)`.
- **Self-service:** users set their own default via `aiSetUserConnection` /
  `POST /ai/connections/select` (validated against availability). They list what they
  may use via `aiAvailableConnections` / `GET /ai/connections/available` — a
  non-sensitive list flagging the currently `selected` one and whether the choice is
  `locked` by a mandatory layer.
- **Admins** manage tenant/user preferences via `setAiConnectionPreference` /
  `findAiConnectionPreferences` / `deleteAiConnectionPreference` (REST under
  `/ai/connections/preferences`).
- **Code override** (`serviceOptions._aiConnectionId`) is the deliberate, trusted
  top layer. Projects that need admin/tenant mandates to be absolute can reorder the
  chain — every layer is an overridable `protected` method and `resolutionLayers()`
  can be replaced wholesale (pass a subclass via `ai: { connectionResolver }`).
- **Robustness:** a selection that points to a deleted/disabled connection (e.g. an
  orphaned enforced preference or a stale code override) is dropped with a `warn` log
  and the chain degrades to the fallback instead of throwing mid-prompt. Admin
  `setAiConnectionPreference` validates that the connection exists before saving, and
  deleting a connection automatically removes preferences pointing to it.

## Tools

> **⚠️ Read this before integrating the AI module into a project — also for AI agents
> assisting with that integration.**
>
> The AI module **does NOT have any automatic access to your domain models** (users,
> orders, files, …). This is intentional: the LLM is treated as untrusted, so it can
> only call tools that a developer has **explicitly registered**. A freshly added AI
> module on a new project will answer "I cannot find a tool to do that" for every
> domain question — that's correct behaviour, **not** a misconfiguration.
>
> **What a project must do** for the assistant to be useful:
>
> 1. For every domain operation that should be reachable from chat (read a list,
>    fetch a record, create / update / delete something, kick off a workflow), write
>    a small `AiTool` subclass that delegates to your existing `*Service` (NEVER
>    directly to the Mongoose Model — see the security contract below).
> 2. Group them in a project module (e.g. `AiToolsModule`) and import it from
>    `ServerModule.imports`.
> 3. Mark mutating tools `mutating: true` (confirmation prompt) and irreversible
>    ones `destructive: true` (always confirmed regardless of admin override).
>
> The framework ships reference tools in
> `node_modules/@lenne.tech/nest-server/src/server/modules/ai/tools/` —
> **`find-users.tool.ts`**, **`get-user.tool.ts`**, **`delete-user.tool.ts`**,
> **`update-user-job-title.tool.ts`** — that demonstrate read / restricted-read /
> destructive-write / mutating-write patterns. They are **NOT auto-registered in
> consumer projects** (they live in the framework's own test fixtures and aren't
> exported); copy them to `<api>/src/server/modules/ai/tools/`, replace the relative
> `'../../../../core/...'` imports with `'@lenne.tech/nest-server'`, and register
> them via a project `AiToolsModule`.
>
> **Security contract:** every tool MUST go through a service that uses `CrudService`
>
> - `serviceOptions.currentUser`, so `@Restricted` field filtering, `securityCheck()`
>   and tenant context still apply. Direct `Model.find()` etc. bypasses the framework's
>   permission layer — see `.claude/rules/security-rules.md` in this repo for the
>   complete rules.

A tool implements `IAiTool` (or extends the `AiTool` base class) and self-registers
in the global `AiToolRegistry`:

```typescript
@Injectable()
export class FindUsersAiTool extends AiTool {
  readonly name = 'find_users';
  readonly description = 'Search users by email or username. Admin only.';
  readonly parameters = { properties: { search: { type: 'string' } }, type: 'object' };
  readonly roles = [RoleEnum.ADMIN];

  constructor(
    registry: AiToolRegistry,
    private readonly userService: UserService,
  ) {
    super(registry);
  }

  async execute(args, context) {
    // Routes through CrudService with the caller's serviceOptions → permissions apply.
    const users = await this.userService.find(
      {
        filterQuery: {
          /* … */
        },
      },
      context.serviceOptions,
    );
    return { data: users, success: true };
  }
}
```

Declare the tool as a provider in any module (see `src/server/modules/ai/` for the
reference implementation). Registering a tool with an existing name overrides it —
the supported way to customize a core tool.

**Security rule:** always route data access through `CrudService` using
`context.serviceOptions`. Returning raw `.lean()`/aggregate data bypasses
`@Restricted` field filtering and may leak data into the LLM context.

## Extending / overriding

Every collaborator can be replaced with a project subclass via
`CoreModule.forRoot(envConfig, { ai: { … } })`:

| Override              | Base class                                                        |
| --------------------- | ----------------------------------------------------------------- |
| `service`             | `CoreAiService` (orchestrator, prompt loop, rate-limit, audit)    |
| `promptBuilder`       | `CoreAiPromptBuilderService` (system prompt, RAG)                 |
| `connectionService`   | `CoreAiConnectionService`                                         |
| `connectionResolver`  | `CoreAiConnectionResolverService` (resolution chain)              |
| `preferenceService`   | `CoreAiConnectionPreferenceService` (tenant/user preferences)     |
| `budgetService`       | `CoreAiBudgetService` (token/prompt budgets + usage)              |
| `conversationService` | `CoreAiConversationService` (multi-turn history)                  |
| `interactionService`  | `CoreAiInteractionService` (audit records)                        |
| `slotService`         | `CoreAiSlotService` (admin slots — system-prompt building blocks) |
| `promptService`       | `CoreAiPromptService` (user re-usable prompts / "Vorlagen")       |
| `promptHintService`   | `CoreAiPromptHintService` (governed learning loop)                |
| `placeholderRegistry` | `CoreAiPlaceholderRegistry` (runtime `{{placeholder}}` registry)  |
| `resolver`            | `CoreAiResolver` (re-declare GraphQL decorators when overriding)  |
| `controller`          | `CoreAiController`                                                |

Add a new LLM backend by registering a builder on `LlmProviderFactory`:

```typescript
factory.registerBuilder('my-provider', (conn) => new MyProvider(conn));
```

## Conversations, audit & streaming

- **Multi-turn conversations** (`aiConversations`, owner-scoped): pass
  `conversationId` to `aiPrompt` to load prior turns and append the new ones.
  Manage via `createAiConversation` / `findAiConversations` / `getAiConversation`
  / `deleteAiConversation`.
- **Audit** (`ai.audit: true`): every run is persisted to `aiInteractions`
  (admin-readable via `findAiInteractions` / `getAiInteraction`).
- **Streaming**: `POST /ai/stream` returns Server-Sent Events (`action`, `token`,
  `final`, `error`). `CoreAiService.promptStream()` powers it.

## Plan mode (pre-flight permission validation, all-or-nothing)

Send `input.mode: 'plan'` (or set `ai.defaultMode: 'plan'`). The model first
produces a complete plan; the backend then **authorizes every step up front**
(registry role filter + each tool's optional `authorize()` data-level check). If
ANY step is not permitted, **nothing executes** and a translated (de/en) error with
`deniedActions` is returned. Otherwise all steps run in order, feeding results
forward. This is the strongest fit for "do several connected actions automatically,
but only if the user may perform all of them".

```typescript
@Injectable()
export class TransferFundsTool extends AiTool {
  readonly name = 'transfer_funds';
  readonly mutating = true; // governed by the confirmation policy
  readonly destructive = true; // always requires confirmation
  // Pre-flight check WITHOUT mutating — decides if the user may run this:
  async authorize(args, context) {
    const account = await this.accountService.get(args.fromId, context.serviceOptions).catch(() => null);
    return { allowed: !!account, reason: account ? undefined : 'No access to source account' };
  }
  async execute(args, context) {
    /* … */
  }
}
```

## Confirmation for changes

- `destructive` tools always require confirmation.
- `mutating` tools follow `ai.confirmation.mutating: { default, enforced }`: the admin
  default can be overridden per request via `input.requireConfirmation` — unless the
  admin set `enforced: true`.
- When confirmation is needed the response has `requiresConfirmation: true` +
  `pendingActions`; re-send the prompt with `confirm: true` to proceed.

## Client metadata & prompt enrichment

- `input.metadata` (current URL, navigation steps, console logs, …) is injected as a
  clearly-delimited, size-capped, **untrusted** context block.
- The system prompt is enriched with the user's roles + available tools and optional
  `ai.documentation` (override `CoreAiPromptBuilderService.getDocumentation()` for RAG).

## Self-optimizing prompts (editable templates + governed learning)

The system prompt is assembled from **keyed fragments** by `CoreAiPromptBuilderService`,
so non-technical users only enter their domain prompt while the backend keeps the model
optimally informed (capabilities, available tools + catalog, the user's roles, an
anti-hallucination + output contract, and the emulated tool protocol when needed). Every
prompt text is **transparent and editable** — there are no hard-coded, inaccessible
prompt strings.

**Editable slots (`aiSlots`, admin CRUD, tenant-scoped).** The builder ships sensible
built-in defaults for every slot (`getSystemDefaultSlots()`), so the module works with
zero rows. A row here **overrides** the default for its `key` (logical slot, e.g. `base`,
`permissions`, `anti_hallucination`, `output_contract`, `tool_protocol_emulated`),
optionally scoped by `locale` and `capability` (`all` / `native` / `emulated`). When
multi-tenancy is active, overrides apply only to the admin's tenant; without multi-tenancy
they are effectively system-wide. `create()` is idempotent on `(tenantId, key)` — a second
"override" of the same system slot UPDATES the existing row instead of inserting a
duplicate. Content may use `{{placeholders}}` (resolved via the placeholder registry —
see below) rendered at build time. Manage via `createAiSlot` / `findAiSlots` / … (GraphQL)
or `/ai/slots` (REST), with admin-friendly extras: `GET /ai/slots/effective` returns the
combined view (framework defaults + tenant overrides + custom slots with `isSystem` /
`isOverride` flags) and `POST /ai/slots/:id/reset` deletes an override → the framework
default applies again.

**Placeholder registry (`CoreAiPlaceholderRegistry`).** Tokens like `{{userId}}`,
`{{roles}}`, `{{tools}}`, `{{toolCatalog}}`, `{{documentation}}`, `{{learnedHints}}` are
resolved at run time by a registry. The framework registers six defaults at boot; projects
add their own via `register({ name, description, resolve })` from any provider. The
current list is served via `GET /ai/placeholders` (S*USER), so any admin/editor UI can
render an up-to-date sidebar without hard-coded names in the frontend. **User-prompt
placeholders** (in user prompts coming from `aiPrompt` / SSE) are ALSO resolved before
the LLM sees them — a stored user prompt template like *"Erkläre dem Nutzer mit ID
`{{userId}}` …"\_ gets the real value substituted at run time. Unknown tokens are left
untouched so plain text with curly braces survives.

**User-facing prompts (`aiPrompts`).** Re-usable short user prompts ("Vorlagen") that
each user authors for themselves (`scope: 'user'` — private) or for the whole tenant
(`scope: 'tenant'` — public). Inserted into the chat input by a picker. Mutations are
owner-only.

**Governed learning loop (`aiPromptHints`, admin CRUD).** When the orchestrator hits a
recurring failure (tool not available, tool error/exception), it records a learned
**hint** scoped to the tool. Hints are `suggested` by default and only reach the prompt
once an admin **approves** them; set `ai.promptLearning.autoApply: true` to auto-approve.
Review/approve/reject via `updateAiPromptHint` (GraphQL) or `/ai/prompt-hints` (REST).
The model also receives **structured tool errors** (`{ error: { code, message, hint } }`)
so it can recover within the run.

> **Security:** learned hints and template overrides only ever **add textual guidance** —
> they can never relax the permission model. Tool role-filtering, `authorize()`,
> `CrudService`/`@Restricted` and `secretFields` are enforced backend-side regardless of
> the prompt.

```typescript
ai: {
  promptLearning: {
    enabled: true,      // record + apply learned hints (default true)
    autoApply: false,   // false = admin approves each hint (governed); true = auto-approve
  },
}
```

All stores are fully overridable per project via `CoreModule.forRoot(env, { ai: {
slotService, promptService, promptHintService, promptBuilder, placeholderRegistry } })`.

## Context window (per user/session, auto-detected)

The assembled session conversation is budgeted against the model's **context window**.
The window is determined automatically per connection (`ILlmProvider.detectContextWindow()`
— e.g. a local Ollama `/api/show` probe, a known-model table, or the Claude alias) and
persisted on the connection alongside the capability flags; set `connection.contextWindow`
explicitly to override, or `ai.contextWindow` (default `8192`) as the global fallback.
When a user's session history would overflow, the **oldest non-system turns are dropped**
(the latest turn is truncated if still too large) and oversized tool-results are capped to
`ai.maxToolResultChars` (default `12000`) — so long-running conversations never exceed the
model's limit.

## Token budgets & usage

Token/prompt limits are **per user AND per tenant**, with **config defaults** so you
need not configure each one individually. Limits are **optional** — a missing or `0`
limit means unlimited (only the LLM's own limit then applies). Requires `audit`.

```typescript
ai: {
  audit: true,
  budget: {
    period: 'day',                         // 'day' | 'month' | 'none'
    user: { maxTokens: 50000 },            // default per user
    tenant: { maxTokens: 2000000 },        // default per whole tenant
  },
}
```

- Admins override per user/tenant at runtime (`aiBudgetLimits`, admin CRUD via
  `createAiBudgetLimit` / REST `/ai/budget-limits`): `{ scope: 'user'|'tenant', refId, maxTokens?, maxPrompts?, period? }`.
- Resolution per scope: persisted override → config default → unlimited.
- Enforced before the run (user OR tenant limit) → HTTP 429 + translated message.

**Usage reported to the client:** every prompt response carries a compact
`budget` summary — `promptTokens` (this prompt), `usedTokens`, `remainingTokens`
(null = unlimited) and `resetAt`. The full breakdown (user + tenant scopes, prompts

- tokens, limits, reset) is available via the `aiUsage` query / `GET /ai/usage`.

## MCP server (`ai.mcp: true`)

The `AiToolRegistry` also feeds a real **MCP server** at `POST/GET/DELETE /ai/mcp`
(Streamable HTTP), so external MCP clients use the same backend tools with the
same role gating. Enable with `ai: { mcp: true }` (requires
`@modelcontextprotocol/sdk`, lazy-loaded).

- Auth: the request must carry a valid Bearer token/session (resolved by the
  framework's existing auth) — the MCP session is bound to that user, and
  `tools/list` / `tools/call` are filtered to and executed with their permissions.
- Unauthenticated requests get `401` with a `WWW-Authenticate` header.

### OAuth 2.1 (`ai.mcp.oauth: true`)

For generic MCP clients that auto-discover + register:
`CoreAiMcpOAuthService` provides HMAC-signed access tokens (constant-time verify),
PKCE S256, and MongoDB-backed client/code/refresh stores; the MCP controller then
also accepts OAuth access tokens. Mount the discovery/token endpoints in `main.ts`:

```typescript
// main.ts, after app.init()
import { mountAiMcpOAuth } from '@lenne.tech/nest-server';
await mountAiMcpOAuth(app, { baseUrl: process.env.BASE_URL });
```

Override `CoreAiMcpOAuthService.authorizeConsent()` to wire your login/consent UI.
Set `ai.mcp.oauthSecret` (or reuse `ai.encryptionSecret`) to a random 32+ char value.

## Tests

- `tests/unit/ai.spec.ts` — crypto, registry role filtering, orchestrator loop,
  streaming, destructive confirmation, MCP role gating (fakes)
- `tests/ai.e2e-spec.ts` — full DI graph: connection CRUD + encryption, prompt
  flow, multi-turn conversation, audit persistence, MCP 401