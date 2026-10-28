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
  deferToolSchemas: false,        // catalog lists names + descriptions only; schemas via search_tools
  deferToolSummaryChars: 0,       // 0 = full descriptions; set ~200-400 together with deferToolSchemas
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
- **Boot drift check (opt-in):** set `ai.capabilityDriftCheck: true` to probe every enabled
  connection that has an EXPLICIT flag once at startup and log a warning when the declared
  value contradicts what the endpoint reports (a wrong explicit flag otherwise degrades the
  assistant silently, e.g. forcing emulated tool-calling on a native-capable backend). It only
  warns — the stored value is never changed. OFF by default because it makes outbound calls to
  the LLM endpoints on every boot; also skipped in the ci/e2e runners.

The probe is provider-agnostic best effort, and a 2xx alone is never the verdict —
a backend that does not implement a parameter typically ignores it and answers
normally, which would persist a `true` it never earns:

- **JSON:** `response_format: json_object` is sent and the CONTENT must actually
  parse. A response truncated by the output budget (`finish_reason: 'length'`, empty
  OR partial) proves nothing and is retried once with a larger budget before the
  probe settles on `false`.
- **Native tools:** a trivial tool with `tool_choice: 'required'` is sent; a
  `tool_calls` result → supported, a `4xx` or a complete answer without tool calls →
  unsupported, a truncation → the same one retry.

Both probes run concurrently. Override `OpenAiCompatibleProvider.detectCapabilities()`
for custom backends, or implement the optional `ILlmProvider.detectCapabilities()` in
your own provider.

> **`supportsJsonResponse` is a CONNECTION flag, but whether an answer must be JSON is
> a property of the PROMPT.** The JSON output contract is carried only by the
> `output_contract` / `tool_protocol_emulated` fragments (both `capability: 'emulated'`)
> and by `plan_protocol`. A **native**-tools run receives none of them and is asked for
> prose — attaching `response_format` on top is a contradiction the model can only
> resolve by inventing a shape of its own, which then reaches the user as the answer.
> The orchestrator therefore decides JSON mode per CALL, not per connection: pass
> `jsonResponse: false` in `LlmCompletionOptions` from any call whose prompt asks for
> prose. The option only ever NARROWS — it can never assert JSON mode for a connection
> whose endpoint was not probed for it.

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

## Egress allowlist (`ai.allowedBaseUrlHosts`)

A connection's `baseUrl` decides where the server sends outbound HTTP. It is admin-set, so the
threat model is a compromised or mistyped admin rather than end-user input — but the request still
leaves from inside your network, which is what makes it an SSRF surface.

**Unset (the default) means no restriction**, so a local provider works out of the box. When set,
only the listed hosts are reachable and everything else is refused with
`ServiceUnavailableException` plus a WARN naming the host:

```typescript
ai: {
  allowedBaseUrlHosts: ['llm.example.com', 'localhost:11434'],
}
```

```bash
# Same setting via the canonical env spelling — a comma-separated string is understood
NSC__AI__ALLOWED_BASE_URL_HOSTS=llm.example.com,localhost:11434
```

Matching details worth knowing before you debug a refusal:

- A bare hostname entry matches **any port** on that host. An entry that names the scheme's default
  port (`example.com:443` for https) also matches the portless URL.
- Entries and URLs are both trimmed, lowercased, and stripped of a fully-qualifying trailing dot, so
  `LLM.Example.com`, `llm.example.com` and `llm.example.com.` are one host.
- The check covers **all three** outbound paths: chat completions, the capability probe, and the
  Ollama context-window probe.
- A value that is neither a list nor a string carries no hostnames. The allowlist is then inactive
  and the framework logs an error — from the outside that state is indistinguishable from
  "correctly unset", which is exactly why it is not silent.

## Where the data lives

