# AI Module

An extensible AI-assistant layer for `@lenne.tech/nest-server`. Users send prompts
from the frontend; the API optimizes/enriches the prompt, talks to a configurable
LLM (local or external), and lets the model call **backend tools** to read and
manipulate data — MCP-style — before returning a structured answer.

## Highlights

- **Database-backed LLM connections** (`CoreAiConnection`) — endpoints, models and
  **encrypted API keys** are managed at runtime (admin CRUD; later a frontend
  settings area), not in `config.env.ts`.
- **Provider abstraction** (`ILlmProvider`) — swap local (Ollama) and external
  (mittwald / OpenAI-compatible) backends via config. Ships with a dependency-free
  `fetch`-based OpenAI-compatible provider.
- **Tool registry** (`AiToolRegistry`) — a global registry of backend capabilities
  the LLM may call. Tools self-register from any module and are filtered by the
  caller's roles.
- **Emulated tool calling** — works even with gateways that lack native function
  calling (mittwald): the tool catalog is injected into the system prompt and tool
  calls are parsed from the model's JSON output. Native tool calling is used
  transparently when a provider supports it.
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
ILlmProvider ── OpenAiCompatibleProvider (mittwald, Ollama, …)
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
    name: 'mittwald GPT-OSS 120B',
    baseUrl: 'https://llm.aihosting.mittwald.de/v1',
    model: 'gpt-oss-120b',
    apiKeyEnv: 'MITTWALD_API_KEY', // prefer env over an inline apiKey
  },
}
```

### mittwald AI hosting

mittwald exposes an **OpenAI-compatible** API but does **not** support native
function calling or JSON mode — the module therefore emulates tool calling. Models
(see the [mittwald docs](https://developer.mittwald.de/de/docs/v2/platform/aihosting/models/)):
`gpt-oss-120b`, `Qwen3.6-35B-A3B-FP8`, `Ministral-3-14B-Instruct-2512` (vision).

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
factory.registerBuilder('anthropic', (conn) => new AnthropicProvider(conn));
```

## MCP exposure (planned)

The `AiToolRegistry` is the single source of truth and is designed to also feed a
real **MCP server** so external MCP clients can use the same backend tools with the
same role gating. See `INTEGRATION-CHECKLIST.md` and the framework's
`mcp-integration` guide for the OAuth-secured Streamable-HTTP pattern.

## Tests

- `tests/unit/ai.spec.ts` — crypto, registry role filtering, orchestrator loop (fakes)
- `tests/ai.e2e-spec.ts` — full DI graph: connection CRUD + encryption + prompt flow