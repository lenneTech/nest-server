# Request Lifecycle & Security Architecture

This document explains the complete lifecycle of a request through `@lenne.tech/nest-server`, covering both REST and GraphQL flows, all security mechanisms, and the interaction between CrudService and the Safety Net.

> **Audience:** Developers and AI agents building on nest-server who want to understand what features are available, how data flows, where security is enforced, and how to use or extend the framework correctly.

---

## Table of Contents

- [Features Overview](#features-overview)
- [Architecture Overview](#architecture-overview)
- [Request Flow Diagram](#request-flow-diagram)
- [Phase 1: Incoming Request](#phase-1-incoming-request)
- [Phase 2: Authorization & Validation](#phase-2-authorization--validation)
- [Phase 3: Handler Execution](#phase-3-handler-execution)
- [Phase 4: Response Processing](#phase-4-response-processing)
- [CrudService.process() Pipeline](#crudserviceprocess-pipeline)
- [Safety Net Architecture](#safety-net-architecture)
- [Decorators Reference](#decorators-reference)
- [Model System](#model-system)
- [REST vs GraphQL Differences](#rest-vs-graphql-differences)
- [Configuration Reference](#configuration-reference)
- [NestJS Documentation Links](#nestjs-documentation-links)

---

## Features Overview

`@lenne.tech/nest-server` extends NestJS with a complete application framework for GraphQL + REST APIs with MongoDB. The following sections list **all features** available out of the box.

### Core Module

The `CoreModule` is a dynamic module that bootstraps the entire framework:

| Feature | Description |
|---------|-------------|
| **GraphQL Integration** | Apollo Server with auto-schema generation (disable via `graphQl: false`) |
| **MongoDB Integration** | Mongoose ODM with automatic connection management |
| **Dual API Support** | GraphQL and REST in the same application |
| **Security Pipeline** | 4 global interceptors, global validation pipe, middleware stack |
| **Mongoose Plugins** | Auto-registration of ID, password, audit, and role guard plugins |
| **GraphQL Subscriptions** | WebSocket support with JWT/session authentication (cluster-wide when `redis` is configured — see the Subscriptions row under GraphQL Features) |
| **Central Redis (optional)** | `CoreRedisService` — globally provided **and exported** by `CoreModule`, always present but **inert unless `redis` is configured** ("presence implies enabled"). Injected with `@Optional()`; every consumer keeps a process-local fallback. One service serves all features: shared client (`getClient()`), one cached subscriber (`getSubscriber()` — a subscribing client cannot run commands), dedicated connections (`createClient(label)`); all tracked and quit on shutdown. Keys are namespaced by the framework per key via `key(...)`, **not** through ioredis's own `keyPrefix` (that would collide with BullMQ's prefix). Requires the OPTIONAL peer `ioredis` — configured but missing **fails the boot**. Switches on: exact cross-replica rate limits, cron deduplication, `CoreRedisPubSub` as `PUB_SUB`, tenant-cache invalidation broadcast, Hub collector mirroring, MCP session registry |
| **Central S3 (optional)** | `CoreS3Service` — globally provided **and exported** by `CoreModule`, inert unless `s3` is configured *and* names a `bucket` (a bucket-less block is ignored with a warning). Backs `file.storage: 's3'` and TUS staging (`tus.s3Staging`). Requires the OPTIONAL peers `@aws-sdk/client-s3` (+ `@aws-sdk/s3-request-presigner` for `presignedDownloads`) — configured but missing **fails the boot** |
| **Configuration System** | `config.env.ts` with ENV variables, `NEST_SERVER_CONFIG` JSON, `NSC__*` prefixes |
| **Cookie Handling** | Enabled by default (`cookies: true`), configurable via `ICookiesConfig` with `exposeTokenInBody` option |
| **Unified CORS** | Single `cors` config propagates to GraphQL, REST, and BetterAuth layers |
| **Dual Auth Modes** | IAM-Only (BetterAuth) or Legacy+IAM for migration periods |

### Authentication & Authorization

#### BetterAuth Module (recommended)

Modern OAuth-compatible authentication with plugin architecture:

| Feature | Description |
|---------|-------------|
| **Session Management** | Secure session-based auth with automatic token rotation |
| **JWT Tokens** | Stateless API authentication (plugin) |
| **2FA / TOTP** | Two-factor authentication (plugin) |
| **Passkey / WebAuthn** | Passwordless authentication (plugin) |
| **Social Login** | OAuth providers: Google, GitHub, Apple, Discord, etc. (plugin) |
| **Email Verification** | Configurable email verification flow |
| **Sign-Up Validation** | Custom validation hooks for registration |
| **Rate Limiting** | Per-endpoint rate limits (`betterAuth.rateLimit`, configurable). Counters live behind a `RateLimitStore`: `RedisRateLimitStore` when `redis` is configured, so `max` is enforced **exactly across replicas** instead of `max × replicas`; otherwise the process-local `InMemoryRateLimitStore` as before. `check()` / `reset()` / `clear()` are **async** since 11.33.0. On a Redis outage it degrades to the in-memory counter and logs once per transition — never a 500, never "allowed". Counters are keyed on `request.ip`, which Express derives from `X-Forwarded-For` only as far as `trust proxy` allows — set `trustProxy` (§ServerOptions) behind a reverse proxy or every client resolves to the proxy and shares ONE bucket; unset with a limiter enabled logs a boot warning |
| **Cross-Subdomain Cookies** | Automatic cookie domain configuration |
| **Organization / Multi-Tenant** | Teams and organization management (plugin) |
| **3 Registration Patterns** | Zero-config, overrides parameter, or manual (`autoRegister: false`) |

#### Legacy Auth Module (backward compatible)

JWT-based authentication for existing projects:

| Feature | Description |
|---------|-------------|
| **JWT Authentication** | Bearer token auth with Passport strategies |
| **Refresh Tokens** | Automatic token renewal |
| **Sign In / Sign Up / Logout** | GraphQL mutations + REST endpoints |
| **Rate Limiting** | Configurable per-endpoint rate limits (`auth.rateLimit`). Same `RateLimitStore` selection, async signatures and Redis-outage degradation as the BetterAuth row above (namespace `legacy-auth`) |
| **Legacy Endpoint Controls** | Legacy endpoints are OFF unless `auth.legacyEndpoints.enabled: true` (default flipped in 11.38.0 — it was an opt-out, it is now an opt-in). `CoreLegacyAuthDeprecationInitializer` reports the state and the IAM migration progress at boot |
| **Migration Tracking** | `betterAuthMigrationStatus` query for monitoring |

#### Role System

| Feature | Description |
|---------|-------------|
| **Real Roles** | `ADMIN` (stored in `user.roles`) |
| **System Roles** | `S_USER`, `S_VERIFIED`, `S_CREATOR`, `S_SELF`, `S_EVERYONE`, `S_NO_ONE` (runtime-only, never stored) |
| **Hierarchy Roles** | Configurable via `multiTenancy.roleHierarchy` (default: `member`, `manager`, `owner`). Level comparison: higher includes lower. Use `DefaultHR` or `createHierarchyRoles()`. |
| **Method-Level Auth** | `@Roles()` decorator on resolvers/controllers |
| **Field-Level Auth** | `@Restricted()` decorator on model properties |
| **Membership Checks** | `@Restricted({ memberOf: 'teamMembers' })` |
| **Input/Output Restriction** | `@Restricted({ processType: ProcessType.INPUT })` |

### Security Features

| Feature | Description |
|---------|-------------|
| **Input Whitelisting** | `MapAndValidatePipe` strips/rejects unknown properties |
| **Input Validation** | `class-validator` integration via `@UnifiedField()` |
| **Password Hashing Plugin** | Automatic BCrypt hashing on all Mongoose write operations |
| **Role Guard Plugin** | Prevents unauthorized role escalation at database level |
| **Audit Fields Plugin** | Automatic `createdBy`/`updatedBy` tracking |
| **Response Model Interceptor** | Auto-converts plain objects to CoreModel instances |
| **Security Check Interceptor** | Calls `securityCheck()` + removes secret fields |
| **Response Filter Interceptor** | Enforces `@Restricted()` field-level access |
| **Translation Interceptor** | Applies `_translations` based on `Accept-Language` |
| **Secret Fields Removal** | Configurable fallback removal of password, tokens, etc. |
| **RequestContext** | `AsyncLocalStorage`-based context for current user in Mongoose hooks |
| **Query Complexity** | GraphQL query complexity analysis to prevent DoS |
| **Tenant Isolation** | Header-based multi-tenant isolation with membership validation (opt-in) |
| **Tenant Guard** | `CoreTenantGuard` validates tenant membership; system roles (`S_EVERYONE`, `S_USER`, `S_VERIFIED`) are checked as OR alternatives before real roles; hierarchy roles (`@Roles(DefaultHR.MEMBER)`), `@SkipTenantCheck()`, BetterAuth auto-skip (`betterAuth.skipTenantCheck`) |
| **Tenant Plugin Safety Net** | Mongoose tenant plugin throws `ForbiddenException` when tenant-schema is accessed without valid tenant context |

### Data & CRUD

| Feature | Description |
|---------|-------------|
| **CrudService** | Abstract CRUD with `process()` pipeline (input/output security) |
| **Filtering** | `FilterArgs` with comparison operators (`eq`, `ne`, `gt`, `in`, `contains`, etc.) |
| **Pagination** | `PaginationArgs` with `limit`/`offset`, returns `PaginationInfo` |
| **Sorting** | `SortInput` with `ASC`/`DESC` |
| **Population** | `@GraphQLPopulate()` for automatic relation loading |
| **Field Selection** | GraphQL field selection drives Mongoose population |
| **Aggregation** | Pipeline support via CrudService |
| **Bulk Operations** | Batch create/update/delete |
| **Force Mode** | `force: true` bypasses all security checks |
| **Raw Mode** | `raw: true` skips prepareInput/prepareOutput |

### Models & Inputs

| Feature | Description |
|---------|-------------|
| **CoreModel** | Base class with `map()`, `securityCheck()`, `hasRole()` |
| **CorePersistenceModel** | Adds `id`, `createdAt`, `updatedAt`, `createdBy`, `updatedBy` |
| **CoreInput** | Base input type for validation |
| **@UnifiedField()** | Combines `@Field()`, `@ApiProperty()`, `@IsOptional()` in one decorator |
| **Nested Validation** | Recursive object/array validation via `nestedTypeRegistry` |
| **Exclude/Include** | `@UnifiedField({ exclude: true/false })` for inheritance control |

### Custom Decorators

| Decorator | Purpose |
|-----------|---------|
| `@Roles(...roles)` | Method-level authorization (includes JWT auth) |
| `@Restricted(...roles)` | Field-level access control |
| `@CurrentUser()` | Inject authenticated user (REST + GraphQL) |
| `@UnifiedField(options)` | Combined schema, validation, and API metadata |
| `@GraphQLPopulate(config)` | Mongoose populate configuration |
| `@GraphQLServiceOptions()` | Service options injection (GraphQL) |
| `@RestServiceOptions()` | Service options injection (REST) |
| `@ResponseModel(Model)` | REST response type hint for auto-conversion |
| `@Translatable()` | Multi-language field metadata |
| `@CommonError(code)` | Error code registration |
| `@SkipTenantCheck()` | Opt out of CoreTenantGuard validation on a method |

### File Handling

| Feature | Description |
|---------|-------------|
| **File Module** | Upload/download with MongoDB GridFS storage |
| **REST Endpoints** | `GET /files/id/:id`, `GET /files/:filename` (core, gated by `file.downloadRoles`, default ADMIN); `POST /files/upload`, `DELETE /files/:id` (project-specific) |
| **GraphQL Endpoints** | `getFileInfo` (`file.downloadRoles`), `uploadFile` / `uploadFiles` (`file.uploadRoles`), `deleteFile` (`file.deleteRoles`) — all default ADMIN |
| **File access control** | Roles are the coarse filter; per-file rules go in `CoreFileService.checkRights()` using metadata written at upload time. Cover BOTH the `id` and the `filename` branch — the filename route authorizes on the by-name lookup alone when presigned S3 downloads are on, and `deleteFileByName()` always does. Working reference: `src/server/modules/file/file.service.ts` (with `file.downloadRoles: [S_USER]` in `src/config.env.ts`, so the rule is actually reached). Both file classes carry `@SkipTenantCheck()` — GridFS is not tenant-scoped |
| **TUS Module** | Resumable uploads via tus.io protocol (creation, termination, expiration), gated by `tus.roles` (default `S_USER`); `OPTIONS` stays public for the CORS preflight |
| **GridFS Migration** | Completed TUS uploads auto-migrate to GridFS |
| **CORS Support** | Automatic CORS headers for browser uploads |

### AI Assistant Module

| Feature | Description |
|---------|-------------|
| **AI Module** | Prompt orchestrator (auto + plan mode), DB-backed LLM connections, tool registry |
| **REST Endpoints** | `POST /ai/prompt`, `POST /ai/stream` (SSE); `GET/POST/PUT/DELETE /ai/connections*`, `/ai/connections/available`, `/ai/connections/select`, `/ai/connections/preferences*`, `/ai/conversations*`, `/ai/interactions*`, `/ai/budget-limits*`, `GET /ai/usage` |
| **GraphQL Endpoints** | `aiPrompt`, `aiAvailableConnections`, `aiSetUserConnection`, connection/preference/conversation/interaction/budget queries + mutations, `aiUsage` |
| **MCP Server** | Streamable HTTP at `POST/GET/DELETE /ai/mcp` (Bearer auth); optional OAuth 2.1 router mounted in `main.ts` via `mountAiMcpOAuth(app)` (`/.well-known/*`, `/authorize`, `/token`, `/register`) |
| **Permission Model** | `S_USER` for prompt/conversations/available/usage; `ADMIN` for connections/preferences/interactions/budgets; encrypted API keys never leave the server (`securityCheck` + `secretFields`) |

### Email & Templates

| Feature | Description |
|---------|-------------|
| **EmailService** | Multi-provider email sending |
| **Mailjet / Brevo** | API-based email providers |
| **SMTP** | Standard SMTP email sending |
| **TemplateService** | EJS template rendering for emails |
| **Template Inheritance** | Project templates override nest-server fallbacks |
| **Multi-Language** | Locale-aware template resolution (`template-de.ejs` → `template.ejs`) |

### Database & Migration

| Feature | Description |
|---------|-------------|
| **Mongoose Plugins** | ID handling, password hashing, audit fields, role guard |
| **Migration Module** | MongoDB migration state management with cluster locking |
| **Synchronized Migrations** | `synchronizedMigration()` with distributed locks |
| **Migration CLI** | TypeScript-based migration scripts with `getDb()` helper |
| **GridFS Helper** | Direct GridFS file access and migration utilities |

### GraphQL Features

| Feature | Description |
|---------|-------------|
| **Apollo Server** | Full GraphQL server with schema-first or code-first |
| **Custom Scalars** | `Date`, `DateTime` (timestamp), `JSON`, `Any` |
| **Subscriptions** | WebSocket support via `graphql-ws` with auth. The `PUB_SUB` provider is built from a factory: `CoreRedisPubSub` when `redis` is configured (delivery is then cluster-wide), the in-memory `PubSub` otherwise (delivery only to clients connected to the publishing replica). **Constraint once Redis is in play: every published payload must be JSON-serializable** — it crosses the wire as JSON, so `Date`, class instances, `Map`/`Set` and `undefined` do not survive the round trip. An in-process `PubSub` never had this constraint, so a payload that worked on one replica can silently lose fields on a cluster. Publish plain objects and ISO strings |
| **Subscription request context** | Since 11.35.0 `CoreModule` installs a context-aware `execute` / `subscribe` pair (inside `subscriptions`, where `ApolloDriver` forwards it) on all three GraphQL driver builders, so every WebSocket operation runs inside a `RequestContext`. Before that a WS operation had **none** — no Express middleware runs on an upgrade, and `CoreTenantGuard.getRequest()` finds no `req` on a subscription context — and `mongooseTenantPlugin` reads "no context" as "system operation, no filter", so a tenant-scoped read while delivering a subscription message returned EVERY tenant's rows. The tenant comes from the handshake's tenant header **validated against an active membership**, else from the subscriber's memberships; an unresolvable tenant leaves the safety net to refuse the read. The async iterator is wrapped too, not only the subscribe call: graphql-js runs `resolve` / `filter` / field resolvers inside its `next()`. See `.claude/rules/role-system.md` → "Tenant context on non-HTTP transports" |
| **Complexity Analysis** | Query cost calculation to prevent DoS attacks |
| **Enum Registration** | `registerEnum()` helper for GraphQL enum types |
| **Upload Support** | `graphqlUploadExpress()` for multipart file uploads |

### Development & Operations

| Feature | Description |
|---------|-------------|
| **Health Check Module** | `GET /health` + GraphQL `healthCheck` query |
| **Error Code Module** | Centralized error registry with unique IDs |
| **Permissions Report** | Interactive HTML dashboard, JSON, and Markdown reports |
| **Hub (Operator Cockpit)** | Build-free ADMIN-gated dashboard at `/hub` (config-gated per environment). Adds an optional HTTP trace middleware (registered by `CoreHubModule.configure()` only when traces are enabled), a chaining `Logger.overrideLogger()` delegate for the log buffer, an optional `EmailService` capture hook (`HUB_EMAIL_CAPTURE` token) for the mailbox, and — when the query profiler is enabled — opts the MongoDB driver into `monitorCommands` from `core.module.ts`. See `src/core/modules/hub/README.md`. |
| **Process Diagnostics** | Opt-in process-level exit diagnostics (`installProcessDiagnostics()` + `handleFatalBootstrapError`, `src/core/common/helpers/process-diagnostics.helper.ts`). Wired into `main.ts` — **NOT** into `CoreModule.forRoot()`, because it must run before `NestFactory.create()` and installs a `process.exit(1)` path that must never arm inside `Test.createTestingModule()`. Logs unhandled rejections without crashing (configurable), uncaught exceptions before the exit, non-zero exit codes, and labels SIGTERM/SIGINT/SIGHUP/SIGQUIT as external terminations. Pair with `installGracefulShutdown(server)` — **not** with `server.enableShutdownHooks()`, see the Graceful Shutdown row below |
| **Graceful Shutdown** | `installGracefulShutdown(app)` (`src/core/common/helpers/graceful-shutdown.helper.ts`), wired in `main.ts`. It **REPLACES** `server.enableShutdownHooks()` and must not be used alongside it: with `shutdownDelayMs` set, Nest would register its own listener for the same signals and close the app in parallel with the wait, so the delay silently never happens. At `shutdownDelayMs: 0` (the default) the helper simply *is* `enableShutdownHooks()`, so the single call is correct either way. With a delay it waits **inside the SIGTERM/SIGINT handler, before `close()` is entered** — a NestJS lifecycle hook cannot do this, because `close()` runs `onModuleDestroy` → `beforeApplicationShutdown` → dispose → `onApplicationShutdown`, i.e. a delay in a hook would wait with every module already torn down while the socket still accepts. A second signal cancels the pending wait and closes immediately. Warns above 10 000 ms, capped at 60 000 ms — keep it below the orchestrator grace period (Compose 10 s, Kubernetes 30 s) and below `installProcessDiagnostics()`'s 30 s force-exit |
| **System Setup Module** | Initial admin creation for fresh deployments |
| **Cron Jobs** | `CoreCronJobsService` with timezone/UTC offset support |
| **Model Documentation** | Auto-generated model docs via `ModelDocService` |
| **SCIM Support** | SCIM filtering and query parsing utilities |

### Testing Utilities

| Feature | Description |
|---------|-------------|
| **TestHelper** | API testing helper for GraphQL and REST |
| **Cookie Support** | Session and JWT token testing |
| **Dynamic Ports** | `httpServer.listen(0)` for parallel test execution |
| **Database Cleanup** | Test data management in `afterAll` hooks |

### Configuration Patterns

| Pattern | Use Case | Example |
|---------|----------|---------|
| **Presence Implies Enabled** | Object config = enabled | `rateLimit: {}` enables with defaults |
| **Boolean Shorthand** | Simple toggle | `jwt: true` or `jwt: { expiresIn: '1h' }` |
| **Explicit Disable** | Pre-configured but off | `{ enabled: false, max: 10 }` |
| **Backward Compatible** | Undefined = disabled | No config = feature off |

### Key TypeScript Utilities

| Type | Purpose |
|------|---------|
| `IServerOptions` | Complete framework configuration interface |
| `IServiceOptions` | Service method options (`force`, `raw`, `currentUser`) |
| `PlainObject` / `PlainInput` | Type-safe plain object types |
| `ID` / `IDs` | MongoDB ObjectId or string types |
| `MaybePromise<T>` | Sync or async return type |
| `RequireOnlyOne<T>` | Require exactly one property |

---

## Architecture Overview

nest-server implements **defense-in-depth security** with three complementary layers:

```
+===================================================================+
|                          HTTP Request                              |
+===================================================================+
|                                                                   |
|  Layer 1: Guardian Gates (Middleware -> Guards -> Pipes)           |
|  +------------------+  +-----------+  +--------+  +------------+  |
|  | RequestContext   |  | Roles     |  | Tenant |  | MapAndValid|  |
|  | BetterAuth       |->| Guard     |->| Guard  |->| atePipe    |  |
|  | Middleware        |  |           |  |        |  |            |  |
|  +------------------+  +-----------+  +--------+  +------------+  |
|                                                                   |
|  Layer 2: Application Logic (Controllers/Resolvers -> Services)   |
|  +----------------+  +---------------------------------------+   |
|  | Controller /   |  | CrudService.process()                 |   |
|  | Resolver       |->| prepareInput -> serviceFunc ->         |   |
|  |                |  | processFieldSelection -> prepareOutput |   |
|  +----------------+  +---------------------------------------+   |
|                                                                   |
|  Layer 3: Safety Net (Mongoose Plugins + Response Interceptors)   |
|  +--------------------------+  +------------------------------+   |
|  | Mongoose Plugins         |  | Response Interceptors        |   |
|  |  - Password Hashing      |  |  - ResponseModelInterceptor  |   |
|  |  - Role Guard            |  |  - TranslateResponse         |   |
|  |  - Audit Fields          |  |  - CheckSecurity (secrets)   |   |
|  |  - Tenant Isolation      |  |  - CheckResponse (@Restrict) |   |
|  |    (Safety Net: 403)     |  |                              |   |
|  +--------------------------+  +------------------------------+   |
|                                                                   |
+===================================================================+
|                          HTTP Response                            |
+===================================================================+
```

**Key principle:** Layer 2 (CrudService) provides the primary security pipeline. Layer 3 (Safety Net) catches anything that bypasses Layer 2, ensuring security even when developers use direct Mongoose queries.

---

## Request Flow Diagram

The following diagram shows the exact order of execution from HTTP request to response:

```
                    +---------------------+
                    |    HTTP Request      |
                    |    (REST or GQL)     |
                    +----------+----------+
                               |
  +----------------------------v----------------------------+
  |              EXPRESS-LEVEL MIDDLEWARE                    |
  |              (registered in main.ts)                    |
  |                                                         |
  |  0a. cookie-parser  [if cookies enabled, default: yes]  |
  |      - Parses Cookie header into req.cookies            |
  |      - Required for session cookie authentication       |
  |                                                         |
  |  0b. compression  [if configured]                       |
  |      - gzip response compression                        |
  |                                                         |
  |  0c. CORS  [if not disabled]                            |
  |      - credentials: true when cookies enabled           |
  |      - Origins from appUrl/baseUrl/cors.allowedOrigins  |
  |      - Propagated to BetterAuth trustedOrigins          |
  +----------------------------+----------------------------+
                               |
  +----------------------------v----------------------------+
  |              NESTJS MIDDLEWARE CHAIN                     |
  |              (registered in CoreModule.configure())     |
  |                                                         |
  |  1. RequestContextMiddleware                            |
  |     - AsyncLocalStorage context                         |
  |     - Lazy currentUser getter (from req.user)           |
  |     - Accept-Language for translations                  |
  |                                                         |
  |  2. CoreBetterAuthMiddleware                            |
  |     - Strategy 1: Auth header (JWT/Session)             |
  |     - Strategy 2: JWT cookie                            |
  |     - Strategy 3: Session cookie                        |
  |     - Sets req.user                                     |
  |                                                         |
  |  3. graphqlUploadExpress()  [GraphQL only]              |
  |     - Handles multipart file uploads                    |
  +----------------------------+----------------------------+
                               |
  +----------------------------v----------------------------+
  |                      GUARDS                             |
  |                                                         |
  |  4. RolesGuard / BetterAuthRolesGuard                   |
  |     - Reads @Roles() metadata                           |
  |     - Validates JWT / session token                     |
  |     - Checks real roles (ADMIN)                         |
  |     - Evaluates system roles (S_USER, ...)              |
  |     - Throws 401 (Unauthorized) or 403 (Forbidden)     |
  |                                                         |
  |  4b. CoreTenantGuard  [if multiTenancy enabled]          |
  |     - Reads X-Tenant-Id header                          |
  |     - Validates membership via hierarchy roles (level comparison)  |
  |     - Non-admin + header + no membership = always 403   |
  |     - Checks configurable roleHierarchy levels          |
  |     - Admin bypass: sets isAdminBypass (sees all data)  |
  |     - Sets tenantId in RequestContext                    |
  |     - @SkipTenantCheck() opts out of tenant validation  |
  |     - BetterAuth auto-skip: IAM handlers skip tenant    |
  |       validation when no X-Tenant-Id header is present  |
  |       (betterAuth.skipTenantCheck, default: true)       |
  |     - Throws 403 (Forbidden) on failure                |
  +----------------------------+----------------------------+
                               |
  +----------------------------v----------------------------+
  |                       PIPES                             |
  |                                                         |
  |  5. MapAndValidatePipe                                  |
  |     - Transform plain object -> class instance          |
  |     - Whitelist: strip/reject unknown fields            |
  |     - Validate via class-validator decorators           |
  |     - Inheritance-aware (child overrides)               |
  +----------------------------+----------------------------+
                               |
  +----------------------------v----------------------------+
  |                 HANDLER EXECUTION                       |
  |                                                         |
  |  6. Controller method / Resolver method                 |
  |     - @CurrentUser() injects authenticated user         |
  |     - Calls service methods                             |
  |     - Service uses CrudService.process()                |
  |       OR direct Mongoose queries                        |
  |                                                         |
  |     +-----------------------------------------------+   |
  |     |  Mongoose Plugins (fire on DB operations)     |   |
  |     |   - mongoosePasswordPlugin (hash password)    |   |
  |     |   - mongooseRoleGuardPlugin (block roles)     |   |
  |     |   - mongooseAuditFieldsPlugin (set by/at)     |   |
  |     |   - mongooseTenantPlugin (tenant isolation)   |   |
  |     +-----------------------------------------------+   |
  +----------------------------+----------------------------+
                               |
                               |  <-- Response data flows back
                               |
  +----------------------------v----------------------------+
  |              RESPONSE INTERCEPTORS                      |
  |        (NestJS runs in REVERSE registration order)      |
  |                                                         |
  |  7. ResponseModelInterceptor              [runs 1st]    |
  |     - Plain object -> CoreModel instance                |
  |     - Enables securityCheck() on output                 |
  |     - Resolves model via @Query/@Mutation type,         |
  |       @ResponseModel(), or @ApiOkResponse()             |
  |                                                         |
  |  8. TranslateResponseInterceptor          [runs 2nd]    |
  |     - Applies _translations for Accept-Language         |
  |     - Skips when no _translations present               |
  |                                                         |
  |  9. CheckSecurityInterceptor              [runs 3rd]    |
  |     - Calls securityCheck(user) on models               |
  |     - Fallback: removes secret fields                   |
  |       (password, tokens, etc.)                          |
  |                                                         |
  | 10. CheckResponseInterceptor              [runs 4th]    |
  |     - Filters @Restricted() fields                      |
  |     - Role-based: removes fields user can't see         |
  |     - Membership-based: checks memberOf                 |
  +----------------------------+----------------------------+
                               |
                    +----------v----------+
                    |   HTTP Response      |
                    |   (filtered &        |
                    |    secured)          |
                    +---------------------+
```

### Shutdown Flow (SIGTERM / SIGINT)

The mirror image of the request flow, and the one place where an ordering mistake is invisible until
a rolling deploy drops requests. Installed in `main.ts` by `installGracefulShutdown(server)` — which
**replaces** `server.enableShutdownHooks()`, never accompanies it.

```
  SIGTERM / SIGINT
        |
        v
  +-------------------------------------------------------------+
  | installGracefulShutdown() signal handler                     |
  |                                                              |
  |  shutdownDelayMs === 0 (default)                             |
  |    -> this IS app.enableShutdownHooks(): close() immediately |
  |                                                              |
  |  shutdownDelayMs > 0                                         |
  |    -> stay FULLY HEALTHY for N ms (routes still served),     |
  |       so the load balancer can finish deregistering          |
  |    -> a second signal cancels the wait and closes now        |
  +----------------------------+---------------------------------+
                               |  (only after the wait)
                               v
  +-------------------------------------------------------------+
  | app.close()                                                  |
  |   1. onModuleDestroy                                         |
  |   2. beforeApplicationShutdown                               |
  |   3. dispose  (HTTP server socket closes HERE)               |
  |   4. onApplicationShutdown                                   |
  |      - CoreRedisService quits every tracked connection       |
  +-------------------------------------------------------------+
```

**Why the wait cannot be a lifecycle hook:** the socket only closes at step 3, so a delay placed in
`beforeApplicationShutdown` (step 2) would keep accepting traffic with every module already torn
down — strictly worse than not waiting at all.

**Why both together is a bug:** with `enableShutdownHooks()` also installed, Nest registers its own
listener for the same signals and enters `close()` in parallel with the wait. Nothing errors; the
delay simply never happens.

| Knob | Default | Notes |
|------|---------|-------|
| `shutdownDelayMs` | `0` (no delay, no log) | Warns above `10000`, capped at `60000`. Keep it below the orchestrator grace period (Compose `stop_grace_period` 10 s, Kubernetes `terminationGracePeriodSeconds` 30 s) **and** below `installProcessDiagnostics()`'s 30 s force-exit — exceed any and the process is SIGKILLed mid-wait with no hook running. Non-numeric/negative behaves like `0` |

---

## Phase 1: Incoming Request

### Express-Level Middleware (main.ts)

These run **before NestJS** processes the request. They are registered in the application bootstrap (`main.ts`), not in `CoreModule`:

#### 0a. cookie-parser

Parses the `Cookie` header into `req.cookies`. Loaded when cookies are enabled (default: `true` since v11.25.0).

```typescript
// main.ts
if (isCookiesEnabled(envConfig.cookies)) {
  server.use(cookieParser());
}
```

Without `cookie-parser`, session cookie authentication in `CoreBetterAuthMiddleware` falls back to manual header parsing. With it, `req.cookies` is a parsed object — more reliable and required for signed cookie verification.

#### 0b. CORS

CORS headers are configured based on the unified `cors` config (since v11.25.0). The same origin list is propagated to GraphQL (Apollo), REST (Express), and BetterAuth (`trustedOrigins`).

```typescript
// main.ts — uses helpers from cookies.helper.ts
if (!isCorsDisabled(envConfig.cors)) {
  server.enableCors({ credentials: cookiesEnabled, origin: resolvedOrigins });
}
```

| Config | REST (Express) | GraphQL (Apollo) | BetterAuth |
|--------|----------------|-------------------|------------|
| `cors: { allowAll: true }` | `origin: true` | `origin: true` | `trustedOrigins: [appUrl] (+ passkey origins)` |
| `cors: { allowedOrigins: [...] }` | `origin: [merged list]` | `origin: [merged list]` | `trustedOrigins: [merged list]` |
| `cors: { enabled: false }` | No CORS headers | No CORS headers | `trustedOrigins: []` |
| `cors: { deriveAppUrl: false }` | `appUrl` not derived from `baseUrl` | same | same |

> **BetterAuth has no "allow all origins" mode (since v11.27.6).** `cors.allowAll` mirrors the request origin for REST/GraphQL, but BetterAuth's origin check is a security control with no meaningful "allow everything" setting. So `allowAll` yields the known-good origins (`appUrl` + any passkey origins), NOT `undefined` — returning nothing there would leave BetterAuth trusting only its own `baseURL` and silently answer `403 INVALID_ORIGIN` for a separately hosted frontend on `two-factor/enable`, passkey registration, etc. For the same reason `trustedOrigins: []` (the `enabled: false` row) does **not** switch the origin check off: BetterAuth always trusts its own `baseURL`, so `[]` and `undefined` behave identically. To accept arbitrary origins for auth, set `betterAuth.trustedOrigins` explicitly.

**URL resolution (since v11.27.5):** all three layers resolve `appUrl`/`baseUrl` through the single `resolveServerUrls()` helper in `cookies.helper.ts`, so they can no longer drift:

1. `appUrl` set explicitly → used as-is
2. `env: 'local' | 'ci' | 'e2e'` with a localhost `baseUrl` that splits API and app by **host** → derived from `baseUrl` (see below)
3. `env: 'local' | 'ci' | 'e2e'` with any other localhost `baseUrl` → `appUrl` defaults to `http://localhost:3001`
4. otherwise derived from `baseUrl` by stripping a leading `api.` label (`https://api.example.com` → `https://example.com`), unless `cors.deriveAppUrl: false`

**Port split vs. host split (step 2 vs. 3, since v11.27.6).** The localhost defaults encode a *port split*: one host, API on `:3000`, app on `:3001`. `lt dev up` instead serves a *host split* behind Caddy — API on `https://api.<slug>.localhost`, app on `https://<slug>.localhost`. The two are told apart by what the `api.` label strips to, never by the port:

| `baseUrl` (`env: 'local'`) | Split | Resolved `appUrl` |
|---------------------------|-------|-------------------|
| `https://api.crm.localhost` | host | `https://crm.localhost` |
| `https://api.crm.localhost:8443` | host | `https://crm.localhost:8443` |
| `https://api.localhost` | port (strips to the bare host the API answers on) | `http://localhost:3001` |
| `http://api.localhost:3000` | port | `http://localhost:3001` |
| `http://localhost:3000` | port (no `api.` label) | `http://localhost:3001` |

> **Security:** steps 2 and 4 grant the derived origin credentialed CORS. If the apex domain is not trusted (e.g. a third-party-hosted marketing site whose XSS surface you do not control), set `cors.deriveAppUrl: false` and list the frontend origin explicitly via `appUrl` or `cors.allowedOrigins`. The derivation never yields a bare TLD (`https://api.dev` stays unchanged) and never emits the opaque `null` origin. With `cors.deriveAppUrl: false`, a host-split localhost `baseUrl` falls back to the `http://localhost:3001` default.

### NestJS Middleware Chain (CoreModule)

NestJS middleware runs for every request after Express-level middleware. Registration happens in `CoreModule.configure()`:

```typescript
// src/core.module.ts
configure(consumer: MiddlewareConsumer) {
  consumer.apply(RequestContextMiddleware).forRoutes('*');
  consumer.apply(graphqlUploadExpress()).forRoutes('graphql');
}
```

#### 1. RequestContextMiddleware

Wraps the entire request in an `AsyncLocalStorage` context, making the current user and language available anywhere — including Mongoose hooks — without dependency injection.

```typescript
// src/core/common/middleware/request-context.middleware.ts
use(req: Request, _res: Response, next: NextFunction) {
  const context: IRequestContext = {
    get currentUser() {
      return (req as any).user || undefined;   // Lazy: evaluated when accessed
    },
    get language() {
      return req.headers?.['accept-language'] || undefined;
    },
  };
  RequestContext.run(context, () => next());
}
```

**Key design:** The `currentUser` getter is **lazy**. At middleware time, `req.user` is not yet set (auth middleware hasn't run). By using a getter, the value is resolved at access time, after authentication.

#### 2. CoreBetterAuthMiddleware

Authenticates the request using three strategies in priority order:

| Priority | Strategy | Source | Token Type |
|----------|----------|--------|------------|
| 1 | Authorization header | `Bearer <token>` | JWT or Session token |
| 2 | JWT cookie | `better-auth.jwt_token` | JWT token |
| 3 | Session cookie | `better-auth.session_token` | Session token |

If authentication succeeds, `req.user` is set with the authenticated user (including `hasRole()` method).

> **Native `/iam/*` routes bypass the `@Roles()`/`checkRoles` layer.** Better-Auth's own endpoints
> (e.g. `POST /iam/update-user`, `POST /iam/sign-up/email`) that are **not** in
> `CONTROLLER_HANDLED_PATHS` are forwarded raw by `CoreBetterAuthApiMiddleware` to Better-Auth's
> native handler under its `sessionMiddleware` — i.e. reachable by **any authenticated user**,
> independent of the controller's class-level `@Roles(ADMIN)` and nest-server's `checkRoles`. This is
> why server-managed user fields (`roles`, `verified`, `verifiedAt`, `twoFactorEnabled`, `iamId`) are
> locked at the Better-Auth schema layer with `input: false` (see `betterAuth.additionalUserFields[].input`
> in `.claude/rules/configurable-features.md` and `.claude/rules/better-auth.md` §2): field-level
> input rejection is the correct control here because the guard layer does not run on these
> raw-forwarded routes. A forged `POST /iam/update-user {"roles":["admin"]}` is rejected with
> `FIELD_NOT_ALLOWED` (HTTP 400) at the input-parse stage, before any persistence.

> **"Raw" has one exception since 11.38.0: the password-setting reset routes.**
> `CoreBetterAuthApiMiddleware.normalizeResetPassword()` rewrites the password field of
> `/reset-password`, `/email-otp/reset-password` and `/phone-number/reset-password` to its
> normalized (sha256) form **before** building the Web Request, then runs the Better-Auth handler
> inside an `AsyncLocalStorage` context carrying that value.
>
> Both halves are load-bearing. Without the rewrite, a client posting a plaintext password would
> have `scrypt(plaintext)` stored while every sign-in — which *is* normalized, in
> `CoreBetterAuthController` — checks `scrypt(sha256(...))`: the account is locked out with the
> password its owner just chose. Without the context, `emailAndPassword.onPasswordReset` knows
> *which* user was reset but not to *what*, and cannot mirror the new password into the legacy
> bcrypt store — leaving the old password valid on the legacy path after a reset.
>
> A project subclassing the middleware must know this: the body it forwards is no longer
> byte-identical to the body it received. `normalizeResetPassword()` is `protected`.

#### 2b. SecurityHeadersMiddleware

Sets the browser security headers on **every** response — `X-Content-Type-Options`,
`X-Frame-Options`, `Referrer-Policy`, `Strict-Transport-Security`, and the removal of
`X-Powered-By`. On by default; `security.headers: false` disables it, individual fields switch off
individually. No CSP is sent unless one is configured.

Middleware rather than an interceptor, and the distinction is the whole point: an interceptor never
runs for a request a guard turns away, and a `401` is still a response a browser renders. Those are
also the responses an attacker generates most of. `tests/security-headers.e2e-spec.ts` asserts the
headers on an actual guard rejection rather than trusting the ordering.

HSTS is decided by the request protocol — `x-forwarded-proto` first, connection protocol as
fallback — and never by configuration. A browser remembers it, so one sent over `http://localhost`
makes every project on that host unreachable over http for up to a year, with no server-side undo.
Behind a TLS-terminating proxy the inward connection is plain http, which makes `trustProxy`
load-bearing for this header too.

#### 3. graphqlUploadExpress

Only for GraphQL routes. Handles multipart file upload requests according to the [GraphQL multipart request specification](https://github.com/jaydenseric/graphql-multipart-request-spec).

> **NestJS docs:** [Middleware](https://docs.nestjs.com/middleware)

---

## Phase 2: Authorization & Validation

### Guards — @Roles() Enforcement

Guards run after middleware but before the handler. The `@Roles()` decorator specifies who can access a method:

```typescript
@Query(() => User)
@Roles(RoleEnum.ADMIN)          // Only admins
async getUser(@Args('id') id: string): Promise<User> { ... }

@Mutation(() => User)
@Roles(RoleEnum.S_USER)         // Any authenticated user
async updateUser(...): Promise<User> { ... }

@Query(() => [User])
@Roles(RoleEnum.S_EVERYONE)     // Public access (no auth required)
async getPublicUsers(): Promise<User[]> { ... }
```

**Public does not mean anonymous (since 11.36.5).** On a public endpoint (`S_EVERYONE`, or no
`@Roles` at all) `RolesGuard` still tries to IDENTIFY the caller before granting access —
Better-Auth first, Passport JWT second, every failure swallowed. Access is granted either way: a
missing, expired or malformed token can never turn a public endpoint into a 401. The effect is that
`@CurrentUser()`, `serviceOptions.currentUser` and `securityCheck(user)` see a signed-in caller, so
a public endpoint can personalise — a search ranking by the caller's own location, a list marking
the caller's own entries.

Before 11.36.5 the guard returned early and `request.user` stayed unset. That mattered **only in
legacy-JWT deployments**: with Better-Auth enabled, `CoreBetterAuthMiddleware` is applied via
`forRoutes('(.*)')` and had already set `request.user` before any guard ran. `BetterAuthRolesGuard`
keeps its early return for exactly that reason — it only runs when Better-Auth is enabled, where the
middleware has already done the work.

Two consequences worth knowing when you own a public endpoint:

- **Owner-restricted output widens for its owner.** `@Restricted(S_SELF)` / `@Restricted(S_CREATOR)`
  fields evaluate against `currentUser`; with `undefined` they always stripped. They now appear for
  the caller who owns the record. That is the declared policy finally being applied, not a leak —
  but it may be the first time anyone sees those fields on that route.
- **An anonymous caller stays ABSENT, not falsy.** Passport answers `false` for "no credentials";
  the guard normalises that away so `@CurrentUser()` yields `undefined` as before. Pinned by
  `tests/public-endpoint-identity.e2e-spec.ts`.

**Important:** `@Roles()` already handles JWT authentication internally. Do NOT add `@UseGuards(AuthGuard(JWT))` — it is redundant.

#### System Roles (S_ prefix)

System roles are evaluated at runtime and must **never** be stored in `user.roles`.

**OR semantics in CoreTenantGuard:** When multiTenancy is active, system roles are checked as OR alternatives in priority order (`S_EVERYONE` → `S_USER` → `S_VERIFIED`) before real roles. If ANY system role in `@Roles()` is satisfied, access is granted immediately — real roles in the same `@Roles()` are treated as alternatives, not additional requirements.

Example: `@Roles(RoleEnum.S_USER, DefaultHR.OWNER)` — any authenticated user passes (owner is an alternative).

When `X-Tenant-Id` header is present and a system role grants access, membership is still validated to set tenant context (`tenantId`, `tenantRole`). A non-member gets 403 even with `S_USER` or `S_VERIFIED` satisfied.

| System Role | Check Logic | Use Case |
|-------------|-------------|----------|
| `S_EVERYONE` | Always true — access granted unconditionally; the caller is still identified when a valid token is present (see above) | Public endpoints |
| `S_NO_ONE` | Always false | Permanently locked |
| `S_USER` | `currentUser` exists | Any authenticated user |
| `S_VERIFIED` | `user.verified \|\| user.verifiedAt \|\| user.emailVerified` | Email-verified users |
| `S_CREATOR` | `object.createdBy === user.id` | Creator of the resource (object-level, checked by interceptor) |
| `S_SELF` | `object.id === user.id` | User accessing own data (object-level, checked by interceptor) |
| `DefaultHR.MEMBER` (`'member'`) | Active membership in current tenant (level >= 1) | Tenant member access |
| `DefaultHR.MANAGER` (`'manager'`) | At least manager-level role (level >= 2) | Tenant manager access |
| `DefaultHR.OWNER` (`'owner'`) | Highest role level (level >= 3) | Tenant owner access |
| Custom hierarchy roles | Configurable via `createHierarchyRoles()` | Level comparison |
| Normal (non-hierarchy) roles | Exact match against membership.role or user.roles | No level compensation |

> **NestJS docs:** [Guards](https://docs.nestjs.com/guards), [Authorization](https://docs.nestjs.com/security/authorization)

### Pipes — Input Validation & Whitelisting

The `MapAndValidatePipe` runs on every incoming argument/body:

```
Plain Object --> Transform to Class Instance --> Whitelist Check --> Validation --> Clean Input
```

#### Whitelisting via @UnifiedField()

Properties **without** `@UnifiedField()` are subject to the whitelist policy:

| Mode | Config Value | Behavior |
|------|-------------|----------|
| **Strip** (default) | `'strip'` | Unknown properties silently removed |
| **Error** | `'error'` | Throws `400 Bad Request` with property names |
| **Disabled** | `false` | All properties accepted |

```typescript
// config.env.ts
security: {
  mapAndValidatePipe: {
    nonWhitelistedFields: 'strip',  // 'strip' | 'error' | false
  },
}
```

#### @UnifiedField() Decorator

Combines GraphQL `@Field()`, Swagger `@ApiProperty()`, and class-validator decorators into one:

```typescript
export class CreateUserInput extends CoreInput {
  @UnifiedField({ description: 'Email address' })
  email: string = undefined;

  @UnifiedField({ isOptional: true, description: 'Display name' })
  displayName?: string = undefined;

  @UnifiedField({ exclude: true })  // Hidden from schema, rejected at runtime
  internalFlag?: boolean = undefined;
}
```

> **NestJS docs:** [Pipes](https://docs.nestjs.com/pipes), [Validation](https://docs.nestjs.com/techniques/validation)

---

## Phase 3: Handler Execution

### Controllers (REST) vs Resolvers (GraphQL)

```
+----------------------------+      +----------------------------+
|     REST Controller        |      |     GraphQL Resolver       |
+----------------------------+      +----------------------------+
| @Controller('/users')      |      | @Resolver(() => User)      |
| @Get(':id')                |      | @Query(() => User)         |
| @Post()                    |      | @Mutation(() => User)      |
| @Patch(':id')              |      |                            |
| @Delete(':id')             |      |                            |
+----------------------------+      +----------------------------+
| Input: @Body(), @Param()   |      | Input: @Args()             |
| User:  @CurrentUser()      |      | User:  @CurrentUser()      |
| Type:  @ApiOkResponse()    |      | Type:  @Query(() => User)  |
|        @ResponseModel()    |      |        @Mutation(() => User)|
+----------------------------+      +----------------------------+
              |                                   |
              +----------------+------------------+
                               |
              +----------------v------------------+
              |          Service Layer            |
              |                                   |
              | A: CrudService.process()          |
              |    Full pipeline with security     |
              |                                   |
              | B: Direct Mongoose query           |
              |    Safety Net catches              |
              |                                   |
              | C: processResult()                |
              |    Population + output only        |
              +-----------------------------------+
```

### @CurrentUser() Decorator

Injects the authenticated user into the handler. This is a **custom parameter decorator** that bypasses the pipe (no validation/whitelist applied):

```typescript
@Query(() => User)
@Roles(RoleEnum.S_USER)
async getMe(
  @CurrentUser() currentUser: User,
  @GraphQLServiceOptions() serviceOptions: ServiceOptions,
): Promise<User> {
  return this.userService.get(currentUser.id, serviceOptions);
}
```

### Mongoose Plugins (Write Operations)

When the service performs write operations (save, update), Mongoose plugins fire **at the database level**:

#### Password Hashing Plugin

```
                              +------------------+
                              | Input password   |
                              +--------+---------+
                                       |
                              +--------v---------+
                              | Already hashed?  |
                              | (BCrypt pattern) |
                              +--------+---------+
                              Yes /          \ No
                                 /            \
                   +------------+    +---------v---------+
                   | Skip       |    | Sentinel value?   |
                   | pass thru  |    | (skipPatterns)     |
                   +------------+    +---------+---------+
                                     Yes /          \ No
                                        /            \
                          +------------+    +---------v---------+
                          | Skip       |    | SHA256 -> BCrypt  |
                          | pass thru  |    | hash -> MongoDB   |
                          +------------+    +-------------------+
```

#### Role Guard Plugin

```
                        +---------------------+
                        | Write includes      |
                        | roles?              |
                        +----------+----------+
                       No /              \ Yes
                         /                \
           +------------+     +------------v-----------+
           | Pass       |     | No currentUser?        |
           | through    |     | (system operation)     |
           +------------+     +------------+-----------+
                              Yes /              \ No
                                 /                \
                   +------------+     +------------v-----------+
                   | Allow      |     | bypassRoleGuard        |
                   |            |     | active?                |
                   +------------+     +------------+-----------+
                                      Yes /              \ No
                                         /                \
                           +------------+     +------------v-----------+
                           | Allow      |     | User is ADMIN?         |
                           |            |     |                        |
                           +------------+     +------------+-----------+
                                              Yes /              \ No
                                                 /                \
                                   +------------+     +------------v-----------+
                                   | Allow      |     | User in allowedRoles?  |
                                   |            |     |                        |
                                   +------------+     +------------+-----------+
                                                      Yes /              \ No
                                                         /                \
                                           +------------+    +-------------+
                                           | Allow      |    | Block       |
                                           |            |    | (strip      |
                                           +------------+    |  roles)     |
                                                             +-------------+
```

#### Audit Fields Plugin

```
                        +---------------------+
                        | Write operation     |
                        +----------+----------+
                                   |
                        +----------v----------+
                        | currentUser exists? |
                        +----------+----------+
                       No /              \ Yes
                         /                \
           +------------+     +------------v-----------+
           | Skip       |     | New document?          |
           +------------+     +------------+-----------+
                              Yes /              \ No
                                 /                \
                   +------------+     +------------v-----------+
                   | Set         |     | Set updatedBy         |
                   | createdBy + |     | only                  |
                   | updatedBy   |     |                       |
                   +-------------+     +-----------------------+
```

#### Tenant Isolation Plugin (opt-in)

Enabled via `multiTenancy: {}` in config. Auto-activates only on schemas with a `tenantId` field.
The `tenantId` is read from RequestContext (set by CoreTenantGuard via `req.tenantId`), not the raw header.

**Safety Net:** If a tenant-schema is accessed without a valid tenant context (no `tenantId` and no bypass), the plugin throws a `ForbiddenException`. This prevents accidental cross-tenant data leaks when developers forget to set the tenant header or bypass.

```
                        +---------------------+
                        | DB operation         |
                        | (query/save/agg)     |
                        +----------+----------+
                                   |
                        +----------v----------+
                        | multiTenancy config |
                        | enabled?            |
                        +----------+----------+
                       No /              \ Yes
                         /                \
           +------------+     +------------v-----------+
           | Skip       |     | RequestContext exists?  |
           +------------+     +------------+-----------+
                              No /              \ Yes
                                 /                \
                   +------------+     +------------v-----------+
                   | No filter  |     | bypassTenantGuard?     |
                   | (system op)|     |                        |
                   +------------+     +------------+-----------+
                                      Yes /              \ No
                                         /                \
                           +------------+     +------------v-----------+
                           | No filter  |     | Schema in              |
                           |            |     | excludeSchemas?        |
                           +------------+     +------------+-----------+
                                              Yes /              \ No
                                                 /                \
                                   +------------+     +------------v-----------+
                                   | No filter  |     | isAdminBypass?         |
                                   +------------+     +------------+-----------+
                                                      Yes /              \ No
                                                         /                \
                                           +------------+     +------------v-----------+
                                           | No filter  |     | tenantId?              |
                                           | (admin sees|     +------------+-----------+
                                           |  all data) |     Yes /              \ No
                                           +------------+        /                \
                                                   +------------+    +-------------+
                                                   | Filter by  |    | FORBIDDEN   |
                                                   | tenantId   |    | (Safety Net)|
                                                   +------------+    +-------------+
```

**Important:** When `multiTenancy.adminBypass` is `true` (default), system admins without a tenant header get `isAdminBypass` set in RequestContext and see all data (no tenant filter). Non-admin users with a tenant header but no membership always get 403. For cross-tenant admin operations, use `RequestContext.runWithBypassTenantGuard()`.

> **NestJS docs:** [Custom decorators](https://docs.nestjs.com/custom-decorators), [Mongoose](https://docs.nestjs.com/techniques/mongodb)

---

## Phase 4: Response Processing

NestJS runs interceptors in **reverse registration order** on the response. Since `ResponseModelInterceptor` is registered last in `CoreModule`, it runs **first** on the response:

```
  Handler return value
           |
  +--------v-------------------------------------------------+
  |  Step 7: ResponseModelInterceptor                         |
  |                                                           |
  |  Resolves the expected model class:                       |
  |    1. @ResponseModel(User) decorator (explicit)           |
  |    2. @Query(() => User) / @Mutation() return type (GQL)  |
  |    3. @ApiOkResponse({ type: User }) (Swagger/REST)       |
  |                                                           |
  |  Converts plain objects -> CoreModel instances via .map() |
  |  Skips if already instanceof or _objectAlreadyChecked     |
  |  Enables securityCheck() and @Restricted on the result    |
  +--------+--------------------------------------------------+
           |
  +--------v-------------------------------------------------+
  |  Step 8: TranslateResponseInterceptor                     |
  |                                                           |
  |  Checks Accept-Language header                            |
  |  If _translations exists on response objects:             |
  |    -> Applies matching translation to base fields         |
  |  Early bailout when no _translations present              |
  +--------+--------------------------------------------------+
           |
  +--------v-------------------------------------------------+
  |  Step 9: CheckSecurityInterceptor                         |
  |                                                           |
  |  Calls securityCheck(user, force) on model instances      |
  |  Recursively processes nested objects                      |
  |                                                           |
  |  Fallback: Removes secret fields from ALL objects         |
  |  (password, verificationToken, refreshTokens, etc.)       |
  |  Even if object is NOT a CoreModel instance               |
  +--------+--------------------------------------------------+
           |
  +--------v-------------------------------------------------+
  |  Step 10: CheckResponseInterceptor                        |
  |                                                           |
  |  Reads @Restricted() metadata from each property          |
  |  For each field:                                          |
  |    - Role check: Does user have required role?            |
  |    - Membership check: Is user.id in field's memberOf?    |
  |    - System role check: S_CREATOR, S_SELF, etc.           |
  |  Removes fields the user is not allowed to see            |
  |  Sets _objectAlreadyCheckedForRestrictions = true         |
  +--------+--------------------------------------------------+
           |
      +----v-----------+
      | HTTP Response   |
      +----------------+
```

> **NestJS docs:** [Interceptors](https://docs.nestjs.com/interceptors)

---

## CrudService.process() Pipeline

The `process()` method in `ModuleService` is the **primary** way to handle CRUD operations with full security. It orchestrates input preparation, authorization, the database operation, and output preparation:

```
  +---------------------------------------------------------------+
  |                    CrudService.process()                       |
  |                                                               |
  |  +----------------------------------------------------------+ |
  |  |  1. prepareInput()                                        | |
  |  |     - Hash password (SHA256 + BCrypt)                     | |
  |  |     - Check roles (if checkRoles: true)                   | |
  |  |     - Convert ObjectIds to strings                        | |
  |  |     - Map to target model type                            | |
  |  |     - Remove undefined properties                         | |
  |  +----------------------------+-----------------------------+  |
  |                               |                                |
  |  +----------------------------v-----------------------------+  |
  |  |  2. checkRights(INPUT)                                   |  |
  |  |     - Evaluate @Restricted() on input properties         |  |
  |  |     - Verify user has required roles/memberships         |  |
  |  |     - Strip/reject unauthorized input fields             |  |
  |  +----------------------------+-----------------------------+  |
  |                               |                                |
  |  +----------------------------v-----------------------------+  |
  |  |  3. serviceFunc()   <-- Your database operation          |  |
  |  |     - findById, create, findByIdAndUpdate, aggregate...  |  |
  |  |     - Mongoose plugins fire here (password, roles, audit)|  |
  |  |     - If force: true -> runs inside bypassRoleGuard      |  |
  |  +----------------------------+-----------------------------+  |
  |                               |                                |
  |  +----------------------------v-----------------------------+  |
  |  |  4. processFieldSelection()                              |  |
  |  |     - Populate referenced documents (GraphQL selections) |  |
  |  +----------------------------+-----------------------------+  |
  |                               |                                |
  |  +----------------------------v-----------------------------+  |
  |  |  5. prepareOutput()                                      |  |
  |  |     - Map Mongoose document -> model instance (.map())   |  |
  |  |     - Convert ObjectIds to strings                       |  |
  |  |     - Remove secrets (if removeSecrets: true)            |  |
  |  |     - Apply custom transformations (overridable)         |  |
  |  +----------------------------+-----------------------------+  |
  |                               |                                |
  |  +----------------------------v-----------------------------+  |
  |  |  6. checkRights(OUTPUT, throwError: false)               |  |
  |  |     - Filter output properties based on @Restricted()   |  |
  |  |     - Non-throwing: strips fields instead of erroring    |  |
  |  +----------------------------+-----------------------------+  |
  |                               |                                |
  |  Return processed result                                       |
  +---------------------------------------------------------------+
```

### Status Codes: 401 vs 403 (v11.28.0+)

One policy across **all five** permission layers — the role guards, the tenant guard, `check()` /
`checkRights`, `checkRestricted()` (object and field level), and a model's `securityCheck()`:

| Situation | Status | Thrown by |
|-----------|--------|-----------|
| Requester is **not authenticated** | **401** `ErrorCode.UNAUTHORIZED` | guards, `accessDeniedException(undefined)` |
| Requester **is authenticated** but lacks a right | **403** `ErrorCode.ACCESS_DENIED` | guards, `accessDeniedException(user)` |
| Resource is locked via `S_NO_ONE` | **403**, always — even for anonymous requesters | guards, `check()` |

`S_NO_ONE` is 403 for everyone because authenticating can never unlock it; a 401 would tell the
client to retry after logging in, which is a lie.

**Why this matters:** SPA auth layers commonly treat 401 as "session expired" and clear the session
(the `@lenne.tech/nuxt-extensions` auth interceptor patches `$fetch`/`fetch` globally and does exactly
this). A permission error answered with 401 therefore logs the user out of the whole app. With this
policy a frontend may treat 401 as "session invalid" — with one exception:
`ErrorCode.EMAIL_VERIFICATION_REQUIRED` is a legitimate 401 (no session exists yet at sign-in) that
must **not** trigger a logout. Branch on the ErrorCode, not on the status alone.

**Writing new denial code:** use the exported factory rather than hand-rolling the decision. It
returns the **native** `ForbiddenException` / `UnauthorizedException`, so `instanceof` checks and
`@Catch(...)` filters in consuming projects keep working:

```typescript
import { accessDeniedException } from '@lenne.tech/nest-server';

// In a service, a custom guard, or a model's securityCheck():
throw accessDeniedException(currentUser);
```

See `src/core/common/exceptions/access-denied.exception.ts` and
`migration-guides/11.27.7-to-11.28.0.md`.

### Depth-Based Optimization (v11.23.0+)

When `process()` is called from within another `process()` call (service cascades like A.create → B.create → C.create), steps 4–6 are **conditionally skipped** on inner calls to avoid redundant work:

| Step | Depth 0 (outermost) | Depth > 0 (nested) |
|------|---------------------|---------------------|
| 1. prepareInput | Runs | Runs |
| 2. checkRights (INPUT) | Runs | Runs |
| 3. serviceFunc | Runs | Runs |
| 4. processFieldSelection | Runs | **Skipped** (unless `populate` explicitly set) |
| 5. prepareOutput (model mapping) | Runs | **Skipped** (secret removal still active) |
| 6. checkRights (OUTPUT) | Runs | **Skipped** |

**Security is maintained** because:
1. Input authorization (step 2) always runs at every depth
2. Output authorization (step 6) runs at the outermost call
3. `CheckSecurityInterceptor` (Safety Net) runs on the final HTTP response

**Important:** Code running at depth > 0 (cron jobs, queue consumers, event handlers outside the HTTP cycle) must NOT return data directly to external consumers without either an outer depth-0 `process()` call or manual `checkRights` — the output rights check is skipped at depth > 0.

See [process() Performance Optimization](process-performance-optimization.md) for details.

### Key Options

| Option | Type | Default | Effect |
|--------|------|---------|--------|
| `force` | boolean | `false` | Disables checkRights, checkRoles, removeSecrets, bypasses role guard plugin |
| `raw` | boolean | `false` | Disables prepareInput and prepareOutput entirely |
| `checkRights` | boolean | `true` | Enable/disable authorization checks |
| `populate` | object | - | Field selection for population (overrides nested skip) |
| `currentUser` | object | from request | Override the current user |
| `debugProcessInput` | boolean | `false` | Config flag: log when prepareInput changes the input type (performance cost) |

### Alternative: processResult()

For direct Mongoose queries that need population and output preparation but not the full pipeline:

```typescript
// Direct query + simplified processing
const doc = await this.mainDbModel.findById(id).exec();
return this.processResult(doc, serviceOptions);
```

`processResult()` handles population and `prepareOutput()` only. It does **not** perform authorization checks (`checkRights`). Security is handled by the Safety Net (Mongoose plugins for input, interceptors for output). If called outside an HTTP request cycle (cron, queue), call `checkRights` manually before returning data to external consumers.

---

## Safety Net Architecture

The Safety Net ensures security even when developers bypass `CrudService.process()` and use direct Mongoose queries. It consists of two complementary layers:

```
  +-----------------------------------------------------------+
  |  Developer writes direct query                            |
  |                                                           |
  |  const user = await this.mainDbModel.findById(id).exec(); |
  |  return user;  // Plain Mongoose document                 |
  +----------------------------+------------------------------+
                               |
           +-------------------v--------------------+
           |  INPUT PROTECTION                      |
           |  (Mongoose Plugins -- on write)        |
           |                                        |
           |  - Password auto-hashed                |
           |    (mongoosePasswordPlugin)            |
           |                                        |
           |  - Roles guarded                       |
           |    (mongooseRoleGuardPlugin)            |
           |                                        |
           |  - Audit fields set                    |
           |    (mongooseAuditFieldsPlugin)          |
           |                                        |
           |  - Tenant isolation enforced           |
           |    (mongooseTenantPlugin)              |
           |    403 if no valid tenant context       |
           +-------------------+--------------------+
                               |
           +-------------------v--------------------+
           |  OUTPUT PROTECTION                     |
           |  (Response Interceptors)               |
           |                                        |
           |  - Plain -> Model conversion           |
           |    (ResponseModelInterceptor)           |
           |                                        |
           |  - Translations applied                |
           |    (TranslateResponseInterceptor)       |
           |                                        |
           |  - securityCheck() called              |
           |    (CheckSecurityInterceptor)           |
           |                                        |
           |  - @Restricted fields filtered         |
           |    (CheckResponseInterceptor)           |
           |                                        |
           |  - Secret fields removed (fallback)    |
           |    (CheckSecurityInterceptor)           |
           +-------------------+--------------------+
                               |
                      +--------v--------+
                      | Secure Response |
                      +-----------------+
```

### When is process() vs Safety Net used?

| Approach | Input Security | Output Security | Population | Custom Logic |
|----------|---------------|----------------|------------|--------------|
| `process()` | prepareInput + plugins | prepareOutput + interceptors | Yes | checkRights, serviceOptions |
| Direct query + `return` | Plugins only | Interceptors only | No | None |
| Direct query + `processResult()` | Plugins only | prepareOutput + interceptors | Yes | Custom prepareOutput |

**Recommendation:** Use `process()` for full CRUD operations. Use direct queries + Safety Net for simple read-only queries, aggregations, or performance-critical paths.

---

## Decorators Reference

### @Roles() — Method-Level Authorization

Controls who can access a resolver/controller method. Evaluated by the RolesGuard.

```typescript
// Only admins
@Roles(RoleEnum.ADMIN)

// Any authenticated user
@Roles(RoleEnum.S_USER)

// Public access
@Roles(RoleEnum.S_EVERYONE)

// Multiple roles (OR logic — user needs at least one)
@Roles(RoleEnum.ADMIN, 'MANAGER')

// Tenant roles — validated by CoreTenantGuard when multiTenancy is enabled
@Roles(DefaultHR.MEMBER)   // Any active tenant member (level >= 1)
@Roles(DefaultHR.MANAGER)  // At least manager-level (level >= 2)
@Roles(DefaultHR.OWNER)    // Highest role level (level >= 3)
@Roles('auditor')           // Normal role: exact match only
```

**Note:** `@Roles()` includes JWT authentication. Do NOT add `@UseGuards(AuthGuard(JWT))`. When multiTenancy is enabled, `CoreTenantGuard` checks system roles as OR alternatives first (`S_EVERYONE` → `S_USER` → `S_VERIFIED`). Hierarchy roles use level comparison. Normal (non-hierarchy) roles use exact match. When `X-Tenant-Id` header is present, only `membership.role` is checked (user.roles ignored, except ADMIN bypass). With a system role granting access + header present, membership is still validated to set tenant context.

### @Restricted() — Field-Level Access Control

Controls who can see or modify specific properties. Evaluated by `CheckResponseInterceptor` (output) and `checkRights()` (input).

On **output** a denied field is silently removed (no exception). On **input** the request is
rejected: **403** for an authenticated requester, **401** for an anonymous one, and **403 always**
for `S_NO_ONE` — see [Status Codes: 401 vs 403](#status-codes-401-vs-403-v11280) above.

```typescript
export class User extends CorePersistenceModel {
  // Only admins or the user themselves can see the email
  @Restricted(RoleEnum.ADMIN, RoleEnum.S_SELF)
  email: string = undefined;

  // Only admins can see roles
  @Restricted(RoleEnum.ADMIN)
  roles: string[] = undefined;

  // Only users who are members of the 'teamMembers' array
  @Restricted({ memberOf: 'teamMembers' })
  internalNotes: string = undefined;

  // Restrict for input only (anyone can read, but only admins can write)
  @Restricted({ roles: RoleEnum.ADMIN, processType: ProcessType.INPUT })
  status: string = undefined;
}
```

#### Nested data: only a DECLARED type is enforced (11.35.0+)

The check recurses, but it can only find metadata for a nested value whose class it knows. An embedded
subdocument read out of MongoDB is a **plain object** (`CoreModel.map()` is a shallow `Object.assign`;
`prepareOutput()` and `ResponseModelInterceptor` map the top level only), and `Object` carries no
`@Restricted` metadata. Before 11.35.0 that meant every nested restriction silently evaluated to "no
restrictions at all"; since 11.35.0 the nested type registry `@UnifiedField` fills is consulted, so a
plain nested value is matched against the class its parent DECLARED — at every level, and for every
item of a declared array.

```typescript
@UnifiedField({ type: () => Insurance })                    // enforced
insurance?: Insurance;

@UnifiedField({ isArray: true, type: () => Insurance })     // enforced, every item
insurances?: Insurance[];

@UnifiedField({ isAny: true })                              // NOT reached — nothing declares the type
extra?: any;
```

An undeclared nested type stays unchecked on purpose: such a value is just as legitimately free-form
JSON, a `Map` or a scalar, and failing closed would strip far more than it protects. **If a nested
field must be protected, declare its type.** A class-level `@Restricted` on a nested type strips the
contents and leaves an empty container (the `checkObjectItself: false` default).

### File access — two layers, and why neither is optional

Files are the one resource whose authorization does NOT go through `CrudService.process()`, so the
decorator model above does not reach them. GridFS is reached through the native MongoDB driver and S3
through its own SDK, which means `mongooseTenantPlugin` never runs on a file store — and that is why
`CoreFileController` and `CoreFileResolver` carry `@SkipTenantCheck()`.

| Layer | What it answers | Where |
|-------|-----------------|-------|
| `file.downloadRoles` / `uploadRoles` / `deleteRoles` | "may this caller reach the route at all" | applied onto the base-class members at boot by `applyFileRoles()`, read by the role guards |
| `CoreFileService.checkRights()` | "…but only THIS file" | the service, once per operation, with `checkInputType` naming the path (`'id'`, `'filename'`, `'filterArgs'`, `'file'`, `'files'`) |

**The first layer cannot express the second.** The role names resolve against `user.roles` — a global
attribute — never against `membership.role`, so no configuration can say "only their own tenant's
files". That sentence needs data, and the data lives in the file's `metadata`.

**File ids are not secrets.** An ObjectId is 4 bytes of timestamp + 5 bytes of randomness generated once
PER PROCESS + a 3-byte incrementing counter, so a caller who holds one valid id (their own upload) knows
the random part and a counter reference point; neighbouring files sit on neighbouring values. The file
routes are also not rate-limited by the framework. So a widened role gate without a per-file rule is
practically enumerable, not theoretically.

Since 11.35.0 the second layer is a declaration rather than code — `file.access`, one value per project
class (`'public'`, `'authenticated'`, `'owner'`, `'tenant'`, or `'custom'` to write your own, the
default). `'owner'` / `'tenant'` also STAMP the metadata they decide on as the service writes. When the
gate is widened past `ADMIN` and neither `file.access` nor an override declares a policy, the service
warns at boot — the difference between a decision and an omission is the only thing a boot check can
usefully detect.

Full model, per-driver behaviour and the audit checklist: `src/core/modules/file/README.md` § Access
control and `src/core/modules/file/INTEGRATION-CHECKLIST.md`.

### @UnifiedField() — Schema & Validation

Single decorator that replaces `@Field()`, `@ApiProperty()`, `@IsOptional()`, and more:

```typescript
export class CreateUserInput extends CoreInput {
  // Required string field (shown in both GraphQL and Swagger)
  @UnifiedField({ description: 'User email address' })
  email: string = undefined;

  // Optional field
  @UnifiedField({ isOptional: true })
  displayName?: string = undefined;

  // Enum field
  @UnifiedField({ enum: RoleEnum, isOptional: true })
  role?: RoleEnum = undefined;

  // Excluded from input (hidden from schema, rejected at runtime)
  @UnifiedField({ exclude: true })
  internalId?: string = undefined;

  // Re-include a field excluded by parent class
  @UnifiedField({ exclude: false })
  parentExcludedField?: string = undefined;
}
```

### @ResponseModel() — REST Response Type Hint

For REST controllers, specifies the model class for automatic response conversion:

```typescript
@ResponseModel(User)
@Get(':id')
async getUser(@Param('id') id: string): Promise<User> {
  return this.mainDbModel.findById(id).exec();
  // Even though this returns a Mongoose document,
  // ResponseModelInterceptor converts it to User model
}
```

**Note:** For GraphQL, the return type is resolved automatically from `@Query(() => User)`.

### @ApiOkResponse() — Swagger + Response Type

For REST controllers with Swagger. Also serves as response type hint for `ResponseModelInterceptor`:

```typescript
@ApiOkResponse({ type: User })
@Get(':id')
async getUser(@Param('id') id: string): Promise<User> { ... }
```

> **NestJS docs:** [Custom decorators](https://docs.nestjs.com/custom-decorators), [OpenAPI](https://docs.nestjs.com/openapi/introduction)

---

## Model System

### Class Hierarchy

```
CoreModel                        Abstract base (map, securityCheck, hasRole)
  |
  +-- CorePersistenceModel       Adds id, createdAt, updatedAt, createdBy, updatedBy
        |
        +-- User                 Your concrete model
```

### Key Methods

#### `Model.map(data)` — Static Factory

Creates a model instance from a plain object or Mongoose document. Copies only properties that exist on the model class (defined with `= undefined`):

```typescript
const user = User.map(mongooseDoc);
// user is now a User instance with securityCheck(), hasRole(), etc.
```

This is what `prepareOutput()` and `ResponseModelInterceptor` call internally.

#### `model.securityCheck(user, force)` — Instance Security

Called by `CheckSecurityInterceptor` on every response object. Override this in your model to implement custom security logic:

```typescript
export class User extends CorePersistenceModel {
  password: string = undefined;
  internalScore: number = undefined;

  override securityCheck(user: any, force?: boolean): this {
    // Remove password from output (should never be returned)
    this.password = undefined;

    // Only admins can see internalScore
    if (!force && !user?.hasRole?.([RoleEnum.ADMIN])) {
      this.internalScore = undefined;
    }

    return this;
  }
}
```

**When securityCheck runs:**
1. `CheckSecurityInterceptor` calls it on every response object
2. `CrudService.process()` runs it via `prepareOutput()` (before the interceptor)
3. Safety Net: `ResponseModelInterceptor` converts to model first → then `CheckSecurityInterceptor` calls securityCheck

### prepareOutput() in Services

Override `prepareOutput()` in your service for custom output transformations:

```typescript
export class UserService extends CoreUserService<User> {
  override async prepareOutput(output: any, options?: any): Promise<User> {
    // Call parent (handles mapping, ObjectId conversion)
    output = await super.prepareOutput(output, options);

    // Custom transformations
    if (output && !options?.force) {
      output.fullName = `${output.firstName} ${output.lastName}`;
    }

    return output;
  }
}
```

---

## REST vs GraphQL Differences

| Aspect | REST | GraphQL |
|--------|------|---------|
| **Entry point** | `@Controller()` class | `@Resolver()` class |
| **Method decorators** | `@Get()`, `@Post()`, `@Patch()`, `@Delete()` | `@Query()`, `@Mutation()` |
| **Input** | `@Body()`, `@Param()`, `@Query()` | `@Args()` |
| **User injection** | `@CurrentUser()` (same) | `@CurrentUser()` (same) |
| **Response type resolution** | `@ResponseModel()` or `@ApiOkResponse()` | Automatic from `@Query(() => Type)` |
| **Context extraction** | `context.switchToHttp().getRequest()` | `GqlExecutionContext.create(context)` |
| **Field selection** | Not available (all fields returned) | GraphQL field selection → population |
| **File uploads** | Standard multipart | `graphqlUploadExpress()` middleware |
| **Subscriptions** | Not supported | WebSocket via `graphql-ws` |

### Guard Context Detection

Guards handle both REST and GraphQL contexts:

```typescript
// Inside RolesGuard
const gqlContext = GqlExecutionContext.create(context).getContext();
const request = gqlContext?.req || context.switchToHttp().getRequest();
```

> **NestJS docs:** [REST Controllers](https://docs.nestjs.com/controllers), [GraphQL Resolvers](https://docs.nestjs.com/graphql/resolvers)

---

## Configuration Reference

All security features are configured in `config.env.ts` under the `security` key:

### Cookies & CORS (since v11.25.0)

| Config Path | Type | Default | Description |
|-------------|------|---------|-------------|
| `cookies` | `boolean \| ICookiesConfig` | `true` | Enable cookie-parser and session cookies |
| `cookies.exposeTokenInBody` | `boolean` | `false` | Keep token in response body alongside cookies |
| `cors` | `boolean \| ICorsConfig` | `undefined` (enabled) | Unified CORS across GraphQL, REST, BetterAuth |
| `cors.allowAll` | `boolean` | `false` | Allow all origins (mirrors request origin) |
| `cors.allowedOrigins` | `string[]` | `[]` | Additional origins beyond appUrl/baseUrl |
| `cors.enabled` | `boolean` | `true` | Enable/disable CORS on all layers |

**Cookie modes:**

| Mode | Config | Token in body | Cookie set | JWT via header |
|------|--------|:---:|:---:|:---:|
| Cookie-only (default) | `cookies: true` | No | Yes | Yes (always) |
| JWT-only | `cookies: false` | Yes | No | Yes |
| Hybrid | `cookies: { exposeTokenInBody: true }` | Yes | Yes | Yes |

> **In hybrid mode the body token and the cookie are DIFFERENT values.** With the JWT plugin active,
> the body carries a JWT while the cookie keeps the opaque Better-Auth session token — Better-Auth
> resolves a session by that opaque value, so a JWT in the cookie authenticates nothing. Treating
> them as one token is what caused 11.36.3, where sign-in succeeded and every following request was
> anonymous. `setSessionCookies()` now refuses a JWT-shaped cookie value. Hybrid mode is confined to
> development and CI: `assertCookiesProductionSafe()` forbids `exposeTokenInBody` in `production`
> and `staging`.

### Guardian Gates

| Config Path | Type | Default | Description |
|-------------|------|---------|-------------|
| `security.checkResponseInterceptor` | `boolean \| object` | `true` | Enable @Restricted field filtering |
| `security.checkSecurityInterceptor` | `boolean \| object` | `true` | Enable securityCheck() calls |
| `security.mapAndValidatePipe` | `boolean \| object` | `true` | Enable input validation |
| `security.mapAndValidatePipe.nonWhitelistedFields` | `'strip' \| 'error' \| false` | `'strip'` | Whitelist behavior |

### Safety Net — Mongoose Plugins

| Config Path | Type | Default | Description |
|-------------|------|---------|-------------|
| `security.mongoosePasswordPlugin` | `boolean \| { skipPatterns }` | `true` | Auto password hashing |
| `security.mongooseRoleGuardPlugin` | `boolean \| { allowedRoles }` | `true` | Role escalation prevention |
| `security.mongooseAuditFieldsPlugin` | `boolean` | `true` | Auto createdBy/updatedBy |
| `multiTenancy` | `IMultiTenancy` | `undefined` (disabled) | Tenant-based data isolation (header + membership) |

### Safety Net — Response Interceptors

| Config Path | Type | Default | Description |
|-------------|------|---------|-------------|
| `security.responseModelInterceptor` | `boolean \| { debug }` | `true` | Plain → Model auto-conversion |
| `security.translateResponseInterceptor` | `boolean` | `true` | Auto translation application |
| `security.secretFields` | `string[]` | `['password', ...]` | Global secret field removal list |
| `security.checkSecurityInterceptor.removeSecretFields` | `boolean` | `true` | Fallback secret removal |

### Role Guard Bypass

```typescript
// Option 1: Programmatic bypass in service code
import { RequestContext } from '@lenne.tech/nest-server';

await RequestContext.runWithBypassRoleGuard(async () => {
  await this.mainDbModel.create({ roles: ['EMPLOYEE'] });
});

// Option 2: CrudService force mode
this.process(serviceFunc, { serviceOptions, force: true });

// Option 3: Config-based (permanently allow roles)
security: {
  mongooseRoleGuardPlugin: { allowedRoles: ['HR_MANAGER'] },
}
```

### Tenant Guard Bypass

```typescript
// Cross-tenant admin operations
import { RequestContext } from '@lenne.tech/nest-server';

const allOrders = await RequestContext.runWithBypassTenantGuard(async () => {
  return this.orderService.find(); // sees all tenants
});

// Exclude specific schemas from tenant filtering
multiTenancy: {
  excludeSchemas: [], // model names, not collection names — this turns isolation OFF per model
}
```

---

## NestJS Documentation Links

| Topic | URL |
|-------|-----|
| **Request Lifecycle** | https://docs.nestjs.com/faq/request-lifecycle |
| **Middleware** | https://docs.nestjs.com/middleware |
| **Guards** | https://docs.nestjs.com/guards |
| **Interceptors** | https://docs.nestjs.com/interceptors |
| **Pipes** | https://docs.nestjs.com/pipes |
| **Custom Decorators** | https://docs.nestjs.com/custom-decorators |
| **Validation** | https://docs.nestjs.com/techniques/validation |
| **Authentication** | https://docs.nestjs.com/security/authentication |
| **Authorization** | https://docs.nestjs.com/security/authorization |
| **MongoDB / Mongoose** | https://docs.nestjs.com/techniques/mongodb |
| **GraphQL** | https://docs.nestjs.com/graphql/quick-start |
| **GraphQL Resolvers** | https://docs.nestjs.com/graphql/resolvers |
| **REST Controllers** | https://docs.nestjs.com/controllers |
| **OpenAPI / Swagger** | https://docs.nestjs.com/openapi/introduction |
| **Dynamic Modules** | https://docs.nestjs.com/fundamentals/dynamic-modules |
