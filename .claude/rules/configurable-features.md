# Configurable Features Pattern

This document describes the standard pattern for implementing optional, configurable features in @lenne.tech/nest-server.

## "Presence Implies Enabled" Pattern

When implementing configurable features, follow this pattern for activation logic:

### Rules

1. **No configuration** (`undefined` or `null`): Feature is **disabled** (backward compatible)
2. **Empty object** (`{}`): Feature is **enabled** with all default values
3. **Partial configuration** (`{ max: 5 }`): Feature is **enabled**, missing values use defaults
4. **Explicit disable** (`{ enabled: false, ... }`): Feature is **disabled**, allows pre-configuration

### Benefits

- **Backward Compatible**: Existing projects without config continue to work unchanged
- **Efficient**: No need to set `enabled: true` redundantly when already providing config
- **Flexible**: Can pre-configure without activating via `enabled: false`
- **Intuitive**: Providing a config object signals intent to use the feature

### Implementation Example

```typescript
interface IFeatureConfig {
  enabled?: boolean;  // Optional - presence of config implies true
  max?: number;
  windowSeconds?: number;
}

const DEFAULT_CONFIG: Required<IFeatureConfig> = {
  enabled: false,  // Default is false, but overridden by presence
  max: 10,
  windowSeconds: 60,
};

class FeatureService {
  private config: Required<IFeatureConfig> = DEFAULT_CONFIG;

  /**
   * Configure the feature
   *
   * Follows the "presence implies enabled" pattern:
   * - If config is undefined/null: feature stays disabled (backward compatible)
   * - If config is an object (even empty {}): feature is enabled by default
   * - Unless `enabled: false` is explicitly set
   */
  configure(config: IFeatureConfig | undefined | null): void {
    // No config = stay disabled (backward compatible)
    if (config === undefined || config === null) {
      return;
    }

    // Presence of config implies enabled, unless explicitly disabled
    const enabled = config.enabled !== false;

    this.config = {
      ...DEFAULT_CONFIG,
      ...config,
      enabled,
    };
  }
}
```

### Usage Examples

```typescript
// config.env.ts

// Feature disabled (no config)
// rateLimit: undefined  // or just don't define it

// Feature enabled with all defaults
auth: {
  rateLimit: {}
}

// Feature enabled with custom max
auth: {
  rateLimit: { max: 20 }
}

// Feature enabled with full configuration
auth: {
  rateLimit: {
    max: 10,
    windowSeconds: 60,
    message: 'Too many requests'
  }
}

// Pre-configured but disabled (for testing or gradual rollout)
auth: {
  rateLimit: {
    enabled: false,
    max: 10,
    windowSeconds: 60
  }
}
```

## Boolean Shorthand Pattern

For simple enable/disable scenarios, support `boolean | object` configuration:

### Rules

1. **`true`**: Feature is **enabled** with all default values
2. **`false`**: Feature is **disabled**
3. **`{}`**: Feature is **enabled** with all default values (same as `true`)
4. **`{ option: value }`**: Feature is **enabled** with custom settings
5. **`{ enabled: false }`**: Feature is **disabled** (allows pre-configuration)
6. **`undefined`**: Feature is **disabled** (default)

### Benefits

- **Concise**: `jwt: true` instead of `jwt: {}`
- **Readable**: Clear intent at a glance
- **Flexible**: Can still use objects for customization

### Implementation Example

```typescript
// Interface definition
interface IBetterAuth {
  jwt?: boolean | IBetterAuthJwtConfig;
  twoFactor?: boolean | IBetterAuthTwoFactorConfig;
  passkey?: boolean | IBetterAuthPasskeyConfig;
}

interface IBetterAuthJwtConfig {
  enabled?: boolean;
  expiresIn?: string;
}

// Helper functions
function isPluginEnabled<T extends { enabled?: boolean }>(
  config: boolean | T | undefined
): boolean {
  if (config === undefined) return false;
  if (typeof config === 'boolean') return config;
  return config.enabled !== false;
}

function getPluginConfig<T extends { enabled?: boolean }>(
  config: boolean | T | undefined
): T | undefined {
  if (!isPluginEnabled(config)) return undefined;
  if (typeof config === 'boolean') return {} as T;
  return config;
}

// Usage in build logic
const jwtConfig = getPluginConfig(config.jwt);
if (jwtConfig) {
  plugins.push(jwt({ expirationTime: jwtConfig.expiresIn || '15m' }));
}
```

