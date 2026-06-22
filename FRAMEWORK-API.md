# @lenne.tech/nest-server — Framework API Reference

> Auto-generated from source code on 2026-06-22 (v11.27.1)
> File: `FRAMEWORK-API.md` — compact, machine-readable API surface for Claude Code

## CoreModule.forRoot()

- `CoreModule.forRoot(options: Partial<IServerOptions>, overrides?: ICoreModuleOverrides)`: `DynamicModule`
- ~~`CoreModule.forRoot(AuthService: any, AuthModule: any, options: Partial<IServerOptions>, overrides?: ICoreModuleOverrides)`: `DynamicModule`~~ *(deprecated)*

## Configuration Interfaces

### IServerOptions

  - `ai?`: `boolean | IAi` — Configuration for the AI assistant module.
  - `appUrl?`: `string` — Base URL of the frontend/app application.
  - `auth?`: `IAuth` — Authentication system configuration
  - `automaticObjectIdFiltering?`: `boolean` — Automatically detect ObjectIds in string values in FilterQueries
  - `baseUrl?`: `string` — Base URL of the API server.
  - `betterAuth?`: `boolean | IBetterAuth` (default: `undefined (enabled with defaults)`) — Configuration for better-auth authentication framework.
  - `brevo?`: `{ apiKey: string; exclude?: RegExp; sender: { email: string; name: string; }; }` — Configuration for Brevo
  - `compression?`: `boolean | compression.CompressionOptions` — Whether to use the compression middleware package to enable gzip compression.
  - `cookies?`: `boolean | ICookiesConfig` (default: `true`) — Cookie configuration for authentication handling.
  - `cors?`: `boolean | ICorsConfig` (default: `undefined (enabled with auto-derived origins)`) — CORS (Cross-Origin Resource Sharing) configuration.
  - `cronJobs?`: `Record<string, string | false | 0 | CronJobConfigWithTimeZone<null, null> | C...` — Cron jobs configuration object with the name of the cron job function as key
  - `debugProcessInput?`: `boolean` (default: `false`) — When true, logs a debug message when prepareInput() changes the input type during process().
  - `email?`: `{ defaultSender?: { email?: string; name?: string; }; mailjet?: MailjetOption...` — SMTP and template configuration for sending emails
  - `env?`: `string` — Environment
  - `version?`: `string` — Semantic version of the running build (e.g. from package.json / meta.json).
  - `errorCode?`: `IErrorCode` — Configuration for the error code module
  - `execAfterInit?`: `string` — Exec a command after server is initialized
  - `filter?`: `{ maxLimit?: number; }` — Filter configuration and defaults
  - `graphQl?`: `false | { driver?: ApolloDriverConfig; enableSubscriptionAuth?: boolean; maxC...` — Configuration of the GraphQL module
  - `healthCheck?`: `{ configs?: { build?: { enabled?: boolean; }; database?: { enabled?: boolean;...` — Whether to activate health check endpoints
  - `hostname?`: `string` — Hostname of the server
  - `ignoreSelectionsForPopulate?`: `boolean` — Ignore selections in fieldSelection
  - `jwt?`: `IJwt & JwtModuleOptions & { refresh?: IJwt & { renewal?: boolean; }; sameToke...` — Configuration of JavaScript Web Token (JWT) module
  - `loadLocalConfig?`: `string | boolean` — Load local configuration
  - `logExceptions?`: `boolean` — Log exceptions (for better debugging)
  - `mongoose?`: `{ collation?: CollationOptions; modelDocumentation?: boolean; options?: Mongo...` — Configuration for Mongoose
  - `multiTenancy?`: `IMultiTenancy` (default: `undefined (disabled)`) — Multi-tenancy configuration for tenant-based data isolation.
  - `permissions?`: `boolean | IPermissions` (default: `undefined (disabled)`) — Permissions report module (development tool).
  - `port?`: `number` — Port number of the server
  - `security?`: `{ checkResponseInterceptor?: boolean | { checkObjectItself?: boolean; debug?:...` — Configuration for security pipes and interceptors
  - `sha256?`: `boolean` — Whether to enable verification and automatic encryption for received passwords that are not in sha256 format
  - `staticAssets?`: `{ options?: ServeStaticOptions; path?: string; }` — Configuration for useStaticAssets
  - `systemSetup?`: `ISystemSetup` — System setup configuration for initial admin creation.
  - `templates?`: `{ engine?: string; path?: string; }` — Templates
  - `tus?`: `boolean | ITusConfig` — TUS resumable upload configuration.

