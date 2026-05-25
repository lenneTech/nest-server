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

This covers the full spectrum — from feature-rich hosted models with native tools
to minimal local runtimes or gateways with no native tool/JSON support — without
naming or special-casing any provider. Add entirely different backends/protocols by
registering a builder on `LlmProviderFactory`.

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

## Tools

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

| Override            | Base class                                                       |
| ------------------- | ---------------------------------------------------------------- |
| `service`           | `CoreAiService` (orchestrator, prompt loop, rate-limit, audit)   |
| `promptBuilder`     | `CoreAiPromptBuilderService` (system prompt, RAG)                |
| `connectionService` | `CoreAiConnectionService`                                        |
| `resolver`          | `CoreAiResolver` (re-declare GraphQL decorators when overriding) |
| `controller`        | `CoreAiController`                                               |

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