### Usage Examples

```typescript
// config.env.ts

betterAuth: {
  // Boolean shorthand - enable with defaults
  jwt: true,
  twoFactor: true,
  passkey: true,
}

// Equivalent to:
betterAuth: {
  jwt: {},
  twoFactor: {},
  passkey: {},
}

// Mixed - some with defaults, some customized
betterAuth: {
  jwt: true,                        // Enable with defaults
  twoFactor: { appName: 'My App' }, // Enable with custom settings
  passkey: false,                   // Explicitly disabled
}

// Pre-configured but disabled
betterAuth: {
  jwt: { enabled: false, expiresIn: '1h' }, // Ready to enable later
}
```

## Numeric Sentinel Pattern

A numeric knob without a separate boolean uses `0` as its "off" sentinel. **`0` has two
opposite meanings depending on what the number bounds — pick the right family and say
which one you are in.** Filing a cap and a TTL under one rule is how someone later builds
an eternal cache out of `cacheTtlMs: 0`.

### Family A — `0` = NO LIMIT (permissive)

For a knob that **bounds** something (a cap, a quota, a maximum). `0` means "unbounded".

| Config | `0` means |
|--------|-----------|
| `ai.deferToolSummaryChars` | descriptions are not truncated |
| `ai.budget.user.maxTokens` / `.maxPrompts` | unlimited |
| `ai.budget.tenant.maxTokens` / `.maxPrompts` | unlimited |

Rules:

1. **`0` and `undefined` both mean unbounded.** `@default 0`.
2. **Never invert it.** `maxTokens: 0` must not mean "may spend nothing" — that turns a
   missing config value into a lockout.
3. **Negative and `NaN` behave like `0`.** A misconfigured value degrades to "no limit",
   never throws, never applies a nonsensical bound. Guard with `typeof v === 'number' && v > 0`,
   **not** `v <= 0` — `NaN <= 0` is `false`, so a bare comparison lets `NaN` through and it
   propagates into arithmetic (`now + NaN`).

### Family B — `0` = FEATURE OFF (restrictive)

For a knob that **enables** something whose size it also configures (a TTL, an interval,
a retry count). `0` means "do not do this at all".

| Config | `0` means | `undefined` means |
|--------|-----------|-------------------|
| `multiTenancy.cacheTtlMs` | no caching | **30000** (caching ON) — not "off" |

Rules:

1. **`0` and `undefined` differ here.** `undefined` falls back to the documented default,
   which is usually ON. Document the real default (`@default 30000`), never `@default 0`.
2. **`NaN` must be normalised explicitly.** `ttl <= 0` does not catch it; coerce first
   (`Number.isFinite(ttl) && ttl > 0`), or a "disabled" value silently becomes an
   expiry of `now + NaN` — every lookup misses while the cache grows.

### Both families

**Warn when the knob is inert.** If a value only takes effect together with another
setting, log once at runtime when it is set while that other setting is off. A silently
ignored number is indistinguishable from a broken feature — see
`CoreAiPromptBuilderService.warnOnOrphanedSummaryCap()` for the reference implementation.

## Applied Features

This pattern is currently applied to:

