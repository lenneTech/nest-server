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

## DI Token Placement (SWC-Safe)

**Rule: DI tokens belong in an import-free leaf file (`*.constants.ts` / `*.enums.ts`) — never in `*.module.ts` or `*.service.ts`.**

A token declared in a module that the service imports (or vice versa) makes the two files import each other. That cycle compiles fine under tsc, but `@Inject(TOKEN)` is a constructor-parameter decorator evaluated at **class-definition time** — so on the cycle it reads a `const` that is still in its temporal dead zone. Under SWC → CommonJS (`nest start -b swc`) the app dies at startup:

```
ReferenceError: Cannot access 'BETTER_AUTH_INSTANCE' before initialization
```

**This is invisible to `tsc`, to `pnpm test` (vitest runs SWC through Vite's cycle-tolerant module runner) and to `oxlint` (which has no `import/no-cycle` rule).** It is caught only by `pnpm run check:swc-tdz`.

### The general rule: a cycle is fatal only when dereferenced at evaluation time

The cycle alone is survivable. What kills it is **reading a TDZ-subject binding (`const` / `class` / `let`) while the module is still initializing**:

| Deref location | Evaluated | Danger |
|----------------|-----------|--------|
| Decorator argument (`@UnifiedField({ type: X })`, `@Inject(TOKEN)`) | class-definition time | ☠️ **fatal on a cycle** |
| `design:type` / `design:paramtypes` metadata (from `emitDecoratorMetadata`) | class-definition time | ☠️ **fatal on a cycle** — and userland cannot make it lazy |
| Static / class field initializer | class-definition time | ☠️ **fatal on a cycle** |
| Top-level `const alias = X` | module-evaluation time | ☠️ **fatal on a cycle** |
| Inside a function or method body | call time | ✅ safe (both modules are done by then) |
| `export function` declaration | hoisted | ✅ TDZ-immune — prefer over `const` arrows on cycle-adjacent files |
| `import type` | erased | ✅ not a runtime edge at all |

**A lazy thunk is often NOT enough.** `type: () => X` defers the decorator argument, but `emitDecoratorMetadata` still emits an eager `design:type` for the property, and SWC's `typeof` guard does not protect the member expression it compiles to. To be safe you must remove the **import edge** — merge the modules, or extract the shared binding into a leaf.

### `check:swc-tdz` loads every module as its own entry point

Whether such a cycle throws depends on **which module the graph is entered through**. A barrel-only check is not enough: `filter.input` ↔ `combined-filter.input` crashed on a direct `require()` of `combined-filter.input` while the barrel loaded green, because the barrel happened to pull `filter.input` in first. So the guard requires each compiled file separately (`scripts/check-swc-tdz.mjs`).

### Status per module

Repo-wide cycles went from **10 → 6** while fixing this. The six that remain are, per an SWC-emit audit, almost all **not runtime cycles at all** (type-only imports that madge reports but both compilers erase — their emits are empty).

| Module | Status |
|--------|--------|
| `better-auth` | ✅ `core-better-auth.constants.ts` (tokens) + `core-better-auth.registry.ts` (static service refs, `import type` only) |
| `tenant` | ✅ `core-tenant.enums.ts` |
| `auth` | ✅ `interfaces/auth-provider.interface.ts` |
| `common/inputs` | ✅ `FilterInput` + `CombinedFilterInput` merged into `filter.input.ts` (declaration order is load-bearing). Split apart, a direct `require()` of `combined-filter.input` **crashed** — it was a live bug, masked by the barrel. |
| `common/helpers` | ✅ `id.helper.ts` (ID cluster, extracted from `db.helper`) + `clone.helper.ts` (`clone`/`deepFreeze`, extracted from `input.helper`). Both are true leaves. |
| `common/decorators` | ✅ `restricted.decorator` is now on **zero** cycles. It took BOTH leaves: `id.helper` killed `→ db.helper → input.helper →`, `clone.helper` killed `→ core-tenant.helpers → config.service → input.helper →`. Its three exports are additionally hoisted `function` declarations (TDZ-immune) as defense in depth. |
| `ai` | ⚠️ `core-ai-interaction.service` ↔ `core-ai.service` is kept off a real cycle **only** by an `import type` on `AiInteractionRecord`. An IDE "organize imports" could silently widen it to a value import and arm a `design:paramtypes` deref. Pinned by `tests/unit/import-cycle-invariants.spec.ts`; moving the type to a leaf would settle it. |
| `tus` | ⚠️ `TUS_CONFIG` declared in `tus.module.ts` — currently acyclic, but unguarded |
| `ai` (tokens) | ⚠️ `AI_*_CLASS` / `AI_*_MODEL` declared in 9 `ai/services/*.service.ts` — currently acyclic, but unguarded |

The ⚠️ entries are each one refactor away from the identical crash. `check:swc-tdz` will catch it if they are ever armed — but move the binding to a leaf when you touch them.

### The lesson that cost the most time

Removing one edge is not the same as removing the cycle. `restricted.decorator` was on **two** cycles through different paths; extracting the ID helpers out of `db.helper` felt like the fix and left the second one (via `config.service`) fully intact — with `madge` happily reporting the file as still cyclic. Always re-run `npx madge --circular --extensions ts src/` after an extraction and check the file appears in **zero** cycles, rather than assuming the edge you removed was the only one.

Full background, failure analysis and the mistakes table: `.claude/rules/better-auth.md` §6.

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
