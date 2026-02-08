# BetterAuth Customization Guide

This guide describes how to customize the BetterAuth module in projects using `@lenne.tech/nest-server`.

Use this guide when a project needs custom authentication behavior, modified endpoints, or custom email templates.

---

## Table of Contents

- [Module Registration Patterns](#module-registration-patterns)
- [Customizing Controller](#customizing-controller)
- [Customizing Resolver](#customizing-resolver)
- [Customizing Services](#customizing-services)
- [Email Template Customization](#email-template-customization)
- [Pattern Selection Guide](#pattern-selection-guide)

---

## Module Registration Patterns

There are **three ways** to register BetterAuth in a project. Choose based on your customization needs.

### Pattern 1: Zero-Config (Default)

**Use when:** No customization needed, using default Controller/Resolver.

```typescript
// server.module.ts
@Module({
  imports: [
    CoreModule.forRoot(envConfig), // Auto-imports CoreBetterAuthModule
  ],
})
export class ServerModule {}
```

**What happens:**

- CoreModule automatically imports `CoreBetterAuthModule.forRoot()` with defaults
- Default `CoreBetterAuthController` and `DefaultBetterAuthResolver` are registered
- No additional configuration needed

### Pattern 2: Config-based Controller/Resolver (Recommended for Customization)

**Use when:** Need custom Controller or Resolver, but don't need a separate module.

```typescript
// config.env.ts
import { IamController } from './server/modules/iam/iam.controller';
import { IamResolver } from './server/modules/iam/iam.resolver';

const config = {
  betterAuth: {
    controller: IamController, // Custom controller class
    resolver: IamResolver, // Custom resolver class
    // ... other betterAuth config
  },
};
```

```typescript
// server.module.ts
@Module({
  imports: [
    CoreModule.forRoot(envConfig), // Uses custom controller/resolver from config
  ],
})
export class ServerModule {}
```

**What happens:**

- CoreModule passes `controller`/`resolver` to `CoreBetterAuthModule.forRoot()`
- Your custom classes are registered instead of defaults
- Single registration point, no duplicate imports

### Pattern 3: Separate Module (autoRegister: false)

**Use when:** Need full control, complex module with additional providers, or multiple custom services.

```typescript
// config.env.ts
const config = {
  betterAuth: {
    autoRegister: false, // CoreModule won't auto-import CoreBetterAuthModule
    // ... other betterAuth config
  },
};
```

```typescript
// iam.module.ts
@Module({})
export class IamModule {
  static forRoot(): DynamicModule {
    return {
      exports: [CoreBetterAuthModule],
      imports: [
        CoreBetterAuthModule.forRoot({
          controller: IamController,
          resolver: IamResolver,
          config: envConfig.betterAuth,
          fallbackSecrets: [envConfig.jwt?.secret],
        }),
      ],
      module: IamModule,
      providers: [
        // Additional custom providers
        MyCustomAuthService,
      ],
    };
  }
}
```

```typescript
// server.module.ts
@Module({
  imports: [
    CoreModule.forRoot(envConfig), // Does NOT import CoreBetterAuthModule
    IamModule.forRoot(), // Your module is the single registration point
  ],
})
export class ServerModule {}
```

**What happens:**

- CoreModule skips auto-import of CoreBetterAuthModule
- Your IamModule is the only place CoreBetterAuthModule.forRoot() is called
- Full control over module configuration and additional providers

---

## Customizing Controller

### When to Customize

- Add custom REST endpoints (e.g., `/iam/custom-verify`)
- Modify response format
- Add logging, analytics, or audit trails
- Integrate with external services after sign-up/sign-in

### How to Customize

**Create:** `src/server/modules/iam/iam.controller.ts`

```typescript
import { Controller } from '@nestjs/common';
import { CoreBetterAuthController } from '@lenne.tech/nest-server';

@Controller('iam')
export class IamController extends CoreBetterAuthController {
  /**
   * Override sign-up to add custom logic
   */
  override async signUp(res: Response, input: BetterAuthSignUpInput) {
    // Custom pre-processing
    const result = await super.signUp(res, input);
    // Custom post-processing (e.g., send welcome email, analytics)
    await this.sendWelcomeNotification(result.user);
    return result;
  }

  /**
   * Add completely new endpoint
   */
  @Post('custom-endpoint')
  @Roles(RoleEnum.S_USER)
  async customEndpoint(@Body() input: CustomInput) {
    // Custom logic
  }
}
```

### Important Notes

- Always extend `CoreBetterAuthController`
- Use `@Controller('iam')` to maintain the same route prefix
- Call `super.method()` when overriding to preserve core functionality
- Add `@Roles()` decorators to new endpoints for security

---

## Customizing Resolver

### When to Customize

- Add custom GraphQL mutations/queries
- Modify response format for GraphQL
- Add field resolvers
- Integrate with external services

### How to Customize (CRITICAL!)

**Create:** `src/server/modules/iam/iam.resolver.ts`

```typescript
import { Mutation, Query, Resolver } from '@nestjs/graphql';
import { BetterAuthAuthModel, CoreBetterAuthResolver, RoleEnum, Roles } from '@lenne.tech/nest-server';

@Resolver(() => BetterAuthAuthModel)
export class IamResolver extends CoreBetterAuthResolver {
  /**
   * CRITICAL: Re-declare ALL decorators when overriding!
   * GraphQL schema is built from decorators - parent's @Mutation/@Query are NOT inherited.
   */
  @Mutation(() => BetterAuthAuthModel, { description: 'Sign up via email' })
  @Roles(RoleEnum.S_EVERYONE)
  override async betterAuthSignUp(/* ... */) {
    // Custom pre-processing
    const result = await super.betterAuthSignUp(/* ... */);
    // Custom post-processing
    return result;
  }

  /**
   * Add new GraphQL mutation
   */
  @Mutation(() => Boolean, { description: 'Custom verification' })
  @Roles(RoleEnum.S_USER)
  async customVerification(@CurrentUser() user: User) {
    // Custom logic
    return true;
  }
}
```

### CRITICAL: Decorator Re-declaration

**WHY must ALL decorators be re-declared?**

GraphQL schema is built from decorators at **compile time**. The parent class (`CoreBetterAuthResolver`) is marked as `isAbstract: true`, so its methods are **not** registered in the schema. You MUST re-declare `@Query`, `@Mutation`, `@Roles` decorators in the child class for the methods to appear in the GraphQL schema.

```typescript
// WRONG: Missing decorators - method won't appear in GraphQL schema!
override async betterAuthSignUp(/* ... */) {
  return super.betterAuthSignUp(/* ... */);
}

// CORRECT: All decorators re-declared
@Mutation(() => BetterAuthAuthModel)
@Roles(RoleEnum.S_EVERYONE)
override async betterAuthSignUp(/* ... */) {
  return super.betterAuthSignUp(/* ... */);
}
```

---

## Customizing Services

### CoreBetterAuthService

The main service handling Better-Auth operations. Extend when you need to:

- Modify token generation
- Add custom session handling
- Integrate with external auth providers

```typescript
import { Injectable } from '@nestjs/common';
import { CoreBetterAuthService } from '@lenne.tech/nest-server';

@Injectable()
export class CustomBetterAuthService extends CoreBetterAuthService {
  // Custom methods or overrides
}
```

### CoreBetterAuthEmailVerificationService

Handles email verification. Extend when you need to:

- Customize verification email content
- Change verification flow
- Add custom logging/analytics

```typescript
import { Injectable } from '@nestjs/common';
import { CoreBetterAuthEmailVerificationService } from '@lenne.tech/nest-server';

@Injectable()
export class CustomEmailVerificationService extends CoreBetterAuthEmailVerificationService {
  override async sendVerificationEmail(options: SendVerificationEmailOptions): Promise<void> {
    // Custom logic before
    await super.sendVerificationEmail(options);
    // Custom logic after (e.g., analytics)
  }
}
```

### CoreBetterAuthUserMapper

Handles user mapping between BetterAuth and nest-server User model. Extend when you need to:

- Sync additional fields
- Custom user creation logic
- Integration with external user systems

---

## Email Template Customization

### Template Resolution Order

Email templates are resolved in this order:

1. `<template>-<locale>.ejs` in **project templates directory**
2. `<template>.ejs` in **project templates directory**
3. `<template>-<locale>.ejs` in **nest-server templates** (fallback)
4. `<template>.ejs` in **nest-server templates** (fallback)

### Available Templates

| Template             | Purpose                             | Default Locales |
| -------------------- | ----------------------------------- | --------------- |
| `email-verification` | Email verification after sign-up    | `en`, `de`      |
| `password-reset`     | Password reset email                | `en`            |
| `welcome`            | Welcome email (not used by default) | `en`            |

### How to Override Templates

**Step 1:** Create templates directory in your project

```bash
mkdir -p src/templates
```

**Step 2:** Copy and modify the template

```bash
# Copy from nest-server (or create new)
cp node_modules/@lenne.tech/nest-server/src/templates/email-verification-en.ejs src/templates/
```

**Step 3:** Configure templates path (if not default)

```typescript
// config.env.ts
const config = {
  templates: {
    path: path.join(__dirname, 'templates'),
  },
};
```

### Template Variables

Available variables in email templates:

| Variable    | Type   | Description                                       |
| ----------- | ------ | ------------------------------------------------- |
| `name`      | string | User's name or email prefix                       |
| `link`      | string | Verification/reset URL                            |
| `appName`   | string | Application name from package.json                |
| `expiresIn` | string | Human-readable expiration time (e.g., "24 hours") |

### Example Template

```html
<!-- src/templates/email-verification-en.ejs -->
<!DOCTYPE html>
<html>
  <head>
    <title>Verify your email - <%= appName %></title>
  </head>
  <body>
    <h1>Hello <%= name %>,</h1>
    <p>Please verify your email address by clicking the link below:</p>
    <p><a href="<%= link %>">Verify Email</a></p>
    <p>This link expires in <%= expiresIn %>.</p>
    <p>Best regards,<br />The <%= appName %> Team</p>
  </body>
</html>
```

### Using Brevo Templates

For production, you can use Brevo (formerly Sendinblue) transactional templates:

```typescript
// config.env.ts
const config = {
  betterAuth: {
    emailVerification: {
      brevoTemplateId: 123, // Your Brevo template ID
      locale: 'de',
    },
  },
  brevo: {
    apiKey: process.env.BREVO_API_KEY,
  },
};
```

**Brevo template parameters:**

- `name` - User's name
- `link` - Verification URL
- `appName` - Application name
- `expiresIn` - Expiration time string

### Email Verification Configuration

```typescript
// config.env.ts
const config = {
  betterAuth: {
    emailVerification: {
      enabled: true, // Default: true
      locale: 'de', // Default: 'en'
      template: 'email-verification', // Default: 'email-verification'
      expiresIn: 86400, // Default: 86400 (24 hours)
      callbackURL: '/auth/verify-email', // Frontend verification page
      autoSignInAfterVerification: true, // Default: true
      resendCooldownSeconds: 60, // Default: 60
    },
  },
};
```

---

## Pattern Selection Guide

| Requirement                               | Recommended Pattern        |
| ----------------------------------------- | -------------------------- |
| No customization needed                   | Pattern 1: Zero-Config     |
| Custom Controller only                    | Pattern 2: Config-based    |
| Custom Resolver only                      | Pattern 2: Config-based    |
| Custom Controller + Resolver              | Pattern 2: Config-based    |
| Additional providers/services             | Pattern 3: Separate Module |
| Complex module with multiple exports      | Pattern 3: Separate Module |
| Need to avoid duplicate forRoot() warning | Pattern 2 or Pattern 3     |

### Avoiding the "forRoot() called twice" Warning

If you see this warning:

```
CoreBetterAuthModule.forRoot() was called more than once.
```

**Solutions:**

1. **Config-based (Pattern 2):** Move `controller`/`resolver` to `config.betterAuth`
2. **autoRegister: false (Pattern 3):** Set `betterAuth.autoRegister: false` in config

**Why this happens:** CoreModule auto-imports `CoreBetterAuthModule.forRoot()` in IAM-only mode. If your project also calls `forRoot()` (e.g., in IamModule), it's called twice. NestJS silently ignores the second call, but your custom Controller/Resolver may not be registered.

---

## Reference Implementation

All customization examples exist as working code in the package:

**Local:**

```
node_modules/@lenne.tech/nest-server/src/server/modules/better-auth/
```

**GitHub:**
https://github.com/lenneTech/nest-server/tree/develop/src/server/modules/better-auth

---

## RolesGuard Selection (Internal)

The BetterAuth module uses different RolesGuard implementations depending on your configuration. **This is handled automatically - you don't need to do anything.**

### Which Guard is Used?

| Mode                                           | Guard Used             | Registered By          |
| ---------------------------------------------- | ---------------------- | ---------------------- |
| **Legacy Mode** (3-param CoreModule.forRoot)   | `RolesGuard`           | `CoreAuthModule`       |
| **IAM-Only Mode** (1-param CoreModule.forRoot) | `BetterAuthRolesGuard` | `CoreBetterAuthModule` |

```typescript
// Legacy Mode → RolesGuard (extends Passport AuthGuard)
CoreModule.forRoot(CoreAuthService, AuthModule.forRoot(jwt), envConfig);

// IAM-Only Mode → BetterAuthRolesGuard (no Passport dependency)
CoreModule.forRoot(envConfig);
```

### Why Two Guards?

**RolesGuard** (Legacy + Hybrid Mode):

- Extends `AuthGuard(AuthGuardStrategy.JWT)` from Passport
- Supports both Legacy JWT and BetterAuth tokens
- Requires `CoreAuthModule` to register the JWT strategy

**BetterAuthRolesGuard** (IAM-Only Mode):

- Does NOT extend AuthGuard (no Passport dependency)
- Uses BetterAuth exclusively for token verification
- Avoids DI issues that occur with Passport AuthGuard mixin in certain module configurations

### Technical Background

The `AuthGuard()` from `@nestjs/passport` is a **mixin** (a factory that returns a class). This mixin generates its own TypeScript `design:paramtypes` metadata, which can conflict with the child class's constructor parameters in certain NestJS DI contexts (specifically when registered as `APP_GUARD` in a dynamic module with `autoRegister: false`).

`BetterAuthRolesGuard` avoids this by:

1. Not extending any mixin
2. Having no constructor dependencies (uses `Reflect.getMetadata` directly instead of NestJS Reflector)
3. Accessing services via static module references

### What You Need to Know

**Nothing changes for you as a developer:**

- Use `@Roles()` decorator as always
- The correct guard is selected automatically
- Both guards process `@Roles()` identically
- Security behavior is identical

---

## Related Documentation

- [README.md](./README.md) - Full BetterAuth documentation
- [INTEGRATION-CHECKLIST.md](./INTEGRATION-CHECKLIST.md) - Quick integration steps
- [Module Inheritance Pattern](../../../.claude/rules/module-inheritance.md) - Core architectural pattern