# Better-Auth Module

Integration of the [better-auth](https://better-auth.com) authentication framework with @lenne.tech/nest-server.

## TL;DR

```typescript
// 1. Follow INTEGRATION-CHECKLIST.md to create required files
// 2. Add to server.module.ts:
CoreModule.forRoot(envConfig),  // IAM-only (new projects)
BetterAuthModule.forRoot({ config: envConfig.betterAuth, fallbackSecrets: [envConfig.jwt?.secret] }),

// 3. Configure in config.env.ts (minimal - JWT enabled by default):
betterAuth: true  // or betterAuth: {} for same effect

// With optional features:
betterAuth: { twoFactor: {}, passkey: {} }
```

**Quick Links:** [Integration Checklist](./INTEGRATION-CHECKLIST.md) | [REST API](#rest-api-endpoints) | [GraphQL API](#graphql-api) | [Configuration](#configuration)

---

## Table of Contents

- [Features](#features)
- [Quick Integration](#quick-integration-for-claude-code--ai-assistants)
- [Project Integration Guide](#project-integration-guide-required-steps)
- [Configuration](#configuration)
- [REST API Endpoints](#rest-api-endpoints)
- [GraphQL API](#graphql-api)
- [CoreModule Signatures](#coremoduleforroot-signatures)
- [Migration Roadmap](#migration-roadmap-legacy-auth--betterauth)
- [Password Synchronization](#bidirectional-password-synchronization)
- [Security Integration](#security-integration)
- [Troubleshooting](#troubleshooting)

---

## Features

### Built-in Plugins

- **JWT Tokens** - For API clients and stateless authentication (**enabled by default**)
- **Two-Factor Authentication (2FA)** - TOTP-based second factor (opt-in)
- **Passkey/WebAuthn** - Passwordless authentication (opt-in)

### Core Features

- **Email/Password Authentication** - Standard username/password login
- **Social Login** - Any OAuth provider (Google, GitHub, Apple, Discord, etc.)
- **Parallel Operation** - Runs alongside Legacy Auth without side effects
- **Bidirectional Sync** - Users can sign in via Legacy Auth or Better-Auth interchangeably

### Extensible via Plugins

- **Organization** - Multi-tenant, teams, member management
- **Admin** - User impersonation, banning
- **SSO** - Single Sign-On (OIDC, SAML)
- **And many more** - See [Plugins and Extensions](#plugins-and-extensions)

---

## Quick Integration (for Claude Code / AI Assistants)

**Use [INTEGRATION-CHECKLIST.md](./INTEGRATION-CHECKLIST.md)** for a concise checklist with references to the actual implementation files.

---

## Reference Implementation

A complete working implementation exists in this package:

**Local (in your node_modules):**
```
node_modules/@lenne.tech/nest-server/src/server/modules/better-auth/
```

**GitHub:**
https://github.com/lenneTech/nest-server/tree/develop/src/server/modules/better-auth

**UserService integration:**
- Local: `node_modules/@lenne.tech/nest-server/src/server/modules/user/user.service.ts`
- GitHub: https://github.com/lenneTech/nest-server/blob/develop/src/server/modules/user/user.service.ts

---

## Project Integration Guide (Required Steps)

### Step 1: Create BetterAuth Module
**Create:** `src/server/modules/better-auth/better-auth.module.ts`
**Copy from:** Reference implementation (see above)

### Step 2: Create BetterAuth Resolver (CRITICAL!)
**Create:** `src/server/modules/better-auth/better-auth.resolver.ts`
**Copy from:** Reference implementation

**WHY must ALL decorators be re-declared?**
GraphQL schema is built from decorators at compile time. The parent class (`CoreBetterAuthResolver`) is marked as `isAbstract: true`, so its methods are not registered in the schema. You MUST re-declare `@Query`, `@Mutation`, `@Roles` decorators in the child class for the methods to appear in the GraphQL schema.

**Note:** `@UseGuards(AuthGuard(JWT))` is NOT needed when using `@Roles(S_USER)` or `@Roles(ADMIN)` because `RolesGuard` already extends `AuthGuard(JWT)` internally.

### Step 3: Create BetterAuth Controller
**Create:** `src/server/modules/better-auth/better-auth.controller.ts`
**Copy from:** Reference implementation

### Step 4: Inject BetterAuthUserMapper in UserService (CRITICAL!)
**Modify:** `src/server/modules/user/user.service.ts`
**Reference:** See UserService in reference implementation

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

**Why is this critical?**
The `BetterAuthUserMapper` enables bidirectional password synchronization:
- User signs up via BetterAuth → password synced to Legacy Auth (bcrypt hash)
- User changes password → synced between both systems
- **Without this, users can only authenticate via ONE system!**

### Step 5: Import in ServerModule
**Modify:** `src/server/server.module.ts`
**Reference:** See ServerModule in reference implementation

Add import and include BetterAuthModule in imports array with `fallbackSecrets`:

```typescript
BetterAuthModule.forRoot({
  config: envConfig.betterAuth,
  fallbackSecrets: [envConfig.jwt?.secret, envConfig.jwt?.refresh?.secret],
}),
```

### Step 6: Configure in config.env.ts
**Modify:** `src/config.env.ts`
**Reference:** See config.env.ts in reference implementation

Add `betterAuth` configuration block. See reference for all available options including `jwt`, `passkey`, `twoFactor`, and `socialProviders`.

---

## Quick Reference

**Configuration formats:**
```typescript
betterAuth: true               // Enable with all defaults (JWT enabled)
betterAuth: false              // Disable completely
betterAuth: {}                 // Same as true
betterAuth: { ... }            // Enable with custom settings
betterAuth: { enabled: false } // Disable (allows pre-configuration)
```

**Default values (used when not configured):**

- **JWT**: Enabled by default
- **Secret**: Falls back to `jwt.secret` → `jwt.refresh.secret` → auto-generated
- **Base URL**: `http://localhost:3000`
- **Base Path**: `/iam`
- **2FA/Passkey**: Disabled (opt-in)

To **explicitly disable** Better-Auth:

```typescript
const config = {
  betterAuth: false,  // or betterAuth: { enabled: false }
};
```

Read the security section below for production deployments.

---

## Understanding Core Settings

### Base URL (`baseUrl`)

**Purpose:** Absolute URL generation for links and redirects

**Technically used for:**

- **Email Links**: Password reset links, email verification links
  ```text
  https://your-domain.com/iam/reset-password?token=xyz
  ```
- **OAuth Redirect URIs**: Callback URLs for social login providers
  ```text
  https://your-domain.com/iam/callback/google
  ```
- **CORS Origin Validation**: If no `trustedOrigins` are set, `baseUrl` is used as the trusted origin

**Impact of incorrect value:** Email links point to wrong server, OAuth callbacks fail.

### Base Path (`basePath`)

**Purpose:** URL prefix for all Better-Auth REST endpoints

**Technically used for:**

- **Routing**: All endpoints are registered under this path
  ```text
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
- **Phishing Protection**: Prevents passkeys from being used on other domains

**Impact of incorrect value:** Passkey authentication fails with "origin mismatch" error.

### Configuration Summary

| Setting           | Technical Purpose      | Impact of Wrong Value        |
| ----------------- | ---------------------- | ---------------------------- |
| `baseUrl`         | Email links, OAuth     | Links point to wrong server  |
| `basePath`        | Endpoint routing       | 404 on API calls             |
| `passkey.origin`  | WebAuthn security      | Passkey auth fails           |

**For Development:** The defaults (`http://localhost:3000`, `/iam`) are correct.

**For Production:** You must set `baseUrl` and `passkey.origin` to your actual domain:

```typescript
const config = {
  betterAuth: {
    baseUrl: 'https://api.your-domain.com',
    passkey: {
      // enabled by default when config block is present
      origin: 'https://your-domain.com', // Frontend domain
      rpId: 'your-domain.com', // Domain without protocol
      rpName: 'Your Application',
    },
  },
};
```

## IMPORTANT: Secret Configuration

### Secret Resolution (Fallback Chain)

Better-Auth resolves the secret in the following order:

1. **`betterAuth.secret`** - If explicitly configured
2. **`jwt.secret`** - Fallback for backwards compatibility (if ≥32 chars)
3. **`jwt.refresh.secret`** - Second fallback (if ≥32 chars)
4. **Auto-generated** - Secure random secret (with warning)

### Backwards Compatibility

If you already have `jwt.secret` configured with ≥32 characters, **Better-Auth will automatically use it** as a fallback. This means:

- No configuration needed for existing projects with proper JWT secrets
- Sessions persist across server restarts (uses existing secret)
- A warning reminds you to set `betterAuth.secret` explicitly

### Development (Auto-Generated Secret)

When no valid secret is found (including fallbacks), Better-Auth **automatically generates a secure random secret** at server startup.

**Consequences:**

- **Secure** - The secret is cryptographically random (32 bytes)
- **Sessions lost on restart** - All user sessions become invalid when the server restarts
- **Acceptable for development** - Frequent restarts during development are normal

### Production (Recommended)

For production, explicitly set `betterAuth.secret` or ensure `jwt.secret` is ≥32 characters:

```bash
# Generate a secure secret:
node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"

# Set in your environment:
export BETTER_AUTH_SECRET="your-generated-secret-here"
```

**Consequences of using auto-generated secret in production:**

- Sessions lost on every deployment - All users must re-login after each deploy
- Sessions lost on server restart - Any restart invalidates all sessions
- No session sharing in clusters - Multiple server instances can't share sessions

### Secret Requirements

| Requirement       | Value                                                     |
| ----------------- | --------------------------------------------------------- |
| Minimum length    | 32 characters                                             |
| Recommended       | 44+ characters (32 bytes base64)                          |
| Character types   | At least 2 of: lowercase, uppercase, numbers, special     |

### Configuration Examples

**Via Environment Variable (Recommended):**

```bash
BETTER_AUTH_SECRET=K7xR2mN9pQ4wE6tY8uI0oP3aS5dF7gH9jK1lZ2xC4vB6nM8=
```

**Via config.env.ts:**

```typescript
const config = {
  betterAuth: {
    // enabled: true by default - no need to set explicitly
    secret: process.env.BETTER_AUTH_SECRET,
  },
};
```

## Configuration

**Optional** - Better-Auth works without any configuration (true zero-config). Only add this block if you need to customize behavior:

```typescript
// In config.env.ts
export default {
  // ... other config

  // MINIMAL: Just enable BetterAuth (JWT enabled by default)
  betterAuth: true,

  // OR with customization:
  betterAuth: {
    // enabled: true by default - only set to false to disable
    // secret: auto-generated if not set (see Security section above)
    // baseUrl: 'http://localhost:3000', // Default
    // basePath: '/iam', // Default

    // JWT Plugin - ENABLED BY DEFAULT (no config needed)
    // Only add this block to customize or explicitly disable
    jwt: {
      expiresIn: '30m',  // Default: '15m'
      // enabled: false,  // Uncomment to disable JWT
    },

    // Two-Factor Authentication (opt-in - requires config block)
    twoFactor: {
      appName: 'My Application',
    },

    // Passkey/WebAuthn (opt-in - requires config block)
    passkey: {
      rpId: 'localhost',
      rpName: 'My Application',
      origin: 'http://localhost:3000',
    },

    // Social Providers (enabled by default when credentials are configured)
    // Set enabled: false to explicitly disable a provider
    socialProviders: {
      google: {
        clientId: 'your-google-client-id',
        clientSecret: 'your-google-client-secret',
      },
      github: {
        clientId: 'your-github-client-id',
        clientSecret: 'your-github-client-secret',
      },
    },

    // Trusted Origins for CORS
    trustedOrigins: ['http://localhost:3000', 'https://your-app.com'],

    // Rate Limiting (optional)
    rateLimit: {
      enabled: true,
      max: 10,
      windowSeconds: 60,
      message: 'Too many requests, please try again later.',
      strictEndpoints: ['/sign-in', '/sign-up', '/forgot-password', '/reset-password'],
      skipEndpoints: ['/session', '/callback'],
    },
  },
};
```

## Advanced Configuration

### Email/Password Authentication

Email/password authentication is enabled by default. You can disable it if you only want social login:

```typescript
const config = {
  betterAuth: {
    emailAndPassword: {
      enabled: false, // Disable email/password, only allow social login
    },
  },
};
```

### Additional User Fields

Add custom fields to the Better-Auth user schema:

```typescript
const config = {
  betterAuth: {
    additionalUserFields: {
      phoneNumber: { type: 'string', defaultValue: null },
      department: { type: 'string', required: true },
      preferences: { type: 'string', defaultValue: '{}' },
      isActive: { type: 'boolean', defaultValue: true },
    },
  },
};
```

**Available field types:** `'string'`, `'number'`, `'boolean'`, `'date'`, `'json'`, `'string[]'`, `'number[]'`

### Module Integration (Recommended Pattern)

By default (`autoRegister: false`), projects integrate BetterAuth via an **extended module** in their project. This follows the same pattern as Legacy Auth and allows for custom resolvers, controllers, and project-specific authentication logic.

```typescript
// src/server/modules/better-auth/better-auth.module.ts
import { Module, DynamicModule } from '@nestjs/common';
import { BetterAuthModule as CoreBetterAuthModule } from '@lenne.tech/nest-server';

@Module({})
export class BetterAuthModule {
  static forRoot(options): DynamicModule {
    return {
      module: BetterAuthModule,
      imports: [CoreBetterAuthModule.forRoot(options)],
      // Add custom providers, resolvers, etc.
    };
  }
}

// src/server/server.module.ts
import { BetterAuthModule } from './modules/better-auth/better-auth.module';

@Module({
  imports: [
    CoreModule.forRoot(environment),
    BetterAuthModule.forRoot({
      config: environment.betterAuth,
      resolver: CustomBetterAuthResolver, // Optional custom resolver
    }),
  ],
})
export class ServerModule {}
```

### Auto-Registration (Simple Projects)

For simple projects that don't need customization, you can enable auto-registration:

```typescript
// In config.env.ts
const config = {
  betterAuth: {
    autoRegister: true, // Enable auto-registration in CoreModule
  },
};

// No manual import needed - CoreModule handles everything
@Module({
  imports: [CoreModule.forRoot(environment)],
})
export class ServerModule {}
```

### Options Passthrough

For full Better-Auth customization, use the `options` passthrough. These options are passed directly to Better-Auth:

```typescript
const config = {
  betterAuth: {
    options: {
      emailAndPassword: {
        requireEmailVerification: true,
        sendResetPassword: async ({ user, url }) => {
          // Custom password reset email logic
        },
      },
      account: {
        accountLinking: { enabled: true },
      },
      session: {
        expiresIn: 60 * 60 * 24 * 7, // 7 days
        updateAge: 60 * 60 * 24, // 1 day
      },
      advanced: {
        cookiePrefix: 'my-app',
        useSecureCookies: true,
      },
    },
  },
};
```

See [Better-Auth Options Reference](https://www.better-auth.com/docs/reference/options) for all available options.

## Plugins and Extensions

Better-Auth provides a rich plugin ecosystem. This module uses a **hybrid approach**:

- **Built-in plugins** (JWT, 2FA, Passkey): Explicitly configured with typed options
- **Additional plugins**: Dynamically added via the `plugins` array

### Built-in Plugins

| Plugin             | Default State | Minimal Config to Enable | Default Values                                                                    |
| ------------------ | ------------- | ------------------------ | --------------------------------------------------------------------------------- |
| **JWT**            | **ENABLED**   | *(none needed)*          | `expiresIn: '15m'`                                                                |
| **Two-Factor**     | Disabled      | `twoFactor: {}`          | `appName: 'Nest Server'`                                                          |
| **Passkey**        | Disabled      | `passkey: {}`            | `origin: 'http://localhost:3000'`, `rpId: 'localhost'`, `rpName: 'Nest Server'`   |

**JWT is enabled by default** - no configuration needed. 2FA and Passkey require explicit configuration.

#### Minimal Syntax (Recommended for Development)

```typescript
const config = {
  // JWT is enabled automatically with BetterAuth
  betterAuth: true,  // or betterAuth: {}

  // To also enable 2FA and Passkey:
  betterAuth: {
    twoFactor: {},
    passkey: {},
  },
};
```

#### Custom Configuration (Recommended for Production)

```typescript
const config = {
  betterAuth: {
    jwt: { expiresIn: '30m' },
    twoFactor: { appName: 'My App' },
    passkey: {
      rpId: 'example.com',
      rpName: 'My App',
      origin: 'https://example.com',
    },
  },
};
```

#### Disabling Plugins

```typescript
const config = {
  betterAuth: {
    jwt: false,               // Disable JWT (or jwt: { enabled: false })
    twoFactor: {},            // 2FA enabled with defaults
    passkey: { enabled: false }, // Passkey explicitly disabled
  },
};
```

**Note:** JWT is the only plugin enabled by default. To disable it, use `jwt: false` or `jwt: { enabled: false }`.

### Dynamic Plugins (plugins Array)

For all other Better-Auth plugins, use the `plugins` array. This provides maximum flexibility without requiring updates to this package.

```typescript
import { organization } from 'better-auth/plugins';
import { admin } from 'better-auth/plugins';
import { multiSession } from 'better-auth/plugins';
import { apiKey } from 'better-auth/plugins';

const config = {
  betterAuth: {
    // Built-in plugins
    jwt: { expiresIn: '30m' },

    // Additional plugins via array
    plugins: [
      organization({
        allowUserToCreateOrganization: true,
        creatorRole: 'owner',
      }),
      admin({
        impersonationSessionDuration: 60 * 60,
      }),
      multiSession({
        maximumSessions: 5,
      }),
      apiKey(),
    ],
  },
};
```

### Available Better-Auth Plugins

| Plugin             | Use Case                                      | Recommendation              |
| ------------------ | --------------------------------------------- | --------------------------- |
| **organization**   | Multi-tenant apps, teams, member management   | Common for SaaS/B2B         |
| **admin**          | User impersonation, banning, user management  | Common for admin panels     |
| **multiSession**   | Multiple active sessions per user             | Account switching apps      |
| **apiKey**         | API key based authentication                  | Public APIs                 |
| **sso**            | Single Sign-On (OIDC, SAML 2.0)               | Enterprise apps             |
| **oidcProvider**   | Build your own identity provider              | Identity platforms          |
| **genericOAuth**   | Custom OAuth providers                        | Special OAuth integrations  |
| **polar**          | Usage-based billing with Polar                | SaaS billing                |

For the complete list of plugins, see:

- [Official Plugins](https://www.better-auth.com/docs/concepts/plugins)
- [Community Plugins](https://www.better-auth.com/docs/plugins/community-plugins)

### Example: Organization Plugin

Multi-tenant support with teams and roles:

```typescript
import { organization } from 'better-auth/plugins';

const config = {
  betterAuth: {
    plugins: [
      organization({
        allowUserToCreateOrganization: true,
        creatorRole: 'owner',
        membershipLimit: 100,
        organizationLimit: 5,
        teams: {
          enabled: true,
          maximumTeams: 10,
        },
      }),
    ],
  },
};
```

### Example: Admin Plugin

User management and impersonation:

```typescript
import { admin } from 'better-auth/plugins';

const config = {
  betterAuth: {
    plugins: [
      admin({
        impersonationSessionDuration: 60 * 60,
        defaultRole: 'user',
        adminRole: 'admin',
      }),
    ],
  },
};
```

### Example: SSO Plugin

Enterprise Single Sign-On:

```typescript
import { sso } from 'better-auth/plugins';

const config = {
  betterAuth: {
    plugins: [
      sso({
        issuer: 'https://your-identity-provider.com',
        // ... OIDC/SAML configuration
      }),
    ],
  },
};
```

### Why This Hybrid Approach?

| Approach                          | Pros                                               | Cons                              |
| --------------------------------- | -------------------------------------------------- | --------------------------------- |
| **Built-in** (jwt, 2fa, passkey)  | TypeScript types, IDE autocomplete, documentation | Package update needed for changes |
| **Dynamic** (plugins array)       | Any plugin works immediately, future-proof         | No typed config in IBetterAuth    |

**Best of both worlds:**

- Core auth plugins with great developer experience
- Full flexibility for specialized plugins
- No package updates needed for new Better-Auth plugins

## Module Setup

See the [Project Integration Guide](#project-integration-guide-required-steps) at the top of this document for complete step-by-step instructions.

### Summary

Better-Auth is **enabled by default** but requires explicit module integration (`autoRegister: false` by default). This follows the same pattern as Legacy Auth, giving projects full control over customization.

**Required components:**

1. `BetterAuthModule` - Wraps CoreBetterAuthModule with custom resolver/controller
2. `BetterAuthResolver` - Extends CoreBetterAuthResolver for GraphQL operations
3. `BetterAuthController` - Extends CoreBetterAuthController for REST endpoints
4. `UserService` - Inject `BetterAuthUserMapper` for bidirectional auth sync

### Simple: Auto-Registration

For simple projects without customization needs (not recommended for production):

```typescript
// In config.env.ts
const config = {
  betterAuth: {
    autoRegister: true, // Let CoreModule handle registration
  },
};

// In server.module.ts - no manual import needed
@Module({
  imports: [CoreModule.forRoot(environment)],
})
export class ServerModule {}
```

### Disable Better-Auth

To explicitly disable Better-Auth:

```typescript
const config = {
  betterAuth: false,  // Simple boolean
  // or
  betterAuth: { enabled: false },  // Allows pre-configuration
};
```

## REST API Endpoints

When enabled, Better-Auth exposes the following endpoints at the configured `basePath` (default: `/iam`):

| Endpoint                    | Method | Description                  |
| --------------------------- | ------ | ---------------------------- |
| `/iam/sign-up/email`        | POST   | Register new user            |
| `/iam/sign-in/email`        | POST   | Sign in with email/password  |
| `/iam/sign-out`             | GET    | Sign out (invalidate session)|
| `/iam/session`              | GET    | Get current session          |
| `/iam/token`                | GET    | Get fresh JWT token          |
| `/iam/forgot-password`      | POST   | Request password reset       |
| `/iam/reset-password`       | POST   | Reset password with token    |
| `/iam/verify-email`         | POST   | Verify email address         |

### JWT Token Endpoint

The `/iam/token` endpoint returns a fresh JWT token for the current session. Use this when your JWT has expired but your session is still valid.

**Request:**
```bash
curl -X GET https://api.example.com/iam/token \
  -H "Cookie: better-auth.session_token=..."
```

**Response:**
```json
{
  "token": "eyJhbGciOiJFZERTQSIsInR5cCI6IkpXVCIsImtpZCI6Ii4uLiJ9..."
}
```

**Use case:** Microservice authentication - pass the JWT to other services that verify tokens via JWKS (`/iam/jwks`) without database access.

### Social Login Endpoints

| Endpoint                   | Method | Description           |
| -------------------------- | ------ | --------------------- |
| `/iam/sign-in/social`      | POST   | Initiate social login |
| `/iam/callback/:provider`  | GET    | OAuth callback        |

### Two-Factor Authentication Endpoints (Native Better Auth)

These endpoints are handled by Better Auth's native `twoFactor` plugin:

| Endpoint                            | Method | Description                    |
| ----------------------------------- | ------ | ------------------------------ |
| `/iam/two-factor/enable`            | POST   | Enable 2FA, get TOTP URI       |
| `/iam/two-factor/disable`           | POST   | Disable 2FA                    |
| `/iam/two-factor/verify-totp`       | POST   | Verify TOTP code               |
| `/iam/two-factor/generate-backup-codes` | POST | Generate backup codes      |
| `/iam/two-factor/verify-backup-code`| POST   | Verify backup code             |

### Passkey Endpoints (Native Better Auth)

These endpoints are handled by Better Auth's native `passkey` plugin:

| Endpoint                                  | Method | Description                         |
| ----------------------------------------- | ------ | ----------------------------------- |
| `/iam/passkey/generate-register-options`  | POST   | Get WebAuthn registration options   |
| `/iam/passkey/verify-registration`        | POST   | Verify and store passkey            |
| `/iam/passkey/generate-authenticate-options` | POST | Get WebAuthn authentication options |
| `/iam/passkey/verify-authentication`      | POST   | Verify passkey authentication       |
| `/iam/passkey/list-user-passkeys`         | POST   | List user's passkeys                |
| `/iam/passkey/delete-passkey`             | POST   | Delete a passkey                    |
| `/iam/passkey/update-passkey`             | POST   | Update passkey name                 |

## GraphQL API

In addition to REST endpoints, Better-Auth provides GraphQL queries and mutations:

### Queries

| Query                    | Arguments | Return Type                  | Description                       |
| ------------------------ | --------- | ---------------------------- | --------------------------------- |
| `betterAuthEnabled`      | -         | `Boolean`                    | Check if Better-Auth is enabled   |
| `betterAuthFeatures`     | -         | `BetterAuthFeaturesModel`    | Get enabled features status       |
| `betterAuthSession`      | -         | `BetterAuthSessionModel`     | Get current session (auth req.)   |
| `betterAuthToken`        | -         | `String`                     | Get fresh JWT token (auth req.)   |
| `betterAuthListPasskeys` | -         | `[BetterAuthPasskeyModel]`   | List user's passkeys (auth req.)  |
| `betterAuthMigrationStatus` | -      | `BetterAuthMigrationStatusModel` | Migration status (admin only) |

### Mutations

#### Authentication

| Mutation              | Arguments                    | Return Type          | Description               |
| --------------------- | ---------------------------- | -------------------- | ------------------------- |
| `betterAuthSignIn`    | `email`, `password`          | `BetterAuthAuthModel`| Sign in with email/pass   |
| `betterAuthSignUp`    | `email`, `password`, `name?` | `BetterAuthAuthModel`| Register new account      |
| `betterAuthSignOut`   | -                            | `Boolean`            | Sign out (requires auth)  |
| `betterAuthVerify2FA` | `code`                       | `BetterAuthAuthModel`| Verify 2FA code           |

#### 2FA Management (requires authentication)

| Mutation                       | Arguments  | Return Type              | Description                    |
| ------------------------------ | ---------- | ------------------------ | ------------------------------ |
| `betterAuthEnable2FA`          | `password` | `BetterAuth2FASetupModel`| Enable 2FA, get TOTP URI       |
| `betterAuthDisable2FA`         | `password` | `Boolean`                | Disable 2FA for user           |
| `betterAuthGenerateBackupCodes`| -          | `[String]`               | Generate new backup codes      |

#### Passkey Management (requires authentication)

| Mutation                       | Arguments   | Return Type                      | Description                 |
| ------------------------------ | ----------- | -------------------------------- | --------------------------- |
| `betterAuthGetPasskeyChallenge`| -           | `BetterAuthPasskeyChallengeModel`| Get WebAuthn challenge      |
| `betterAuthDeletePasskey`      | `passkeyId` | `Boolean`                        | Delete a passkey            |

### Response Types

#### BetterAuthAuthModel

```graphql
type BetterAuthAuthModel {
  success: Boolean!
  requiresTwoFactor: Boolean
  token: String
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
  socialProviders: [String!]!
}
```

#### BetterAuth2FASetupModel

```graphql
type BetterAuth2FASetupModel {
  success: Boolean!
  totpUri: String
  backupCodes: [String!]
  error: String
}
```

#### BetterAuthPasskeyModel

```graphql
type BetterAuthPasskeyModel {
  id: String!
  name: String
  credentialId: String!
  createdAt: DateTime!
}
```

#### BetterAuthPasskeyChallengeModel

```graphql
type BetterAuthPasskeyChallengeModel {
  success: Boolean!
  challenge: String
  error: String
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

# Enable 2FA (requires authentication)
mutation {
  betterAuthEnable2FA(password: "yourPassword") {
    success
    totpUri
    backupCodes
    error
  }
}

# Disable 2FA
mutation {
  betterAuthDisable2FA(password: "yourPassword")
}

# Generate new backup codes
mutation {
  betterAuthGenerateBackupCodes
}

# List passkeys
query {
  betterAuthListPasskeys {
    id
    name
    credentialId
    createdAt
  }
}

# Get passkey registration challenge (for WebAuthn)
mutation {
  betterAuthGetPasskeyChallenge {
    success
    challenge
    error
  }
}

# Delete a passkey
mutation {
  betterAuthDeletePasskey(passkeyId: "passkey-id-here")
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

| Method                              | Description                                  |
| ----------------------------------- | -------------------------------------------- |
| `isEnabled()`                       | Check if Better-Auth is enabled              |
| `getInstance()`                     | Get the Better-Auth instance                 |
| `getApi()`                          | Get the Better-Auth API                      |
| `getConfig()`                       | Get the current configuration                |
| `isJwtEnabled()`                    | Check if JWT plugin is enabled               |
| `isTwoFactorEnabled()`              | Check if 2FA is enabled                      |
| `isPasskeyEnabled()`                | Check if Passkey is enabled                  |
| `getEnabledSocialProviders()`       | Get list of enabled social providers         |
| `getBasePath()`                     | Get the base path for endpoints              |
| `getBaseUrl()`                      | Get the base URL                             |
| `getSession(req)`                   | Get current session from request             |
| `revokeSession(token)`              | Revoke a session (logout)                    |
| `isSessionExpiringSoon(session, t?)`| Check if session is expiring soon            |
| `getSessionTimeRemaining(session)`  | Get remaining session time in seconds        |

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

| Role          | Description                           |
| ------------- | ------------------------------------- |
| `S_EVERYONE`  | Accessible by everyone (no auth req.) |
| `S_USER`      | Any authenticated user                |
| `S_VERIFIED`  | Users with verified email             |
| `S_NO_ONE`    | Never accessible                      |

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

| Property                      | Type       | Description                                           |
| ----------------------------- | ---------- | ----------------------------------------------------- |
| `id`                          | string     | User ID (from database or Better-Auth ID as fallback) |
| `iamId`                       | string     | IAM provider user ID (e.g., Better-Auth)              |
| `email`                       | string     | User email                                            |
| `name`                        | string     | User display name                                     |
| `roles`                       | string[]   | User roles from database                              |
| `verified`                    | boolean    | Whether user is verified                              |
| `emailVerified`               | boolean    | Better-Auth email verification status                 |
| `hasRole(roles)`              | function   | Check if user has any of the specified roles          |
| `_authenticatedViaBetterAuth` | true       | Marker for Better-Auth authenticated users            |

## CoreModule.forRoot() Signatures

Two signatures are available for different use cases:

### IAM-Only Signature (Recommended for New Projects)

```typescript
// server.module.ts
@Module({
  imports: [
    CoreModule.forRoot(envConfig),
    BetterAuthModule.forRoot({
      config: envConfig.betterAuth,
      fallbackSecrets: [envConfig.jwt?.secret],
    }),
  ],
})
export class ServerModule {}
```

**Features:**
- Simplified setup - no Legacy Auth overhead
- GraphQL Subscription authentication via BetterAuth sessions
- BetterAuthModule is auto-registered when using this signature

**Requirements:**
- Create BetterAuthModule, Resolver, and Controller in your project
- Inject BetterAuthUserMapper in UserService
- Set `auth.legacyEndpoints.enabled: false` in config

### Legacy + IAM Signature (For Existing Projects)

```typescript
// server.module.ts
@Module({
  imports: [
    CoreModule.forRoot(AuthService, AuthModule.forRoot(envConfig.jwt), envConfig),
    BetterAuthModule.forRoot({
      config: envConfig.betterAuth,
      fallbackSecrets: [envConfig.jwt?.secret],
    }),
  ],
})
export class ServerModule {}
```

> **@deprecated** This 3-parameter signature is deprecated for new projects.
> Use the single-parameter signature for new projects.

**Features:**
- Both Legacy Auth and BetterAuth run in parallel
- Bidirectional password synchronization
- Gradual user migration to IAM

---

## Migration Roadmap (Legacy Auth → BetterAuth)

Better-Auth is designed as the successor to Legacy Auth. This section describes the migration path.

### Scenario Overview

| Scenario | Signature | Description |
|----------|-----------|-------------|
| **1. Legacy Only** | 3-parameter | Existing projects, no IAM integration |
| **2. Migration** | 3-parameter | Legacy + IAM parallel operation |
| **3. IAM Only** | 1-parameter | New projects, BetterAuth only |

### Migration Steps (Scenario 2)

1. **Enable BetterAuth**
   - Follow the [Project Integration Guide](#project-integration-guide-required-steps)
   - Both systems run in parallel

2. **Monitor Migration Progress**
   ```graphql
   query {
     betterAuthMigrationStatus {
       totalUsers
       fullyMigratedUsers
       pendingMigrationUsers
       migrationPercentage
       canDisableLegacyAuth
     }
   }
   ```
   Users migrate automatically when signing in via BetterAuth (IAM).

3. **Disable Legacy Endpoints** (when `canDisableLegacyAuth: true`)
   ```typescript
   // config.env.ts
   auth: {
     legacyEndpoints: {
       enabled: false  // Disables signIn, signUp, logout, refreshToken
     }
   }
   ```

4. **Switch to IAM-Only Signature** (optional)
   ```typescript
   // Before (deprecated)
   CoreModule.forRoot(AuthService, AuthModule.forRoot(envConfig.jwt), envConfig)

   // After (recommended)
   CoreModule.forRoot(envConfig)
   ```

### Why No Automatic Migration Script?

| System | Password Hash Algorithm |
|--------|------------------------|
| Legacy Auth | `bcrypt(sha256(password))` |
| BetterAuth | `scrypt(sha256(password))` |

These are **one-way hashes** - there's no way to convert between them without the plain password.
Users must sign in at least once via BetterAuth to create a compatible hash.

### Detailed Documentation

See `.claude/rules/module-deprecation.md` for complete migration documentation.

---

## Parallel Operation with Legacy Auth

Better-Auth runs **parallel to Legacy JWT authentication** without conflicts. Both systems are fully compatible because they share the same users collection.

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

| Scenario                           | Result                             |
| ---------------------------------- | ---------------------------------- |
| Legacy user → Legacy login         | Works                              |
| Legacy user → Better-Auth login    | Works (bcrypt compatible)          |
| Better-Auth user → Better-Auth     | Works                              |
| Better-Auth user → Legacy login    | Works (password field preserved)   |
| Social-only user → Legacy login    | Fails (no password field)          |

### User Database Fields

| Field      | Purpose                                           |
| ---------- | ------------------------------------------------- |
| `password` | Password hash (bcrypt) - used by both systems     |
| `iamId`    | IAM provider user ID (set on first Better-Auth login) |

**No migration is required** - users can authenticate with either system immediately.

## Bidirectional Password Synchronization

### Overview

When both Legacy Auth and BetterAuth (IAM) are active, passwords are automatically synchronized between the systems. This ensures users can sign in via either system after any password change or reset.

### How Password Sync Works

| Scenario | Source | Target | Auto-Synced? |
|----------|--------|--------|--------------|
| Sign up via BetterAuth | IAM | Legacy | ✅ Yes |
| Sign up via Legacy Auth | Legacy | IAM | ⚠️ On first IAM sign-in |
| Password reset via Legacy | Legacy | IAM | ✅ Yes |
| Password reset via BetterAuth | IAM | Legacy | ⚠️ See below |
| Password change via user update | Legacy | IAM | ✅ Yes |

#### IAM Password Reset → Legacy Sync

When a user resets their password via BetterAuth's native `/iam/reset-password` endpoint, the password is hashed with scrypt before storage. Since we don't have access to the plain password after hashing, we **cannot** automatically sync to Legacy Auth.

**Solutions:**

1. **Recommended: Custom Password Reset Flow**
   Override the password reset to capture the plain password for sync. See [Custom Password Reset with Sync](#custom-password-reset-with-sync).

2. **Use Legacy Password Reset Only**
   Direct users to the Legacy Auth password reset flow, which syncs to IAM automatically.

3. **Re-authenticate After Reset**
   After IAM password reset, users can sign in via IAM. On next Legacy sign-in attempt, they'll need to reset via Legacy too.

### Automatic Sync (No Configuration Required)

The following sync operations happen automatically when `BetterAuthUserMapper` is injected in `UserService`:

#### 1. IAM Sign-Up → Legacy
When a user signs up via BetterAuth (`/iam/sign-up/email`), the password is hashed with bcrypt and stored in `users.password`, enabling Legacy Auth sign-in.

#### 2. Legacy Password Reset → IAM
When a user resets their password via `CoreUserService.resetPassword()`, the new password is synced to the BetterAuth `account` collection (if the user has a credential account).

#### 3. Legacy Password Update → IAM
When a user changes their password via `UserService.update()`, the new password is synced to BetterAuth (if the user has a credential account).

#### 4. Legacy → IAM Migration (On First Sign-In)
When a legacy user signs in via BetterAuth for the first time, their account is migrated:
- Their `iamId` is set
- A credential account is created in the `account` collection with the scrypt hash

### BetterAuth Password Reset Configuration

BetterAuth provides native password reset via `/iam/forgot-password` and `/iam/reset-password` endpoints. To enable this, configure the `sendResetPassword` callback:

```typescript
// config.env.ts
betterAuth: {
  options: {
    emailAndPassword: {
      sendResetPassword: async ({ user, url, token }) => {
        // Send password reset email
        // 'url' contains the full reset URL with token
        await emailService.sendEmail({
          to: user.email,
          subject: 'Reset Your Password',
          html: `<a href="${url}">Click here to reset your password</a>`,
        });
      },
    },
  },
},
```

#### Password Reset Flow (BetterAuth)

1. User requests reset: `POST /iam/forgot-password` with `{ email }`
2. BetterAuth generates token and calls `sendResetPassword` callback
3. User clicks link in email → navigates to reset page
4. Frontend submits: `POST /iam/reset-password` with `{ token, newPassword }`
5. BetterAuth updates password in `account` collection
6. Password is automatically synced to Legacy Auth (`users.password`)

### Password Hashing Algorithms

| System | Algorithm | Format |
|--------|-----------|--------|
| Legacy Auth | bcrypt(sha256(password)) | `$2b$10$...` (60 chars) |
| BetterAuth (IAM) | scrypt | `salt:hash` (hex encoded) |

**Important:** These hashes are NOT interchangeable. Password sync requires re-hashing the plain password with the target algorithm.

### Email Change Synchronization

Email changes are also synchronized bidirectionally:

| Scenario | Effect |
|----------|--------|
| Email changed via Legacy (`UserService.update()`) | IAM sessions invalidated (forces re-auth) |
| Email changed via IAM | Legacy refresh tokens cleared |

### User Deletion Cleanup

When a user is deleted:

| Via | Effect |
|-----|--------|
| Legacy (`UserService.delete()`) | IAM accounts and sessions are cleaned up |
| IAM | Legacy user record is removed |

### Troubleshooting Password Sync

#### Password not syncing to IAM

1. Verify `BetterAuthUserMapper` is injected in `UserService`:
   ```typescript
   constructor(
     @Optional() private readonly betterAuthUserMapper?: BetterAuthUserMapper,
   ) {
     super(..., { betterAuthUserMapper });
   }
   ```

2. Check if user has an IAM credential account:
   ```javascript
   // MongoDB query
   db.account.findOne({ userId: ObjectId("..."), providerId: "credential" })
   ```

3. Check server logs for sync warnings:
   ```
   [CoreUserService] Failed to sync password to IAM...
   ```

#### Password reset email not sending

1. Configure `sendResetPassword` callback in `betterAuth.options`
2. Check that your email service is working
3. Verify the callback receives `user`, `url`, and `token` parameters

#### Legacy user can't sign in via IAM

The user needs to sign in via Legacy Auth first with their password. This triggers the automatic migration on first IAM sign-in attempt.

Alternatively, use `BetterAuthUserMapper.migrateAccountToIam()` to migrate the user programmatically:

```typescript
await betterAuthUserMapper.migrateAccountToIam(email, plainPassword);
```

### Custom Password Reset with Sync

To enable bidirectional password reset sync, implement a custom password reset endpoint that captures the plain password and syncs to both systems:

```typescript
// src/server/modules/better-auth/better-auth.controller.ts
import { Body, Controller, Post } from '@nestjs/common';
import { CoreBetterAuthController, BetterAuthUserMapper, Roles, RoleEnum } from '@lenne.tech/nest-server';

@Controller('iam')
export class BetterAuthController extends CoreBetterAuthController {
  constructor(
    // ... other dependencies
    private readonly betterAuthUserMapper: BetterAuthUserMapper,
  ) {
    super(...);
  }

  /**
   * Custom password reset that syncs to both auth systems
   */
  @Post('reset-password-sync')
  @Roles(RoleEnum.S_EVERYONE)
  async resetPasswordWithSync(
    @Body() input: { token: string; newPassword: string },
  ): Promise<{ success: boolean }> {
    // 1. Reset password via BetterAuth native API
    const api = this.betterAuthService.getApi();
    await api.resetPassword({
      body: { token: input.token, newPassword: input.newPassword },
    });

    // 2. Sync to Legacy Auth using the plain password
    // Get user email from the token (you may need to decode it or lookup)
    const userEmail = await this.getUserEmailFromToken(input.token);
    if (userEmail) {
      await this.betterAuthUserMapper.syncPasswordToLegacy(
        '', // iamUserId not needed for email lookup
        userEmail,
        input.newPassword,
      );
    }

    return { success: true };
  }

  private async getUserEmailFromToken(token: string): Promise<string | null> {
    // Implementation depends on your token structure
    // You may need to query the database or decode the token
    return null;
  }
}
```

**Alternative: Use Legacy Password Reset**

The simpler approach is to use the Legacy Auth password reset flow, which automatically syncs to IAM:

```typescript
// Frontend points to Legacy Auth password reset
const passwordResetUrl = config.email.passwordResetLink;
// e.g., 'http://localhost:4200/user/password-reset'

// User submits new password via Legacy Auth
// → CoreUserService.resetPassword() is called
// → Automatically syncs to IAM via syncPasswordChangeToIam()
```

This is the recommended approach for projects in migration phase where both auth systems are active.

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

- Ensure `betterAuth.enabled` is NOT explicitly set to `false`
- Check that a valid secret is available
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
const config = {
  betterAuth: {
    rateLimit: {
      enabled: true,
      max: 10,
      windowSeconds: 60,
      message: 'Too many requests, please try again later.',
      strictEndpoints: ['/sign-in', '/sign-up', '/forgot-password', '/reset-password'],
      skipEndpoints: ['/session', '/callback'],
    },
  },
};
```

### Configuration Options

| Option            | Type     | Default                    | Description                           |
| ----------------- | -------- | -------------------------- | ------------------------------------- |
| `enabled`         | boolean  | `false`                    | Enable/disable rate limiting          |
| `max`             | number   | `10`                       | Maximum requests per time window      |
| `windowSeconds`   | number   | `60`                       | Time window in seconds                |
| `message`         | string   | `'Too many requests...'`   | Error message when limit exceeded     |
| `strictEndpoints` | string[] | See below                  | Endpoints with half the normal limit  |
| `skipEndpoints`   | string[] | See below                  | Endpoints that skip rate limiting     |

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

| Header                 | Description                              |
| ---------------------- | ---------------------------------------- |
| `X-RateLimit-Limit`    | Maximum requests allowed in the window   |
| `X-RateLimit-Remaining`| Remaining requests in current window     |
| `X-RateLimit-Reset`    | Seconds until the rate limit resets      |
| `Retry-After`          | (429 only) Seconds to wait before retry  |

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
  }
}
```

### Production Recommendations

For production environments, consider:

1. **Enable rate limiting** - Always enable in production
2. **Lower limits** - Use stricter limits (e.g., `max: 5`) for production
3. **Environment variables** - Configure via environment:

```typescript
const config = {
  rateLimit: {
    enabled: process.env.RATE_LIMIT_ENABLED !== 'false',
    max: parseInt(process.env.RATE_LIMIT_MAX || '10', 10),
    windowSeconds: parseInt(process.env.RATE_LIMIT_WINDOW_SECONDS || '60', 10),
  },
};
```

4. **Monitor rate limit events** - The service logs warnings when limits are exceeded
5. **Consider Redis** - For multi-instance deployments, implement Redis-based rate limiting

## Extending Better-Auth (Custom Resolver)

See the [Project Integration Guide](#project-integration-guide-required-steps) for complete setup instructions. This section covers additional customization options.

### Adding Custom Logic

Override any method to add custom behavior (e.g., sending welcome emails, analytics):

```typescript
// In your BetterAuthResolver (see Step 2 in Integration Guide)

@Mutation(() => BetterAuthAuthModel, { description: 'Sign up via Better-Auth (email/password)' })
@Roles(RoleEnum.S_EVERYONE)
override async betterAuthSignUp(
  @Args('email') email: string,
  @Args('password') password: string,
  @Args('name', { nullable: true }) name?: string,
): Promise<BetterAuthAuthModel> {
  // Call original implementation
  const result = await super.betterAuthSignUp(email, password, name);

  // Add custom logic after successful sign-up
  if (result.success && result.user) {
    await this.emailService.sendWelcomeEmail(result.user.email, result.user.name);
    await this.analyticsService.trackSignUp(result.user.id);
  }

  return result;
}
```

### Available Override Methods

All methods in `CoreBetterAuthResolver` can be overridden:

| Method | Description |
| ------ | ----------- |
| `betterAuthSignIn(email, password, ctx)` | Sign in with email/password |
| `betterAuthSignUp(email, password, name?)` | Register new user |
| `betterAuthSignOut(ctx)` | Sign out current session |
| `betterAuthVerify2FA(code, ctx)` | Verify 2FA code |
| `betterAuthEnable2FA(password, ctx)` | Enable 2FA for user |
| `betterAuthDisable2FA(password, ctx)` | Disable 2FA for user |
| `betterAuthGenerateBackupCodes(ctx)` | Generate new backup codes |
| `betterAuthGetPasskeyChallenge(ctx)` | Get WebAuthn challenge |
| `betterAuthListPasskeys(ctx)` | List user's passkeys |
| `betterAuthDeletePasskey(passkeyId, ctx)` | Delete a passkey |
| `betterAuthSession(ctx)` | Get current session |
| `betterAuthEnabled()` | Check if Better-Auth is enabled |
| `betterAuthFeatures()` | Get enabled features |

### Helper Methods (Protected)

These protected methods are available for use in your custom resolver:

```typescript
// Check if Better-Auth is enabled (throws if not)
this.ensureEnabled();

// Convert Express headers to Web API Headers
const headers = this.convertHeaders(ctx.req.headers);

// Map session info
const sessionInfo = this.mapSessionInfo(response.session);

// Map user to model
const userModel = this.mapToUserModel(mappedUser);
```