The module's eleven models (connections, preferences, conversations, interactions, budget limits,
prompts, prompt hints, slots, modes, tool grants, tool policies) are registered through
`CorePersistenceModule.forFeature()` and every service works on its model's data store, so `database`
routes them like any model — MongoDB or a SQL source, one code path. Budget sums run in the store
(`sum()`), across tenants as before; an expired tool grant is refused on read, and on SQL the expiry
sweep removes it. Code of your own that reads these models goes through the store
(`@InjectStore('<model>')`), not through `connection.collection()`.

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
        filterQuery: {/* … */},
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

  // PLAN-MODE pre-flight, without mutating: lets the whole plan be rejected before
  // any step runs. It does NOT run in auto mode or over MCP — so it must never be
  // the only place a permission is checked.
  async authorize(args, context) {
    const account = await this.accountService.get(args.fromId, context.serviceOptions).catch(() => null);
    return { allowed: !!account, reason: account ? undefined : 'No access to source account' };
  }

  async execute(args, context) {
    // The REAL gate, on every path: route through the service with the caller's
    // serviceOptions so `@Restricted`, `securityCheck()` and tenant scoping apply.
    // Do not rely on authorize() having run.
    const account = await this.accountService.getForUser(args.fromId, context.serviceOptions);
    return this.accountService.transfer(account, args.toId, args.amount, context.serviceOptions);
  }
}
```

> **Do not put a permission check only in `authorize()`.** It runs in plan mode
> only — auto mode (the default) and MCP go straight to `execute()`.

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
> they can never relax the permission model. Tool role-filtering,
> `CrudService`/`@Restricted` and `secretFields` are enforced backend-side regardless of
> the prompt. (`authorize()` is _not_ part of that unconditional set — it runs in plan
> mode only; see [Deferred tool schemas](#deferred-tool-schemas-large-registries) below.)

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

## Deferred tool schemas (large registries)

The system prompt normally carries every tool's full JSON parameter schema. With a large
registry that catalog can dominate a small context window. Set `ai.deferToolSchemas: true`
and the catalog lists only tool **names + descriptions**; the model fetches a specific
schema on demand through the built-in `search_tools` meta-tool.

With many tools the **descriptions alone** can then re-inflate the prompt the deferral was
meant to shrink. `ai.deferToolSummaryChars` caps each description in that deferred catalog:
whole sentences up to the cap (always at least the first one), a word-boundary cut when the
first sentence already exceeds it, and a `…` marker appended **on top of** the cap.

```typescript
ai: {
  deferToolSchemas: true,
  deferToolSummaryChars: 300,  // 0 (default) = keep descriptions untruncated
}
```

The default of `0` is deliberate: enabling `deferToolSchemas` alone never changes what a
tool description _says_. The saving is therefore opt-in — when you defer schemas to reclaim
context, set `deferToolSummaryChars` alongside it (roughly 200–400 works well).

> **Scoped to the emulated tool protocol, not to the provider.** In auto mode a connection
> with `supportsNativeTools: true` receives every full description and JSON schema through
> the native `tools` payload anyway, so truncation is skipped there and no `search_tools`
> banner is emitted — telling the model a description was cut while handing it the full text
> in the same request would only buy a wasted round-trip against `maxIterations`.
>
> **Plan mode always uses the emulated protocol**, so a native connection IS truncated there.
> Because plan mode returns a complete plan in one call without executing anything, the model
> cannot act on a `search_tools` hint before committing — the catalog therefore carries a
> different banner there ("descriptions are abbreviated, plan conservatively") instead of
> promising a lookup that would arrive too late. The dropped tail stays unrecoverable for
> planning, so keep the cap generous if you rely on plan mode.

> **The truncated tail is where preconditions and role restrictions usually live.** The
> catalog banner instructs the model to fetch the full text via `search_tools` before
> calling a `…`-marked tool. This is model **guidance only** — it never affects
> authorization. Which tools a user sees and may run is decided server-side by the registry's
> role filter (`AiToolRegistry.forUser()`), re-checked when the call executes; and the
> confirmation gate reads a tool's `mutating`/`destructive` **flags**, never its description
> — so a truncated "requires confirmation" sentence cannot disable it.
>
> Note `AiTool.authorize()` is **not** part of that chain in every mode: it runs in **plan
> mode only**. In auto mode (the default) and over MCP, tools go straight to `execute()` — so
> data-level checks (ownership, tenant scope) must live **inside `execute()`**, routed through
> `CrudService` with `context.serviceOptions`, not in `authorize()` alone.

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

## Tool access is the user's access

An AI client — the chat's agent loop or an MCP client — acts **on behalf of the signed-in user and
never beyond that user's rights**. Three things make that hold, and a project's tools must not undo
them:

- **Visibility and execution** are decided by `AiToolRegistry.userCanAccess()`, evaluated per request —
  over MCP with the user as of THAT request, not as of the session's `initialize` (11.42.0+), so a
  revoked role stops working without a reconnect.
  Under multi-tenancy (11.42.0+) it resolves a tool's `roles` like `CoreTenantGuard` resolves
  `@Roles()`: a global role (`RoleEnum.ADMIN`, `multiTenancy.globalOnlyRoles`) against `user.roles`, a
  tenant role against the **membership role in the request's tenant** (by hierarchy), and the ADMIN
  bypass only where `multiTenancy.adminBypass` grants it. Before, every role was compared with the
  global `user.roles` — a tool requiring the tenant role `owner` was offered to nobody who held it as
  a membership, and to anyone holding a global role of that name.
- **Data** is scoped by the request context: a tool runs inside the HTTP request (chat or `/ai/mcp`),
  so `mongooseTenantPlugin` filters by the tenant the guard validated. Without a tenant header there
  is no tenant scope on these routes and tenant-scoped reads are refused (403) — an AI client is
  never broader than its user, at worst narrower.
  An **MCP OAuth access token** is accepted only by the MCP controller, after the guards ran without a
  user. Since 11.43.3 the controller gives such a request what the guard gives a user it saw: the user
  on the request (so `RequestContext.currentUser`, the audit fields and `mongooseRoleGuardPlugin` see
  it), and the tenant the header names — only when the user is an ACTIVE member of it, through the
  guard's own check (`CoreTenantGuard.resolveMembershipContext()`). Before, every tenant-scoped tool
  answered "Tenant context required" to an OAuth client, even for a member.
- **Service-level rules** apply on every entry point when the service enforces them itself —
  `assertTenantRole()` (see the tenant module README) — instead of relying on a controller's
  `@Roles()`, which a tool calling the service never passes through.

Without multi-tenancy, tool roles are compared with `user.roles` exactly as before.

## MCP server (`ai.mcp: true`)

The `AiToolRegistry` also feeds a real **MCP server** at `POST/GET/DELETE /ai/mcp`
(Streamable HTTP), so external MCP clients use the same backend tools with the
same role gating. Enable with `ai: { mcp: true }`.

**No install step needed.** `@modelcontextprotocol/sdk` ships as a regular
dependency of `@lenne.tech/nest-server` and reaches both consumption modes:
npm-mode projects resolve it transitively, and CLI-vendored projects get it
merged into their own `package.json`. The controller still `import()`s it
lazily, so a project that never enables MCP does not pay the startup cost.

If `/ai/mcp` nevertheless returns **503 Service Unavailable**, the module could
not be _resolved_ — a bundler or test runner with its own module resolution can
fail on the subpath export while plain Node succeeds. The underlying error is in
the server log; the response carries only a stable `#LTNS_0901` code.

