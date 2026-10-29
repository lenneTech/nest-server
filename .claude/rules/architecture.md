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
| **Central infrastructure (optional)** | `CoreRedisService` + `CoreRedisPubSub` (`redis` config), `CoreS3Service` (`s3` config), `RateLimitStore`, the `installGracefulShutdown()` helper. All inert without their config — see below |

### Optional central infrastructure

`CoreRedisService` and `CoreS3Service` are always provided and exported by `CoreModule`, but stay
**inert unless configured** (`redis` / `s3`, "presence implies enabled"). Their client libraries are
OPTIONAL peer dependencies, lazy-imported at bootstrap, so a project that uses neither installs
nothing extra. They exist so process-local state can become shared state when a deployment runs more
than one replica: rate-limit counters, cron deduplication, GraphQL subscriptions, tenant-cache
invalidation, Hub collectors and file storage all pick the distributed path automatically when the
config is present, and keep their previous single-process behaviour when it is not. Inject them with
`@Optional()` and always keep the non-configured fallback path — that is the pattern every core
consumer follows. See `.claude/rules/configurable-features.md` for the full option reference.

**MongoDB itself is optional since 12.1.0** — the same pattern one level down: `mongoose`, `@nestjs/mongoose` and
`mongodb` are optional peers, reached only through `common/persistence/mongo/` (never a static value import in
`src/core/`), and `CoreModule` connects MongoDB only when a data source uses it. `pnpm run check:without-mongodb`
proves the build loads and runs with them unresolvable. Rules: `.claude/rules/persistence.md`.

## Core Modules (`src/core/modules/`)

| Module | Purpose |
|--------|---------|
| **ApiToken** | Opt-in bearer tokens: USER tokens (act as their user, no global roles) and TENANT tokens (lowest tenant role, own tenant only); deny by default via `@ApiTokenScopes()`; signed short-lived assertions |
| **Auth** | JWT authentication, refresh tokens, role-based access |
| **BetterAuth** | Modern auth integration (2FA, Passkey, Social) |
| **ErrorCode** | Centralized error codes with unique identifiers |
| **File** | File upload/download with GridFS storage |
| **HealthCheck** | Application health monitoring |
| **Hub** | Build-free ADMIN-gated operator cockpit at `/hub` (config-gated per environment; 17 panels, runtime collectors, mailbox, admin actions) |
| **Migrate** | Database migration utilities |
| **Permissions** | ADMIN-gated security-map report (routes + roles + `@Restricted` fields); also surfaced in the Hub's "Routes / Permissions" panel |
| **SystemSetup** | Initial admin creation for fresh deployments |
| **Tus** | Resumable file uploads via tus.io protocol |
| **User** | Core user management functionality |

## Security Implementation

- `@Restricted()` - Field-level access control
- `@Roles()` - Method-level authorization
- `CheckResponseInterceptor` - Filters restricted fields
- `CheckSecurityInterceptor` - Processes `securityCheck()` methods

## Module Format: an ESM package whose source is valid as CommonJS AND ESM (12.0.0+)

