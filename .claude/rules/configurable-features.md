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
| Cookies | `cookies` | Boolean Shorthand (default true) | `true` (enabled), `exposeTokenInBody: false`. When enabled: loads `cookie-parser`, sets CORS `credentials: true`, sets signed httpOnly session cookies. When `exposeTokenInBody: true`: token stays in response body alongside cookies (for hybrid JWT+Cookie auth). JWT via `Authorization: Bearer` always works independently |
| CORS | `cors` | Boolean Shorthand | `enabled: true`, `allowAll: false`, origins auto-derived from `appUrl`/`baseUrl`. Propagates to all three CORS layers (GraphQL, REST, BetterAuth `trustedOrigins`). `allowAll: true` mirrors request origin. `enabled: false` disables CORS on all layers including BetterAuth. Explicit `betterAuth.trustedOrigins` always takes precedence |

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
| `errorCode` | `controller`, `service` | Custom error code endpoint and/or service |
| `betterAuth` | `controller`, `resolver` | Custom IAM REST controller and/or GraphQL resolver |

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
