# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

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

### Development Utilities
- `npm run build:dev` - Build and push to yalc for local package development
- `npm run reinit` - Clean reinstall with tests and build
- `npm run watch` - Watch for changes using npm-watch

## Code Architecture

### Core Framework Structure
This is a **NestJS-based server** with **GraphQL API** and **MongoDB** integration using Mongoose. The codebase is organized into two main layers:

1. **Core Layer** (`src/core/`) - Reusable framework components
2. **Server Layer** (`src/server/`) - Project-specific implementations

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
- Primary testing approach using Jest
- Configuration in `jest-e2e.json`
- Test files in `tests/` directory with `.e2e-spec.ts` suffix
- 20-second timeout for database operations
- Run with `NODE_ENV=local` environment

### Test Environment Setup
- Uses local MongoDB instance
- Custom test helper utilities in `src/test/test.helper.ts`
- Coverage collection from `src/**/*.{ts,js}`

## Package Distribution

This package serves dual purposes:
1. **NPM Package**: Distributed as `@lenne.tech/nest-server` for integration
2. **Direct Usage**: Can be cloned and extended as a project template

### Package Development
- `npm run build:dev` - Build and publish to yalc for local testing
- `npm run build:pack` - Create tarball for integration testing
- Main entry: `dist/index.js`, Types: `dist/index.d.ts`

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