| Feature | Config Path | Pattern | Default Values |
|---------|-------------|---------|----------------|
| Legacy Auth Rate Limiting | `auth.rateLimit` | Presence Implies Enabled | `max: 10`, `windowSeconds: 60` |
| BetterAuth Rate Limiting | `betterAuth.rateLimit` | Presence Implies Enabled | `max: 10`, `windowSeconds: 60` |
| BetterAuth JWT Plugin | `betterAuth.jwt` | Boolean Shorthand | `expiresIn: '15m'` |
| BetterAuth 2FA Plugin | `betterAuth.twoFactor` | Boolean Shorthand | `appName: 'Nest Server'` |
| BetterAuth Passkey Plugin | `betterAuth.passkey` | Boolean Shorthand | `rpName: 'Nest Server'` |
| BetterAuth Cross-Subdomain Cookies | `betterAuth.crossSubDomainCookies` | Boolean Shorthand | `domain: auto (appUrl → baseUrl without api. prefix)` |
| BetterAuth Disable Sign-Up | `betterAuth.emailAndPassword.disableSignUp` | Explicit Boolean | `false` (sign-up enabled) |
| BetterAuth Server-Managed User Fields | `betterAuth.additionalUserFields[].input` | Explicit Boolean | `true` (Better-Auth default). `input: false` makes Better-Auth reject client-supplied values (`FIELD_NOT_ALLOWED` HTTP 400 on `/iam/update-user`; server default substituted on sign-up). The core fields `roles`, `verified`, `verifiedAt`, `twoFactorEnabled`, `iamId` are hard-locked to `input: false` via `PROTECTED_INPUT_FALSE_KEYS`, **re-asserted after** the `additionalUserFields` merge (and for any shadow field whose `fieldName` maps to a protected column) — a project override cannot re-open them. Closes vertical privilege-escalation (self-granting `roles`), email-verification bypass and 2FA self-toggle via the Better-Auth native input path. nest-server's own role path (`UserService.setRoles` / `CrudService.update` `checkRoles`) is unaffected. `termsAndPrivacyAcceptedAt` is `input: false` by default but intentionally NOT hard-locked (consent timestamp, not a privilege boundary) |
| Hub (Operator Cockpit) | `hub` | Presence Implies Enabled — but NEVER implicitly (must be set per environment) | `path: 'hub'`, `roles: [ADMIN]`, `actions: true`, `pollIntervalMs: 5000`, `collectors: { logs: on, traces: on, queries: off }`, `mailbox: off` (when set: `mode: 'capture'`, throws in production/staging), `migrations: { dir: './migrations' }`, `db: on`, `emailPreview: on`. Build-free ADMIN-gated dashboard (dashboard, diagnostics, logs, request traces, query profiler, cron, db, models/ERD, migrations, files, config, auth-migration, error-codes, email preview, mailbox, AI). Query profiler opts the driver into `monitorCommands`. Mailbox is a Mailpit-style capture hooked into `EmailService` via the optional `HUB_EMAIL_CAPTURE` token. Mutating actions require `X-Hub-Request` header + type-to-confirm keyword and write `[HUB-ACTION]` audit logs. Overrides via `CoreModule.forRoot(env, { hub: { controller, actionsController, service, htmlService, actionsService } })` |
| System Setup | `systemSetup` | Enabled by Default (when BetterAuth active) | `initialAdmin: undefined` |
| GraphQL | `graphQl` | Explicit Disable (`false`) | Enabled (full GraphQL stack) |
| Mongoose Password Plugin | `security.mongoosePasswordPlugin` | Boolean Shorthand | `true` (enabled), `skipPatterns: []` |
| Mongoose Role Guard Plugin | `security.mongooseRoleGuardPlugin` | Boolean Shorthand | `true` (enabled), `allowedRoles: []`. Bypass: `RequestContext.runWithBypassRoleGuard()` or `force: true` |
| Mongoose Audit Fields Plugin | `security.mongooseAuditFieldsPlugin` | Boolean Shorthand | `true` (enabled) |
| Response Model Interceptor | `security.responseModelInterceptor` | Boolean Shorthand | `true` (enabled), `debug: false` |
| Translate Response Interceptor | `security.translateResponseInterceptor` | Boolean Shorthand | `true` (enabled) |
| Secret Fields Removal | `security.secretFields` | Array | `['password', 'verificationToken', ...]` |
| Multi-Tenancy | `multiTenancy` | Presence Implies Enabled | `headerName: 'x-tenant-id'`, `membershipModel: 'TenantMember'`, `adminBypass: true`, `excludeSchemas: []`, `roleHierarchy: { member: 1, manager: 2, owner: 3 }`, `cacheTtlMs: 30000` (0 disables, process-local). System roles (`S_EVERYONE`, `S_USER`, `S_VERIFIED`) are checked as OR alternatives before real roles; method-level system roles take precedence; membership validated for context when system role grants access + header present. Hierarchy roles use level comparison, normal roles use exact match. Use `DefaultHR` or `createHierarchyRoles()` for type-safe role constants. Bypass: `RequestContext.runWithBypassTenantGuard()`. Cache invalidation: `CoreTenantGuard.invalidateUser(userId)` / `invalidateAll()` |
| BetterAuth Tenant Skip | `betterAuth.skipTenantCheck` | Explicit Boolean | `true` (default). When `true` and no `X-Tenant-Id` header is sent, IAM endpoints (controller + resolver) skip `CoreTenantGuard` tenant validation. When header IS present, normal membership validation runs regardless. Set `false` for tenant-aware auth scenarios (subdomain-based, invite links, SSO per tenant) |
| Debug Process Input | `debugProcessInput` | Explicit Boolean | `false` (default). When `true`, logs a debug message when `prepareInput()` changes the input type during `process()`. Has performance cost due to `JSON.stringify` on every `process()` call — enable only for debugging |
| JSONTransport Production Guard | `email.smtp` with `jsonTransport` | Runtime Guard | Throws `Error` when `email.smtp` has a truthy `jsonTransport` property in `production` or `staging` environments (read from config `env` field). JSONTransport silently discards all outgoing mail — the guard prevents accidental misconfiguration that causes password-reset, 2FA, and verification emails to vanish. Use `{ jsonTransport: true }` only in CI/e2e/local environments |
| Cookies | `cookies` | Boolean Shorthand (default true) | `true` (enabled), `exposeTokenInBody: false`. When enabled: loads `cookie-parser`, sets CORS `credentials: true`, sets signed httpOnly session cookies. When `exposeTokenInBody: true`: token stays in response body alongside cookies (for hybrid JWT+Cookie auth). JWT via `Authorization: Bearer` always works independently. **BetterAuth cookie name (since v11.27.6):** `createBetterAuthInstance()` pins `advanced.useSecureCookies: false` so BetterAuth's native handlers read the same UNPREFIXED `<cookiePrefix>.session_token` the helper writes (fixes a `401` split-brain on 2FA/passkey/`/token`); the `Secure` attribute is still applied on an `https://` baseURL via `advanced.defaultCookieAttributes`. Opt back into the `__Secure-` prefix with `betterAuth.options.advanced.useSecureCookies: true` only when BetterAuth manages cookies entirely |
| CORS | `cors` | Boolean Shorthand | `enabled: true`, `allowAll: false`, `deriveAppUrl: true`. Origins come from `appUrl`/`baseUrl`, resolved by the shared `resolveServerUrls()` helper (`cookies.helper.ts`) that ALL three CORS layers use (GraphQL, REST, BetterAuth `trustedOrigins`) — they can no longer drift. `appUrl` resolution: explicit → derived from a **host-split** localhost `baseUrl` (its `api.` label strips to a sibling host: `https://api.crm.localhost` → `https://crm.localhost`, as served by `lt dev up`; the port is preserved) → localhost default (`http://localhost:3001`, only for `env: local`/`ci`/`e2e` with a **port-split** localhost `baseUrl` — one host, API `:3000`, app `:3001`; `https://api.localhost` strips to the bare `localhost` the API already answers on and is therefore a port split, not a host split) → derived from `baseUrl` by stripping a leading `api.` label (`https://api.example.com` → `https://example.com`). **Security:** the derived origin receives credentialed CORS; set `deriveAppUrl: false` when the apex domain is not trusted, then list the frontend origin via `appUrl`/`allowedOrigins` (a host-split localhost `baseUrl` then falls back to the localhost default). The derivation never yields a bare TLD (`https://api.dev` unchanged) and never emits the opaque `null` origin (non-http(s) `baseUrl` passes through verbatim). `allowAll: true` mirrors the request origin for REST/GraphQL, but BetterAuth's `trustedOrigins` still resolve to `[appUrl]` (+ passkey origins) — an origin check has no "allow everything" mode, so a separately hosted frontend must appear in `appUrl`/`allowedOrigins` (or set `betterAuth.trustedOrigins` explicitly). `enabled: false` disables CORS on all layers including BetterAuth (`trustedOrigins: []`, which still trusts BetterAuth's own `baseURL`). Explicit `betterAuth.trustedOrigins` always takes precedence |
| AI Assistant | `ai` | Presence Implies Enabled | Core: `maxIterations: 5`, `defaultMode: 'auto'` (or `'plan'`), `rateLimit` (presence implies enabled: `max: 20`, `windowSeconds: 60`), `systemPrompt`, `documentation` (injected into the system prompt), `encryptionSecret`. **DB-backed LLM connections** (`aiConnections`, admin CRUD) with AES-256-GCM-encrypted API keys (`AiCryptoService`, secret from `ai.encryptionSecret` / `NSC__AI__ENCRYPTION_SECRET` / `SECRETS_ENCRYPTION_KEY`; `apiKeyEncrypted` is a global `secretFields` entry, never returned — only `hasApiKey`); optional `defaultConnection` one-time seed. **Provider abstraction** (`ILlmProvider`, default `OpenAiCompatibleProvider` for any OpenAI-compatible endpoint via `fetch`; per-connection `supportsNativeTools`/`supportsJsonResponse` capabilities, emulated tool calling when native tools are unavailable). **Tool registry** (`AiToolRegistry`, tools self-register, role-filtered; tools may be `mutating`/`destructive` and define `authorize()` for pre-flight data-level checks). **Plan mode** (`input.mode: 'plan'`): full plan → pre-flight authorize ALL steps → all-or-nothing execution with a translated (de/en) error when any step is not permitted. **Confirmation policy**: `confirmation.mutating: { default, enforced }` + client `input.requireConfirmation` (ignored when enforced); `destructive` always confirms. **Client metadata** (`input.metadata`: URL/nav/console logs, untrusted+capped). **Multi-turn conversations** (`aiConversations`, owner-scoped). **SSE streaming** (`POST /ai/stream`). **Audit** (`audit: false` → persist to `aiInteractions`, admin-readable). **Token budgets** (`budget: { period: 'day'|'month'|'none', user: { maxTokens?, maxPrompts? }, tenant: { maxTokens?, maxPrompts? } }`, requires audit): per-user AND per-tenant limits with config defaults; admins override per user/tenant at runtime (`aiBudgetLimits`, `CoreAiBudgetService`). Resolution: override → default → unlimited (missing/0 = unlimited). Enforced before the run (HTTP 429 + translated). Each response carries a compact `budget` summary (promptTokens, usedTokens, remainingTokens, resetAt); full breakdown via `aiUsage` query / `GET /ai/usage`. **Self-optimizing prompts**: the system prompt is assembled from keyed fragments (`CoreAiPromptBuilderService` ships built-in defaults; works with zero rows). Admin-editable overrides per slot (`aiSlots`, admin CRUD, `/ai/slots`) scoped by `key`/`locale`/`capability`/`tenantId`, with tenant override/reset semantics and placeholder tokens resolved at run time via the placeholder registry. **Governed learning loop** (`promptLearning: { enabled: true, autoApply: false }`): tool errors record `suggested` hints (`aiPromptHints`, admin CRUD, `/ai/prompt-hints`) that only reach the prompt once admin-approved (or auto-approved when `autoApply`); hints only ADD guidance, never relax permissions. **Context window** (`contextWindow`, default 8192; auto-detected per connection via `ILlmProvider.detectContextWindow()` — Ollama `/api/show` probe / known-model table / Claude alias — and persisted): per-user/session history is trimmed (oldest non-system turns dropped, last truncated) and tool-results capped to `maxToolResultChars` (default 12000) so a session never overflows the model. **Deferred tool schemas** (`deferToolSchemas`, default `false`): the system-prompt tool catalog then lists only tool NAMES + descriptions instead of full JSON schemas, and the model fetches a schema on demand via the built-in `search_tools` meta-tool — with a large registry the schemas alone can dominate a small context window. `deferToolSummaryChars` (default `0` = untruncated) additionally caps each description in that DEFERRED catalog: whole sentences up to the cap (always at least the first), word-boundary cut when the first sentence already exceeds it, and a `…` marker appended ON TOP of the cap. The default of `0` keeps the saving opt-in, so enabling `deferToolSchemas` alone never changes what a description says; set roughly 200–400 alongside it to actually reclaim the context. Both apply to EMULATED providers only — a connection with `supportsNativeTools: true` receives every full description + schema via `buildToolSchemas()` regardless, so truncation and the banner are skipped there rather than asserting a cut the tool payload contradicts. The omitted tail is where preconditions and role restrictions usually live — the catalog banner tells the model to fetch the full text via `search_tools` first, but this is model GUIDANCE only: authorization is enforced server-side by the registry's role filter (`forUser()`), the execution-time re-check, and the `mutating`/`destructive` flags read by the confirmation gate — never by what the catalog shows. (`AiTool.authorize()` runs in PLAN MODE only; in auto mode and over MCP, data-level checks must live inside `execute()`.) **MCP server** (`mcp: false` → `/ai/mcp` Streamable HTTP, Bearer auth, lazy `@modelcontextprotocol/sdk`; `mcp: { oauth: true, oauthSecret }` adds OAuth 2.1 — HMAC tokens + PKCE S256 + dynamic registration via `mountAiMcpOAuth(app)` in main.ts). Overrides via `CoreModule.forRoot(env, { ai: { budgetService, connectionResolver, connectionService, controller, conversationService, interactionService, mcpClientService, modeService, placeholderRegistry, preferenceService, promptBuilder, promptHintService, promptService, resolver, service, slotService, toolGrantService, toolPolicyService } })` |