### IBetterAuth (type alias: IBetterAuthWithoutPasskey | IBetterAuthWithPasskey)

When `passkey` is enabled, `trustedOrigins` is required (compile-time enforcement).

  - `passkey?`: `IBetterAuthPasskeyDisabled` — Passkey/WebAuthn configuration (DISABLED or not configured).
  - `trustedOrigins?`: `string[]` — Trusted origins for CORS configuration.

### IAuth

  - `legacyEndpoints?`: `IAuthLegacyEndpoints` — Configuration for legacy auth endpoints
  - `preventUserEnumeration?`: `boolean` (default: `false (backward compatible - specific error messages)`) — Prevent user enumeration via unified error messages
  - `rateLimit?`: `IAuthRateLimit` (default: `{ enabled: false }`) — Rate limiting configuration for Legacy Auth endpoints

### IMultiTenancy

  - `enabled?`: `boolean` (default: `true (when config object is present)`) — Explicitly disable multi-tenancy even when config is present.
  - `excludeSchemas?`: `string[]` — Model names (NOT collection names) to exclude from tenant filtering.
  - `headerName?`: `string` (default: `'x-tenant-id'`) — Header name for tenant selection.
  - `membershipModel?`: `string` (default: `'TenantMember'`) — Mongoose model name for the membership collection.
  - `adminBypass?`: `boolean` (default: `true`) — Whether system admins (RoleEnum.ADMIN) bypass the membership check.
  - `roleHierarchy?`: `Record<string, number>` (default: `{ member: 1, manager: 2, owner: 3 }`) — Custom role hierarchy for tenant membership roles.
  - `cacheTtlMs?`: `number` (default: `30000 (30 seconds)`) — TTL in milliseconds for the tenant guard's in-memory membership cache.

### IErrorCode

  - `additionalErrorRegistry?`: `Record<string, { code: string; message: string; translations: { [locale: stri...` — Additional error registry to merge with core LTNS_* errors
  - `autoRegister?`: `boolean` (default: `true`) — Automatically register the ErrorCodeModule in CoreModule

### IJwt

  - `privateKey?`: `string` — Private key
  - `publicKey?`: `string` — Public key
  - `secret?`: `string` — Secret to encrypt the JWT
  - `secretOrKeyProvider?`: `(request: Record<string, any>, rawJwtToken: string, done: (err: any, secret: ...` — JWT Provider
  - `secretOrPrivateKey?`: `string` — Alias of secret (for backwards compatibility)
  - `signInOptions?`: `JwtSignOptions` — SignIn Options like expiresIn

### ICookiesConfig

  - `enabled?`: `boolean` (default: `true`) — Whether cookies are enabled.
  - `exposeTokenInBody?`: `boolean` (default: `false`) — Whether to include the session token in the response body when cookies are enabled.

### ICorsConfig

  - `allowAll?`: `boolean` (default: `false`) — Allow all origins by mirroring the request Origin header back.
  - `allowedOrigins?`: `string[]` — Additional allowed origins beyond `appUrl` and `baseUrl`.
  - `enabled?`: `boolean` (default: `true`) — Whether CORS is enabled.