All NestJS 12 packages are ESM-only, and so is this one since 12.0.0: `package.json` declares `"type": "module"`,
`dist/` is one ESM build. A CommonJS project loads it through Node's `require(esm)` (Node 20.19+ / 22.12+;
`engines.node` is `>= 22.15`) exactly as it loads every `@nestjs/*` package — verified against the unchanged
nest-server-starter (type check, all tests, build, `migrate:list`, production start). `tsconfig.json` uses `module` /
`moduleResolution: nodenext`, so `tsc` resolves exactly like Node, `exports` maps included, plus `isolatedModules`
(NestJS 12's default; SWC compiles one file at a time anyway).

**`require()` of the package must keep working, so the package must never contain top-level `await`** —
`require(esm)` refuses a graph with it (`ERR_REQUIRE_ASYNC_MODULE`), and every CommonJS project would stop loading.

**Two contracts stay CommonJS, through a directory-level `package.json` with `"type": "commonjs"`:**
`src/core/modules/migrate/helpers/` (the TypeScript loader `ts-compiler.js`, whose path and function export every
project's `--compiler ts:…` and `node -r …` name) and `bin/` (`bin/migrate.js`, the `migrate` binary). Both
`package.json` files reach `dist/` and vendor projects like any other file, so the contracts hold in CommonJS and ESM
projects alike.

**No CommonJS module may sit inside the core's ES module graph and load other core modules.** Found the hard way:
with `migration.helper.ts` compiled as CommonJS in `helpers/` and imported by the barrel, `require('@lenne.tech/nest-server')`
returned the helper's exports instead of the barrel's — Node mixed up the module objects while a CommonJS module
required ES modules of the graph it was being loaded for. The helper therefore lives in `migrate/migration.helper.ts`
(ESM like the rest); `helpers/migration.helper.ts` is a CommonJS forwarder for the path existing
`migrations-utils/migrate.js` files require, and nothing in the core imports it.

**Enforced in three places, because vitest sees none of it** (it imports sources through its own module runner):
`tests/unit/module-format-invariants.spec.ts` refuses a runtime import from a CommonJS directory into the graph and any
top-level `await` (mutation `barrel-imports-cjs-forwarder`); `tests/unit/package-format-contracts.spec.ts` loads
`bin/migrate.js`, the loader and the forwarder in place, in a child process, and checks that every CommonJS `.js` file
sits in a CommonJS scope and that nest-cli copies the nested manifests into `dist/` (mutations
`bin-manifest-type-module`, `nest-cli-assets-drop-json`, `migration-helper-forwarder-emptied`); and
`pnpm run check:manifest` (after the build in `check`) does the same against the PACKED package, plus `require()` vs
`import()` of `dist/index.js` in two fresh processes — the export lists must match.

The **source** of `src/core/` must additionally be valid as **ESM**, because a vendor-mode project may be an ESM
project (`"type": "module"`, what `nest new` generates since NestJS 12) and then compiles and runs the vendored core as
ESM. Rules for code in `src/core/`, `src/index.ts`, `src/core.module.ts` and `src/test/`:

| Rule | Why |
|------|-----|
| Relative specifiers name the emitted file: `./x.js`, `./dir/index.js` — never `./x` or `./dir` | ESM resolves no extension and no directory. `tsc` under `nodenext` keeps the specifier as written; the SWC loader and vitest map `.js` to `.ts` in a source run |
| No `require()`, `__dirname` / `__filename`, `import x = require()`, `export =` (CommonJS only) and no `import.meta` (ESM only). Use static imports, `createRequire(join(process.cwd(), 'package.json'))` to load a PROJECT file, `callerDirectory()` (`common/helpers/module-location.helper.ts`) for "the directory of this file" | each of them fails in the other module system — inside a function only when it runs. Enforced by `tests/unit/module-format-invariants.spec.ts` (mutation `core-uses-dirname`), because `check:esm` sees only what fails while a module LOADS |
| A CommonJS package without `__esModule` is a DEFAULT import (`import _ from 'lodash'`), one WITH it (graphql) a named or namespace import. Never a named import Node cannot see (`import { cloneDeep } from 'lodash'`, mongoose's `Connection` as a value) | ESM gets a CommonJS module's names from `cjs-module-lexer`, which misses lodash's and mongoose's. Under CommonJS the same line works, so only `pnpm run check:esm` notices |
| `import type` for types — also in decorated signatures; `export type` for re-exported types | `isolatedModules` (TS1272 / TS1205): a value import of a type links under CommonJS and fails under ESM |
| A cycle that forces laziness is broken with an import-free leaf, never with a lazy `require()` | `core-better-auth.registry.ts` → `isBetterAuthHandlerClass()` is how the tenant guard recognises the IAM handlers |
| No deep imports into `@nestjs/*` packages whose `exports` map lists only the root (`jwt`, `mongoose`, `passport`, `schedule`, `swagger`, `terminus`) | `ERR_PACKAGE_PATH_NOT_EXPORTED` at runtime, `TS2307` at compile time. `@nestjs/common`, `core`, `platform-express` and `graphql` export `./*`, so their subpaths still resolve |
| No relative dynamic `import()` at all | under `nodenext` a dynamic `import()` in CommonJS output stays a NATIVE `import()` and follows ESM resolution, while a source run in a CommonJS project turns it into `require()`. vitest accepts both, so only `tests/unit/module-format-invariants.spec.ts` sees it — the 12.0.0 migration runner shipped `await import('./helpers/migration.helper.js')` with every suite green |
| A dual package (separate CJS and ESM builds — `@aws-sdk/*`, `@modelcontextprotocol/sdk`, `@getbrevo/brevo`, `bullmq`) is either lazy everywhere or static everywhere | a native `import()` loads the ESM build, a static import the CJS build — two module instances, and an `instanceof` across them fails. Take its types from the import EXPRESSION (`const load = () => import('x'); type X = Awaited<ReturnType<typeof load>>`), never from an `import type`: TypeScript types an `import()` the way it is emitted (ESM under `nodenext`, CJS under `module: commonjs`), while any fixed `import type` matches only one of the two (TS2322 in the other). And keep such a derived CLASS type out of public/protected signatures — under `module: commonjs` with declarations it cannot be named (TS2883); give the extension point a structural interface instead (`IBrevoSdkClient`) |
| Write code that compiles under BOTH `nodenext` and `module: commonjs` | vendor consumers compile `src/core/` with their own tsconfig. Under TypeScript 6, `module: commonjs` without `moduleResolution` resolves as `bundler` and keeps the `require()` emit for `import()`. Enforced by `pnpm run typecheck:vendor` (`scripts/check-vendor-declarations.mjs` + `tsconfig.vendor-commonjs.json`, part of `check`): it compiles under `module: commonjs`, emits the declarations and fails on `typeof import("<package>")` or `import("<pkg>/…/dist/…")` in them — references that resolve in this repo's HOISTED `node_modules` and break in a consumer's isolated pnpm layout (TS2883). The nodenext build alone passed three 12.0.0 errors that only a vendor project saw |

**`pnpm run check:esm`** (`scripts/check-esm-core.mjs`, part of `check`) is the proof of the ESM half: it copies what a
vendor project receives into a temporary `"type": "module"` package, compiles it with `nodenext` and imports EVERY
module plus the barrel in one process. It catches what no other step can — a named import Node cannot see, a type
imported as a value, a missing extension — and reports each distinct cause once.

**The TypeScript loader is three files.** `helpers/ts-compiler.cjs` is the implementation, `ts-compiler-hooks.mjs` the
ESM hooks it registers through `module.register()` (resolve `.js` → `.ts`, compile ESM-scoped `.ts` with SWC — import
attributes kept — and hand CommonJS-scoped files back), and `ts-compiler.js` the established entry path, a one-line
CommonJS shim that `helpers/package.json` keeps CommonJS in every project. The SWC build (`check:swc-tdz`) does not
emit `.cjs` / `.mjs` sources; its guard places them like `tsc` does. That guard also pins the SWC build to CommonJS
(`tsconfig.swc-tdz.json`), because it checks what a CommonJS project runs under `nest start -b swc`; `@nestjs/cli` would
otherwise emit ES modules for this `"type": "module"` package.

**The build `target` stays `es2022`**, although NestJS 12's template uses `ES2023`: a vendor project compiles the core
with its own lib, and the starter's is es2022 — see `tests/unit/toolchain-contract.spec.ts`. ES2023 changes no emitted
syntax on Node 22, only which APIs the type-checker allows.

**Type-aware lint.** `pnpm run lint` runs `oxlint --type-aware` (needs `oxlint-tsgolint`) with
`typescript/no-floating-promises` as an error, as NestJS 12's template does: an un-awaited promise's rejection is
unhandled, and Node ends the process on that by default. Mark a deliberate fire-and-forget with `void` and say why it
cannot reject. The other type-aware rules the categories would turn on are switched off in `.oxlintrc.json`, each
with the reason; `tests/unit/lint-type-aware.spec.ts` pins the flag, the backend and the rule, because without either
half oxlint skips the rule silently.

The SWC build (`nest start -b swc`, `check:swc-tdz`), the SWC source loader and vitest transform `import()`
themselves; none of them is affected by the tsconfig's `module` setting. `tsconfig.tests.json` uses
`module: preserve` + `moduleResolution: bundler` because that is how vitest resolves the specs. **Both vitest configs
set `resolve.extensions` in Node's order** (`.js` before `.mjs`): graphql declares an extensionless `main` next to an
`index.mjs`, Vite probes `.mjs` first, and an `import` of graphql then loaded a second, ESM copy — every subscription
closed with 4500 ("Cannot use GraphQLSchema from another module or realm"). Pinned by
`tests/unit/vitest-node-resolution.spec.ts`. Background: `migration-guides/11.43.x-to-12.0.x.md` §2–§3 and §17.

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

Repo-wide cycles went from **10 → 5**, and **every DI token in `src/core/` now lives in an import-free leaf**. The five that remain are, per an SWC-emit audit, **not runtime cycles at all** — type-only imports that madge reports but both compilers erase (their emits are empty).

Since 11.33.0 madge reports a **sixth**: `server/modules/user/user.module.ts ↔ server/modules/file/file.module.ts`. That one IS a real runtime cycle, and it is deliberate — the avatar upload needs `FileService` to reach the central file storage while `FileModule` already imported `UserModule`. It is a NestJS *module* cycle, not a TDZ hazard: both sides declare it with `forwardRef()`, and nothing on either side dereferences the other at class-definition time. It lives in `src/core/`-external `src/server/`, which vendor consumers do not receive.

Both invariants are enforced by `tests/unit/import-cycle-invariants.spec.ts`, which fails if a token reappears in a `*.module.ts` / `*.service.ts` or if a leaf grows an import. That matters, because the guard below catches the *crash*, not the *disarming* of a safety property — those are different things, and only the second one is silent.

| Module | Token / type leaf |
|--------|-------------------|
| `better-auth` | `core-better-auth.constants.ts` (tokens) + `core-better-auth.registry.ts` (static service refs, `import type` only, deliberately **not** barrel-exported) |
| `ai` | `core-ai.constants.ts` (all 22 `AI_*` tokens) + `interfaces/ai-interaction-record.interface.ts` |
| `tus` | `tus.constants.ts` (`TUS_CONFIG`) |
| `tenant` | `core-tenant.enums.ts` |
| `auth` | `interfaces/auth-provider.interface.ts` |
| `common/services` | `core-cron-jobs.registry.ts` (the cron infrastructure refs `CoreCronJobs` reads — `import type` only, so its emit is empty). Unlike the better-auth registry it IS barrel-exported: `setCronJobsInfrastructure()` / `getCronJobsInfrastructure()` are public, because a project may register its own connection or Redis service |
| `common/helpers` | `id.helper.ts` (ID cluster, out of `db.helper`) + `clone.helper.ts` (`clone`/`deepFreeze`, out of `input.helper`) |
| `common/inputs` | `FilterInput` + `CombinedFilterInput` merged into `filter.input.ts` — declaration order is load-bearing |
| `common/decorators` | `restricted.decorator` is on **zero** cycles; its exports are hoisted `function` declarations (TDZ-immune) as defense in depth. `nested-type.registry.ts` (11.35.0) holds `nestedTypeRegistry` + `resolveNestedType`, because `unified-field.decorator` WRITES the map while `restricted.decorator` now READS it — and `unified-field` already imports `restricted` for `@Restricted`, so a direct read would put the access-control file back on a cycle. `unified-field.decorator` re-exports both, so no import path broke |
| `common/services` (tenant) | `core-tenant-context.registry.ts` (11.35.0) — how a transport without an Express request (the GraphQL WebSocket) reaches `CoreTenantGuard`'s membership logic. Under `common/` rather than next to the tenant module because the READER is `common/helpers/graphql-ws-context.helper`, and `src/core/common/**` must not import from `src/core/modules/**`; a registry rather than DI because the GraphQL wiring must not depend on a provider that only exists when multi-tenancy is configured |
| `modules/tus` | `tus.constants.ts` also holds `TUS_OWNER_METADATA_KEY` (11.35.0) |

Every old location re-exports what it lost, so no import path broke — the public API is byte-identical (472 exports, verified by diffing both versions).

### What each of these actually was

Worth knowing, because the pattern repeats:

- **`CombinedFilterInput` was already crashing.** `require('.../combined-filter.input.js')` threw. It stayed hidden because the barrel happens to pull `filter.input` in first — a deep import or a reordering of `src/index.ts` would have surfaced it. A lazy thunk does **not** fix that shape: `emitDecoratorMetadata` still emits an eager `design:type`.
- **`restricted.decorator` sat on two cycles at once**, in the file that drives field-level access control. Removing the `db.helper` edge felt like the fix and left the `config.service` one fully intact. **Removing one edge is not removing the cycle** — re-run madge and confirm the file appears in *zero* cycles.
- **The AI interaction record was held apart by one keyword.** `import type` erases the edge; an IDE "organize imports" widening it to a value import would have armed a `design:paramtypes` deref, silently.
- **`TUS_CONFIG` and the 22 `AI_*` tokens** never crashed — their graphs happened to be acyclic. Each was one back-import away, with nothing watching.

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