## Module Override Pattern (via `ICoreModuleOverrides`)

For replacing default controllers, resolvers, or services of auto-registered core modules.

### Why a separate `overrides` parameter?

NestJS registers controllers at module scan time — there is no mechanism to replace them after registration.
When `CoreModule.forRoot()` auto-registers a module (e.g., ErrorCodeModule), the only way to use a custom controller
is to pass it **before** registration happens. A separate `overrides` parameter on `CoreModule.forRoot()` keeps
class references (code) cleanly separated from environment configuration (strings/numbers).

### Usage

```typescript
// IAM-only mode
CoreModule.forRoot(envConfig, {
  errorCode: { controller: ErrorCodeController, service: ErrorCodeService },
  betterAuth: { resolver: BetterAuthResolver },
})

// Legacy mode
CoreModule.forRoot(CoreAuthService, AuthModule.forRoot(envConfig.jwt), envConfig, {
  errorCode: { controller: ErrorCodeController, service: ErrorCodeService },
})
```

### Available Override Fields

| Module | Fields | Description |
|--------|--------|-------------|
| `ai` | `budgetService`, `connectionResolver`, `connectionService`, `controller`, `conversationService`, `interactionService`, `mcpClientService`, `modeService`, `placeholderRegistry`, `preferenceService`, `promptBuilder`, `promptHintService`, `promptService`, `resolver`, `service`, `slotService`, `toolGrantService`, `toolPolicyService` | Custom AI orchestrator, connection-resolution chain, connection/preference/budget/conversation/interaction/MCP-client services, slot + user-prompt + learning-hint stores, mode service, placeholder registry, tool-grant + tool-policy services, endpoints |
| `errorCode` | `controller`, `service` | Custom error code endpoint and/or service |
| `betterAuth` | `controller`, `resolver` | Custom IAM REST controller and/or GraphQL resolver |
| `hub` | `controller`, `actionsController`, `service`, `htmlService`, `actionsService` | Custom Hub page/actions controllers and aggregator/HTML/actions services (each must extend its `Core*` base) |

