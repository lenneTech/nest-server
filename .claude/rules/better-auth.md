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

## Summary

| Principle | Requirement |
|-----------|-------------|
| Standard Compliance | Stay close to Better-Auth, minimize custom code |
| Security | Maximum security, thorough review before completion |
| Testing | Full coverage, all tests pass, security tests included |
