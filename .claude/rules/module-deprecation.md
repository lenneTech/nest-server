# Module Deprecation & Migration Roadmap

This document describes the deprecation strategy for Legacy Auth and the migration path to BetterAuth (IAM).

## Authentication System Roadmap

### v11.x (Current - Backward Compatible)

- **Legacy Auth** (CoreAuthService) is available for backwards compatibility
- **BetterAuth** (IAM) can run standalone or alongside Legacy Auth
- **GraphQL Subscriptions** work with both systems (IAM uses BetterAuth sessions)
- Both systems share the same user database with bidirectional sync
- Password hashes use different algorithms (Legacy: `bcrypt(sha256(pw))`, IAM: `scrypt(sha256(pw))`)

**Key Configuration:**

```typescript
// config.env.ts
{
  // Legacy Auth configuration (optional, for backwards compatibility)
  jwt: {
    secret: 'YOUR_JWT_SECRET',
    refresh: { secret: 'YOUR_REFRESH_SECRET' }
  },

  // BetterAuth configuration (optional, runs in parallel)
  betterAuth: {
    enabled: true,
    secret: 'YOUR_BETTERAUTH_SECRET',
    // ...
  },

  // NEW in v11.7.x: Disable legacy endpoints after migration
  auth: {
    legacyEndpoints: {
      enabled: true  // Set to false after all users migrated
    }
  }
}
```

**CoreModule.forRoot Signatures:**

```typescript
// IAM-Only (recommended for new projects)
CoreModule.forRoot(envConfig)

// Legacy + IAM (for existing projects during migration)
CoreModule.forRoot(CoreAuthService, AuthModule.forRoot(envConfig.jwt), envConfig)
```

### Future Version (Planned - Breaking Change)

- **BetterAuth** (IAM) becomes the default authentication system
- **Legacy Auth** becomes optional (must be explicitly enabled)
- Simplified CoreModule.forRoot signature becomes the only option
- Legacy Auth removed from codebase

**New Configuration:**

```typescript
// config.env.ts
{
  // BetterAuth is now the default
  betterAuth: {
    secret: 'YOUR_BETTERAUTH_SECRET',
    // ...
  },

  // Legacy Auth is optional (enable only if needed)
  auth: {
    legacy: {
      enabled: false  // Explicitly enable if still needed
    }
  }
}
```

**Simplified CoreModule.forRoot Signature:**

```typescript
// Future version: Single parameter
CoreModule.forRoot(envConfig)
```

## Migration Path for Projects

### Phase 1: Enable BetterAuth (v11.x)

1. Ensure `betterAuth` is configured in `config.env.ts`
2. Integrate BetterAuthModule in your project (see INTEGRATION-CHECKLIST.md)
3. Both auth systems run in parallel

### Phase 2: Monitor Migration

Use the `betterAuthMigrationStatus` GraphQL query (admin only):

```graphql
query {
  betterAuthMigrationStatus {
    totalUsers
    fullyMigratedUsers
    pendingMigrationUsers
    migrationPercentage
    canDisableLegacyAuth
    pendingUserEmails
  }
}
```

Users migrate automatically when they:
- Sign in via BetterAuth (IAM) endpoints
- Use social login (if configured)
- Use passkey authentication (if configured)

### Phase 3: Disable Legacy Endpoints

Once `canDisableLegacyAuth` is `true`:

```typescript
// config.env.ts
auth: {
  legacyEndpoints: {
    enabled: false  // Disable all legacy endpoints
    // Or disable selectively:
    // graphql: false  // Disable only GraphQL endpoints
    // rest: false     // Disable only REST endpoints
  }
}
```

Legacy endpoint calls will return HTTP 410 Gone.

### Phase 4: Upgrade to Future Version

When upgrading to the future version with BetterAuth as default:

1. Update `package.json` dependency
2. Simplify `CoreModule.forRoot` call:

```typescript
// Before (v11.x)
CoreModule.forRoot(CoreAuthService, AuthModule.forRoot(envConfig.jwt), envConfig)

// After (future version)
CoreModule.forRoot(envConfig)
```

3. Remove Legacy Auth configuration if no longer needed

## Password Hash Incompatibility

**Why parallel operation is necessary:**

| System | Hash Algorithm |
|--------|----------------|
| Legacy Auth | `bcrypt(sha256(password))` |
| BetterAuth | `scrypt(sha256(password))` |

These algorithms are **one-way** - there is no migration script possible.
Users must sign in at least once via BetterAuth to create a new hash.

## Configuration Reference

### auth.legacyEndpoints (v11.7.x+)

| Property | Type | Default | Description |
|----------|------|---------|-------------|
| `enabled` | boolean | `true` | Enable/disable all legacy endpoints |
| `graphql` | boolean | inherits `enabled` | Enable/disable GraphQL endpoints only |
| `rest` | boolean | inherits `enabled` | Enable/disable REST endpoints only |

### Legacy Endpoints Affected

**GraphQL Mutations:**
- `signIn` - Sign in via email/password
- `signUp` - Register new account
- `logout` - Sign out
- `refreshToken` - Refresh JWT tokens

**REST Endpoints:**
- `POST /auth/signin` - Sign in via email/password
- `POST /auth/signup` - Register new account
- `GET /auth/logout` - Sign out
- `GET /auth/refresh-token` - Refresh JWT tokens

## IAuthProvider Interface (v11.7.x+)

The `IAuthProvider` interface abstracts authentication operations:

```typescript
interface IAuthProvider {
  decodeJwt(token: string): JwtPayload;
  validateUser(payload: JwtPayload): Promise<any>;
  signToken(user: any, expiresIn?: string): string;
}
```

In a future version, this interface will be used by CoreModule.forRoot to support
both Legacy Auth and BetterAuth transparently.

## Timeline

| Version | Status | Changes |
|---------|--------|---------|
| v11.6.x | Released | BetterAuth introduced |
| v11.7.x | Current | Legacy endpoint controls, IAuthProvider, migration status |
| Future | Planned | BetterAuth default, simplified API, Legacy optional |

## Related Documentation

- [BetterAuth Integration Checklist](../../src/core/modules/better-auth/INTEGRATION-CHECKLIST.md)
- [Module Inheritance Pattern](./module-inheritance.md)
- [Role System](./role-system.md)