- Auth: the request must carry a valid Bearer token/session (resolved by the
  framework's existing auth) — the MCP session is bound to that user, and
  `tools/list` / `tools/call` are filtered to and executed with their permissions.
- Unauthenticated requests get `401` with a `WWW-Authenticate` header.
- A session id the server does not know — which every restart produces, because the
  transport map is process memory — gets **`404`**, and so does another user's id. 404
  is the status the MCP spec has a client react to by sending a fresh `initialize`, so
  clients recover from a deploy on their own rather than sitting dead until someone
  reconnects by hand. A request with **no** session id and no `initialize` body still
  gets `400`: there is nothing to recover, and a 404 would start a reconnect loop.
- Answering a foreign id `404` rather than `403` is deliberate — a 403 would confirm
  that the id exists, and the id travels in a response header and through client logs.

### Multi-replica / sticky sessions

An MCP session owns a **live Streamable-HTTP transport** — an open response stream
held in process memory. It cannot be serialized, so it cannot be moved to another
replica. **`/ai/mcp` therefore requires sticky sessions** behind a load balancer:
every request carrying the same `mcp-session-id` must reach the replica that
created it.

When [Redis](../../common/services/core-redis.service.ts) is configured
(`ServerOptions.redis`), the controller additionally registers each session id in a
shared registry (`<keyPrefix>:ai-mcp-session:<id>` → `<hostname>:<pid>`, 1h TTL,
refreshed on every request, deleted on close/eviction). That does **not** make
sessions portable; it makes the failure legible: a request that lands on the wrong
replica gets

```
409 Conflict — MCP session belongs to another server instance (api-7f4d:31);
this instance is api-9b2c:29. … /ai/mcp requires sticky sessions …
```

instead of a `404 Unknown or expired MCP session`, which reads like an expiry bug
and sends operators looking in the wrong place.

Without Redis nothing changes: unknown ids answer `404` exactly as before.

### OAuth 2.1 (`ai.mcp.oauth: true`)

For generic MCP clients that auto-discover + register:
`CoreAiMcpOAuthService` provides HMAC-signed access tokens (constant-time verify),
PKCE S256, and client/code/refresh stores; the MCP controller then also accepts OAuth access
tokens. The stores live wherever `database` routes the models `AiMcpOAuthClient`, `AiMcpOAuthCode`
and `AiMcpOAuthRefreshToken` (MongoDB collections, or SQL tables). An authorization code is refused
on read once it is older than ten minutes, on both databases — never only by a TTL index, which
deletes late; on SQL the expiry sweep removes old codes, on MongoDB the TTL index does.

```typescript
// config.env.ts — that is all: endpoints, consent page and sign-in come with it
ai: { mcp: { oauth: true, oauthSecret: process.env.NSC__AI__ENCRYPTION_SECRET } }
```

**Mounted by `CoreModule` (11.43.0).** `CoreAiMcpOAuthInitializer` mounts the discovery and token
endpoints (`/.well-known/oauth-authorization-server`, `/.well-known/oauth-protected-resource<mcp path>`,
`/authorize`, `/token`, `/register`) during `app.init()` — no `main.ts` code, and the same under
`Test.createTestingModule()`. The position is the point: the endpoints are an Express router, and Nest
registers its not-found handler inside `app.init()`. The call this replaces — `mountAiMcpOAuth(app)` after
`app.init()`, as this README used to say — sat behind that handler, so every OAuth endpoint answered 404.
Mounted during init, the router sits behind every Nest middleware (security headers, request context,
CORS) and the Nest routes, and ahead of the not-found handler. Guards and interceptors do not run for it;
the SDK's handlers authenticate the client and rate-limit per IP themselves (so `trustProxy` matters
behind a proxy). A `mountAiMcpOAuth()` call left in `main.ts` is a no-op and logs that it can go; options
it passes that differ from the mount (`baseUrl`, `mcpPath`) are named in a warning.

