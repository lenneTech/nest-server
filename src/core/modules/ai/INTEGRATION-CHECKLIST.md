# AI Module Integration Checklist

## Reference Implementation

- Local (npm): `node_modules/@lenne.tech/nest-server/src/server/modules/ai/`
- Local (vendor): `src/server/modules/ai/` in this repo
- GitHub: https://github.com/lenneTech/nest-server/tree/develop/src/server/modules/ai

## Overview

The AI module is **auto-registered by `CoreModule.forRoot()`** when an `ai` config
block is present (presence implies enabled). You only need to:

1. add the `ai` config block,
2. set an encryption secret,
3. create one or more AI tools (project-specific capabilities),
4. register your tools in a module.

No manual `CoreAiModule` import is required for the default setup.

## Required Steps

### 1. Configure the module (`config.env.ts`)

Add an `ai` block to each relevant environment:

```typescript
ai: {
  encryptionSecret: process.env.NSC__AI__ENCRYPTION_SECRET, // REQUIRED in prod (32+ chars)
  maxIterations: 5,
  rateLimit: { max: 20, windowSeconds: 60 },
  defaultConnection: {                 // optional one-time seed
    name: 'Default LLM',
    baseUrl: process.env.AI_BASE_URL,   // any OpenAI-compatible endpoint
    model: process.env.AI_MODEL,
    apiKeyEnv: 'AI_API_KEY',            // prefer env over inline apiKey
    supportsNativeTools: false,         // set per the backend's actual support
  },
}
```

**WHY the encryption secret:** connection API keys are AES-256-GCM encrypted at
rest. Without `ai.encryptionSecret` / `NSC__AI__ENCRYPTION_SECRET` /
`SECRETS_ENCRYPTION_KEY`, an insecure development default is used (logged as a
warning) — never ship that.

### 2. Set the LLM API key (environment)

```bash
# .env
AI_API_KEY=...
AI_BASE_URL=https://your-openai-compatible-endpoint/v1
NSC__AI__ENCRYPTION_SECRET=<random 32+ char string>
```

Admins can also store/rotate keys at runtime via the connection CRUD endpoints
(stored encrypted; env is only the fallback).

### 3. Create AI tools

**Create:** `src/server/modules/ai/tools/<your>.tool.ts`
**Copy from:** the reference tools (`find-users.tool.ts`, `get-user.tool.ts`,
`update-user-job-title.tool.ts`).

Each tool extends `AiTool`, declares `name`/`description`/`parameters`/`roles`, and
implements `execute()` by routing through a `CrudService` with
`context.serviceOptions`.

### 4. Register your tools in a module

**Create:** `src/server/modules/ai/ai-tools.module.ts` (copy from reference) and
import it in `server.module.ts`:

```typescript
// server.module.ts → imports: [ … , AiToolsModule ]
```

The `AiToolRegistry` is provided globally by the auto-registered `CoreAiModule`, so
your module only needs to import whatever services your tools depend on (e.g.
`UserModule`).

### 5. (Optional) Override collaborators

For custom behaviour, pass subclasses via `CoreModule.forRoot()`:

```typescript
CoreModule.forRoot(envConfig, {
  ai: { service: MyAiService, resolver: MyAiResolver, promptBuilder: MyPromptBuilder },
});
```

When overriding the resolver, **re-declare all GraphQL decorators**
(`@Mutation`/`@Query`/`@Roles`) — the schema is built from decorators at compile
time.

## Advanced configuration (optional)

```typescript
ai: {
  defaultMode: 'auto',                 // or 'plan' (validate all permissions, then execute atomically)
  documentation: '…',                  // system docs injected into the prompt (or override getDocumentation())
  confirmation: { mutating: { default: false, enforced: false } }, // require confirmation for create/update/delete
  audit: true,                         // persist runs to aiInteractions (required for budget)
  budget: {                            // per-user/tenant token limits (defaults; admins override per user/tenant)
    period: 'day',                     // 'day' | 'month' | 'none'
    user: { maxTokens: 50000 },        // 0/undefined = unlimited
    tenant: { maxTokens: 2000000 },
  },
  mcp: { oauth: true, oauthSecret: process.env.NSC__AI__ENCRYPTION_SECRET },
}
```

- **Plan mode / pre-flight permissions:** give data-mutating tools an `authorize()` that
  checks permission WITHOUT mutating (e.g. load the record + verify ownership). Plan mode
  runs it for every step before executing anything.
- **Confirmation:** mark create/update/delete tools `mutating: true` and irreversible ones
  `destructive: true`.

### MCP OAuth 2.1 (only when `ai.mcp.oauth` is enabled)

**Edit `main.ts`** (after `app.init()`):

```typescript
import { mountAiMcpOAuth } from '@lenne.tech/nest-server';
await mountAiMcpOAuth(app, { baseUrl: process.env.BASE_URL });
```

Override `CoreAiMcpOAuthService.authorizeConsent()` with your login/consent UI (the only
browser-interactive step). All other OAuth pieces (tokens, PKCE, stores) are built in.

## Verification Checklist

- [ ] Build succeeds (`pnpm run build`)
- [ ] Tests pass (`pnpm test`)
- [ ] `findAiConnections` / `getAiConnection` etc. are admin-only and never return `apiKeyEncrypted`
- [ ] A created connection's `hasApiKey` is `true`, the key is stored encrypted
- [ ] `aiPrompt` works for an authenticated user
- [ ] Your tools appear in `AiToolRegistry.all()` and are role-filtered correctly
- [ ] Tools route through `CrudService` (no raw `.lean()`/aggregate results sent to the LLM)

## Common Mistakes

| Mistake                                       | Symptom                                           | Fix                                                       |
| --------------------------------------------- | ------------------------------------------------- | --------------------------------------------------------- |
| No `ai` config block                          | Module not loaded, `aiPrompt` missing from schema | Add an `ai` block (presence implies enabled)              |
| No encryption secret in prod                  | Warning logged, keys encrypted with dev default   | Set `NSC__AI__ENCRYPTION_SECRET` (32+ chars)              |
| Tool returns `.lean()`/aggregate data         | `@Restricted` fields leak into the LLM context    | Route through `CrudService` with `context.serviceOptions` |
| Tool not registered                           | Tool never offered to the LLM                     | Declare it as a provider in a module (extends `AiTool`)   |
| Overridden resolver method missing decorators | Method absent from GraphQL schema                 | Re-declare `@Mutation`/`@Query`/`@Roles` in the override  |
| Storing a real API key in `config.env.ts`     | Secret committed to the repo                      | Use `apiKeyEnv` or the runtime connection CRUD            |