### Rules

1. Overrides take precedence over `betterAuth.controller`/`resolver` in config (backward compatible)
2. Only auto-registered modules are affected — `autoRegister: false` modules are imported separately
3. The `ICoreModuleOverrides` interface enforces type safety per module

### Alternative: `autoRegister: false`

For complex setups requiring additional providers or a custom module structure, disable auto-registration
and import the module separately:

```typescript
// config.env.ts
errorCode: { autoRegister: false }
betterAuth: { autoRegister: false }

// server.module.ts
@Module({
  imports: [
    CoreModule.forRoot(envConfig),
    ErrorCodeModule.forRoot({ controller: MyController, service: MyService }),
    BetterAuthModule.forRoot({ controller: MyController, resolver: MyResolver }),
  ],
})
```

## Checklist for New Configurable Features

When adding a new configurable feature:

### For "Presence Implies Enabled" Pattern:

- [ ] Define interface with `enabled?: boolean` as optional property
- [ ] Set `enabled: false` in DEFAULT_CONFIG
- [ ] Implement "presence implies enabled" logic in configure method
- [ ] Document all default values in interface JSDoc
- [ ] Add tests for: undefined config, empty object, partial config, explicit disable

### For "Boolean Shorthand" Pattern:

- [ ] Define separate interface for config options (e.g., `IBetterAuthJwtConfig`)
- [ ] Use union type: `property?: boolean | IPropertyConfig`
- [ ] Implement `isPluginEnabled()` helper for boolean/object handling
- [ ] Implement `getPluginConfig()` helper to normalize to object
- [ ] Add tests for: `true`, `false`, `{}`, `{ option: value }`, `{ enabled: false }`, `undefined`

### For "Module Override" Pattern:

- [ ] Add override fields to `ICoreModuleOverrides` interface
- [ ] Pass overrides through in `CoreModule.forRoot()` to the module's `forRoot()`
- [ ] Ensure the module's `forRoot()` accepts controller/resolver/service parameters
- [ ] Update this document with the new override fields
- [ ] Update module's INTEGRATION-CHECKLIST.md

### For Both Patterns:

- [ ] Update this document with the new feature
- [ ] Export new interfaces in `src/index.ts` (if needed)
