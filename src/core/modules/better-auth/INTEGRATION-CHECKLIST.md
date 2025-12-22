# BetterAuth Integration Checklist

**For integrating BetterAuth into projects using `@lenne.tech/nest-server`.**

> **Estimated time:** 10-15 minutes

---

## Choose Your Scenario

| Scenario | Use When | CoreModule Signature | Steps |
|----------|----------|---------------------|-------|
| **New Project (IAM-Only)** | Starting fresh, no legacy users | `CoreModule.forRoot(envConfig)` | 1-6 |
| **Existing Project (Migration)** | Have legacy users to migrate | `CoreModule.forRoot(AuthService, AuthModule, envConfig)` | 1-6 |

**Key difference:** New projects disable Legacy endpoints, existing projects keep them enabled during migration.

---

## Reference Implementation

All files you need to create are already implemented as reference in the package:

**Local (in your node_modules):**
```
node_modules/@lenne.tech/nest-server/src/server/modules/better-auth/
```

**GitHub:**
https://github.com/lenneTech/nest-server/tree/develop/src/server/modules/better-auth

**Also see the UserService integration:**
- Local: `node_modules/@lenne.tech/nest-server/src/server/modules/user/user.service.ts`
- GitHub: https://github.com/lenneTech/nest-server/blob/develop/src/server/modules/user/user.service.ts

---

## Required Files (Create in Order)

### 1. BetterAuth Module
**Create:** `src/server/modules/better-auth/better-auth.module.ts`
**Copy from:** `node_modules/@lenne.tech/nest-server/src/server/modules/better-auth/better-auth.module.ts`

---

### 2. BetterAuth Controller
**Create:** `src/server/modules/better-auth/better-auth.controller.ts`
**Copy from:** `node_modules/@lenne.tech/nest-server/src/server/modules/better-auth/better-auth.controller.ts`

---

### 3. BetterAuth Resolver (CRITICAL!)
**Create:** `src/server/modules/better-auth/better-auth.resolver.ts`
**Copy from:** `node_modules/@lenne.tech/nest-server/src/server/modules/better-auth/better-auth.resolver.ts`

**WHY must ALL decorators be re-declared?**
GraphQL schema is built from decorators at compile time. The parent class (`CoreBetterAuthResolver`) is marked as `isAbstract: true`, so its methods are not registered in the schema. You MUST re-declare `@Query`, `@Mutation`, `@Roles` decorators in the child class for the methods to appear in the GraphQL schema.

**Note:** `@UseGuards(AuthGuard(JWT))` is NOT needed when using `@Roles(S_USER)` or `@Roles(ADMIN)` because `RolesGuard` already extends `AuthGuard(JWT)` internally.

---

### 4. Update UserService (CRITICAL!)
**Modify:** `src/server/modules/user/user.service.ts`
**Reference:** `node_modules/@lenne.tech/nest-server/src/server/modules/user/user.service.ts`

**Required changes:**

1. Add import:
   ```typescript
   import { BetterAuthUserMapper } from '@lenne.tech/nest-server';
   ```

2. Add constructor parameter:
   ```typescript
   @Optional() private readonly betterAuthUserMapper?: BetterAuthUserMapper,
   ```

3. Pass to super() via options object:
   ```typescript
   super(configService, emailService, mainDbModel, mainModelConstructor, { betterAuthUserMapper });
   ```

**WHY is this critical?**
The `BetterAuthUserMapper` enables bidirectional password synchronization:
- User signs up via BetterAuth → password synced to Legacy Auth (bcrypt hash)
- User changes password → synced between both systems
- **Without this, users can only authenticate via ONE system!**

---

### 5. Update ServerModule
**Modify:** `src/server/server.module.ts`
**Reference:** `node_modules/@lenne.tech/nest-server/src/server/server.module.ts`

#### For New Projects (IAM-Only) - Recommended:
```typescript
@Module({
  imports: [
    CoreModule.forRoot(envConfig),  // Simplified signature
    BetterAuthModule.forRoot({
      config: envConfig.betterAuth,
      fallbackSecrets: [envConfig.jwt?.secret],
    }),
    // ... other modules
  ],
})
export class ServerModule {}
```

#### For Existing Projects (Migration):
```typescript
@Module({
  imports: [
    CoreModule.forRoot(AuthService, AuthModule.forRoot(envConfig.jwt), envConfig),
    BetterAuthModule.forRoot({
      config: envConfig.betterAuth,
      fallbackSecrets: [envConfig.jwt?.secret],
    }),
    // ... other modules
  ],
})
export class ServerModule {}
```

---

