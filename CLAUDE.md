# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Quick Reference

- [Commands](#common-development-commands) | [Architecture](#code-architecture) | [Guidelines](#development-guidelines) | [Troubleshooting](#debugging--troubleshooting)
- **Detailed Rules**: See `.claude/rules/` for in-depth documentation

## Self-Improvement Instructions

**Claude Code must actively maintain and improve this file and `.claude/rules/`.**

After significant development sessions, update with new learnings (patterns, pitfalls, best practices). Keep this file concise (~150 lines) and move detailed topics to `.claude/rules/`.

## Project Overview

**@lenne.tech/nest-server** - An extension layer on top of NestJS for building server applications with GraphQL and MongoDB.

- **NPM**: https://www.npmjs.com/package/@lenne.tech/nest-server
- **GitHub**: https://github.com/lenneTech/nest-server
- **Starter Project**: https://github.com/lenneTech/nest-server-starter (reference for migrations)
- **CLI**: https://github.com/lenneTech/cli (`lt server module <Name>`)

## Common Development Commands

```bash
# Building & Running
npm run build          # Build (outputs to dist/)
npm start              # Start in local mode
npm run start:dev      # Development mode with watch

# Testing (ALWAYS run before completing changes)
npm test               # Run E2E tests (Vitest)
npm run test:cov       # With coverage
npm run test:e2e-doh   # Debug open handles

# Linting & Formatting
npm run lint           # ESLint check
npm run lint:fix       # Auto-fix
npm run format         # Prettier format

# Package Development
npm run build:dev      # Build + push to yalc
npm run reinit         # Clean reinstall + tests + build
```

## Code Architecture

**Two-Layer Structure:**
- `src/core/` - Reusable framework components (exported)
- `src/server/` - Internal test implementation (not exported)
- `src/index.ts` - Public API exports

**Key Components:**
- `CoreModule` - Dynamic module with GraphQL, MongoDB, security
- `src/core/common/` - Decorators, helpers, interceptors, services
- `src/core/modules/` - Auth, BetterAuth, File, User, HealthCheck

See `.claude/rules/architecture.md` for detailed documentation.

## Development Guidelines

### Core Principles

1. **Module Inheritance Pattern** - Extend through inheritance, not hooks/events
   - See `.claude/rules/module-inheritance.md`

2. **Dynamic Integration** - Components opt-in, configurable, no package modification required

3. **Backward Compatibility** - Changes affect all consuming projects

4. **Test Coverage** - All changes must pass `npm test`

5. **Export Management** - New public components → `src/index.ts`

### Role System (Critical)

System roles (`S_` prefix) are runtime checks only - **NEVER store in user.roles**:

```typescript
@Roles(RoleEnum.S_USER)      // Correct: runtime check
roles: [RoleEnum.S_USER]      // WRONG: never store S_ roles!
roles: [RoleEnum.ADMIN]       // Correct: real role
```

See `.claude/rules/role-system.md` for complete documentation.

### Versioning

`MAJOR.MINOR.PATCH` where MAJOR = NestJS version, MINOR = breaking changes, PATCH = non-breaking.

See `.claude/rules/versioning.md` for release process.

## Environment Configuration

```typescript
// config.env.ts supports:
- Direct environment variables
- NEST_SERVER_CONFIG JSON variable
- NSC__* prefixed variables
```

**Key areas:** JWT, MongoDB, GraphQL, email, security, betterAuth

## Debugging & Troubleshooting

| Issue | Solution |
|-------|----------|
| Tests timeout | Ensure MongoDB running on localhost:27017 |
| GraphQL introspection fails | Check `config.env.ts` introspection setting |
| Module not found after adding | Verify export in `src/index.ts`, run `npm run build` |
| Open handles in tests | Run `npm run test:e2e-doh` |

## Best Practices

1. **All code, comments, documentation in English**
2. **Run tests before completing changes** - `npm test`
3. **Follow existing patterns** for consistency
4. **Never store S_ roles** in user.roles array
5. **Use Module Inheritance Pattern** for core modules
6. **Document breaking changes** in commits
7. **Integration Checklists for Core Modules** - Every core module requiring project integration needs `INTEGRATION-CHECKLIST.md` (see `.claude/rules/core-modules.md`)
8. **Don't add redundant @UseGuards** - `@Roles()` already handles JWT auth (see `.claude/rules/role-system.md`)

## Migration Guides

When releasing MINOR or MAJOR versions, create migration guides in `migration-guides/`:
- Use `migration-guides/TEMPLATE.md` as starting point
- Always analyze `src/server/` and [nest-server-starter](https://github.com/lenneTech/nest-server-starter)
- Ask developer for additional projects to analyze
- See `.claude/rules/migration-guides.md` for complete process

## Modular Rules

Detailed documentation in `.claude/rules/`:

| File | Content |
|------|---------|
| `module-inheritance.md` | Core architectural pattern for extending modules |
| `role-system.md` | Role system, S_ prefix rules, @Roles vs @UseGuards |
| `architecture.md` | Detailed code architecture |
| `testing.md` | Test configuration and best practices |
| `versioning.md` | Version strategy and release process |
| `core-modules.md` | Path-scoped rules for `src/core/modules/` incl. Integration Checklist requirements |
| `module-deprecation.md` | Legacy Auth → BetterAuth migration roadmap |
| `migration-guides.md` | Process for creating version migration guides |
| `configurable-features.md` | Configuration patterns: "Presence implies enabled" and "Boolean shorthand" (`true` / `{}`) |
