# Code Architecture

## Framework Stack

- **NestJS** - Server framework
- **GraphQL** - API layer (Apollo Server)
- **MongoDB** - Database (Mongoose ODM)

## Two-Layer Structure

1. **Core Layer** (`src/core/`) - Reusable framework components (exported to consumers)
2. **Server Layer** (`src/server/`) - Internal test/demo implementation (not exported)

## Core Module (`src/core.module.ts`)

- Dynamic module providing base functionality
- Configures GraphQL with Apollo Server (can be disabled via `graphQl: false`), MongoDB with Mongoose
- Provides global services: ConfigService, EmailService, TemplateService
- Sets up security interceptors, validation pipes, complexity plugins (when GraphQL enabled)
- Handles GraphQL subscriptions with authentication

## Configuration System (`src/config.env.ts`)

Environment-based configuration (development, local, production) with multiple sources:

- Direct environment variables in config file
- `NEST_SERVER_CONFIG` JSON environment variable
- `NSC__*` prefixed single environment variables

Key areas: JWT, MongoDB, GraphQL, email, security, static assets

## Core Common Components (`src/core/common/`)

| Type | Components |
|------|------------|
| **Decorators** | `@Restricted()`, `@Roles()`, `@CurrentUser()`, `@UnifiedField()` |
| **Helpers** | Database, GraphQL, filtering, validation utilities |
| **Security** | Response/security interceptors, input validation pipes |
| **Scalars** | Custom GraphQL scalars (Date, JSON, Any) |
| **Services** | CRUD operations, email (Mailjet/SMTP), template rendering |

## Core Modules (`src/core/modules/`)

| Module | Purpose |
|--------|---------|
| **Auth** | JWT authentication, refresh tokens, role-based access |
| **BetterAuth** | Modern auth integration (2FA, Passkey, Social) |
| **ErrorCode** | Centralized error codes with unique identifiers |
| **File** | File upload/download with GridFS storage |
| **HealthCheck** | Application health monitoring |
| **Migrate** | Database migration utilities |
| **SystemSetup** | Initial admin creation for fresh deployments |
| **Tus** | Resumable file uploads via tus.io protocol |
| **User** | Core user management functionality |

## Security Implementation

- `@Restricted()` - Field-level access control
- `@Roles()` - Method-level authorization
- `CheckResponseInterceptor` - Filters restricted fields
- `CheckSecurityInterceptor` - Processes `securityCheck()` methods

## Model Inheritance

- `CorePersistenceModel` - Base for database entities
- `CoreModel` - Base for GraphQL types
- Automatic ID handling with custom Mongoose plugin

## Input Validation

- `MapAndValidatePipe` - Automatic validation with inheritance-aware checking
- `@UnifiedField()` - Single decorator for GraphQL, Swagger, and validation (replaces separate `@Field`, `@ApiProperty`, `@IsOptional`, etc.)
- Automatic input property whitelisting — properties without `@UnifiedField` are stripped (default) or rejected
- `@UnifiedField({ exclude: true })` — explicitly exclude a property from input (hidden from schema, rejected at runtime)
- `@UnifiedField({ exclude: false })` — explicitly re-enable a property excluded by a parent class
- Configurable via `security.mapAndValidatePipe.nonWhitelistedFields`: `'strip'` (default), `'error'`, or `false`
- Custom decorator parameters (`@CurrentUser()`, `@RESTServiceOptions()`, etc.) and basic types (`String`, `Number`, etc.) are skipped — no validation or whitelist check
- Recursive nested object/array checking via `nestedTypeRegistry`
- Core args classes for filtering/pagination
