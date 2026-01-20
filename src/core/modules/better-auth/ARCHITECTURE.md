# Architecture: Why Custom Controllers?

The `CoreBetterAuthController` implements custom endpoints instead of directly using native Better-Auth endpoints. This is **necessary** for the nest-server hybrid auth system.

## 1. Hybrid-Auth-System (Legacy + Better-Auth)

The nest-server supports bidirectional authentication:
- **Legacy Auth → Better-Auth**: Users created via Legacy Auth can sign in via Better-Auth
- **Better-Auth → Legacy Auth**: Users created via Better-Auth can sign in via Legacy Auth

This requires custom logic that cannot be implemented via Better-Auth hooks alone.

## 2. Why Not Better-Auth Hooks?

Better-Auth hooks have fundamental limitations that prevent full implementation of our requirements:

| Requirement | Hook Support | Reason |
|-------------|--------------|--------|
| Legacy user migration | ⚠️ Partial | Requires global DB access outside NestJS DI |
| Password sync to Legacy | ❌ No | **After-hooks don't have access to plaintext password** |
| Custom response format | ❌ No | **Hooks cannot modify HTTP response** |
| Multi-cookie setting | ❌ No | **Hooks cannot set cookies** |
| User mapping with roles | ❌ No | Requires NestJS Dependency Injection |
| Session token injection | ❌ No | Before-hooks cannot inject tokens into requests |

## 3. Hook Limitations Explained

### After-Hooks Cannot Change Response

```typescript
// ❌ This does NOT work - return value is ignored
hooks: {
  after: createAuthMiddleware(async (ctx) => {
    ctx.response.body.customField = 'value'; // Ignored!
    return { response: modifiedResponse }; // Also ignored!
  }),
}
```

### After-Hooks Don't Have Plaintext Password

```typescript
// ❌ Cannot sync password because it's already hashed
hooks: {
  after: [
    {
      matcher: (ctx) => ctx.path === '/sign-up/email',
      handler: async (ctx) => {
        // ctx.body.password is ALREADY HASHED at this point
        // We cannot call syncPasswordToLegacy() without plaintext!
      },
    },
  ],
}
```

### Hooks Don't Have NestJS DI Access

```typescript
// ❌ Hooks are configured in betterAuth(), not in NestJS context
export const auth = betterAuth({
  hooks: {
    // No access to NestJS services here!
    // this.userService, this.emailService, etc. are unavailable
  },
});
```

## 4. What Custom Endpoints Do

| Endpoint | Custom Logic | Why Required |
|----------|--------------|--------------|
| `/sign-in/email` | Legacy migration, PW normalization, 2FA handling | Migration needs plaintext password |
| `/sign-up/email` | PW normalization, Legacy sync, User linking | Sync needs plaintext password |
| `/sign-out` | Multi-cookie clearing | Response modification |
| `/session` | User mapping with roles | NestJS service access |
| Plugin routes | Session token injection | Request modification |

## 5. Native Handler Where Possible

Despite custom endpoints, we use Better-Auth's native handler where appropriate:
- **Plugin routes** (Passkey, 2FA, OAuth) → `authInstance.handler()`
- **2FA verification flow** → Native handler for correct cookie setting
- **Passkey authentication** → Native WebAuthn handling

## 6. Alternative Approaches Considered

| Approach | Evaluation |
|----------|------------|
| **Full Hook Approach** | ❌ Not feasible - missing plaintext password, no response modification |
| **Hybrid with Global DB** | ⚠️ Possible but anti-pattern - bypasses NestJS DI, harder to test |
| **Custom Controller (current)** | ✅ Best balance - NestJS DI access, testable, maintainable |

## Conclusion

The custom controller architecture is **necessary complexity**, not unnecessary overhead. It enables:
- ✅ Legacy Auth compatibility
- ✅ Bidirectional password synchronization
- ✅ Multi-cookie support
- ✅ Custom user mapping with roles
- ✅ Proper 2FA cookie handling
- ✅ Full NestJS Dependency Injection access