### IAi

  - `allowedBaseUrlHosts?`: `string[]` — Optional SSRF allowlist for connection base URLs. When set (non-empty), the
  - `audit?`: `boolean` (default: `false`) — Persist an audit record (`aiInteractions`) for every prompt run (admin-readable).
  - `budget?`: `{ period?: "day" | "month" | "none"; tenant?: { maxPrompts?: number; maxToken...` — Token/prompt budgets for AI prompts, enforced before a run (HTTP 429 + translated
  - `confirmation?`: `{ mutating?: { default?: boolean; enforced?: boolean; }; }` — Confirmation policy for mutating tool actions (create/update/delete).
  - `documentation?`: `string` — System documentation injected into the system prompt to inform the LLM
  - `defaultConnection?`: `IAiDefaultConnection` — Optional one-time seed for a default connection (see {@link IAiDefaultConnection}).
  - `defaultMode?`: `"auto" | "plan"` (default: `'auto'`) — Default execution mode when the client does not specify one.
  - `enabled?`: `boolean` — Explicitly disable while keeping the config (default: enabled when present).
  - `encryptionSecret?`: `string` — Pass-phrase used to derive the AES-256-GCM key for encrypting connection API
  - `contextWindow?`: `number` (default: `8192`) — Fallback total context window (input + output tokens) used to budget the
  - `claudeCli?`: `{ bin?: string; extraArgs?: string[]; maxBudgetUsd?: number; }` — Optional config for the `ClaudeCliProvider` (LLM backend that invokes a local
  - `compaction?`: `boolean` (default: `true`) — LLM-driven context compaction: when a session would overflow the connection's
  - `deferToolSchemas?`: `boolean` (default: `false`) — Defer the parameter schemas of tools out of the system prompt. With many tools
  - `maxIterations?`: `number` (default: `5`) — Maximum number of agent-loop iterations (tool round-trips).
  - `maxToolResultChars?`: `number` (default: `12000`) — Maximum characters of a tool-results payload fed back to the model.
  - `promptLearning?`: `{ autoApply?: boolean; enabled?: boolean; minOccurrences?: number; }` — Governed self-improvement loop for the system prompt. The orchestrator records
  - `mcp?`: `boolean | { enabled?: boolean; oauth?: boolean; oauthSecret?: string; }` (default: `false`) — Expose the tool registry as an MCP server at `/ai/mcp` (Streamable HTTP) for
  - `rateLimit?`: `IAiRateLimit` — Rate limiting for prompts.
  - `systemPrompt?`: `string` — Base system prompt prepended to every conversation.

### IAiRateLimit

  - `enabled?`: `boolean` — Explicitly disable while keeping the config (default: enabled when present).
  - `max?`: `number` (default: `20`) — Maximum number of prompts per window per user.
  - `windowSeconds?`: `number` (default: `60`) — Window length in seconds.

### IAiDefaultConnection

  - `apiKey?`: `string` — Inline plaintext API key (encrypted on seed). Prefer `apiKeyEnv` instead.
  - `apiKeyEnv?`: `string` — Name of an environment variable holding the API key (e.g. 'AI_API_KEY').
  - `baseUrl`: `string` — Base URL of the OpenAI-compatible endpoint.
  - `capabilities?`: `string[]` — Capability tags (free-form, e.g. 'analysis', 'vision').
  - `defaultMaxTokens?`: `number` — Default maximum number of tokens for completions.
  - `defaultTemperature?`: `number` — Default sampling temperature.
  - `description?`: `string` — Human-readable description.
  - `model`: `string` — Model id sent to the backend (e.g. 'gpt-oss-120b').
  - `name`: `string` — Human-readable connection name.
  - `providerType?`: `string` — Provider type (default 'openai-compatible').
  - `supportsJsonResponse?`: `boolean` — Native JSON / structured-output support. Omit to auto-detect by probing the
  - `supportsNativeTools?`: `boolean` — Native function/tool-calling support. Omit to auto-detect by probing the
  - `supportsVision?`: `boolean` — Whether the model supports image input.

### ICoreModuleOverrides

  - `ai?`: `{ budgetService?: Type<any>; connectionResolver?: Type<any>; connectionServic...` — Override AI module collaborators with project-specific subclasses.
  - `betterAuth?`: `{ controller?: Type<any>; resolver?: Type<any>; }` — Override BetterAuth controller and/or resolver.
  - `errorCode?`: `{ controller?: Type<any>; service?: Type<any>; }` — Override ErrorCode controller and/or service.

### IBetterAuthPasskeyConfig

  - `authenticatorAttachment?`: `"cross-platform" | "platform"` (default: `undefined (both allowed)`) — Authenticator attachment preference.
  - `challengeStorage?`: `"cookie" | "database"` (default: `'database'`) — Where to store WebAuthn challenges.
  - `challengeTtlSeconds?`: `number` (default: `300 (5 minutes)`) — TTL in seconds for database-stored challenges.
  - `enabled?`: `boolean` (default: `true (when config block is present)`) — Whether passkey authentication is enabled.
  - `origin?`: `string` — Origin URL for WebAuthn.
  - `residentKey?`: `"discouraged" | "preferred" | "required"` (default: `'preferred'`) — Resident key (discoverable credential) requirement.
  - `rpId?`: `string` — Relying Party ID (usually the domain without protocol).
  - `rpName?`: `string` — Relying Party Name (displayed to users)
  - `userVerification?`: `"discouraged" | "preferred" | "required"` (default: `'preferred'`) — User verification requirement.
  - `webAuthnChallengeCookie?`: `string` (default: `'better-auth-passkey'`) — Custom cookie name for WebAuthn challenge storage.

### IBetterAuthTwoFactorConfig

  - `appName?`: `string` (default: `'Nest Server'`) — App name shown in authenticator apps.
  - `enabled?`: `boolean` (default: `true (enabled by default when BetterAuth is active)`) — Whether 2FA is enabled.

### IBetterAuthJwtConfig

  - `enabled?`: `boolean` (default: `true (enabled by default when BetterAuth is active)`) — Whether JWT plugin is enabled.
  - `expiresIn?`: `string` (default: `'15m'`) — JWT expiration time

### IBetterAuthEmailVerificationConfig

  - `autoSignInAfterVerification?`: `boolean` (default: `true`) — Whether to automatically sign in the user after email verification.
  - `brevoTemplateId?`: `number` (default: `undefined (uses SMTP/EJS templates)`) — Brevo template ID for verification emails.
  - `callbackURL?`: `string` (default: `undefined (backend-handled verification)`) — Frontend callback URL for email verification.
  - `enabled?`: `boolean` (default: `true (enabled by default when BetterAuth is active)`) — Whether email verification is enabled.
  - `expiresIn?`: `number` (default: `86400 (24 hours)`) — Time in seconds until the verification link expires.
  - `locale?`: `string` (default: `'en'`) — Locale for the verification email template.
  - `resendCooldownSeconds?`: `number` (default: `60`) — Cooldown in seconds between resend requests for the same email address.
  - `template?`: `string` (default: `'email-verification'`) — Custom template name for the verification email.

### IBetterAuthRateLimit

  - `enabled?`: `boolean` (default: `false`) — Whether rate limiting is enabled
  - `max?`: `number` (default: `10`) — Maximum number of requests within the time window
  - `maxEntries?`: `number` (default: `10000`) — Maximum number of entries in the in-memory rate limit store.
  - `message?`: `string` — Custom message when rate limit is exceeded
  - `skipEndpoints?`: `string[]` — Endpoints to skip rate limiting entirely
  - `strictEndpoints?`: `string[]` — Endpoints to apply stricter rate limiting (e.g., sign-in, sign-up)
  - `windowSeconds?`: `number` — Time window in seconds

### IBetterAuthSignUpChecksConfig

  - `enabled?`: `boolean` (default: `true (enabled by default when BetterAuth is active)`) — Whether sign-up checks are enabled.
  - `requiredFields?`: `string[]` (default: `['termsAndPrivacyAccepted']`) — Fields that must be provided and truthy during sign-up.

### ServiceOptions

  - `checkRights?`: `boolean`
  - `collation?`: `CollationOptions`
  - `create?`: `boolean`
  - `currentUser?`: `{ [key: string]: any; id: string; roles?: string[]; }`
  - `fieldSelection?`: `FieldSelection`
  - `force?`: `boolean`
  - `inputType?`: `new (...params: any[]) => any`
  - `outputType?`: `new (...params: any[]) => any`
  - `populate?`: `string | PopulateOptions | (string | PopulateOptions)[]`
  - `prepareInput?`: `PrepareInputOptions`
  - `prepareOutput?`: `PrepareOutputOptions`
  - `processFieldSelection?`: `{ dbModel?: Model<any>; ignoreSelections?: boolean; model?: new (...args: any...`
  - `pubSub?`: `boolean`
  - `raw?`: `boolean`
  - `roles?`: `string | string[]`
  - `select?`: `string | string[] | Record<string, number | boolean | object>`
  - `setCreateOrUpdateUserId?`: `boolean`

## CrudService Methods

Base class for all services. Located at `src/core/common/services/crud.service.ts`.

Generic: `CrudService<Model, CreateInput, UpdateInput>`

- `async aggregate(pipeline: PipelineStage[], serviceOptions?: ServiceOptions & { aggregateOptions?: AggregateOptions; })`: `Promise<T>` — Aggregate
- `async aggregateForce(pipeline: PipelineStage[], serviceOptions?: ServiceOptions)`: `Promise<T>` — Aggregate without checks or restrictions
- `async aggregateRaw(pipeline: PipelineStage[], serviceOptions?: ServiceOptions)`: `Promise<T>` — Aggregate without checks, restrictions or preparations
- `async create(input: PlainObject<CreateInput>, serviceOptions?: ServiceOptions)`: `Promise<Model>` — Create item
- `async createForce(input: PlainObject<CreateInput>, serviceOptions?: ServiceOptions)`: `Promise<Model>` — Create item without checks or restrictions
- `async createRaw(input: PlainObject<CreateInput>, serviceOptions?: ServiceOptions)`: `Promise<Model>` — Create item without checks, restrictions or preparations
- `distinct(property: string)`: `Promise<string[]>` — Get distinct values of a property
- `async get(id: string, serviceOptions?: ServiceOptions)`: `Promise<Model>` — Get item by ID
- `async getForce(id: string, serviceOptions?: ServiceOptions)`: `Promise<Model>` — Get item by ID without checks or restrictions
- `async getRaw(id: string, serviceOptions?: ServiceOptions)`: `Promise<Model>` — Get item by ID without checks, restrictions or preparations
- `async find(filter?: FilterArgs | { filterQuery?: QueryFilter<any>; queryOptions?: QueryOptions; s..., serviceOptions?: ServiceOptions)`: `Promise<Model[]>` — Get items via filter
- `async findForce(filter?: FilterArgs | { filterQuery?: QueryFilter<any>; queryOptions?: QueryOptions; s..., serviceOptions?: ServiceOptions)`: `Promise<Model[]>` — Get items via filter without checks or restrictions
- `async findRaw(filter?: FilterArgs | { filterQuery?: QueryFilter<any>; queryOptions?: QueryOptions; s..., serviceOptions?: ServiceOptions)`: `Promise<Model[]>` — Get items via filter without checks, restrictions or preparations
- `async findAndCount(filter?: FilterArgs | { filterQuery?: QueryFilter<any>; queryOptions?: QueryOptions; s..., serviceOptions?: ServiceOptions)`: `Promise<{ items: Model[]; pagination: PaginationInfo; totalCount: number; }>` — Get items and total count via filter
- `async findAndCountForce(filter?: FilterArgs | { filterQuery?: QueryFilter<any>; queryOptions?: QueryOptions; s..., serviceOptions?: ServiceOptions)`: `Promise<{ items: Model[]; pagination: PaginationInfo; totalCount: number; }>` — Get items and total count via filter without checks or restrictions
- `async findAndCountRaw(filter?: FilterArgs | { filterQuery?: QueryFilter<any>; queryOptions?: QueryOptions; s..., serviceOptions?: ServiceOptions)`: `Promise<{ items: Model[]; pagination: PaginationInfo; totalCount: number; }>` — Get items and total count via filter without checks, restrictions or preparations
- `async findAndUpdate(filter: FilterArgs | { filterQuery?: QueryFilter<any>; queryOptions?: QueryOptions; s..., update: PlainObject<UpdateInput>, serviceOptions?: ServiceOptions)`: `Promise<Model[]>` — Find and update
- `async findAndUpdateForce(filter: FilterArgs | { filterQuery?: QueryFilter<any>; queryOptions?: QueryOptions; s..., update: PlainObject<UpdateInput>, serviceOptions?: ServiceOptions)`: `Promise<Model[]>` — Find and update without checks or restrictions
- `async findAndUpdateRaw(filter: FilterArgs | { filterQuery?: QueryFilter<any>; queryOptions?: QueryOptions; s..., update: PlainObject<UpdateInput>, serviceOptions?: ServiceOptions)`: `Promise<Model[]>` — Find and update without checks, restrictions or preparations
- `async findOne(filter?: FilterArgs | { filterQuery?: QueryFilter<any>; queryOptions?: QueryOptions; }, serviceOptions?: ServiceOptions)`: `Promise<Model>` — Find one item via filter
- `async findOneForce(filter?: FilterArgs | { filterQuery?: QueryFilter<any>; queryOptions?: QueryOptions; s..., serviceOptions?: ServiceOptions)`: `Promise<Model>` — Find one item via filter without checks or restrictions
- `async findOneRaw(filter?: FilterArgs | { filterQuery?: QueryFilter<any>; queryOptions?: QueryOptions; s..., serviceOptions?: ServiceOptions)`: `Promise<Model>` — Find one item via filter without checks, restrictions or preparations
- `getModel()`: `MongooseModel<Document<Types.ObjectId, any, any, Record<string, any>, {}> & M...` — Get service model to process queries directly.
- `getNativeCollection(reason: string)`: `Collection<Document>` — Get the native MongoDB Collection, bypassing all Mongoose plugins.
- `getNativeConnection(reason: string)`: `Connection` — Get the Mongoose Connection (which provides access to the native MongoDB Db and MongoClient).
- `validateNativeAccessReason(reason: string, method: string)`: `void`
- `async read(input: string | FilterArgs | { filterQuery?: QueryFilter<any>; queryOptions?: QueryO..., serviceOptions?: ServiceOptions)`: `Promise<Model | Model[]>` — CRUD alias for get or find
- `async readForce(input: string | FilterArgs | { filterQuery?: QueryFilter<any>; queryOptions?: QueryO..., serviceOptions?: ServiceOptions)`: `Promise<Model | Model[]>` — CRUD alias for getForce or findForce
- `async readRaw(input: string | FilterArgs | { filterQuery?: QueryFilter<any>; queryOptions?: QueryO..., serviceOptions?: ServiceOptions)`: `Promise<Model | Model[]>` — CRUD alias for getRaw or findRaw
- `async update(id: string, input: PlainObject<UpdateInput>, serviceOptions?: ServiceOptions)`: `Promise<Model>` — Update item via ID
- `async updateForce(id: string, input: PlainObject<UpdateInput>, serviceOptions?: ServiceOptions)`: `Promise<Model>` — Update item via ID without checks or restrictions
- `async updateRaw(id: string, input: PlainObject<UpdateInput>, serviceOptions?: ServiceOptions)`: `Promise<Model>` — Update item via ID without checks, restrictions or preparations
- `async delete(id: string, serviceOptions?: ServiceOptions)`: `Promise<Model>` — Delete item via ID
- `async deleteForce(id: string, serviceOptions?: ServiceOptions)`: `Promise<Model>` — Delete item via ID without checks or restrictions
- `async deleteRaw(id: string, serviceOptions?: ServiceOptions)`: `Promise<Model>` — Delete item via ID without checks, restrictions or preparations
- `async pushToArray(id: string | Types.ObjectId | { id?: any; _id?: any; }, field: string, items: any, options?: { $slice?: number; $position?: number; $sort?: Record<string, 1 | -1>; })`: `Promise<void>` — Append items to an array field without loading the full array.
- `async pullFromArray(id: string | Types.ObjectId | { id?: any; _id?: any; }, field: string, condition: any)`: `Promise<void>` — Remove items from an array field.
- `async processQueryOrDocument(queryOrDocument: Document<Types.ObjectId, any, any, Record<string, any>, {}> | Document<Types...., serviceOptions?: ServiceOptions)`: `Promise<T>` — Execute, populate and map Mongoose query or document(s) with serviceOptions

**Variants:** Each method has three variants:
- `method()` — Standard: applies `securityCheck()`, respects permissions
- `methodForce()` — Bypasses `securityCheck()`, still applies input validation
- `methodRaw()` — Direct database access, no security or validation

## Core Modules

| Module | Docs | Path |
|--------|------|------|
| `ai` | README, CHECKLIST | `src/core/modules/ai/` |
| `auth` | — | `src/core/modules/auth/` |
| `better-auth` | README, CHECKLIST | `src/core/modules/better-auth/` |
| `error-code` | CHECKLIST | `src/core/modules/error-code/` |
| `file` | README | `src/core/modules/file/` |
| `health-check` | — | `src/core/modules/health-check/` |
| `migrate` | README | `src/core/modules/migrate/` |
| `permissions` | README, CHECKLIST | `src/core/modules/permissions/` |
| `system-setup` | README, CHECKLIST | `src/core/modules/system-setup/` |
| `tenant` | README, CHECKLIST | `src/core/modules/tenant/` |
| `tus` | README, CHECKLIST | `src/core/modules/tus/` |
| `user` | — | `src/core/modules/user/` |

## Key Source Files

| File | Purpose |
|------|---------|
| `src/core.module.ts` | CoreModule.forRoot() — module registration |
| `src/core/common/interfaces/server-options.interface.ts` | All config interfaces |
| `src/core/common/interfaces/service-options.interface.ts` | ServiceOptions interface |
| `src/core/common/services/crud.service.ts` | CrudService base class |
| `src/core/common/services/config.service.ts` | ConfigService (global) |
| `src/core/common/decorators/` | @Restricted, @Roles, @CurrentUser, @UnifiedField |
| `src/core/common/interceptors/` | CheckResponse, CheckSecurity, ResponseModel |
| `docs/REQUEST-LIFECYCLE.md` | Complete request lifecycle |
| `.claude/rules/` | Detailed rules for architecture, security, testing |
