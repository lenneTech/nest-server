# AI Module — Provider-agnostic + Connection Resolution (temporary)

> DELETE when done. Branch `feature/ai-module`. Backend AI module otherwise complete
> (docs in `src/core/modules/ai/`).

## Goals (this phase)

A) **Provider-agnostic**: no concrete vendor/runtime names anywhere in code (docs neutral).
   Providers declare **capabilities** (native tools / JSON response / system prompt …) so
   the orchestrator compensates across ALL gradations (full native → none = emulated).
   Capabilities are configured on the DB connection (admin knows the endpoint).

B) **Connection resolution chain** (DB-backed, per-tenant restrictable, easily
   overridable/extendable/replaceable per project). No connections → handling disabled.
   One connection → it is the default. Multiple → flexible, prioritized resolution
   (ascending priority, later wins; soft layers must be within the tenant's available set):
   1. Global default (`isDefault`)
   2. Tenant default (preference)
   3. User default (preference, from tenant's available set)
   4. Client request (`input.connectionId`, from tenant's available set)
   5. Tenant-enforced (preference enforced)
   6. Admin-enforced global (connection `enforced`)
   7. Admin-enforced for tenant (connection `enforcedTenantIds`)
   8. Explicit code override (module/service/function) — deliberate, trusted bypass
   Each layer is an overridable protected method; the whole chain is replaceable.

## Tasks (TDD)

### A — agnostic + capabilities
- [ ] `LlmCapabilities { jsonResponse, nativeTools, systemPrompt }`; `ILlmProvider.capabilities`
      (replace `supportsNativeTools`). Orchestrator uses `provider.capabilities.nativeTools`.
- [ ] Connection + ResolvedAiConnection + inputs: `supportsNativeTools?`, `supportsJsonResponse?`.
      OpenAiCompatibleProvider derives capabilities from the connection; sends `response_format`
      when jsonResponse; native `tools` when nativeTools.
- [ ] Scrub ALL concrete names (mittwald/Anthropic/OpenAI/Ollama/Claude) from code; docs neutral
      (categories only: local runtimes / hosted endpoints; native vs emulated tool calling).
- [ ] Genericize config.env.ts example seed (neutral name + AI_BASE_URL/AI_API_KEY).

### B — resolution chain
- [ ] Connection fields: `tenantIds?` (availability; empty = all), `enforced?`, `enforcedTenantIds?`.
- [ ] `CoreAiConnectionPreference` model (`aiConnectionPreferences`): scope('tenant'|'user'), refId,
      connectionId, enforced? — unique (scope, refId). + service (CRUD + get).
- [ ] `CoreAiConnectionResolverService`: `resolveConnectionId(input, ctx)` walking the chain via
      overridable layer methods + `availableConnectionsFor(tenantId)` + `isAvailable` + one=default
      + none=disabled. `resolveConnection(...)` → loads/decrypts via connection service.
- [ ] Orchestrator uses the resolver; code-override channel (`input.connectionId` is client;
      a separate `serviceOptions._aiConnectionOverride` / param is code). none → translated
      "AI not available" response.
- [ ] Endpoints: user self-service `aiSetUserConnection` (S_USER, from available); admin CRUD for
      preferences + connection flags already via connection CRUD. `aiAvailableConnections` query
      (list the connections the current user/tenant may use).
- [ ] Module wiring, exports, overridable via `CoreAiModule.forRoot({ connectionResolver, ... })`.
- [ ] Tests: capability compensation; resolution order (each layer overrides prior; enforced wins;
      availability filtering; one=default; none=disabled) — unit + e2e. Docs.

## Finalization
- [ ] `pnpm test` green, lint/format/build, commit + push, delete this file.
