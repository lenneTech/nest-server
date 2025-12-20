---
paths: src/core/modules/**
---

# Core Module Development Rules

These rules apply when working in `src/core/modules/`.

## Naming Conventions

- Base classes: `Core` prefix (e.g., `CoreAuthService`, `CoreBetterAuthResolver`)
- Interfaces: `I` prefix (e.g., `IBetterAuth`, `IServerOptions`)
- Models: `*Model` suffix for GraphQL types
- Inputs: `*Input` suffix for input types
- Args: `*Args` suffix for query arguments

## Method Visibility

- Use `protected` for methods that should be overridable
- Use `public` for API methods
- Avoid `private` for methods that projects might need to customize

## Module Registration

Always support both registration modes:

```typescript
// In module class
static forRoot(options: ModuleOptions): DynamicModule {
  // Check autoRegister option
  if (options.config?.autoRegister === true) {
    // Auto-registration logic
  }
  // Manual registration is default
}
```

## Export Requirements

All public classes must be exported in `src/index.ts`:

```typescript
// src/index.ts
export { CoreAuthService } from './core/modules/auth/services/core-auth.service';
export { CoreBetterAuthResolver } from './core/modules/better-auth/core-better-auth.resolver';
```

## Documentation

Each core module should have:

1. README.md in module directory
2. JSDoc comments on public methods
3. Interface documentation in `server-options.interface.ts`

## Logging

Use NestJS Logger with module name:

```typescript
private readonly logger = new Logger(ModuleName.name);

// Use appropriate log levels
this.logger.log('Important info');      // Normal operations
this.logger.warn('Warning message');    // Potential issues
this.logger.error('Error occurred');    // Errors
this.logger.debug('Debug info');        // Development only (sparingly)
```

## Testing

- Create story tests in `tests/stories/`
- Test through API (REST/GraphQL), not direct service calls
- Include security tests for authentication/authorization
