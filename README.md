# lenne.Tech Nest Server

An enterprise-grade extension layer on top of [NestJS](https://nestjs.com/) for building secure, scalable server applications with **GraphQL**, **REST/Swagger** and **MongoDB, PostgreSQL, MySQL or MariaDB**.

[![License](https://img.shields.io/github/license/lenneTech/nest-server)](/LICENSE)
[![npm version](https://img.shields.io/npm/v/@lenne.tech/nest-server)](https://www.npmjs.com/package/@lenne.tech/nest-server)
[![Node.js](https://img.shields.io/badge/node-%3E%3D%2022.15-brightgreen)](https://nodejs.org/)

## Table of Contents

- [Quick Start](#quick-start)
- [Features Overview](#features-overview)
- [Architecture](#architecture)
- [API-First Design](#api-first-design)
- [Authentication](#authentication)
- [Roles & Permissions](#roles--permissions)
- [Multi-Tenancy](#multi-tenancy)
- [Databases](#databases)
- [API Tokens](#api-tokens)
- [AI Assistant & MCP](#ai-assistant--mcp)
- [Operator Hub](#operator-hub)
- [Scalability](#scalability)
- [API Versioning](#api-versioning)
- [Webhook Support](#webhook-support)
- [External System Integration](#external-system-integration)
- [Core Modules](#core-modules)
- [Configuration](#configuration)
- [Development](#development)
- [Documentation](#documentation)
- [License](#license)

## Quick Start

The fastest way to get started is via the [lenne.Tech CLI](https://github.com/lenneTech/cli) with the [starter project](https://github.com/lenneTech/nest-server-starter):

```bash
npm install -g @lenne.tech/cli
lt server create <ServerName>
cd <ServerName>
pnpm start
```

Or install directly as a package:

```bash
pnpm add @lenne.tech/nest-server
```

### Create a new module

```bash
lt server module <ModuleName>
```

This generates a complete module with model, inputs, resolver, controller, and service.

## Features Overview

| Category | Features |
|----------|----------|
| **API-First** | GraphQL (Apollo Server) + REST with Swagger/OpenAPI, dual API surface from single codebase |
| **Authentication** | BetterAuth (IAM) with JWT, sessions, 2FA/TOTP, Passkey/WebAuthn, social login; Legacy JWT auth (opt-in); scoped API tokens for users and tenants |
| **Authorization** | Extensible role-based access control, field-level restrictions (also on nested types), system roles, hierarchy roles; every entry point checked, not just the route |
| **Database** | MongoDB (Mongoose), PostgreSQL, MySQL or MariaDB (TypeORM, Kysely or Drizzle) — per project or per model — behind one CrudService and security pipeline; tenant isolation enforced by row-level security on PostgreSQL; schema evolution and SQL migrations by the framework; advanced filtering & pagination |
| **Multi-Tenancy** | Header-based tenant isolation, membership management, hierarchy roles, auto-filtering, a tenant row check after every read, deactivatable tenants |
| **File Handling** | GridFS, S3 or filesystem storage, presigned downloads, resumable uploads via TUS protocol (up to 50 GB, S3 staging) |
| **AI** | AI assistant with tool registry, plan mode, confirmation policy, token budgets, conversations and SSE streaming; MCP server (`/ai/mcp`) with OAuth 2.1 |
| **Security** | Defense-in-depth: input validation, password hashing, role guard, audit fields, response filtering, security headers, SSRF guard for user-entered URLs, re-checked WebSocket subscriptions |
| **Integration** | SCIM support, OAuth providers, multi-provider email (Mailjet/Brevo/SMTP), webhook support via lifecycle hooks |
| **Scalability** | Stateless design; optional Redis and S3 for multi-replica deployments (shared rate limits, cron deduplication, GraphQL subscriptions, cache invalidation, file storage); distributed locks; graceful shutdown; query complexity analysis |
| **API Versioning** | NestJS-native URI/header/media-type versioning, GraphQL schema evolution with deprecations |
| **DevOps** | Operator Hub (`/hub`), health checks, database migrations (MongoDB and SQL), cron jobs, permissions reporting, system setup |
| **Platform** | NestJS 12, ESM package that CommonJS projects load as well; npm or vendor mode (the core copied into the project) |

## Architecture

### Modular Extensibility

The framework is built on a **Module Inheritance Pattern** — all core modules are designed to be extended through class inheritance in consuming projects:

```typescript
// Your project extends core classes — full control via override + super()
export class UserService extends CoreUserService {
  override async create(input, serviceOptions) {
    // Custom pre-processing (validation, enrichment, ...)
    const result = await super.create(input, serviceOptions);
    // Custom post-processing (notifications, logging, ...)
    return result;
  }
}
```

**Why inheritance over hooks/events:**
- **Full control**: Override methods and precisely define what happens before/after `super()` calls
- **Selective override**: Skip parts of the parent implementation entirely for custom logic
- **Type safety**: TypeScript inheritance ensures proper typing and IDE support
- **No silent failures**: No runtime event systems or hooks that can fail silently

### Two-Layer Structure

- `src/core/` — Reusable framework components (exported via npm, extended by projects)
- `src/server/` — Internal test/demo implementation (not exported)

Every core module supports both **auto-registration** (zero-config) and **manual registration** (full customization via extended module). New modules can be added alongside existing ones without modifying the framework.

### Framework Stack

- [NestJS](https://nestjs.com/) — Server framework
- [Apollo Server](https://www.apollographql.com/docs/apollo-server/) — GraphQL API (optional, disable via `graphQl: false`)
- [Mongoose](https://mongoosejs.com/) — MongoDB ODM (optional peer since 12.1.0)
- [PostgreSQL](https://www.postgresql.org/), [MySQL](https://www.mysql.com/) or [MariaDB](https://mariadb.org/) via TypeORM, Kysely or Drizzle — optional, see [Databases](#databases)
- [Swagger/OpenAPI](https://swagger.io/) — REST API documentation
- [Redis](https://redis.io/) and S3-compatible storage — optional, for multi-replica deployments (see [Scalability](#scalability))

## API-First Design

The server follows an API-first approach where API contracts are the primary interface:

### Dual API Surface

Both **GraphQL** and **REST** endpoints are served from the same codebase and business logic. The `@UnifiedField()` decorator generates schemas for both APIs simultaneously:

```typescript
@UnifiedField({ description: 'User email address', isOptional: false })
email: string;
// → Generates: GraphQL @Field() + Swagger @ApiProperty() + class-validator checks
```

### Documented API Structure

- **GraphQL Introspection** — Full schema introspection for client code generation (configurable via `graphQl.introspection`)
- **Swagger/OpenAPI** — Auto-generated REST API documentation from decorators
- **SpectaQL** — Visual GraphQL documentation (`pnpm run docs`)
- **Permissions Dashboard** — Interactive HTML report of all endpoints, roles, and security checks (`/permissions`)

### GraphQL Features

- Custom scalars: `Date`, `DateTime`, `JSON`, `Any`
- WebSocket subscriptions with authentication
- Query complexity analysis (DoS prevention)
- File upload support via `graphql-upload`
- Automatic enum registration

## API Versioning

NestJS provides built-in [API versioning](https://docs.nestjs.com/techniques/versioning) support with multiple strategies. Projects can enable versioning for REST endpoints:

| Strategy | Example | Use Case |
|----------|---------|----------|
| **URI** | `/v1/users`, `/v2/users` | Most common, explicit in URL |
| **Header** | `X-API-Version: 2` | Clean URLs, version in header |
| **Media Type** | `Accept: application/vnd.app.v2+json` | Content negotiation |

```typescript
// main.ts — enable URI versioning
app.enableVersioning({ type: VersioningType.URI });

// controller — assign to version
@Controller({ path: 'users', version: '2' })
export class UsersV2Controller { ... }

// or per-route
@Get()
@Version('2')
async findAll() { ... }
```

**GraphQL** APIs are evolved through schema additions and field deprecations (`@deprecated`) rather than versioning, following the [GraphQL best practice](https://graphql.org/learn/best-practices/#versioning) of continuous evolution.

## Webhook Support

The framework provides webhook capabilities through two mechanisms:

### BetterAuth Lifecycle Hooks

BetterAuth supports [hooks](https://www.better-auth.com/docs/concepts/hooks) that intercept authentication lifecycle events. Projects can extend the BetterAuth service via the Module Inheritance Pattern to react to these events:

```typescript
export class AuthService extends CoreBetterAuthService {
  override async signIn(input, serviceOptions) {
    const result = await super.signIn(input, serviceOptions);
    // Trigger webhook after successful sign-in
    await this.webhookService.dispatch('auth.sign-in', { userId: result.user.id });
    return result;
  }
}
```

Authentication events that can be intercepted include: sign-in, sign-up, sign-out, session creation, token refresh, email verification, 2FA verification, and more.

### Module Inheritance for Custom Webhooks

Any service method can be extended to dispatch webhooks via the Module Inheritance Pattern:

```typescript
export class ProjectService extends CoreProjectService {
  override async create(input, serviceOptions) {
    const project = await super.create(input, serviceOptions);
    // Dispatch webhook on project creation
    await this.webhookService.dispatch('project.created', project);
    return project;
  }
}
```

This approach allows projects to add webhook dispatching to any CRUD operation or custom business logic without modifying the framework.

## Authentication

Two authentication systems are available — BetterAuth (recommended) and Legacy JWT auth:

### BetterAuth (IAM) — Recommended

Modern, session-based authentication with plugin architecture:

| Feature | Config |
|---------|--------|
| **JWT tokens** | `betterAuth.jwt: true` |
| **Two-Factor (2FA/TOTP)** | `betterAuth.twoFactor: true` |
| **Passkey/WebAuthn** | `betterAuth.passkey: true` |
| **Social login** (Google, GitHub, Apple, ...) | `betterAuth.socialProviders: { ... }` |
| **Email verification** | `betterAuth.emailVerification: { ... }` |
| **Rate limiting** | `betterAuth.rateLimit: { max: 10 }` |
| **Cross-subdomain cookies** | `betterAuth.crossSubDomainCookies: true` |
| **Disable sign-up** | `betterAuth.emailAndPassword.disableSignUp: true` |

Three integration patterns: zero-config, config-based, or manual (`autoRegister: false`).

BetterAuth provides **lifecycle hooks** for reacting to authentication events (sign-in, sign-up, session creation, etc.), enabling integration with external systems. See [Webhook Support](#webhook-support) for details.

### Legacy Auth (JWT)

Passport-based JWT authentication with sign-in, sign-up, refresh tokens, and rate limiting. Runs in parallel with BetterAuth during migration. Since 11.38.0 the legacy endpoints are off unless a project opts in with `auth.legacyEndpoints.enabled: true`; disabled endpoints answer 410 Gone.

A built-in **migration status query** (`betterAuthMigrationStatus`) tracks progress and indicates when legacy auth can be safely disabled.

## Roles & Permissions

The role and permission system is designed for extensibility — from simple role checks to complex multi-tenant hierarchies.

### System Roles (Runtime Checks)

System roles (`S_` prefix) are evaluated dynamically at runtime, never stored in the database:

| Role | Purpose |
|------|---------|
| `S_USER` | Any authenticated user |
| `S_VERIFIED` | Email-verified users |
| `S_CREATOR` | Creator of the resource |
| `S_SELF` | User accessing own data |
| `S_EVERYONE` | Public access |
| `S_NO_ONE` | Permanently locked |

### Method & Field-Level Authorization

```typescript
// Method-level: who can call this endpoint?
@Roles(RoleEnum.ADMIN)
async deleteUser() { ... }

// Field-level: who can see/modify this field?
@Restricted(RoleEnum.S_SELF, RoleEnum.ADMIN)
email: string;

// Membership-based: only team members can see this field
@Restricted({ memberOf: 'teamMembers' })
internalNotes: string;
```

### Custom Role Hierarchies

Projects can define custom role hierarchies beyond the built-in roles:

```typescript
// Custom hierarchy with level-based comparison
const HR = createHierarchyRoles({ viewer: 1, editor: 2, admin: 3, owner: 4 });

@Roles(HR.EDITOR) // requires level >= 2 (editor, admin, or owner)
async editDocument() { ... }
```

### Resource-Level Security

Every model can override `securityCheck()` for fine-grained, context-aware access control:

```typescript
export class Project extends CorePersistenceModel {
  override securityCheck(user: any, force?: boolean): this {
    // Remove sensitive fields based on user context
    if (!this.hasRole(user, RoleEnum.ADMIN)) {
      this.budget = undefined;
    }
    return this;
  }
}
```

### Permissions Reporting

The built-in Permissions module scans all endpoints and generates security audit reports (HTML dashboard, JSON, Markdown) showing coverage of `@Roles`, `@Restricted`, and `securityCheck()` across the entire API.

## Multi-Tenancy

Full multi-tenancy support with header-based tenant isolation, membership management, and automatic data filtering:

```typescript
// config.env.ts
multiTenancy: {
  headerName: 'x-tenant-id',
  roleHierarchy: { member: 1, manager: 2, owner: 3 },
  adminBypass: true,
}

// Usage in resolvers
@Roles(DefaultHR.MANAGER)
async updateProject(@CurrentTenant() tenantId: string) { ... }
```

- **Membership validation** — `CoreTenantGuard` validates membership on every request
- **Hierarchy roles** — Level comparison (higher includes lower), custom via `createHierarchyRoles()`
- **Automatic data isolation** — the tenant policy filters all queries by tenant context (Mongoose plugin on MongoDB, the data store and row-level security on PostgreSQL)
- **Defense-in-depth** — Guard validation, the tenant policy, and a tenant row check that refuses any read result containing another tenant's row
- **Every transport** — GraphQL subscriptions over WebSocket get the same validated tenant context, and open sockets are re-checked when rights change
- **Multi-membership** — Users can belong to multiple tenants with different roles
- **Status management** — ACTIVE, INVITED, SUSPENDED membership states
- **`@SkipTenantCheck()`** — Opt out per endpoint
- **`@CurrentTenant()`** — Parameter decorator for validated tenant ID

## Databases

A project keeps its data in **MongoDB** (the default), in **PostgreSQL**, in **MySQL 8.4 / MariaDB 11.8**, or in several
of them, model by model — the framework's own modules (users, tenants, API tokens, AI, file metadata, locks,
migrations) run on each; Better-Auth on MongoDB and PostgreSQL:

```typescript
// config.env.ts — PostgreSQL as the default source
database: {
  url: 'postgres://app_role@db/project',      // application role: owns nothing, no BYPASSRLS
  ownerUrl: 'postgres://owner_role@db/project', // owner role: creates and migrates the schema
  sqlEngine: 'typeorm',                         // or 'kysely' / 'drizzle'
},
```

Models are registered with `CorePersistenceModule.forFeature()` and declared with the framework's `Schema`, `Prop` and
`SchemaFactory` (same names as `@nestjs/mongoose`). `mongoose`, `@nestjs/mongoose` and `mongodb` are optional peers: a
project on PostgreSQL alone installs none of them (in vendor mode it keeps them as `devDependencies` for the types the
vendored core imports). On MySQL and MariaDB (`mysql2` plus the engine) there is no row-level security: tenant isolation
is the store's, and native access to a tenant table must filter by tenant itself. Which database to choose:
[docs/choosing-a-database.md](docs/choosing-a-database.md);
the rules for code: [.claude/rules/persistence.md](.claude/rules/persistence.md).

## API Tokens

Opt-in bearer tokens for integrations and scripts (`apiTokens` configuration):

- **User tokens** act as their user, with global roles removed (no admin bypass through a token)
- **Tenant tokens** act with the lowest hierarchy role inside their own tenant (requires `multiTenancy`)
- **Deny by default** — a token is refused on every route that does not release a scope via `@ApiTokenScopes()`, public routes included
- **Signed short-lived assertions** with encrypted signing keys, a per-token rate limit, and a separate Swagger view with only the routes a token may call

Details: [src/core/modules/api-token/README.md](src/core/modules/api-token/README.md).

## AI Assistant & MCP

An optional AI module (`ai` configuration) for any OpenAI-compatible model endpoint:

- **Tool registry** — the assistant reaches exactly the domain operations a project registers as tools, filtered by the user's roles; tools go through a `CrudService`, so `@Restricted` and `securityCheck()` apply
- **Plan mode and confirmations** — a full plan is authorized step by step before anything runs; mutating and destructive tools ask for confirmation
- **Token budgets** per user and per tenant, conversations, audit log, SSE streaming, admin-editable prompt fragments
- **MCP server** at `/ai/mcp` (Streamable HTTP) with optional OAuth 2.1 (PKCE, dynamic client registration, consent page), so MCP clients use the same tools with the same rights

Integration: [src/core/modules/ai/INTEGRATION-CHECKLIST.md](src/core/modules/ai/INTEGRATION-CHECKLIST.md).

## Operator Hub

A build-free, ADMIN-only operator cockpit at `/hub`, enabled per environment (`hub` configuration): dashboard and
diagnostics, logs, request traces, query profiler, cron jobs, database and models, migrations, files, configuration,
routes and permissions, error codes, e-mail preview and mailbox, AI. Mutating actions require a confirmation keyword
and are written to an audit log. Details: [src/core/modules/hub/README.md](src/core/modules/hub/README.md).

## Scalability

The architecture is designed for horizontal scalability:

- **Stateless request handling** — No server-side session state in the process (JWT, or Better-Auth sessions in the database)
- **Optional central infrastructure** — with `redis` configured, rate limits hold across replicas, cron jobs run once per tick (BullMQ), GraphQL subscriptions reach every replica and tenant-cache invalidations are broadcast; with `s3` configured, files and resumable uploads live in shared storage. Without the configuration every feature keeps its process-local behaviour
- **Distributed locks** — migrations, cron leases and the initial admin setup are serialized across instances, on MongoDB or SQL
- **Graceful shutdown** — `installGracefulShutdown(app)` with `shutdownDelayMs` lets a load balancer deregister the instance before it closes
- **Request-scoped isolation** — `AsyncLocalStorage`-based `RequestContext` ensures safe concurrent request processing without shared mutable state
- **Query complexity analysis** — Configurable complexity limits prevent expensive GraphQL queries from consuming excessive resources
- **Connection pooling** — Managed by the Mongoose/MongoDB driver and by one pool per SQL source

## External System Integration

### Authentication Providers

BetterAuth supports OAuth integration with external identity providers (Google, GitHub, Apple, Discord, and more) via the `socialProviders` configuration.

### SCIM Support

Built-in [SCIM](http://www.simplecloud.info/) (System for Cross-domain Identity Management) filter parsing and MongoDB query conversion for enterprise identity management:

```typescript
scimToMongo('userName eq "Joe" and emails[type eq "work"]')
// → MongoDB: { $and: [{ userName: 'Joe' }, { emails: { $elemMatch: { type: 'work' } } }] }
```

Supported operators: `eq`, `co`, `sw`, `ew`, `gt`, `ge`, `lt`, `le`, `pr`, `aco`, `and`, `or`.

### Email Providers

Pluggable email provider abstraction with support for:
- **Mailjet** — API-based transactional email
- **Brevo** — API-based transactional email (formerly Sendinblue)
- **SMTP** — Standard SMTP via Nodemailer

All providers use the same `EmailService` interface with EJS template engine and locale-aware template resolution.

### Extensibility

The Module Inheritance Pattern ensures any core module can be extended to integrate with external systems — override service methods to add API calls, event publishing, webhook dispatching, or data synchronization without modifying the framework. See also [Webhook Support](#webhook-support).

## Core Modules

| Module | Purpose |
|--------|---------|
| **AI** | AI assistant with tool registry, budgets, conversations and an MCP server with OAuth 2.1 |
| **ApiToken** | Scoped user and tenant tokens, deny by default |
| **Auth** | Legacy JWT authentication with Passport strategies (opt-in) |
| **BetterAuth** | Modern auth (2FA, Passkey, Social, sessions, lifecycle hooks) on MongoDB or PostgreSQL |
| **User** | User management, profile, roles, verification |
| **Tenant** | Multi-tenancy with membership and hierarchy roles |
| **File** | File upload/download with GridFS, S3 or filesystem storage |
| **Tus** | Resumable file uploads via [tus.io](https://tus.io/) protocol (up to 50 GB) |
| **ErrorCode** | Centralized error codes with unique identifiers |
| **HealthCheck** | REST (`/health-check`) and GraphQL health monitoring, per database source |
| **Hub** | ADMIN-only operator cockpit at `/hub` |
| **Migrate** | Migrations for MongoDB and SQL with distributed locking for cluster deployments |
| **Permissions** | Security map report: routes, roles and `@Restricted` fields (HTML, JSON, Markdown) |
| **SystemSetup** | Initial admin creation for fresh deployments |

### CrudService

Abstract base service providing a complete CRUD pipeline with built-in security:

```typescript
export class ProjectService extends CrudService<Project> {
  // Inherits: find, findOne, create, update, delete
  // With: input validation, field selection, security checks, population
}
```

**Advanced querying** with comparison operators (`eq`, `ne`, `gt`, `in`, `contains`, `regex`, ...), logical operators (`AND`, `OR`), pagination, sorting, and GraphQL-driven population.

### Security Layers

Defense-in-depth security architecture with three layers:

**Layer 1: Guards & Middleware**
- `@Roles()` — Method-level authorization (includes JWT auth automatically)
- `@Restricted()` — Field-level access control with process type support (INPUT/OUTPUT)
- System roles — `S_USER`, `S_VERIFIED`, `S_CREATOR`, `S_SELF`, `S_EVERYONE`, `S_NO_ONE`

**Layer 2: CrudService Pipeline**
- Input validation — MapAndValidatePipe with whitelist checking
- `@UnifiedField()` — Single decorator for GraphQL, Swagger, and validation
- `securityCheck()` — Resource-level security on model instances

**Layer 3: Data Layer (Safety Net)** — the same policies on every database: as Mongoose plugins on MongoDB, in the data store on SQL
- Password policy — Automatic password hashing
- Role guard — Prevents unauthorized role escalation at DB level; system roles can never be stored
- Audit fields — Automatic `createdBy`/`updatedBy` tracking
- Tenant isolation — Automatic tenant filtering, plus a tenant row check after every read and row-level security on PostgreSQL

**Interceptor Chain:**
- ResponseModelInterceptor — Plain objects to CoreModel conversion
- TranslateResponseInterceptor — Multi-language support via `Accept-Language`
- CheckSecurityInterceptor — Executes `securityCheck()` and removes secret fields
- CheckResponseInterceptor — Enforces `@Restricted()` field-level filtering

### Email & Templates

Multi-provider email service (Mailjet, Brevo, SMTP) with EJS template engine and locale-aware template resolution.

## Configuration

Configuration is managed via `src/config.env.ts` with environment-based profiles (development, local, production):

```typescript
export const config = {
  local: {
    port: 3000,
    graphQl: { driver: 'apollo' },
    mongoose: { uri: 'mongodb://localhost/my-app' }, // or: database: 'postgres://…' (see Databases)
    betterAuth: { secret: 'my-secret', jwt: true, twoFactor: true },
    multiTenancy: { roleHierarchy: { member: 1, manager: 2, owner: 3 } },
  },
};
```

### Configuration Patterns

- **Presence implies enabled**: `rateLimit: {}` enables with defaults, `undefined` stays disabled
- **Boolean shorthand**: `jwt: true` enables with defaults, `{ expiresIn: '1h' }` customizes

### Environment Variables

Three methods to override configuration:

1. **Direct** — `process.env.PORT` in `config.env.ts`
2. **JSON** — `NEST_SERVER_CONFIG` environment variable (deep merge)
3. **Prefixed** — `NSC__EMAIL__DEFAULT_SENDER__NAME` for `email.defaultSender.name`

## Development

**Requirements:** Node.js >= 22.15, pnpm 11, MongoDB and Docker for the e2e suite (the Redis, S3, PostgreSQL, MySQL and MariaDB test containers start automatically)

```bash
# Install dependencies
pnpm install

# Start in development mode
pnpm run start:dev

# Run tests (Vitest: unit + e2e, the e2e suite on MongoDB and on PostgreSQL)
pnpm test

# Run tests with coverage
pnpm run test:cov

# Everything a release needs: audit, format, lint, type checks, tests, build, module-format checks
pnpm run check

# Lint (oxlint) & format (oxfmt)
pnpm run lint
pnpm run format

# Build
pnpm run build

# Generate documentation
pnpm run docs
```

### Docker Production Build

The [starter project](https://github.com/lenneTech/nest-server-starter) includes a production-ready multi-stage Dockerfile. It works both as a standalone project and inside a monorepo created with `lt fullstack init`:

```bash
# Standalone
docker build -t api .
docker run -e NSC__MONGOOSE__URI=mongodb://host:27017/mydb -p 3000:3000 api

# Monorepo (build context = monorepo root)
docker build --build-arg API_DIR=projects/api -t api .
```

The `docker-entrypoint.sh` runs database migrations before starting the server. On MongoDB the migration store reads `NSC__MONGOOSE__URI`; on SQL, `createMigrationStore()` connects with the owner URL and keeps its state in `lt_migrations`.

### Debugging as package

Link into a consuming project for local development:

```bash
# In nest-server
pnpm run watch

# In your project
pnpm run link:nest-server     # pnpm link /path/to/nest-server
pnpm run unlink:nest-server   # pnpm unlink @lenne.tech/nest-server && pnpm install
```

### Versioning

`MAJOR.MINOR.PATCH` — MAJOR mirrors NestJS version, MINOR = breaking changes, PATCH = non-breaking improvements.

## Documentation

- [Request Lifecycle](docs/REQUEST-LIFECYCLE.md) — Complete request pipeline, security architecture, interceptor chain
- [Choosing a Database](docs/choosing-a-database.md) — MongoDB, PostgreSQL, MySQL/MariaDB or several, and which SQL engine
- [Native Driver Security](docs/native-driver-security.md) — What native database access bypasses, and the safe alternatives
- [process() Performance](docs/process-performance-optimization.md) — The CrudService pipeline on hot paths, subdocument arrays
- [Framework API](FRAMEWORK-API.md) — Generated reference of interfaces, `CoreModule.forRoot()` and CrudService methods
- [Security Overrides](docs/security-overrides.md) — **Read this**: pnpm `overrides:` are not inherited from this package, so two known-vulnerable transitive deps need an entry in *your* project
- [Migration Guides](migration-guides/) — Version upgrade instructions
- [Starter Project](https://github.com/lenneTech/nest-server-starter) — Reference implementation
- [CLI](https://github.com/lenneTech/cli) — Code generation tools
- [NestJS Documentation](https://docs.nestjs.com/) — Framework docs

## Thanks

Many thanks to the developers of [NestJS](https://github.com/nestjs/nest)
and all the developers whose packages are used here.

## License

MIT - see [LICENSE](/LICENSE)
