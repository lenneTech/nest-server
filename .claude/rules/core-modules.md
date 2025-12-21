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

## Optional Constructor Parameters

Use the **options object pattern** for optional constructor parameters in Core classes:

```typescript
// Define options interface
export interface CoreUserServiceOptions {
  betterAuthUserMapper?: BetterAuthUserMapper;
  // Future optional params can be added without breaking changes
}

// Core class constructor
protected constructor(
  // Required params first
  protected readonly configService: ConfigService,
  protected readonly emailService: EmailService,
  // Options object last
  protected readonly options?: CoreUserServiceOptions,
) {
  super();
}

// Usage in methods
if (this.options?.betterAuthUserMapper) {
  await this.options.betterAuthUserMapper.syncEmail(...);
}
```

**Why this pattern:**
- New optional parameters can be added without breaking existing implementations
- No need to pass `null` or `undefined` for unused optional parameters
- Order of optional parameters doesn't matter
- Clear distinction between required and optional dependencies

**Implementation in extending classes:**
```typescript
constructor(
  // ... required params ...
  @Optional() private readonly betterAuthUserMapper?: BetterAuthUserMapper,
) {
  super(configService, emailService, mainDbModel, mainModelConstructor, { betterAuthUserMapper });
}
```

## Testing

- Create story tests in `tests/stories/`
- Test through API (REST/GraphQL), not direct service calls
- Include security tests for authentication/authorization

## Integration Documentation (Required for All Core Modules)

Every core module that requires project integration MUST have an `INTEGRATION-CHECKLIST.md` file.

### Purpose

This checklist helps developers (and AI assistants like Claude Code) integrate the module into their projects. It should be optimized for:
- Quick understanding of required steps
- Clear references to working code (no duplicates)
- Critical "WHY" explanations for non-obvious steps

### Required Structure

```markdown
# [ModuleName] Integration Checklist

## Reference Implementation
- Local: `node_modules/@lenne.tech/nest-server/src/server/modules/[module]/`
- GitHub: https://github.com/lenneTech/nest-server/tree/develop/src/server/modules/[module]

## Required Files (Create in Order)
### 1. [FileName]
**Create:** `src/server/modules/[module]/[file].ts`
**Copy from:** Reference implementation
[Optional: WHY explanation for critical/non-obvious steps]

## Verification Checklist
- [ ] Build succeeds
- [ ] Tests pass
- [ ] [Module-specific checks]

## Common Mistakes
| Mistake | Symptom | Fix |
```

### Key Principles

1. **No Code Duplication**: Never include full code examples that duplicate `src/server/`
   - Reference files exist in `src/server/modules/` and are included in the npm package
   - Claude Code can read these files directly from `node_modules/`
   - Only include small code snippets for DIFFs (changes to existing files)

2. **Single Source of Truth**: The reference implementation in `src/server/` is always current
   - Documentation never becomes outdated
   - Copy-paste from reference is always correct

3. **WHY Explanations**: Include for critical/non-obvious steps
   - Example: "WHY must decorators be re-declared?" → GraphQL schema registration
   - Example: "WHY inject this mapper?" → Bidirectional sync between systems

4. **Verification Checklist**: Help verify successful integration
   - Build/test commands
   - Module-specific functional checks

5. **Common Mistakes Table**: Document known pitfalls with symptoms and fixes

### Example

See `src/core/modules/better-auth/INTEGRATION-CHECKLIST.md` as the reference template.

### When to Create

Create an `INTEGRATION-CHECKLIST.md` when the module:
- Requires files to be created in the consuming project
- Has non-obvious integration steps
- Extends Core classes that need decorator re-declaration
- Requires changes to existing project files (UserService, ServerModule, etc.)
