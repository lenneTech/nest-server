# Permissions Report Module

A development tool that scans `src/server/modules/` for `@Roles`, `@Restricted`, and `securityCheck()` usage, then generates an interactive HTML dashboard.

## Purpose

Provides a real-time overview of all role-based access control configuration across your project, helping identify:

- Endpoints without `@Roles` protection
- Models without `@Restricted` class-level restrictions
- Models missing `securityCheck()` overrides
- Fields without role restrictions

## Endpoints

The base path defaults to `/permissions` but can be customized via the `path` config option.

| Method | Path               | Content-Type       | Description                               |
| ------ | ------------------ | ------------------ | ----------------------------------------- |
| `GET`  | `/{path}`          | `text/html`        | Interactive HTML dashboard                |
| `GET`  | `/{path}/json`     | `application/json` | JSON report with `stats` field            |
| `GET`  | `/{path}/markdown` | `text/plain`       | Markdown report (optimized for AI agents) |
| `POST` | `/{path}/rescan`   | `application/json` | Force a rescan (rate limited: 1 per 10s)  |

## JSON Stats

The JSON report includes a `stats` field with pre-calculated metrics:

```json
{
  "stats": {
    "totalModules": 5,
    "totalModels": 8,
    "totalEndpoints": 42,
    "totalSubObjects": 3,
    "totalWarnings": 12,
    "endpointCoverage": 85,
    "securityCoverage": 62,
    "warningsByType": {
      "NO_RESTRICTION": 3,
      "NO_ROLES": 2,
      "NO_SECURITY_CHECK": 3,
      "UNRESTRICTED_FIELD": 2,
      "UNRESTRICTED_METHOD": 2
    }
  }
}
```

- **endpointCoverage**: % of methods with @Roles (own or class-level)
- **securityCoverage**: % of models with both @Restricted AND securityCheck()

## Configuration

Add `permissions` to your `config.env.ts`:

```typescript
// Enable with admin-only access (default)
permissions: true,

// Enable with custom role
permissions: { role: 'S_EVERYONE' },

// Enable without authentication
permissions: { role: false },

// Custom endpoint path (e.g. /admin/permissions instead of /permissions)
permissions: { path: 'admin/permissions' },

// Explicitly disabled
permissions: { enabled: false },
```

Follows the [Boolean Shorthand Pattern](/.claude/rules/configurable-features.md).

## How It Works

1. **Lazy scanning**: The first request to `/permissions` triggers a full scan using [ts-morph](https://ts-morph.com/) to parse TypeScript AST
2. **Caching**: Results are cached in memory until a `.ts` file changes in `src/server/`
3. **File watching**: A recursive `fs.watch` on `src/server/` invalidates the cache on changes
4. **Inheritance resolution**: Walks `node_modules/@lenne.tech/nest-server` to resolve inherited fields from `Core*` base classes
5. **Security gap detection**: Compares found decorators against expected patterns and reports warnings

## Access Control

By default, only users with `RoleEnum.ADMIN` can access the endpoints. This is applied via `Reflect.defineMetadata('roles', ...)` at module registration time, which is read by `RolesGuard`.

## Architecture

```
CorePermissionsModule.forRoot(config)
  -> CorePermissionsController (REST endpoints)
  -> CorePermissionsService (caching, file watcher, HTML/Markdown generation)
  -> permissions-scanner.ts (standalone AST scanning, shared with lt CLI)
```

The architecture is split into:

- **`permissions-scanner.ts`** (standalone, no NestJS dependencies): All AST-based scan logic using `ts-morph`. This is the single source of truth, also used by the `lt server permissions` CLI command via dynamic import.
- **`CorePermissionsService`**: Caching, rate limiting, file watching, HTML/Markdown generation. Delegates scanning to `scanPermissions()`.
- **`CorePermissionsController`**: REST endpoints with dynamically configurable base path.
- **`CorePermissionsModule`**: DynamicModule with `forRoot()`, configures role and path via `Reflect.defineMetadata`.