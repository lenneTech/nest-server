# Better-Auth Module

Integration of the [better-auth](https://better-auth.com) authentication framework with @lenne.tech/nest-server.

## Features

- **Email/Password Authentication** - Standard username/password login
- **JWT Tokens** - For API clients and stateless authentication
- **Two-Factor Authentication (2FA)** - TOTP-based second factor
- **Passkey/WebAuthn** - Passwordless authentication
- **Social Login** - Google, GitHub, Apple OAuth providers
- **Legacy Password Handling** - Migration support for existing users
- **Parallel Operation** - Runs alongside Legacy Auth without side effects

## Quick Start

**True Zero-Config: Better-Auth is enabled by default!** No configuration block is required - it works out of the box.

```typescript
// Works automatically - no betterAuth config needed!
// Better-Auth will use sensible defaults and fallback secrets

// To customize behavior (optional):
betterAuth: {
  // Only add this block if you need to override defaults
  // baseUrl: 'https://your-domain.com',
  // basePath: '/iam',
}
```

**Default values (used when not configured):**
- **Secret**: Falls back to `jwt.secret` → `jwt.refresh.secret` → auto-generated
- **Base URL**: `http://localhost:3000`
- **Base Path**: `/iam`
- **Passkey Origin**: `http://localhost:3000`
- **Passkey rpId**: `localhost`
- **Passkey rpName**: `Nest Server`

To **explicitly disable** Better-Auth (the only way to turn it off):

```typescript
betterAuth: {
  enabled: false,  // Only way to disable Better-Auth
}
```

Read the security section below for production deployments.

## Understanding Core Settings

### Base URL (`baseUrl`)

**Purpose:** Absolute URL generation for links and redirects

**Technically used for:**
- **Email Links**: Password reset links, email verification links
  ```
  https://your-domain.com/iam/reset-password?token=xyz
  ```
- **OAuth Redirect URIs**: Callback URLs for social login providers
  ```
  https://your-domain.com/iam/callback/google
  ```
- **CORS Origin Validation**: If no `trustedOrigins` are set, `baseUrl` is used as the trusted origin

**Impact of incorrect value:** Email links point to wrong server, OAuth callbacks fail.

### Base Path (`basePath`)

**Purpose:** URL prefix for all Better-Auth REST endpoints

**Technically used for:**
- **Routing**: All endpoints are registered under this path
  ```
  /iam/sign-in
  /iam/sign-up
  /iam/session
  /iam/callback/:provider
  ```
- **Middleware Matching**: `BetterAuthMiddleware` only forwards requests to paths starting with `basePath`

**Default `/iam`** avoids collisions with existing `/auth` routes from Legacy Auth.

### Passkey Origin (`passkey.origin`)

**Purpose:** WebAuthn/Passkey security validation

**Technically used for:**
- **Passkey Registration/Authentication**: Browser sends origin in WebAuthn request
- **Origin Verification**: Server validates that request comes from expected origin
  ```typescript
  // WebAuthn requires exact match:
  // Client sends: "https://example.com"
  // Server checks: origin === config.passkey.origin
  ```
- **Phishing Protection**: Prevents passkeys from being used on other domains

**Impact of incorrect value:** Passkey authentication fails with "origin mismatch" error.

### Configuration Summary

| Setting | Technical Purpose | Impact of Wrong Value |
|---------|-------------------|----------------------|
| `baseUrl` | Email links, OAuth callbacks | Links point to wrong server |
| `basePath` | Endpoint routing | 404 on API calls |
| `passkey.origin` | WebAuthn security | Passkey auth fails |

**For Development:** The defaults (`http://localhost:3000`, `/iam`) are correct.

**For Production:** You must set `baseUrl` and `passkey.origin` to your actual domain:

```typescript
betterAuth: {
  baseUrl: 'https://api.your-domain.com',
  passkey: {
    enabled: true,
    origin: 'https://your-domain.com',  // Frontend domain
    rpId: 'your-domain.com',            // Domain without protocol
    rpName: 'Your Application',
  },
}
```

## ⚠️ IMPORTANT: Secret Configuration

### Secret Resolution (Fallback Chain)

Better-Auth resolves the secret in the following order:

1. **`betterAuth.secret`** - If explicitly configured
2. **`jwt.secret`** - Fallback for backwards compatibility (if ≥32 chars)
3. **`jwt.refresh.secret`** - Second fallback (if ≥32 chars)
4. **Auto-generated** - Secure random secret (with warning)

### Backwards Compatibility

If you already have `jwt.secret` configured with ≥32 characters, **Better-Auth will automatically use it** as a fallback. This means:
- ✅ **No configuration needed** for existing projects with proper JWT secrets
- ✅ **Sessions persist** across server restarts (uses existing secret)
- 💡 A warning reminds you to set `betterAuth.secret` explicitly

### Development (Auto-Generated Secret)

When no valid secret is found (including fallbacks), Better-Auth **automatically generates a secure random secret** at server startup.

**Consequences:**
- ✅ **Secure** - The secret is cryptographically random (32 bytes)
- ⚠️ **Sessions lost on restart** - All user sessions become invalid when the server restarts
- ✅ **Acceptable for development** - Frequent restarts during development are normal

### Production (Recommended)

For production, explicitly set `betterAuth.secret` or ensure `jwt.secret` is ≥32 characters:

```bash
# Generate a secure secret:
node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"

# Set in your environment:
export BETTER_AUTH_SECRET="your-generated-secret-here"
```

**Consequences of using auto-generated secret in production:**
- ⚠️ **Sessions lost on every deployment** - All users must re-login after each deploy
- ⚠️ **Sessions lost on server restart** - Any restart invalidates all sessions
- ⚠️ **No session sharing in clusters** - Multiple server instances can't share sessions

### Secret Requirements

| Requirement | Value |
|-------------|-------|
| Minimum length | 32 characters |
| Recommended | 44+ characters (32 bytes base64) |
| Character types | At least 2 of: lowercase, uppercase, numbers, special |

### Configuration Examples

**Via Environment Variable (Recommended):**
```bash
BETTER_AUTH_SECRET=K7xR2mN9pQ4wE6tY8uI0oP3aS5dF7gH9jK1lZ2xC4vB6nM8=
```

**Via config.env.ts:**
```typescript
betterAuth: {
  // enabled: true by default - no need to set explicitly
  secret: process.env.BETTER_AUTH_SECRET, // Let it be undefined for auto-generation in dev
}
```

## Configuration

**Optional** - Better-Auth works without any configuration (true zero-config). Only add this block if you need to customize behavior:

```typescript
// In config.env.ts
export default {
  // ... other config

  // OPTIONAL: Better-Auth configuration
  // Omit entirely for default behavior, or customize as needed:
  betterAuth: {
    // enabled: true by default - only set to false to disable
    // secret: auto-generated if not set (see Security section above)
    // baseUrl: 'http://localhost:3000', // Default
    // basePath: '/iam', // Default

    // JWT Plugin (optional)
    jwt: {
      enabled: true,
      expiresIn: '15m',
    },

    // Two-Factor Authentication (optional)
    twoFactor: {
      enabled: true,
      appName: 'My Application',
    },

    // Passkey/WebAuthn (optional)
    passkey: {
      enabled: true,
      rpId: 'localhost',
      rpName: 'My Application',
      origin: 'http://localhost:3000',
    },

    // Social Providers (optional)
    socialProviders: {
      google: {
        enabled: true,
        clientId: 'your-google-client-id',
        clientSecret: 'your-google-client-secret',
      },
      github: {
        enabled: true,
        clientId: 'your-github-client-id',
        clientSecret: 'your-github-client-secret',
      },
      apple: {
        enabled: true,
        clientId: 'your-apple-client-id',
        clientSecret: 'your-apple-client-secret',
      },
    },

    // Legacy Password Handling (for migration)
    legacyPassword: {
      enabled: true,
    },

    // Trusted Origins for CORS
    trustedOrigins: ['http://localhost:3000', 'https://your-app.com'],

    // Rate Limiting (optional)
    rateLimit: {
      enabled: true,
      max: 10, // Max requests per window
      windowSeconds: 60, // Time window in seconds
      message: 'Too many requests, please try again later.',
      strictEndpoints: ['/sign-in', '/sign-up', '/forgot-password', '/reset-password'],
      skipEndpoints: ['/session', '/callback'],
    },
  },
};
```

## Module Setup

The Better-Auth module is **automatically enabled by default** - no configuration required (true zero-config). It will only be disabled if you explicitly set `enabled: false`.

### Using with CoreModule

```typescript
// In your ServerModule
@Module({
  imports: [
    CoreModule.forRoot(environment),
    // BetterAuthModule is automatically included and configured
    // No betterAuth config block needed - works out of the box!
  ],
})
export class ServerModule {}
```

### Standalone Usage

```typescript
import { BetterAuthModule } from '@lenne.tech/nest-server';

@Module({
  imports: [
    BetterAuthModule.forRoot({
      config: environment.betterAuth,
    }),
  ],
})
export class AppModule {}
```

## REST API Endpoints

When enabled, Better-Auth exposes the following endpoints at the configured `basePath` (default: `/iam`):

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/iam/sign-up` | POST | Register new user |
| `/iam/sign-in` | POST | Sign in with email/password |
| `/iam/sign-out` | POST | Sign out (invalidate session) |
| `/iam/session` | GET | Get current session |
| `/iam/forgot-password` | POST | Request password reset |
| `/iam/reset-password` | POST | Reset password with token |
| `/iam/verify-email` | POST | Verify email address |

### Social Login Endpoints

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/iam/sign-in/social` | POST | Initiate social login |
| `/iam/callback/:provider` | GET | OAuth callback |

### Two-Factor Authentication Endpoints

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/iam/two-factor/enable` | POST | Enable 2FA |
| `/iam/two-factor/disable` | POST | Disable 2FA |
| `/iam/two-factor/verify` | POST | Verify 2FA code |

### Passkey Endpoints

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/iam/passkey/register` | POST | Register new passkey |
| `/iam/passkey/authenticate` | POST | Authenticate with passkey |

## GraphQL API

In addition to REST endpoints, Better-Auth provides GraphQL queries and mutations:

### Queries

| Query | Arguments | Return Type | Description |
|-------|-----------|-------------|-------------|
| `betterAuthEnabled` | - | `Boolean` | Check if Better-Auth is enabled |
| `betterAuthFeatures` | - | `BetterAuthFeaturesModel` | Get enabled features status |
| `betterAuthSession` | - | `BetterAuthSessionModel` | Get current session (requires auth) |

### Mutations

| Mutation | Arguments | Return Type | Description |
|----------|-----------|-------------|-------------|
| `betterAuthSignIn` | `email`, `password` | `BetterAuthAuthModel` | Sign in with email/password |
| `betterAuthSignUp` | `email`, `password`, `name?` | `BetterAuthAuthModel` | Register new account |
| `betterAuthSignOut` | - | `Boolean` | Sign out (requires auth) |
| `betterAuthVerify2FA` | `code` | `BetterAuthAuthModel` | Verify 2FA code |

### Response Types

#### BetterAuthAuthModel
```graphql
type BetterAuthAuthModel {
  success: Boolean!
  requiresTwoFactor: Boolean
  token: String          # JWT token (if JWT plugin enabled)
  user: BetterAuthUserModel
  session: BetterAuthSessionInfoModel
  error: String
}
```

#### BetterAuthFeaturesModel
```graphql
type BetterAuthFeaturesModel {
  enabled: Boolean!
  jwt: Boolean!
  twoFactor: Boolean!
  passkey: Boolean!
  legacyPassword: Boolean!
  socialProviders: [String!]!
}
```

### Example Usage

```graphql
# Check if Better-Auth is enabled
query {
  betterAuthEnabled
}

# Get available features
query {
  betterAuthFeatures {
    enabled
    jwt
    twoFactor
    passkey
    socialProviders
  }
}

# Sign in
mutation {
  betterAuthSignIn(email: "user@example.com", password: "password123") {
    success
    requiresTwoFactor
    token
    user {
      id
      email
      name
      roles
    }
  }
}

# Sign up
mutation {
  betterAuthSignUp(
    email: "newuser@example.com"
    password: "securePassword123"
    name: "New User"
  ) {
    success
    user {
      id
      email
    }
  }
}

# Verify 2FA (after sign-in with requiresTwoFactor: true)
mutation {
  betterAuthVerify2FA(code: "123456") {
    success
    token
    user {
      id
      email
    }
  }
}
```

## Using BetterAuthService

Inject `BetterAuthService` to access Better-Auth functionality:

```typescript
import { BetterAuthService } from '@lenne.tech/nest-server';

@Injectable()
export class MyService {
  constructor(private readonly betterAuthService: BetterAuthService) {}

  async checkUser(req: Request) {
    // Check if Better-Auth is enabled
    if (!this.betterAuthService.isEnabled()) {
      return null;
    }

    // Get current session
    const { session, user } = await this.betterAuthService.getSession(req);

    if (session) {
      console.log('User:', user.email);
      console.log('Session expires:', session.expiresAt);

      // Check if session is expiring soon
      if (this.betterAuthService.isSessionExpiringSoon(session)) {
        console.log('Session expiring soon!');
      }

      // Get remaining time
      const remaining = this.betterAuthService.getSessionTimeRemaining(session);
      console.log(`Session valid for ${remaining} seconds`);
    }

    return user;
  }

  async logout(sessionToken: string) {
    const success = await this.betterAuthService.revokeSession(sessionToken);
    return success;
  }
}
```

### Available Methods

| Method | Description |
|--------|-------------|
| `isEnabled()` | Check if Better-Auth is enabled |
| `getInstance()` | Get the Better-Auth instance |
| `getApi()` | Get the Better-Auth API |
| `getConfig()` | Get the current configuration |
| `isJwtEnabled()` | Check if JWT plugin is enabled |
| `isTwoFactorEnabled()` | Check if 2FA is enabled |
| `isPasskeyEnabled()` | Check if Passkey is enabled |
| `isLegacyPasswordEnabled()` | Check if legacy password handling is enabled |
| `getEnabledSocialProviders()` | Get list of enabled social providers |
| `getBasePath()` | Get the base path for endpoints |
| `getBaseUrl()` | Get the base URL |
| `getSession(req)` | Get current session from request |
| `revokeSession(token)` | Revoke a session (logout) |
| `isSessionExpiringSoon(session, threshold?)` | Check if session is expiring soon |
| `getSessionTimeRemaining(session)` | Get remaining session time in seconds |

## Security Integration

Better-Auth users are automatically integrated with the existing security system:

### Role-Based Access Control

Better-Auth users work seamlessly with `@Roles()` decorators:

```typescript
@Roles(RoleEnum.ADMIN)
@Query(() => [User])
async findAllUsers() {
  // Only accessible by users with ADMIN role
}
```

### Special Roles

| Role | Description |
|------|-------------|
| `S_EVERYONE` | Accessible by everyone (no auth required) |
| `S_USER` | Any authenticated user |
| `S_VERIFIED` | Users with verified email |
| `S_NO_ONE` | Never accessible |

### How It Works

1. `BetterAuthMiddleware` validates the session on each request
2. `BetterAuthUserMapper` maps the session user to a user with `hasRole()` capability
3. The mapped user is set to `req.user` for use with guards and decorators
4. `RolesGuard` and `@Restricted()` work as expected

## User Mapping

The `BetterAuthUserMapper` handles the conversion between Better-Auth sessions and application users:

```typescript
import { BetterAuthUserMapper } from '@lenne.tech/nest-server';

@Injectable()
export class MyService {
  constructor(private readonly userMapper: BetterAuthUserMapper) {}

  async mapUser(sessionUser: BetterAuthSessionUser) {
    // Maps session user to application user with roles
    const user = await this.userMapper.mapSessionUser(sessionUser);

    if (user) {
      // Check roles
      user.hasRole(RoleEnum.ADMIN); // true/false
      user.hasRole([RoleEnum.ADMIN, 'editor']); // true if any match
    }
  }

  async linkUser(sessionUser: BetterAuthSessionUser) {
    // Links Better-Auth user with application database
    const dbUser = await this.userMapper.linkOrCreateUser(sessionUser);
    // Creates new user or links existing one via iamId
  }
}
```

### Mapped User Properties

| Property | Type | Description |
|----------|------|-------------|
| `id` | string | User ID (from database or Better-Auth ID as fallback) |
| `iamId` | string | IAM provider user ID (e.g., Better-Auth) |
| `email` | string | User email |
| `name` | string | User display name |
| `roles` | string[] | User roles from database |
| `verified` | boolean | Whether user is verified |
| `emailVerified` | boolean | Better-Auth email verification status |
| `hasRole(roles)` | function | Check if user has any of the specified roles |
| `_authenticatedViaBetterAuth` | true | Marker for Better-Auth authenticated users |

## Parallel Operation with Legacy Auth

Better-Auth runs **parallel to Legacy JWT authentication** without conflicts. Both systems are fully compatible because they use the same password hashing (bcrypt) and share the same users collection.

### How It Works

```typescript
// Legacy Auth - continues to work as before
const legacyToken = await authService.signIn({ email, password });

// Better-Auth - works with the same users
// POST /iam/sign-in { email, password }

// Both share the same users collection and bcrypt passwords
```

### Key Points

1. **Shared Users Collection**: Both systems use the same `users` MongoDB collection
2. **bcrypt Compatibility**: Both systems use bcrypt - passwords work with either system
3. **User Linking**: When a user logs in via Better-Auth, `iamId` is set to link them
4. **Role Preservation**: User roles work with both systems

### Compatibility Matrix

| Scenario | Result |
|----------|--------|
| Legacy user → Legacy login | ✅ Works |
| Legacy user → Better-Auth login | ✅ Works (bcrypt compatible) |
| Better-Auth user → Better-Auth login | ✅ Works |
| Better-Auth user → Legacy login | ✅ Works (password field preserved) |
| Social-only user → Legacy login | ❌ Fails (no password field) |

### User Database Fields

| Field | Purpose |
|-------|---------|
| `password` | Password hash (bcrypt) - used by both systems |
| `iamId` | IAM provider user ID (set on first Better-Auth login) |

**No migration is required** - users can authenticate with either system immediately.

## Testing

The module provides a `reset()` method for testing:

```typescript
import { BetterAuthModule } from '@lenne.tech/nest-server';

describe('My Tests', () => {
  beforeEach(() => {
    // Reset static state between tests
    BetterAuthModule.reset();
  });

  afterAll(() => {
    BetterAuthModule.reset();
  });
});
```

## Troubleshooting

### Better-Auth endpoints return 404

- Ensure `betterAuth.enabled` is NOT explicitly set to `false` (Better-Auth is enabled by default, no config needed)
- Check that a valid secret is available (explicit, fallback from `jwt.secret`, or auto-generated)
- Verify MongoDB connection is established
- Check logs for initialization errors during startup

### Session not being set on requests

- Check that `BetterAuthMiddleware` is being applied (automatic with module)
- Verify cookies are being sent with requests
- Check browser developer tools for session cookies

### Social login not working

- Verify `clientId` and `clientSecret` are correct
- Check that redirect URLs are configured in provider settings
- Ensure `trustedOrigins` includes your application URL

### 2FA/Passkey not working

- Ensure the respective plugin is enabled in configuration
- For Passkey, verify `rpId` matches your domain
- Check browser console for WebAuthn errors

## Rate Limiting

The Better-Auth module includes built-in rate limiting to protect against brute-force attacks.

### Configuration

```typescript
betterAuth: {
  // ... other config
  rateLimit: {
    enabled: true,
    max: 10, // Maximum requests per time window
    windowSeconds: 60, // Time window in seconds (1 minute)
    message: 'Too many requests, please try again later.',
    strictEndpoints: ['/sign-in', '/sign-up', '/forgot-password', '/reset-password'],
    skipEndpoints: ['/session', '/callback'],
  },
}
```

### Configuration Options

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `enabled` | boolean | `false` | Enable/disable rate limiting |
| `max` | number | `10` | Maximum requests per time window |
| `windowSeconds` | number | `60` | Time window in seconds |
| `message` | string | `'Too many requests...'` | Error message when limit exceeded |
| `strictEndpoints` | string[] | See below | Endpoints with half the normal limit |
| `skipEndpoints` | string[] | See below | Endpoints that skip rate limiting |

### Default Strict Endpoints

Strict endpoints receive half the configured `max` limit to provide extra protection:

- `/sign-in` - Login attempts
- `/sign-up` - Registration attempts
- `/forgot-password` - Password reset requests
- `/reset-password` - Password reset submissions

### Default Skip Endpoints

These endpoints bypass rate limiting entirely:

- `/session` - Session checks (frequent client-side calls)
- `/callback` - OAuth callbacks

### Response Headers

When rate limiting is enabled, the following headers are added to responses:

| Header | Description |
|--------|-------------|
| `X-RateLimit-Limit` | Maximum requests allowed in the window |
| `X-RateLimit-Remaining` | Remaining requests in current window |
| `X-RateLimit-Reset` | Seconds until the rate limit resets |
| `Retry-After` | (429 only) Seconds to wait before retrying |

### Rate Limit Exceeded Response

When the rate limit is exceeded, a `429 Too Many Requests` response is returned:

```json
{
  "statusCode": 429,
  "error": "Too Many Requests",
  "message": "Too many requests, please try again later.",
  "retryAfter": 45
}
```

### Using BetterAuthRateLimiter Programmatically

```typescript
import { BetterAuthRateLimiter } from '@lenne.tech/nest-server';

@Injectable()
export class MyService {
  constructor(private readonly rateLimiter: BetterAuthRateLimiter) {}

  checkCustomLimit(ip: string) {
    // Check rate limit for custom endpoint
    const result = this.rateLimiter.check(ip, '/custom-endpoint');

    if (!result.allowed) {
      console.log(`Rate limit exceeded. Retry in ${result.resetIn} seconds`);
    }
  }

  resetUserLimit(ip: string) {
    // Reset rate limit for specific IP (e.g., after successful captcha)
    this.rateLimiter.reset(ip);
  }

  getStats() {
    // Get rate limiter statistics
    return this.rateLimiter.getStats();
    // { enabled: true, activeEntries: 42 }
  }
}
```

### Production Recommendations

For production environments, consider:

1. **Enable rate limiting** - Always enable in production
2. **Lower limits** - Use stricter limits (e.g., `max: 5`) for production
3. **Environment variables** - Configure via environment:
   ```typescript
   rateLimit: {
     enabled: process.env.RATE_LIMIT_ENABLED !== 'false',
     max: parseInt(process.env.RATE_LIMIT_MAX || '10', 10),
     windowSeconds: parseInt(process.env.RATE_LIMIT_WINDOW_SECONDS || '60', 10),
   }
   ```
4. **Monitor rate limit events** - The service logs warnings when limits are exceeded
5. **Consider Redis** - For multi-instance deployments, implement Redis-based rate limiting
