# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Self-Improvement Instructions

**Claude Code must actively maintain and improve this file.**

After significant development sessions where new fundamental insights were gained together with the developer, Claude Code should:

1. **Update this file** with new learnings that are valuable for future development sessions (patterns, pitfalls, best practices discovered during implementation)

2. **Validate against best practices** - Check if this CLAUDE.md still follows Claude Code best practices and can be optimally utilized for development

3. **Optimize automatically** - Restructure, clarify, or extend sections as needed to maximize effectiveness

**Goal:** This CLAUDE.md should always be current and optimally structured so that Claude Code is perfectly briefed to extend and improve this project in the best possible way.

**When to update:**
- New architectural patterns established
- Important edge cases or pitfalls discovered
- New integrations added that require specific handling
- Development workflows improved
- Common mistakes identified that should be avoided

## Project Overview

### What is this?
This is **@lenne.tech/nest-server** - an extension/layer on top of [NestJS](https://docs.nestjs.com/) that provides additional functionality for building server applications with GraphQL and MongoDB.

- **NPM Package**: https://www.npmjs.com/package/@lenne.tech/nest-server
- **GitHub Repository**: https://github.com/lenneTech/nest-server
- **NestJS Framework**: https://github.com/nestjs/nest

### Ecosystem

This package is part of the lenne.Tech ecosystem:

1. **@lenne.tech/nest-server** (this repository)
   - Core extension package providing reusable components
   - Extended through `src/core/common` (decorators, helpers, services)
   - Extended through `src/core/modules` (auth, file, user modules)

2. **nest-server-starter** (https://github.com/lenneTech/nest-server-starter)
   - Template project for new applications
   - Has @lenne.tech/nest-server as dependency
   - **Reference project**: Each new version is integrated and tested here
   - **Migration documentation**: Commits document required changes for each version upgrade

3. **lt CLI** (https://github.com/lenneTech/cli)
   - Command-line tool for project initialization and extension
   - Server commands: https://github.com/lenneTech/cli/tree/main/src/commands/server
   - Use `lt server module <ModuleName>` to generate new modules

## Important Development Guidelines

### Design Principles

**Dynamic Integration & Flexible Configuration**

All new components (third-party package integrations, elements in `src/core/common`, and modules in `src/core/modules`) must be designed with maximum flexibility:

1. **Dynamic Integrability**: Components should be opt-in and configurable at runtime or during module initialization. Avoid hardcoded dependencies that force all consumers to use specific features.

2. **Flexible Configuration**: Provide comprehensive configuration options so consuming projects can customize behavior without modifying this package. Use:
   - Configuration interfaces with sensible defaults
   - Factory methods for custom implementations
   - Conditional feature activation via config flags
   - Dependency injection for swappable implementations

3. **No Package Modification Required**: The goal is that projects using @lenne.tech/nest-server can fully leverage all features, customized to their specific needs, without ever needing to fork or modify this package.

**Example Pattern:**
```typescript
// Good: Configurable module with options
CoreModule.forRoot({
  graphQl: { playground: true, introspection: true },
  email: { provider: 'smtp', config: { ... } },
  customFeature: { enabled: false }  // Opt-in
})

// Bad: Hardcoded behavior that can't be customized
```

### When Modifying This Package

1. **Backward Compatibility**: Changes affect all projects using this package. Consider breaking changes carefully.

2. **Version Documentation**: After significant changes, the corresponding update must be applied and documented in the [nest-server-starter](https://github.com/lenneTech/nest-server-starter) repository.

3. **Test Coverage**: All changes must pass E2E tests (`npm test`). Production-ready code requires all tests to pass without errors.

4. **Export Management**: New public components must be exported via `src/index.ts` to be available to consuming projects.

### Code Organization

- `src/core/` - **Reusable framework components** (exported to consumers)
  - `src/core/common/` - Decorators, helpers, interceptors, pipes, scalars, services
  - `src/core/modules/` - Auth, File, User, HealthCheck modules
- `src/server/` - **Internal test/demo implementation** (not exported)
- `src/index.ts` - **Public API exports**

### Adding New Features

When adding new functionality:

1. **Determine location**: Core components go in `src/core/`, test implementations in `src/server/`
2. **Follow existing patterns**: Check similar existing implementations for consistency
3. **Update exports**: Add public APIs to `src/index.ts`
4. **Add tests**: Create or extend E2E tests in `tests/`
5. **Document changes**: Update relevant documentation if needed

## Common Development Commands

### Building and Running
- `npm run build` - Build the application (uses Nest CLI, outputs to dist/)
- `npm start` - Start in local mode (same as start:local)
- `npm run start:dev` - Start in development mode with nodemon watching
- `npm run start:local` - Start with NODE_ENV=local and nodemon
- `npm run start:prod` - Start in production mode with PM2

### Testing
- `npm test` or `npm run test:e2e` - Run E2E tests (default test command)
- `npm run test:cov` - Run tests with coverage
- `npm run test:ci` - Run tests in CI mode
- `npm run test:e2e-doh` - Run E2E tests with --detectOpenHandles for debugging

### Linting and Formatting
- `npm run lint` - Run ESLint on source files with caching
- `npm run lint:fix` - Run ESLint with auto-fix
- `npm run format` - Format code with Prettier
- `npm run format:staged` - Format only staged files with pretty-quick

### Documentation
- `npm run docs` - Generate and serve API documentation (SpectaQL + Compodoc)
- `npm run docs:ci` - Generate documentation for CI

### Package Development
- `npm run build:dev` - Build and push to yalc for local package testing
- `npm run build:pack` - Create tarball for integration testing
- `npm run reinit` - Clean reinstall with tests and build
- `npm run watch` - Watch for changes using npm-watch

## Code Architecture

### Core Framework Structure
This is a **NestJS-based server** with **GraphQL API** and **MongoDB** integration using Mongoose. The codebase is organized into two main layers:

1. **Core Layer** (`src/core/`) - Reusable framework components
2. **Server Layer** (`src/server/`) - Project-specific implementations (for testing)

### Key Architectural Components

#### Core Module (`src/core.module.ts`)
- Dynamic module providing base functionality for any NestJS server
- Configures GraphQL with Apollo Server, MongoDB with Mongoose
- Provides global services: ConfigService, EmailService, TemplateService
- Sets up security interceptors, validation pipes, and complexity plugins
- Handles GraphQL subscriptions with authentication

#### Configuration System (`src/config.env.ts`)
- Environment-based configuration (development, local, production)
- Supports multiple config sources:
  - Direct environment variables in config file
  - `NEST_SERVER_CONFIG` JSON environment variable
  - `NSC__*` prefixed single environment variables
- Key config areas: JWT, MongoDB, GraphQL, email, security, static assets

#### Core Common Components (`src/core/common/`)
- **Decorators**: `@Restricted()`, `@Roles()`, `@CurrentUser()`, `@UnifiedField()`
- **Helpers**: Database, GraphQL, filtering, validation utilities
- **Security**: Response/security interceptors, input validation pipes
- **Scalars**: Custom GraphQL scalars (Date, JSON, Any)
- **Services**: CRUD operations, email (Mailjet/SMTP), template rendering

#### Authentication & Authorization (`src/core/modules/auth/`)
- JWT-based auth with refresh tokens
- Role-based access control
- GraphQL subscription authentication
- Passport strategies for JWT validation

#### Modular Structure
- **Auth Module**: User authentication and session management
- **File Module**: File upload/download with GridFS storage
- **User Module**: Core user management functionality
- **Health Check Module**: Application health monitoring

### Development Patterns

#### Creating New Modules
Use the lenne.Tech CLI for consistent module generation:
```bash
lt server module <ModuleName>
```

#### Model Inheritance
- Extend `CorePersistenceModel` for database entities
- Use `CoreModel` for base GraphQL types
- Automatic ID handling with custom Mongoose plugin

#### Input Validation
- All inputs automatically validated via `MapAndValidatePipe`
- Use class-validator decorators on input classes
- Filtering and pagination handled by core args classes

#### Security Implementation
- `@Restricted()` decorator for field-level access control
- `@Roles()` decorator for method-level authorization
- Response interceptor automatically filters restricted fields
- Security interceptor processes `securityCheck()` methods

## Testing Configuration

### E2E Tests
- Primary testing approach using Vitest (migrated from Jest)
- Configuration in `vitest.config.ts`
- Test files in `tests/` directory with `.e2e-spec.ts` suffix
- Run with `NODE_ENV=local` environment

### Test Environment Setup
- Uses local MongoDB instance
- Custom test helper utilities in `src/test/test.helper.ts`
- Coverage collection from `src/**/*.{ts,js}`

## Package Distribution

This package serves dual purposes:
1. **NPM Package**: Distributed as `@lenne.tech/nest-server` for integration
2. **Direct Usage**: Can be cloned and extended as a project template

### Versioning Strategy

The version number follows a specific schema: `MAJOR.MINOR.PATCH`

| Part    | Meaning                                                            |
|---------|--------------------------------------------------------------------|
| `MAJOR` | Mirrors the NestJS major version (e.g., `11.x.x` = NestJS 11)      |
| `MINOR` | Breaking changes or significant restructuring                      |
| `PATCH` | Improvements (bugfixes) or additions (new features) - non-breaking |

**Examples:**
- `11.0.0` → Initial release for NestJS 11
- `11.1.0` → Breaking change or major restructuring within NestJS 11
- `11.1.5` → Bugfix or new feature (backward compatible)

**Important:** When incrementing the minor version, always document the breaking changes clearly in the commit message and ensure the nest-server-starter is updated with migration instructions.

### Release Process
1. Make changes and ensure all tests pass
2. Update version in `package.json`
3. Build the package (`npm run build`)
4. Publish to npm
5. Update and test in nest-server-starter
6. Commit changes to starter with migration notes

### Package Exports
- Main entry: `dist/index.js`
- Types: `dist/index.d.ts`
- All public APIs exported from `src/index.ts`

## Environment Configuration

### Database
- MongoDB connection configured per environment
- Default local: `mongodb://127.0.0.1/nest-server-local`
- Mongoose strictQuery disabled by default
- Custom ID plugin automatically applied

### GraphQL Setup
- Schema-first approach with code generation
- Introspection enabled in non-production
- Subscription support with WebSocket authentication
- Query complexity analysis (max 1000 by default)

### Email Configuration
- Supports both SMTP and Mailjet providers
- Template rendering with EJS
- Development uses Ethereal Email / MailHog for testing

## Debugging & Troubleshooting

### Common Issues

**E2E Tests Timeout or Fail**
- Ensure MongoDB is running on `localhost:27017`
- Verify `NODE_ENV=local` is set
- Use `npm run test:e2e-doh` for open handle detection
- Check test timeout settings in `vitest.config.ts`

**GraphQL Introspection Not Working**
- Verify introspection is enabled in `config.env.ts` for non-production
- Check Apollo Server configuration in CoreModule

**Database Connection Failures**
- Verify MongoDB connection string in environment config
- Check `mongoose.set('strictQuery', false)` setting
- Ensure MongoDB service is running

**Module/Service Not Found After Adding**
- Verify export in `src/index.ts`
- Check module is properly imported in CoreModule or target module
- Run `npm run build` to regenerate dist files

**Validation Errors Not Showing**
- Ensure `MapAndValidatePipe` is applied
- Check class-validator decorators on input classes
- Verify DTO extends correct base class

## Role System (RoleEnum)

The role system distinguishes between **real roles** and **system roles**:

### Real Roles
Actual roles stored in `user.roles` array in the database:
- `RoleEnum.ADMIN` - Administrator role

### System Roles (S_ Prefix)
System roles are used for **runtime checks only** and must **NEVER** be stored in `user.roles`:

| Role | Purpose | Check Logic |
|------|---------|-------------|
| `S_USER` | User is logged in | `currentUser` exists |
| `S_VERIFIED` | User is verified | `user.verified \|\| user.verifiedAt \|\| user.emailVerified` |
| `S_CREATOR` | User created the object | `object.createdBy === user.id` |
| `S_SELF` | User is accessing own data | `object.id === user.id` |
| `S_EVERYONE` | Public access | Always true |
| `S_NO_ONE` | Locked access | Always false |

### Critical Rule
```typescript
// CORRECT: Using S_ roles in decorators (runtime checks)
@Roles(RoleEnum.S_USER)
@Restricted(RoleEnum.S_VERIFIED)

// WRONG: Storing S_ roles in user.roles array
roles: [RoleEnum.S_USER]  // ❌ NEVER do this!

// CORRECT: Empty roles or real roles only
roles: []                  // ✓ Empty array
roles: [RoleEnum.ADMIN]    // ✓ Real role
```

The `S_` prefix indicates a **system check**, not an actual role. These are evaluated dynamically at runtime based on context (current user, request, object being accessed).

## Best Practices for This Repository

1. **All code, comments, and documentation must be in English**
2. **Run tests before considering any change complete** - `npm test`
3. **Follow existing code patterns** for consistency across the codebase
4. **Consider downstream impact** - this package is used by multiple projects
5. **Document breaking changes** clearly for version updates
6. **Never store S_ roles in user.roles** - they are system checks, not actual roles
