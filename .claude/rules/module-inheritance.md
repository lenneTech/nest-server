# Module Inheritance Pattern

**This is a fundamental architectural pattern that MUST be followed for all new modules in `src/core/modules/`.**

## Why Inheritance Over Hooks/Events

Core modules (like `AuthModule`, `BetterAuthModule`, `FileModule`) are designed to be **extended through inheritance** in consuming projects, not manipulated through hooks, events, or other workarounds. This provides:

1. **Full Control**: Projects can override methods and precisely define what happens before/after `super()` calls
2. **Flexibility**: Parts of the parent implementation can be skipped entirely for custom logic
3. **Type Safety**: TypeScript inheritance ensures proper typing and IDE support
4. **Robustness**: No runtime event systems or hooks that can fail silently

## Pattern Structure

```typescript
// src/core/modules/example/core-example.resolver.ts (in nest-server)
@Resolver()
export class CoreExampleResolver {
  async someMethod() { /* base implementation */ }
}

// src/server/modules/example/example.resolver.ts (in consuming project)
@Resolver()
export class ExampleResolver extends CoreExampleResolver {
  override async someMethod() {
    // Custom pre-processing
    const result = await super.someMethod();  // Or skip for full override
    // Custom post-processing
    return result;
  }
}
```

## Module Registration Options

Core modules should support both:

1. **Auto-registration** (`autoRegister: true`) - For simple projects without customization
2. **Manual registration** (`autoRegister: false`, default) - Projects integrate via extended module

```typescript
// config.env.ts - auto-registration for simple projects
betterAuth: { autoRegister: true }

// server.module.ts - manual registration with custom resolver (recommended)
BetterAuthModule.forRoot({ config, resolver: CustomResolver })
```

## Examples in Codebase

- `CoreAuthService` → extended by project's `AuthService`
- `CoreBetterAuthResolver` → extended by project's `BetterAuthResolver`
- `CoreUserService` → extended by project's `UserService`

## Checklist for New Core Modules

When adding new core modules, ensure:

- [ ] Base classes in `src/core/modules/` with `Core` prefix
- [ ] Methods are `protected` or `public` (not `private`) to allow override
- [ ] `autoRegister` option defaults to `false`
- [ ] Clear documentation for extension points
- [ ] Export base classes via `src/index.ts`