### 6. Update config.env.ts
**Modify:** `src/config.env.ts`
**Reference:** `node_modules/@lenne.tech/nest-server/src/config.env.ts`

#### For New Projects (IAM-Only):
```typescript
const config = {
  // Disable Legacy Auth endpoints
  auth: {
    legacyEndpoints: {
      enabled: false,
    },
  },
  // BetterAuth configuration (minimal - JWT enabled by default)
  betterAuth: true,  // or betterAuth: {} for same effect

  // OR with optional features:
  betterAuth: {
    twoFactor: {}, // Enable 2FA (opt-in)
    passkey: {},   // Enable Passkeys (opt-in)
    // JWT is already enabled by default
  },
};
```

#### For Existing Projects (Migration):
```typescript
const config = {
  // Keep Legacy Auth endpoints enabled during migration
  auth: {
    legacyEndpoints: {
      enabled: true, // Default - can disable after migration
    },
  },
  // BetterAuth configuration (JWT enabled by default)
  betterAuth: true,  // Minimal config, or use object for more options
};
```

---

## Verification Checklist

After integration, verify:

- [ ] `npm run build` succeeds without errors
- [ ] `npm test` passes
- [ ] GraphQL Playground shows `betterAuthEnabled` query
- [ ] REST endpoint `GET /iam/session` responds
- [ ] Sign-up via BetterAuth creates user in database with `iamId`
- [ ] Sign-in via BetterAuth works correctly

### Additional checks for Migration scenario:
- [ ] Sign-in via Legacy Auth works for BetterAuth-created users
- [ ] Sign-in via BetterAuth works for Legacy-created users
- [ ] `betterAuthMigrationStatus` query shows correct counts

---

## Common Mistakes

| Mistake | Symptom | Fix |
|---------|---------|-----|
| Forgot to re-declare decorators in Resolver | GraphQL endpoints missing (404) | Copy resolver from reference, keep ALL decorators |
| Forgot `BetterAuthUserMapper` in UserService | Auth systems not synced, users can't cross-authenticate | Add `@Optional()` parameter and pass to super() |
| Missing `fallbackSecrets` in ServerModule | Session issues without explicit secret | Add `fallbackSecrets: [envConfig.jwt?.secret, ...]` |
| Wrong `basePath` in config | 404 on BetterAuth endpoints | Ensure basePath matches controller (default: `/iam`) |
| Using wrong CoreModule signature | Build errors or missing features | New projects: 1-parameter, Existing: 3-parameter |
| AuthResolver override missing `checkLegacyGraphQLEnabled()` | Legacy endpoint disabling doesn't work (no HTTP 410) | Call `this.checkLegacyGraphQLEnabled('signIn')` in overrides |

---

## Important: AuthResolver Override Pattern

If your project has a custom `AuthResolver` that extends `CoreAuthResolver` and overrides `signIn()` or `signUp()`, you **MUST** call the protected check method:

```typescript
// src/server/modules/auth/auth.resolver.ts
@Mutation(() => Auth)
override async signIn(...): Promise<Auth> {
  this.checkLegacyGraphQLEnabled('signIn');  // Required!
  const result = await this.authService.signIn(input, serviceOptions);
  return this.processCookies(ctx, result);
}
```

**WHY?** When `auth.legacyEndpoints.enabled: false`, this method throws `LegacyAuthDisabledException` (HTTP 410). Without this call, legacy endpoints remain accessible even when configured as disabled.

See: `.claude/rules/module-inheritance.md` for the full pattern.

---

## Client-Side Configuration

Clients must be configured to use the correct base path and hash passwords:

```typescript
// auth-client.ts (e.g., for Nuxt/Vue)
import { createAuthClient } from 'better-auth/vue';
import { sha256 } from '~/utils/crypto';

const baseClient = createAuthClient({
  baseURL: import.meta.env.VITE_API_URL,
  basePath: '/iam',  // Must match server config
  plugins: [...],
});

// Wrap signIn/signUp to hash passwords before sending
export const authClient = {
  ...baseClient,
  signIn: {
    ...baseClient.signIn,
    email: async (params) => {
      const hashedPassword = await sha256(params.password);
      return baseClient.signIn.email({ ...params, password: hashedPassword });
    },
  },
  // ... same for signUp, resetPassword, etc.
};
```

---

## Detailed Documentation

For complete configuration options, API reference, and advanced topics:
- **README.md:** `node_modules/@lenne.tech/nest-server/src/core/modules/better-auth/README.md`
- **GitHub:** https://github.com/lenneTech/nest-server/blob/develop/src/core/modules/better-auth/README.md