The protected MCP resource is described at the path Nest registered the endpoint at — global prefix and
its exclusions, URI versioning and a `RouterModule` path included — and the endpoint's `401` names that
metadata document in `WWW-Authenticate: Bearer resource_metadata="…"` (RFC 9728 §5.1). Without OAuth the
challenge is a plain `Bearer`: there is no metadata to point at. CORS: a project's `enableCors()` runs
first, so a browser-based MCP client on an origin it does not allow is refused at the preflight; native
clients (Claude Code, Claude Desktop) send none.

**Swagger (11.42.9):** `setupSwagger()` documents `/ai/mcp` (POST/GET/DELETE, with the bearer
requirement the endpoint enforces itself) whenever the MCP server is registered, and — because the
OAuth endpoints are an Express router, invisible to `@nestjs/swagger` — exactly the OAuth endpoints that
are mounted (`/revoke` only for a provider with `revokeToken`). Without `ai.mcp.oauth` they are not
documented, because they do not exist.

The issuer — and with it every endpoint URL in the discovery metadata, which MCP clients follow —
is the server's `baseUrl` (`NSC__BASE_URL` when deployed), resolved the same way BetterAuth and
CORS resolve it. `local` / `ci` / `e2e` fall back to `http://localhost:3000`; any other environment
without a `baseUrl` fails the boot instead of guessing, because a deployed API that advertised
`http://localhost:3000` sent Claude Code off to register the client on the user's own machine.
Set `ai.mcp.oauthBaseUrl` only when MCP clients reach the server under another URL than `baseUrl` (its
origin is then trusted by Better-Auth automatically, because the consent page signs users in there),
and do not add a `localhost` fallback of your own. Issuer and resource are logged once at boot.
Set `ai.mcp.oauthSecret` (or reuse `ai.encryptionSecret`) to a random 32+ char value.

**Consent page (11.43.0).** `/authorize` answers with a built-in, build-free page — the step where the
user decides whether an MCP client may act for them:

- **Nobody signed in** → the sign-in view: e-mail + password and the two-factor step (TOTP or backup
  code) against Better-Auth's own endpoints on this origin (`<basePath>/sign-in/email`,
  `/two-factor/verify-totp`, `/two-factor/verify-backup-code`), then a reload of the same `/authorize`
  request. Passkey and social login go through the app's login page: `ai.mcp.oauthLoginUrl`, else
  `<appUrl>/auth/login`, opened next to the consent page, which then offers "continue". A `{returnTo}`
  in `oauthLoginUrl` is replaced by the pending request's URL, for a login page that sends the user
  back by itself. A user already signed in to the API origin (session cookie) skips this view.
