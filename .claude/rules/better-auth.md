---
paths: src/core/modules/better-auth/**
---

# Better-Auth Module Development Rules

These rules apply when working in `src/core/modules/better-auth/`.

## 1. Maximize Better-Auth Standard Compliance

When making changes to the Better-Auth module:

- **Stay as close as possible to Better-Auth's standard behavior**
- **Minimize custom implementations** - use Better-Auth's built-in functionality wherever possible
- **Never bypass or disable security mechanisms** provided by Better-Auth
- **Maintain update compatibility** - changes must not break when Better-Auth releases updates

### Rationale

Better-Auth is a security-critical library. Custom implementations:
- May introduce security vulnerabilities
- Can break with Better-Auth updates
- Add maintenance burden
- May not benefit from Better-Auth's security audits

### Example: Adapter Pattern

When extending functionality (e.g., JWT mode for Passkey), prefer adapter patterns:

```typescript
// GOOD: Adapter that bridges to Better-Auth's mechanisms
// - Uses Better-Auth's verificationToken
// - Lets Better-Auth handle all WebAuthn logic
// - Only bridges the cookie gap for JWT mode

// BAD: Custom implementation that replaces Better-Auth logic
// - Stores challenges separately
// - Implements own verification
// - Bypasses Better-Auth's security checks
```

## 2. Security-First Implementation

All Better-Auth code must be implemented with maximum security:

### Mandatory Security Measures

1. **Cryptographically secure IDs** - Use `crypto.randomBytes(32)` for tokens/IDs
2. **TTL-based expiration** - All temporary data must have automatic cleanup
3. **One-time use** - Tokens/challenges must be deleted after use
4. **Secrets protection** - Never expose internal tokens to clients
5. **Cookie signing** - Use proper HMAC signatures for cookies

### Security Review Checklist

Before completing any Better-Auth changes:

- [ ] No secrets/tokens exposed to client (only opaque IDs)
- [ ] All temporary data has TTL-based expiration
- [ ] One-time tokens are deleted after use
- [ ] Cryptographically secure random generation used
- [ ] No OWASP Top 10 vulnerabilities introduced
- [ ] Cookie signing uses proper HMAC with application secret
- [ ] Rate limiting considered for authentication endpoints
- [ ] Input validation on all user-supplied data

### Example: Challenge Storage

```typescript
// Security measures applied:
// 1. challengeId: 256-bit entropy (crypto.randomBytes(32))
// 2. verificationToken: never sent to client
// 3. TTL index: automatic MongoDB cleanup
// 4. One-time use: deleted after verification
// 5. User binding: challenges tied to specific user
```

## 3. Comprehensive Testing Requirements

All Better-Auth changes require comprehensive tests:

### Test Requirements

1. **New functionality tests** - Cover all new features completely
2. **Security tests** - Verify authentication/authorization works correctly
3. **Edge case tests** - Token expiration, invalid input, race conditions
4. **Regression tests** - Existing tests must pass (adapt if needed)

### Pre-Commit Checklist

Before completing any Better-Auth changes:

```bash
# All tests must pass
npm test

# Specific test file for targeted changes
npm test -- tests/stories/better-auth-*.ts
```

### Test Categories for Better-Auth

| Category | Focus | Example Tests |
|----------|-------|---------------|
| Authentication | Login/logout flows | `better-auth-api.story.test.ts` |
| Authorization | Role-based access | `better-auth-rest-security.e2e-spec.ts` |
| Security | Token validation, rate limiting | `better-auth-rate-limit.story.test.ts` |
| Integration | Module initialization | `better-auth-integration.story.test.ts` |
| Plugins | 2FA, Passkey, Social Login | `better-auth-plugins.story.test.ts` |

### Adapting Existing Tests

When changes affect existing test expectations:

1. **Understand why** the test was written that way
2. **Verify the change is correct** - not breaking intended behavior
3. **Update test** to match new correct behavior
4. **Document** why the test was changed in commit message

## 4. Customization Patterns

When a project needs custom BetterAuth behavior, follow these patterns:

### Module Registration Patterns

| Pattern | Use When | Configuration |
|---------|----------|---------------|
| **Zero-Config** | No customization needed | `CoreModule.forRoot(envConfig)` |
| **Config-based** | Custom Controller/Resolver | `betterAuth: { controller, resolver }` in config |
| **Separate Module** | Full control, additional providers | `betterAuth: { autoRegister: false }` |

### Pattern Selection Decision Tree

1. Does the project need custom Controller or Resolver?
   - No → Use Zero-Config (Pattern 1)
   - Yes → Continue to 2

2. Does the project need additional providers or complex module structure?
   - No → Use Config-based (Pattern 2) - add `controller`/`resolver` to `betterAuth` config
   - Yes → Use Separate Module (Pattern 3) - set `autoRegister: false`

### Critical: Resolver Decorator Re-declaration

When customizing the Resolver, **ALL decorators MUST be re-declared**:

```typescript
// WRONG - method won't appear in GraphQL schema!
override async betterAuthSignUp(...) {
  return super.betterAuthSignUp(...);
}

// CORRECT - all decorators re-declared
@Mutation(() => BetterAuthAuthModel)
@Roles(RoleEnum.S_EVERYONE)
override async betterAuthSignUp(...) {
  return super.betterAuthSignUp(...);
}
```

**Why:** GraphQL schema is built from decorators at compile time. Parent class is `isAbstract: true`.

### Email Template Customization

Templates are resolved in order:
1. `<template>-<locale>.ejs` in project templates
2. `<template>.ejs` in project templates
3. `<template>-<locale>.ejs` in nest-server (fallback)
4. `<template>.ejs` in nest-server (fallback)

To override: Create `src/templates/email-verification-de.ejs` in the project.

### Avoiding "forRoot() called twice" Warning

If you see this warning, the project has duplicate registration:

**Solutions:**
1. Move `controller`/`resolver` to `config.betterAuth` (Pattern 2)
2. Set `betterAuth.autoRegister: false` (Pattern 3)

**See:** `src/core/modules/better-auth/CUSTOMIZATION.md` for complete documentation.

## 5. RolesGuard Architecture

### Two Guard Implementations

The BetterAuth module provides two RolesGuard implementations:

| Guard | Used In | Key Characteristics |
|-------|---------|---------------------|
| `RolesGuard` | Legacy + Hybrid Mode | Extends `AuthGuard(JWT)`, supports Passport |
| `BetterAuthRolesGuard` | IAM-Only Mode | No Passport, no constructor dependencies |

### Why BetterAuthRolesGuard Exists

**Problem:** `AuthGuard()` from `@nestjs/passport` is a **mixin** that generates `design:paramtypes` metadata. When `RolesGuard extends AuthGuard(JWT)` is registered as `APP_GUARD` in a dynamic module (Pattern 3: `autoRegister: false`), NestJS DI fails to inject `Reflector` and `ModuleRef`.

**Error:** `Reflector not available - RolesGuard cannot function without it`

**Solution:** `BetterAuthRolesGuard` with NO constructor dependencies:

```typescript
@Injectable()
export class BetterAuthRolesGuard implements CanActivate {
  // NO constructor dependencies - avoids mixin DI conflict

  async canActivate(context: ExecutionContext): Promise<boolean> {
    // Use Reflect.getMetadata directly (not NestJS Reflector)
    const roles = Reflect.getMetadata('roles', context.getHandler());

    // Access services via static module reference
    const tokenService = CoreBetterAuthModule.getTokenServiceInstance();

    // ... role checking logic identical to RolesGuard
  }
}
```

### Guard Selection Logic

In `CoreBetterAuthModule.createDeferredModule()`:

```typescript
// IAM-Only Mode: Use BetterAuthRolesGuard (no Passport dependency)
providers: [
  BetterAuthRolesGuard,
  { provide: APP_GUARD, useExisting: BetterAuthRolesGuard },
]
```

In `CoreAuthModule` (Legacy Mode):

```typescript
// Legacy Mode: Use RolesGuard (extends AuthGuard for Passport support)
providers: [
  { provide: APP_GUARD, useClass: RolesGuard },
]
```

### Security Equivalence

Both guards implement identical security logic:
- Same `@Roles()` decorator processing
- Same role checks (S_USER, S_EVERYONE, S_VERIFIED, S_SELF, S_CREATOR, S_NO_ONE)
- Same token verification (via BetterAuthTokenService)
- Same error responses (401 Unauthorized, 403 Forbidden)

### When Working on Guards

1. **Changes to role logic** → Update BOTH guards
2. **New system roles** → Add to BOTH guards
3. **Token verification changes** → Update `BetterAuthTokenService` (shared by both)
4. **Testing** → Test both Legacy Mode and IAM-Only Mode

## Summary

| Principle | Requirement |
|-----------|-------------|
| Standard Compliance | Stay close to Better-Auth, minimize custom code |
| Security | Maximum security, thorough review before completion |
| Testing | Full coverage, all tests pass, security tests included |
| Customization | Use correct registration pattern, re-declare Resolver decorators |
| Guards | Maintain both RolesGuard and BetterAuthRolesGuard in sync |
