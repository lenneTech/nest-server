# Framework Compatibility for Claude Code

This document defines the maintenance obligations that ensure Claude Code can effectively work with `@lenne.tech/nest-server` in consuming projects.

## Architecture Overview

The framework ships documentation alongside source code so that Claude Code can read it from `node_modules/`. Three layers work together:

1. **npm package** ships `CLAUDE.md`, `FRAMEWORK-API.md`, `.claude/rules/`, `docs/`, `migration-guides/`
2. **Consuming project** `CLAUDE.md` points Claude to read `node_modules/@lenne.tech/nest-server/`
3. **Claude Code plugin** (`lt-dev`) detects nest-server and injects concrete source paths via hooks

## Maintenance Obligations

### When Adding/Changing Interfaces in `server-options.interface.ts`

1. `FRAMEWORK-API.md` is auto-generated during `pnpm run build` via `scripts/generate-framework-api.ts`
2. Verify the generated output includes the new interface and all fields
3. Add JSDoc with `@default` tags for all config fields — these appear in the API reference

### When Adding New Core Modules (`src/core/modules/`)

1. Create `README.md` and `INTEGRATION-CHECKLIST.md` in the module directory
2. The generator script automatically picks up new modules for the "Core Modules" table
3. If the module has `forRoot()` config, add the interface to `server-options.interface.ts`
4. Run `pnpm run build` to regenerate `FRAMEWORK-API.md`

### When Changing CrudService Methods

1. Add JSDoc to new methods — the generator extracts the first line as description
2. Run `pnpm run build` to regenerate `FRAMEWORK-API.md`
3. If the method signature pattern changes (standard/Force/Raw), update the "Variants" note

### When Changing `CoreModule.forRoot()` Signatures

1. Ensure JSDoc is complete on the new overload
2. Run `pnpm run build` to regenerate `FRAMEWORK-API.md`
3. If adding a new parameter, update the consuming project template (`nest-server-starter/CLAUDE.md`)

### When Releasing New Versions

1. Run `pnpm run build` — this regenerates `FRAMEWORK-API.md` with the new version number
2. The file is included in the npm package via `package.json` `files` array
3. Migration guides are separate (see `.claude/rules/migration-guides.md`)

## Files Shipped with npm Package

| File | Purpose | Auto-Updated |
|------|---------|:------------:|
| `CLAUDE.md` | Framework rules, architecture, debugging guide | Manual |
| `FRAMEWORK-API.md` | Compact API reference (interfaces, methods) | Yes (`pnpm run build`) |
| `.claude/rules/*.md` | 12 rule files covering all aspects | Manual |
| `docs/REQUEST-LIFECYCLE.md` | Complete request lifecycle | Manual |
| `migration-guides/*.md` | Version migration guides | Per release |

## Generator Script

`scripts/generate-framework-api.ts` extracts via ts-morph:
- `CoreModule.forRoot()` overload signatures
- All config interfaces (`IServerOptions`, `IBetterAuth`, `IMultiTenancy`, etc.)
- `ServiceOptions` interface
- `CrudService` public method signatures
- Core module listing with documentation status

Run manually: `npx tsx scripts/generate-framework-api.ts`

## Cross-Repository Dependencies

This framework compatibility strategy spans multiple repositories:

| Repository | Role |
|-----------|------|
| `nest-server` | Ships documentation with npm package (this repo) |
| `nest-server-starter` | `CLAUDE.md` points Claude to `node_modules/` source |
| `nuxt-extensions` | Same pattern: `CLAUDE.md` shipped with npm package |
| `nuxt-base-starter` | `CLAUDE.md` points Claude to nuxt-extensions source |
| `claude-code/plugins/lt-dev` | Hooks detect frameworks, Skills reference source paths |

The full strategy document is maintained in the claude-code plugin repository.