- **Signed in** → the consent view: the signed-in account first (with "use another account", which signs
  out and shows the sign-in view), the client's name, the host the code goes to (a loopback host is
  named "an application on this computer"), Allow / Deny as a form POST. Allow is rendered `disabled`;
  a nonce'd script enables it, and a click counts only after intent on this page — visible, focused,
  and a pointer move / key / touch at least 600 ms after it got there. That defeats
  double-clickjacking (a hostile page sends this window to `/authorize` behind a popup and lets the
  second click of a "double-click" land on Allow). Without JavaScript nothing can be approved, and the
  sign-in forms are hidden and `method="post"`, so a password never lands in a URL.
- **Allow** issues the code only with the page's CSRF token, signed with the OAuth secret and bound to
  the user, the client, the redirect URI and the PKCE challenge (10 minutes); a stale token shows the
  form again, a forged or tampered one too, and nothing is issued. **Deny** sends the client back with
  `access_denied`.

The page carries its own `Content-Security-Policy` (script and style by nonce, `frame-ancestors 'none'`,
no `form-action`, which browsers would apply to the redirect to the client), `X-Frame-Options: DENY`,
`Cache-Control: no-store` and `Referrer-Policy: no-referrer`, independent of `security.headers`. Every
value from outside is escaped — the client's name is chosen by whoever registered the client. German
for a German `Accept-Language`, English otherwise.

Why Allow is a deliberate step: dynamic registration is open by design, so anybody can register a
client with their own redirect URI and start the flow — PKCE is then theirs too. A GET to `/authorize`
is what any link produces, and it carries the session cookie, so a page that issued on GET would let any
link a signed-in user opens authorize an attacker's client. The framework refuses a code saved while
answering a GET to `/authorize` (logged; the client gets `error=server_error`) — for the built-in page
and for one of your own alike.

**Global prefix.** Nest registers the Better-Auth middleware below a global prefix while the OAuth router sits at the
root, so the page resolves the session itself when the middleware did not run, and signs in at the prefixed IAM path
(`/api/iam/sign-in/email`). Better-Auth's own routes are not forwarded below a global prefix (see `setupSwagger()`), so
the two-factor step does not work there; users with 2FA sign in through the app.

**Needs Better-Auth.** The page signs users in through it; without Better-Auth active the boot warns and
the page offers no sign-in. Its sign-in goes through the IAM sign-in controller, which (since 11.43.0)
hands Better-Auth the request so Better-Auth's own login-CSRF protection runs — otherwise a hostile page
could sign the visitor in to the attacker's account before they approve a client.

**Your own page.** Override `renderConsentPage(view)` in a subclass to restyle it (keep every value
escaped), or `authorizeConsent(client, params, res)` for a consent UI of your own — same shape: no session
→ sign in, GET → show which client, POST with a CSRF token → `saveAuthorizationCode()` and redirect;
refuse with `AccessDeniedError` from `this.loadOAuthErrors()`. Register the subclass via
`CoreModule.forRoot(env, { ai: { mcpOAuthService } })`, so the MCP controller and the endpoints share it.
Two checks stay outside the overridable methods: an API token can never approve a consent, and the
production secret check runs again before the endpoints are mounted (without a signing secret, a
environment outside `local` / `ci` / `e2e` refuses to boot and to sign tokens at all — deployed `develop` and `test`
stages included).

Known property of the SDK: `/authorize` redirects its error answers to the client's registered
redirect URI, and any client may register any https URI — an open redirect in the sense of RFC 9700
§4.11.2, carrying only an OAuth error code.

**Refusals are OAuth errors (11.43.0).** The SDK's handlers answer an error with its OAuth code only
when it is one of the SDK's own `OAuthError` classes; anything else becomes `500 server_error`. The
built-in provider refuses an unknown, rotated or foreign refresh token or authorization code with
`400 invalid_grant` (until 11.43.0 these were plain `Error`s and answered 500). That matters beyond the
status: an MCP client discards its stored tokens only on `invalid_grant`, so on a 500 it kept a dead
token, retried, and never asked the user to sign in again. A refusal in your own `authorizeConsent()`
needs the same: take the class from `this.loadOAuthErrors()` (e.g. `AccessDeniedError` when the user
declines), never a plain `Error`.

## Tests

- `tests/unit/ai.spec.ts` — crypto, registry role filtering, orchestrator loop,
  streaming, destructive confirmation, MCP role gating (fakes)
- `tests/ai.e2e-spec.ts` — full DI graph: connection CRUD + encryption, prompt
  flow, multi-turn conversation, audit persistence, MCP 401