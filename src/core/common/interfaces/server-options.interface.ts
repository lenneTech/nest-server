import { ApolloDriverConfig } from '@nestjs/apollo';
import { Type } from '@nestjs/common';
import { GqlModuleAsyncOptions } from '@nestjs/graphql';
import { JwtModuleOptions } from '@nestjs/jwt';
import { JwtSignOptions } from '@nestjs/jwt/dist/interfaces';
import { MongooseModuleOptions } from '@nestjs/mongoose';
import { ServeStaticOptions } from '@nestjs/platform-express/interfaces/serve-static-options.interface';
import { CronExpression } from '@nestjs/schedule';
import { MongoosePingCheckSettings } from '@nestjs/terminus/dist/health-indicator/database/mongoose.health';
import { DiskHealthIndicatorOptions } from '@nestjs/terminus/dist/health-indicator/disk/disk-health-options.type';
import compression from 'compression';
import { CollationOptions } from 'mongodb';
import * as SMTPTransport from 'nodemailer/lib/smtp-transport';

import { Falsy } from '../types/falsy.type';
import { CronJobConfigWithTimeZone } from './cron-job-config-with-time-zone.interface';
import { CronJobConfigWithUtcOffset } from './cron-job-config-with-utc-offset.interface';
import { MailjetOptions } from './mailjet-options.interface';

/**
 * Better-Auth field type definition
 * Matches the DBFieldType from better-auth
 */
export type BetterAuthFieldType = 'boolean' | 'date' | 'json' | 'number' | 'number[]' | 'string' | 'string[]';

/**
 * Interface for Auth configuration
 *
 * This configuration controls the authentication system behavior.
 * In v11.x, Legacy Auth (CoreAuthService) is the default.
 * In a future version, BetterAuth (IAM) will become the default.
 *
 * @since 11.7.1
 *
 * ## Migration Roadmap
 *
 * ### v11.x (Current)
 * - Legacy Auth is the default and required for GraphQL Subscriptions
 * - BetterAuth can be used alongside Legacy Auth
 * - Use `legacyEndpoints.enabled: false` after all users migrated to IAM
 *
 * ### Future Version (Planned)
 * - BetterAuth becomes the default
 * - Legacy Auth becomes optional (must be explicitly enabled)
 * - CoreModule.forRoot signature simplifies to `CoreModule.forRoot(options)`
 *
 * @see https://github.com/lenneTech/nest-server/blob/develop/.claude/rules/module-deprecation.md
 */
export interface IAuth {
  /**
   * Configuration for legacy auth endpoints
   *
   * Legacy endpoints include:
   * - GraphQL: signIn, signUp, signOut, refreshToken mutations
   * - REST: /api/auth/* endpoints
   *
   * These can be disabled once all users have migrated to BetterAuth (IAM).
   *
   * @example
   * ```typescript
   * auth: {
   *   legacyEndpoints: {
   *     enabled: false // Disable all legacy endpoints after migration
   *   }
   * }
   * ```
   */
  legacyEndpoints?: IAuthLegacyEndpoints;

  /**
   * Prevent user enumeration via unified error messages
   *
   * When enabled, authentication errors return a generic "Invalid credentials"
   * message instead of specific messages like "Unknown email" or "Wrong password".
   *
   * This prevents attackers from determining whether an email address exists
   * in the system, but reduces UX clarity for legitimate users.
   *
   * @since 11.7.x
   * @default false (backward compatible - specific error messages)
   *
   * @example
   * ```typescript
   * auth: {
   *   preventUserEnumeration: true // Returns "Invalid credentials" for all auth errors
   * }
   * ```
   */
  preventUserEnumeration?: boolean;

  /**
   * Rate limiting configuration for Legacy Auth endpoints
   *
   * Protects against brute-force attacks on signIn, signUp, and other
   * authentication endpoints.
   *
   * Follows the same pattern as `betterAuth.rateLimit`.
   *
   * @since 11.7.x
   * @default { enabled: false }
   *
   * @example
   * ```typescript
   * auth: {
   *   rateLimit: {
   *     enabled: true,
   *     max: 10,
   *     windowSeconds: 60,
   *     message: 'Too many login attempts, please try again later.',
   *   }
   * }
   * ```
   */
  rateLimit?: IAuthRateLimit;
}

/**
 * Interface for Legacy Auth endpoints configuration
 *
 * These endpoints are part of the Legacy Auth system (CoreAuthService).
 * In a future version, BetterAuth (IAM) will become the default and these endpoints
 * can be disabled once all users have migrated.
 *
 * @since 11.7.1
 * @see https://github.com/lenneTech/nest-server/blob/develop/.claude/rules/module-deprecation.md
 */
export interface IAuthLegacyEndpoints {
  /**
   * Whether legacy auth endpoints are enabled.
   *
   * Set to false to disable all legacy auth endpoints (GraphQL and REST).
   * Use this after all users have migrated to BetterAuth (IAM).
   *
   * Check migration status via the `betterAuthMigrationStatus` query.
   *
   * **Environment Variable:** `LEGACY_AUTH_ENABLED`
   *
   * @default true
   *
   * @example
   * ```typescript
   * // Via environment variable
   * enabled: process.env.LEGACY_AUTH_ENABLED !== 'false',
   * ```
   */
  enabled?: boolean;

  /**
   * Whether legacy GraphQL auth endpoints are enabled.
   * Affects: signIn, signUp, signOut, refreshToken mutations
   *
   * @default true (inherits from `enabled`)
   */
  graphql?: boolean;

  /**
   * Whether legacy REST auth endpoints are enabled.
   * Affects: /api/auth/sign-in, /api/auth/sign-up, etc.
   *
   * @default true (inherits from `enabled`)
   */
  rest?: boolean;
}

/**
 * Interface for Legacy Auth rate limiting configuration
 *
 * Same structure as IBetterAuthRateLimit for consistency.
 *
 * @since 11.7.x
 */
export interface IAuthRateLimit {
  /**
   * Whether rate limiting is enabled
   * @default false
   */
  enabled?: boolean;

  /**
   * Maximum number of requests within the time window
   * @default 10
   */
  max?: number;

  /**
   * Custom message when rate limit is exceeded
   * @default 'Too many requests, please try again later.'
   */
  message?: string;

  /**
   * Time window in seconds
   * @default 60
   */
  windowSeconds?: number;
}

/**
 * Better-Auth configuration type (Discriminated Union).
 *
 * This type enforces at compile-time that `trustedOrigins` is REQUIRED
 * when `passkey` is enabled. This prevents CORS errors at runtime.
 *
 * ## Why this constraint?
 * Passkey (WebAuthn) uses `credentials: 'include'` for API calls.
 * Browsers don't allow CORS wildcard `*` with credentials, so explicit
 * origins must be configured.
 *
 * ## Usage Examples
 *
 * ```typescript
 * // CORRECT: Passkey with trustedOrigins
 * const config: IBetterAuth = {
 *   passkey: true,
 *   trustedOrigins: ['http://localhost:3001'],
 * };
 *
 * // CORRECT: No Passkey, trustedOrigins optional
 * const config: IBetterAuth = {
 *   twoFactor: true,
 * };
 *
 * // TypeScript ERROR: trustedOrigins required when passkey is enabled
 * const config: IBetterAuth = {
 *   passkey: true,
 *   // Error: Property 'trustedOrigins' is missing
 * };
 * ```
 *
 * @see IBetterAuthWithPasskey - When Passkey is enabled
 * @see IBetterAuthWithoutPasskey - When Passkey is disabled
 */
export type IBetterAuth = IBetterAuthWithoutPasskey | IBetterAuthWithPasskey;

/**
 * Email verification configuration for Better-Auth
 *
 * Controls email verification behavior after sign-up.
 * When enabled, users receive a verification email and must verify
 * their email address before certain actions are allowed.
 *
 * **Enabled by Default:** Email verification is enabled by default.
 * Set `emailVerification: false` or `emailVerification: { enabled: false }` to disable.
 *
 * Accepts:
 * - `undefined`: Enabled with defaults (zero-config)
 * - `true` or `{}`: Enable with defaults (same as undefined)
 * - `{ locale: 'de', ... }`: Enable with custom settings
 * - `false` or `{ enabled: false }`: Explicitly disable
 *
 * @since 11.13.0
 *
 * @example
 * ```typescript
 * // Default: Email verification enabled
 * betterAuth: {}
 *
 * // Custom configuration
 * betterAuth: {
 *   emailVerification: {
 *     locale: 'de',
 *     autoSignInAfterVerification: true,
 *     expiresIn: 86400, // 24 hours in seconds
 *   }
 * }
 *
 * // Disable email verification
 * betterAuth: {
 *   emailVerification: false,
 * }
 * ```
 */
export interface IBetterAuthEmailVerificationConfig {
  /**
   * Whether to automatically sign in the user after email verification.
   * @default true
   */
  autoSignInAfterVerification?: boolean;

  /**
   * Brevo template ID for verification emails.
   * When set and Brevo is configured (config.brevo), verification emails
   * are sent via Brevo's transactional API instead of SMTP/EJS templates.
   *
   * Template variables passed to Brevo:
   * - `name`: User display name
   * - `link`: Verification URL
   * - `appName`: Application name
   * - `expiresIn`: Formatted expiration time
   *
   * @default undefined (uses SMTP/EJS templates)
   */
  brevoTemplateId?: number;

  /**
   * Frontend callback URL for email verification.
   *
   * When set, the verification link in the email will point to this URL
   * with the token as a query parameter (e.g., `{callbackURL}?token=xxx`).
   * The frontend page should then call the backend verify-email endpoint
   * to complete verification.
   *
   * Supports both absolute URLs and relative paths:
   * - Absolute: `https://example.com/auth/verify-email`
   * - Relative: `/auth/verify-email` (resolved against `appUrl`)
   *
   * When not set, the verification link points directly to the backend
   * endpoint which handles verification and redirects.
   *
   * @default undefined (backend-handled verification)
   * @since 11.13.0
   */
  callbackURL?: string;

  /**
   * Whether email verification is enabled.
   * @default true (enabled by default when BetterAuth is active)
   */
  enabled?: boolean;

  /**
   * Time in seconds until the verification link expires.
   * @default 86400 (24 hours)
   */
  expiresIn?: number;

  /**
   * Locale for the verification email template.
   * Used to select the correct language template.
   * @default 'en'
   */
  locale?: string;

  /**
   * Cooldown in seconds between resend requests for the same email address.
   * Prevents abuse by limiting how often verification emails can be resent.
   * Applied per email address in-memory.
   *
   * @default 60
   * @since 11.13.0
   */
  resendCooldownSeconds?: number;

  /**
   * Custom template name for the verification email.
   * The system looks for templates in this order:
   * 1. `<template>-<locale>.ejs` in project templates
   * 2. `<template>.ejs` in project templates
   * 3. `<template>-<locale>.ejs` in nest-server templates (fallback)
   * 4. `<template>.ejs` in nest-server templates (fallback)
   *
   * @default 'email-verification'
   */
  template?: string;
}

/**
 * JWT plugin configuration for Better-Auth
 *
 * **Enabled by Default:** JWT is enabled by default when BetterAuth is active.
 * This provides stateless authentication for API clients.
 * Set `jwt: false` or `jwt: { enabled: false }` to disable.
 */
export interface IBetterAuthJwtConfig {
  /**
   * Whether JWT plugin is enabled.
   * @default true (enabled by default when BetterAuth is active)
   */
  enabled?: boolean;

  /**
   * JWT expiration time
   * @default '15m'
   */
  expiresIn?: string;
}

/**
 * Passkey/WebAuthn plugin configuration for Better-Auth
 *
 * **Auto-Detection from baseUrl:** When `passkey: true` is set and `baseUrl` is configured,
 * the following values are auto-detected:
 * - `rpId`: Derived from baseUrl hostname (e.g., 'example.com')
 * - `origin`: Derived from baseUrl (e.g., 'https://api.example.com')
 * - `trustedOrigins`: Derived from baseUrl (e.g., ['https://api.example.com'])
 *
 * **Graceful Degradation:** If auto-detection fails and values are not explicitly set,
 * Passkey is automatically disabled with a warning. Other auth methods continue to work.
 *
 * @see https://www.better-auth.com/docs/plugins/passkey
 *
 * @example
 * ```typescript
 * // RECOMMENDED: Use auto-detection
 * betterAuth: {
 *   baseUrl: process.env.BASE_URL, // e.g., 'https://api.example.com'
 *   passkey: true, // Auto-detects rpId, origin, trustedOrigins
 * }
 *
 * // Explicit configuration (overrides auto-detection)
 * betterAuth: {
 *   passkey: {
 *     rpId: 'example.com',
 *     origin: 'https://app.example.com',
 *     rpName: 'My App',
 *   },
 *   trustedOrigins: ['https://app.example.com'],
 * }
 * ```
 */
export interface IBetterAuthPasskeyConfig {
  /**
   * Authenticator attachment preference.
   * - 'platform': Built-in authenticators (Touch ID, Face ID, Windows Hello)
   * - 'cross-platform': External authenticators (YubiKey, security keys)
   * - undefined: Allow both (default, platform preferred)
   * @default undefined (both allowed)
   */
  authenticatorAttachment?: 'cross-platform' | 'platform';

  /**
   * Where to store WebAuthn challenges.
   * - 'database': Store in MongoDB with TTL (default, works everywhere including cross-origin and JWT mode)
   * - 'cookie': Store in httpOnly cookie (requires session cookies and same-origin setup)
   *
   * Use 'cookie' only when:
   * - You want to avoid database writes for challenges
   * - You have a same-origin setup (frontend and API on same domain/port)
   * - You are NOT using JWT mode
   *
   * @default 'database'
   */
  challengeStorage?: 'cookie' | 'database';

  /**
   * TTL in seconds for database-stored challenges.
   * Only used when challengeStorage is 'database'.
   * @default 300 (5 minutes)
   */
  challengeTtlSeconds?: number;

  /**
   * Whether passkey authentication is enabled.
   * @default true (when config block is present)
   */
  enabled?: boolean;

  /**
   * Origin URL for WebAuthn.
   *
   * **Auto-detected** from `baseUrl` if not set (e.g., 'https://api.example.com').
   *
   * @example 'http://localhost:3000' or 'https://api.example.com'
   */
  origin?: string;

  /**
   * Resident key (discoverable credential) requirement.
   * - 'required': Must create discoverable credential
   * - 'preferred': Prefer discoverable, but allow non-discoverable (default)
   * - 'discouraged': Prefer non-discoverable credentials
   * @default 'preferred'
   */
  residentKey?: 'discouraged' | 'preferred' | 'required';

  /**
   * Relying Party ID (usually the domain without protocol).
   *
   * **Auto-detected** from `baseUrl` hostname if not set (e.g., 'example.com').
   *
   * @example 'localhost' or 'example.com'
   */
  rpId?: string;

  /**
   * Relying Party Name (displayed to users)
   * e.g. 'My Application'
   */
  rpName?: string;

  /**
   * User verification requirement.
   * - 'required': Always require biometric/PIN verification (most secure)
   * - 'preferred': Request verification if available (default)
   * - 'discouraged': Skip verification for faster auth (least secure)
   * @default 'preferred'
   */
  userVerification?: 'discouraged' | 'preferred' | 'required';

  /**
   * Custom cookie name for WebAuthn challenge storage.
   * Only used when challengeStorage is 'cookie'.
   * @default 'better-auth-passkey'
   */
  webAuthnChallengeCookie?: string;
}

/**
 * Interface for Better-Auth rate limiting configuration
 *
 * **Environment Variables:**
 * - `RATE_LIMIT_ENABLED` - Set to 'false' to disable
 * - `RATE_LIMIT_MAX` - Maximum requests per window
 * - `RATE_LIMIT_WINDOW_SECONDS` - Window duration
 *
 * @example
 * ```typescript
 * rateLimit: {
 *   enabled: process.env.RATE_LIMIT_ENABLED !== 'false',
 *   max: parseInt(process.env.RATE_LIMIT_MAX || '10', 10),
 * },
 * ```
 */
export interface IBetterAuthRateLimit {
  /**
   * Whether rate limiting is enabled
   * @default false
   */
  enabled?: boolean;

  /**
   * Maximum number of requests within the time window
   * @default 10
   */
  max?: number;

  /**
   * Maximum number of entries in the in-memory rate limit store.
   * When exceeded, the oldest entries are evicted to prevent unbounded memory growth.
   * @default 10000
   */
  maxEntries?: number;

  /**
   * Custom message when rate limit is exceeded
   * default: 'Too many requests, please try again later.'
   */
  message?: string;

  /**
   * Endpoints to skip rate limiting entirely
   * e.g., ['/iam/session'] for session checks
   */
  skipEndpoints?: string[];

  /**
   * Endpoints to apply stricter rate limiting (e.g., sign-in, sign-up)
   * These endpoints will have half the max requests
   */
  strictEndpoints?: string[];

  /**
   * Time window in seconds
   * default: 60 (1 minute)
   */
  windowSeconds?: number;
}

/**
 * Sign-up checks configuration for Better-Auth
 *
 * Controls which fields are required during sign-up.
 * This is useful for enforcing terms acceptance, age verification, etc.
 *
 * **Enabled by Default:** Sign-up checks are enabled by default with
 * `requiredFields: ['termsAndPrivacyAccepted']`.
 *
 * Accepts:
 * - `undefined`: Enabled with defaults (`termsAndPrivacyAccepted` required)
 * - `true` or `{}`: Enable with defaults (same as undefined)
 * - `{ requiredFields: [...] }`: Enable with custom required fields
 * - `false` or `{ enabled: false }`: Disable sign-up checks entirely
 *
 * @since 11.13.0
 *
 * @example
 * ```typescript
 * // Default: termsAndPrivacyAccepted is required
 * betterAuth: {}
 *
 * // Custom required fields
 * betterAuth: {
 *   signUpChecks: {
 *     requiredFields: ['termsAndPrivacyAccepted', 'ageConfirmed'],
 *   }
 * }
 *
 * // Disable sign-up checks (no fields required)
 * betterAuth: {
 *   signUpChecks: false,
 * }
 * ```
 */
export interface IBetterAuthSignUpChecksConfig {
  /**
   * Whether sign-up checks are enabled.
   * @default true (enabled by default when BetterAuth is active)
   */
  enabled?: boolean;

  /**
   * Fields that must be provided and truthy during sign-up.
   * If a required field is missing or falsy, sign-up will fail.
   *
   * @default ['termsAndPrivacyAccepted']
   *
   * @example ['termsAndPrivacyAccepted', 'ageConfirmed', 'newsletterOptIn']
   */
  requiredFields?: string[];
}

/**
 * Interface for better-auth social provider configuration
 *
 * **Enabled by default:** A social provider is automatically enabled when
 * both `clientId` and `clientSecret` are provided. You only need to set
 * `enabled: false` to explicitly disable a configured provider.
 *
 * **Environment Variables (convention):**
 * - `SOCIAL_GOOGLE_CLIENT_ID`, `SOCIAL_GOOGLE_CLIENT_SECRET`
 * - `SOCIAL_GITHUB_CLIENT_ID`, `SOCIAL_GITHUB_CLIENT_SECRET`
 * - `SOCIAL_APPLE_CLIENT_ID`, `SOCIAL_APPLE_CLIENT_SECRET`
 *
 * @example
 * ```typescript
 * // Via environment variables (recommended)
 * google: {
 *   clientId: process.env.SOCIAL_GOOGLE_CLIENT_ID || '',
 *   clientSecret: process.env.SOCIAL_GOOGLE_CLIENT_SECRET || '',
 * },
 *
 * // Provider is explicitly disabled despite having credentials
 * github: { clientId: '...', clientSecret: '...', enabled: false }
 * ```
 */
export interface IBetterAuthSocialProvider {
  /**
   * OAuth client ID
   */
  clientId: string;

  /**
   * OAuth client secret
   */
  clientSecret: string;

  /**
   * Whether this provider is enabled.
   * Defaults to true when clientId and clientSecret are provided.
   * Set to false to explicitly disable this provider.
   * @default true (when credentials are configured)
   */
  enabled?: boolean;
}

/**
 * Two-factor authentication plugin configuration for Better-Auth
 *
 * **Enabled by Default:** 2FA is enabled by default when BetterAuth is active.
 * Users can optionally set up 2FA for their accounts.
 * Set `twoFactor: false` or `twoFactor: { enabled: false }` to disable.
 *
 * **Environment Variables:**
 * - `TWO_FACTOR_APP_NAME` - App name shown in authenticator apps
 * - `TWO_FACTOR_ENABLED` - Set to 'true' to enable (default: true)
 */
export interface IBetterAuthTwoFactorConfig {
  /**
   * App name shown in authenticator apps.
   * This appears in Google Authenticator, Authy, etc.
   *
   * **Environment Variable:** `TWO_FACTOR_APP_NAME`
   *
   * @default 'Nest Server'
   * @example 'My Application'
   */
  appName?: string;

  /**
   * Whether 2FA is enabled.
   * @default true (enabled by default when BetterAuth is active)
   */
  enabled?: boolean;
}

/**
 * Interface for additional user fields in Better-Auth
 * @see https://www.better-auth.com/docs/concepts/users-accounts#additional-fields
 */
export interface IBetterAuthUserField {
  /**
   * Default value for the field
   */
  defaultValue?: unknown;

  /**
   * Database field name (if different from key)
   */
  fieldName?: string;

  /**
   * Whether this field is required
   */
  required?: boolean;

  /**
   * Field type
   */
  type: BetterAuthFieldType;
}

/**
 * Interface for Error Code module configuration
 *
 * Controls how the ErrorCodeModule is registered and configured.
 *
 * @since 11.9.0
 */
export interface IErrorCode {
  /**
   * Additional error registry to merge with core LTNS_* errors
   *
   * Use this to add project-specific error codes with a custom prefix.
   *
   * @example
   * ```typescript
   * const ProjectErrors = {
   *   ORDER_NOT_FOUND: {
   *     code: 'PROJ_0001',
   *     message: 'Order not found',
   *     translations: { de: 'Bestellung nicht gefunden.', en: 'Order not found.' }
   *   }
   * } as const satisfies IErrorRegistry;
   *
   * errorCode: {
   *   additionalErrorRegistry: ProjectErrors,
   * }
   * ```
   */
  additionalErrorRegistry?: Record<
    string,
    {
      code: string;
      message: string;
      translations: { [locale: string]: string; de: string; en: string };
    }
  >;

  /**
   * Automatically register the ErrorCodeModule in CoreModule
   *
   * Set to `false` to disable auto-registration and provide your own
   * ErrorCodeModule with custom controller and/or service.
   *
   * @default true
   *
   * @example
   * ```typescript
   * // In config.env.ts - disable auto-registration
   * errorCode: {
   *   autoRegister: false,
   * }
   *
   * // In server.module.ts - import your custom module
   * @Module({
   *   imports: [
   *     CoreModule.forRoot(...),
   *     ErrorCodeModule.forRoot(), // Your custom module
   *   ],
   * })
   * ```
   */
  autoRegister?: boolean;
}

/**
 * Interface for JWT configuration (main and refresh)
 */
export interface IJwt {
  /**
   * Private key
   */
  privateKey?: string;

  /**
   * Public key
   */
  publicKey?: string;

  /**
   * Secret to encrypt the JWT
   * Each secret should be unique and not reused in other environments,
   * also the JWT secret should be different from the Refresh secret!
   */
  secret?: string;

  /**
   * JWT Provider
   * See https://github.com/mikenicholson/passport-jwt/blob/master/README.md#configure-strategy
   */
  secretOrKeyProvider?: (
    request: Record<string, any>,
    rawJwtToken: string,
    done: (err: any, secret: string) => any,
  ) => any;

  /**
   * Alias of secret (for backwards compatibility)
   */
  secretOrPrivateKey?: string;

  /**
   * SignIn Options like expiresIn
   */
  signInOptions?: JwtSignOptions;
}

/**
 * Options for the server
 */
export interface IServerOptions {
  /**
   * Base URL of the frontend/app application.
   *
   * Used for:
   * - CORS `trustedOrigins` configuration
   * - Passkey/WebAuthn `origin` (where the browser runs)
   * - Frontend redirect URLs
   *
   * **Auto-Detection from `baseUrl`:**
   * If not set, `appUrl` is derived from `baseUrl`:
   * - `https://api.example.com` → `https://example.com` (removes 'api.' prefix)
   * - `https://example.com` → `https://example.com` (unchanged)
   *
   * **Localhost Environment Defaults:**
   * When `env` is 'local', 'ci', or 'e2e' and neither `baseUrl` nor `appUrl` is set:
   * - `appUrl` defaults to `http://localhost:3001`
   *
   * **Environment Variable:** `APP_URL` (only needed if not auto-derivable from `BASE_URL`)
   *
   * @example 'https://example.com' or 'http://localhost:3001'
   *
   * @example
   * ```typescript
   * // Typical production setup (appUrl auto-derived from baseUrl)
   * baseUrl: process.env.BASE_URL,  // e.g., 'https://api.example.com'
   * // → appUrl auto-derived: 'https://example.com'
   *
   * // Explicit appUrl (when frontend is on different domain)
   * appUrl: process.env.APP_URL,    // e.g., 'https://app.different-domain.com'
   *
   * // Local/CI/E2E (auto-defaults)
   * env: 'local', // or 'ci' or 'e2e'
   * // baseUrl defaults to 'http://localhost:3000'
   * // appUrl defaults to 'http://localhost:3001'
   * ```
   */
  appUrl?: string;

  /**
   * Authentication system configuration
   *
   * Controls Legacy Auth endpoints and behavior.
   * In a future version, this will also control BetterAuth as the default system.
   *
   * @since 11.7.1
   * @see IAuth
   */
  auth?: IAuth;

  /**
   * Automatically detect ObjectIds in string values in FilterQueries
   * and expand them as OR query with string and ObjectId.
   * Fields with the name "id" are renamed to "_id" and the value is converted to ObjectId,
   * without changing the filter into an OR combined filter.
   * See generateFilterQuery in Filter helper (src/core/common/helpers/filter.helper.ts)
   */
  automaticObjectIdFiltering?: boolean;

  /**
   * Base URL of the API server.
   *
   * Used for:
   * - Email links (password reset, verification)
   * - OAuth callback URLs
   * - Swagger/OpenAPI documentation
   * - BetterAuth configuration
   *
   * **Localhost Environment Defaults:**
   * When `env` is 'local', 'ci', or 'e2e' and `baseUrl` is not set:
   * - `baseUrl` defaults to `http://localhost:3000`
   *
   * **Relationship with `appUrl`:**
   * If `appUrl` is not set, it is auto-derived from `baseUrl`:
   * - `https://api.example.com` → `appUrl: https://example.com`
   * - `https://example.com` → `appUrl: https://example.com`
   *
   * **Environment Variable:** `BASE_URL`
   *
   * @example 'https://api.example.com' or 'http://localhost:3000'
   *
   * @example
   * ```typescript
   * // Production (via environment variable)
   * baseUrl: process.env.BASE_URL,
   *
   * // Local/CI/E2E (auto-defaults)
   * env: 'local', // or 'ci' or 'e2e'
   * // baseUrl defaults to 'http://localhost:3000'
   * ```
   */
  baseUrl?: string;

  /**
   * Configuration for better-auth authentication framework.
   * See: https://better-auth.com
   *
   * **Zero-Config Philosophy:** BetterAuth is enabled by default.
   * JWT, 2FA, and Passkey are also enabled by default when BetterAuth is active.
   *
   * **Passkey Auto-Activation:**
   * Passkey is automatically enabled when `baseUrl` (or `appUrl`) is configured.
   * If URLs are not set, Passkey is disabled with a warning (Graceful Degradation).
   *
   * Accepts:
   * - `undefined`: Enabled with defaults (zero-config)
   * - `true`: Enable with all defaults (same as undefined)
   * - `false`: Disable BetterAuth completely
   * - `{ ... }`: Enable with custom configuration
   * - `{ enabled: false }`: Disable BetterAuth completely
   *
   * | Configuration | BetterAuth | JWT | 2FA | Passkey |
   * |---------------|:----------:|:---:|:---:|:-------:|
   * | *not set* + no URLs | ✅ | ✅ | ✅ | ⚠️ disabled |
   * | *not set* + `baseUrl` set | ✅ | ✅ | ✅ | ✅ auto |
   * | `env: 'local'/'ci'/'e2e'` (auto URLs) | ✅ | ✅ | ✅ | ✅ auto |
   * | `false` | ❌ | ❌ | ❌ | ❌ |
   * | `{ passkey: false }` | ✅ | ✅ | ✅ | ❌ |
   * | `{ twoFactor: false }` | ✅ | ✅ | ❌ | ✅ auto |
   *
   * @default undefined (enabled with defaults)
   *
   * @example
   * ```typescript
   * // Zero-config for local/ci/e2e:
   * env: 'local', // or 'ci' or 'e2e'
   * // → baseUrl: 'http://localhost:3000' (auto)
   * // → appUrl: 'http://localhost:3001' (auto)
   * // → BetterAuth + JWT + 2FA + Passkey all enabled!
   *
   * // Production with auto-derived appUrl:
   * baseUrl: 'https://api.example.com',
   * // → appUrl: 'https://example.com' (auto-derived)
   * // → Passkey uses appUrl for origin/trustedOrigins
   *
   * // Disable Passkey explicitly (no warning):
   * betterAuth: { passkey: false },
   *
   * // Disable BetterAuth completely:
   * betterAuth: false,
   * ```
   */
  betterAuth?: boolean | IBetterAuth;

  /**
   * Configuration for Brevo
   * See: https://developers.brevo.com/
   */
  brevo?: {
    /**
     * API key for Brevo
     */
    apiKey: string;

    /**
     * Regular expression for excluding (test) users
     * e.g. /@testuser.com$/i
     */
    exclude?: RegExp;

    /**
     * Default sender for Brevo
     */
    sender: {
      email: string;
      name: string;
    };
  };

  /**
   * Whether to use the compression middleware package to enable gzip compression.
   * See: https://docs.nestjs.com/techniques/compression
   */
  compression?: boolean | compression.CompressionOptions;

  /**
   * Whether to use cookies for authentication handling
   * See: https://docs.nestjs.com/techniques/cookies
   */
  cookies?: boolean;

  /**
   * Cron jobs configuration object with the name of the cron job function as key
   * and the cron expression or config as value
   */
  cronJobs?: Record<
    string,
    CronExpression | CronJobConfigWithTimeZone | CronJobConfigWithUtcOffset | Date | Falsy | string
  >;

  /**
   * SMTP and template configuration for sending emails
   */
  email?: {
    /**
     * Data for default sender
     */
    defaultSender?: {
      /**
       * Default email for sending emails
       */
      email?: string;

      /**
       * Default name for sending emails
       */
      name?: string;
    };

    /**
     * Options for Mailjet
     */
    mailjet?: MailjetOptions;

    /**
     * Password reset link for email
     */
    passwordResetLink?: string;

    /**
     * SMTP configuration for nodemailer
     */
    smtp?: SMTPTransport | SMTPTransport.Options | string;

    /**
     * Verification link for email
     */
    verificationLink?: string;
  };

  /**
   * Environment
   * e.g. 'development'
   */
  env?: string;

  /**
   * Configuration for the error code module
   *
   * Controls how error codes and translations are handled.
   *
   * @since 11.9.0
   *
   * @example
   * ```typescript
   * // Default: auto-register with core errors only
   * errorCode: undefined
   *
   * // Add project-specific error codes
   * errorCode: {
   *   additionalErrorRegistry: ProjectErrors,
   * }
   *
   * // Disable auto-registration to provide your own module
   * errorCode: {
   *   autoRegister: false,
   * }
   * ```
   */
  errorCode?: IErrorCode;

  /**
   * Exec a command after server is initialized
   * e.g. 'npm run docs:bootstrap'
   */
  execAfterInit?: string;

  /**
   * Filter configuration and defaults
   */
  filter?: {
    /**
     * Maximum limit for the number of results
     */
    maxLimit?: number;
  };

  /**
   * Configuration of the GraphQL module
   * see https://docs.nestjs.com/graphql/quick-start
   * and https://www.apollographql.com/docs/apollo-server/api/apollo-server/
   */
  graphQl?: {
    /**
     * Driver configuration for Apollo
     */
    driver?: ApolloDriverConfig;

    /**
     * Subscription authentication
     */
    enableSubscriptionAuth?: boolean;

    /**
     * Maximum complexity of GraphQL requests
     */
    maxComplexity?: number;

    /**
     * Module options (forRootAsync)
     */
    options?: GqlModuleAsyncOptions;
  };

  /**
   * Whether to activate health check endpoints
   */
  healthCheck?: {
    /**
     * Configuration of single health checks
     */
    configs?: {
      /**
       * Configuration for database health check
       */
      database?: {
        /**
         * Whether to enable the database health check
         */
        enabled?: boolean;

        /**
         * Key in result JSON
         */
        key?: string;

        /**
         * Database health check options
         */
        options?: MongoosePingCheckSettings;
      };

      /**
       * Configuration for memory heap health check
       */
      memoryHeap?: {
        /**
         * Whether to enable the memory heap health check
         */
        enabled?: boolean;

        /**
         * Memory limit in bytes
         */
        heapUsedThreshold?: number;

        /**
         * Key in result JSON
         */
        key?: string;
      };

      /**
       * Configuration for memory resident set size health check
       */
      memoryRss?: {
        /**
         * Whether to enable the memory resident set size health check
         */
        enabled?: boolean;

        /**
         * Key in result JSON
         */
        key?: string;

        /**
         * Memory limit in bytes
         */
        rssThreshold?: number;
      };

      /**
       * Configuration for disk space health check
       */
      storage?: {
        /**
         * Whether to enable the disk space health check
         */
        enabled?: boolean;

        /**
         * Key in result JSON
         */
        key?: string;

        /**
         * Disk health indicator options
         */
        options?: DiskHealthIndicatorOptions;
      };
    };

    /**
     * Whether health check is enabled
     */
    enabled?: boolean;
  };

  /**
   * Hostname of the server
   * default: localhost
   */
  hostname?: string;

  /**
   * Ignore selections in fieldSelection
   * [ConfigService must be integrated in ModuleService]
   * If truly (default): select fields will be ignored and only populate fields in fieldSelection will be respected
   * If falsy: select and populate information in fieldSelection will be respected
   *
   * Hint: falsy may cause problems with CheckSecurityInterceptor
   * because the checks may miss fields that were not explicitly requested
   */
  ignoreSelectionsForPopulate?: boolean;

  /**
   * Configuration of JavaScript Web Token (JWT) module
   *
   * Hint: The secrets of the different environments should be different, otherwise a JWT can be used in different
   * environments, which can lead to security vulnerabilities.
   */
  jwt?: IJwt &
    JwtModuleOptions & {
      /**
       * Configuration for refresh Token (JWT)
       * Hint: The secret of the JWT and the Refresh Token should be different, otherwise a new RefreshToken can also be
       * requested with the JWT, which can lead to a security vulnerability.
       */
      refresh?: IJwt & {
        /**
         * Whether renewal of the refresh token is permitted
         * If falsy (default): during refresh only a new token, the refresh token retains its original term
         * If true: during refresh not only a new token but also a new refresh token is created
         */
        renewal?: boolean;
      };

      /**
       * Time period in milliseconds
       * in which the same token ID is used so that all parallel token refresh requests of a device can be generated.
       * default: 0 (every token includes a new token ID, all parallel token refresh requests must be prevented by the client or processed accordingly)
       */
      sameTokenIdPeriod?: number;
    };

  /**
   * Load local configuration
   * false: no local configuration is loaded,
   * true: it tries to load ./config.json or ../config.json,
   * string: path to configuration
   */
  loadLocalConfig?: boolean | string;

  /**
   * Log exceptions (for better debugging)
   */
  logExceptions?: boolean;

  /**
   * Configuration for Mongoose
   */
  mongoose?: {
    /**
     * Collation allows users to specify language-specific rules for string comparison,
     * such as rules for letter-case and accent marks.
     */
    collation?: CollationOptions;

    /**
     * Whether to create SVG-Diagrams of mongoose models
     * @beta
     */
    modelDocumentation?: boolean;

    /**
     * Mongoose module options
     */
    options?: MongooseModuleOptions;

    /**
     * Mongoose supports a separate strictQuery option to avoid strict mode for query filters.
     * This is because empty query filters cause Mongoose to return all documents in the model, which can cause issues.
     * See: https://github.com/Automattic/mongoose/issues/10763
     * and: https://mongoosejs.com/docs/guide.html#strictQuery
     * default: false
     */
    strictQuery?: boolean;

    /**
     * Mongoose connection string
     */
    uri: string;
  };

  /**
   * Port number of the server
   * e.g. 8080
   */
  port?: number;

  /**
   * Configuration for security pipes and interceptors
   */
  security?: {
    /**
     * Check restrictions for output (models and output objects)
     * See @lenne.tech/nest-server/src/core/common/interceptors/check-response.interceptor.ts
     */
    checkResponseInterceptor?:
      | boolean
      | {
          /**
           * Check the object itself for restrictions
           * (the class restriction is not only default for properties but object itself)
           * default = false (to act like Roles)
           */
          checkObjectItself?: boolean;

          /**
           * Whether to log if a restricted field is found or process is slow
           * boolean or number (time in ms)
           * default = false
           */
          debug?: boolean | number;

          /**
           * Whether to ignore fields with undefined values
           * default = true
           */
          ignoreUndefined?: boolean;

          /**
           * Merge roles of object and properties
           * default = true (to act like Roles)
           */
          mergeRoles?: boolean;

          /**
           * Whether objects that have already been checked should be ignored
           * Objects with truly property `_objectAlreadyCheckedForRestrictions` will be ignored
           * default = true
           */
          noteCheckedObjects?: boolean;

          /**
           * Remove undefined values from result array
           * default = true
           */
          removeUndefinedFromResultArray?: boolean;

          /**
           * Whether to throw an error if a restricted field is found
           * default = false (for output objects)
           */
          throwError?: boolean;
        };

    /**
     * Process securityCheck() methode of Object before response
     * See @lenne.tech/nest-server/src/core/common/interceptors/check-security.interceptor.ts
     * default = true
     */
    checkSecurityInterceptor?:
      | boolean
      | {
          /**
           * Whether to log if a process is slow
           * boolean or number (time in ms)
           * default = false
           */
          debug?: boolean | number;

          /**
           * Whether objects with truly property `_objectAlreadyCheckedForRestrictions` will be ignored
           * default = true
           */
          noteCheckedObjects?: boolean;
        };

    /**
     * Map incoming plain objects to meta-type and validate
     * See @lenne.tech/nest-server/src/core/common/pipes/map-and-validate.pipe.ts
     * default = true
     */
    mapAndValidatePipe?: boolean;
  };

  /**
   * Whether to enable verification and automatic encryption for received passwords that are not in sha256 format
   * default = false, sha256 format check: /^[a-f0-9]{64}$/i
   */
  sha256?: boolean;

  /**
   * Configuration for useStaticAssets
   */
  staticAssets?: {
    /**
     * Additional options for useStaticAssets
     * e.g. {prefix: '/public/'}
     */
    options?: ServeStaticOptions;

    /**
     * Root directory for static assets
     * e.g. join(__dirname, '..', 'public')
     */
    path?: string;
  };

  /**
   * Templates
   */
  templates?: {
    /**
     * View engine
     * e.g. 'ejs'
     */
    engine?: string;

    /**
     * Directory for templates
     *  e.g. join(__dirname, '..', 'templates')
     */
    path?: string;
  };

  /**
   * TUS resumable upload configuration.
   *
   * Follows the "Enabled by Default" pattern - tus is automatically enabled
   * without any configuration. Set `tus: false` to explicitly disable.
   *
   * Accepts:
   * - `true` or `undefined`: Enable with defaults (enabled by default)
   * - `false`: Disable TUS uploads
   * - `{ ... }`: Enable with custom configuration
   *
   * @example
   * ```typescript
   * // Default: TUS enabled with all defaults (no config needed)
   *
   * // Disable TUS
   * tus: false,
   *
   * // Custom configuration
   * tus: {
   *   maxSize: 100 * 1024 * 1024, // 100 MB
   *   path: '/uploads',
   * },
   * ```
   *
   * @since 11.8.0
   */
  tus?: boolean | ITusConfig;
}

/**
 * TUS Upload Configuration Interface
 *
 * Follows the "Enabled by Default" pattern - tus is automatically enabled
 * without any configuration. Set `tus: false` to explicitly disable.
 */
export interface ITusConfig {
  /**
   * Additional allowed HTTP headers for TUS requests (beyond @tus/server defaults).
   *
   * Note: @tus/server already includes all TUS protocol headers:
   * Authorization, Content-Type, Location, Tus-Extension, Tus-Max-Size,
   * Tus-Resumable, Tus-Version, Upload-Concat, Upload-Defer-Length,
   * Upload-Length, Upload-Metadata, Upload-Offset, X-HTTP-Method-Override,
   * X-Requested-With, X-Forwarded-Host, X-Forwarded-Proto, Forwarded
   *
   * Use this only for project-specific custom headers.
   *
   * @default [] (no additional headers needed)
   */
  allowedHeaders?: string[];

  /**
   * Allowed MIME types for uploads.
   * If undefined, all types are allowed.
   * @default undefined (all types allowed)
   */
  allowedTypes?: string[];

  /**
   * Checksum extension configuration.
   * Enables data integrity verification.
   * @default true
   */
  checksum?: boolean;

  /**
   * Concatenation extension configuration.
   * Allows parallel uploads that are merged.
   * @default true
   */
  concatenation?: boolean;

  /**
   * Creation extension configuration.
   * Allows creating new uploads via POST.
   * @default true
   */
  creation?: boolean | ITusCreationConfig;

  /**
   * Creation With Upload extension configuration.
   * Allows sending data in the initial POST request.
   * @default true
   */
  creationWithUpload?: boolean;

  /**
   * Whether tus uploads are enabled.
   * @default true (enabled by default)
   */
  enabled?: boolean;

  /**
   * Expiration extension configuration.
   * Automatically cleans up incomplete uploads.
   * @default { expiresIn: '24h' }
   */
  expiration?: boolean | ITusExpirationConfig;

  /**
   * Maximum upload size in bytes
   * @default 50 * 1024 * 1024 * 1024 (50 GB)
   */
  maxSize?: number;

  /**
   * Base path for tus endpoints
   * @default '/tus'
   */
  path?: string;

  /**
   * Termination extension configuration.
   * Allows deleting uploads via DELETE.
   * @default true
   */
  termination?: boolean;

  /**
   * Directory for temporary upload chunks.
   * @default 'uploads/tus'
   */
  uploadDir?: string;
}

/**
 * TUS Creation extension configuration
 */
export interface ITusCreationConfig {
  /**
   * Whether creation is enabled
   * @default true
   */
  enabled?: boolean;
}

/**
 * TUS Expiration extension configuration
 */
export interface ITusExpirationConfig {
  /**
   * Whether expiration is enabled
   * @default true
   */
  enabled?: boolean;

  /**
   * Time until incomplete uploads expire
   * Supports formats: '24h', '1d', '12h', etc.
   * @default '24h'
   */
  expiresIn?: string;
}

/**
 * Base interface for better-auth configuration (shared properties)
 * This contains all properties except passkey and trustedOrigins,
 * which are handled by the discriminated union types below.
 */
interface IBetterAuthBase {
  /**
   * Additional user fields beyond the core fields (firstName, lastName, etc.)
   * These fields will be merged with the default user fields.
   * @see https://www.better-auth.com/docs/concepts/users-accounts#additional-fields
   * @example
   * ```typescript
   * additionalUserFields: {
   *   phoneNumber: { type: 'string', defaultValue: null },
   *   department: { type: 'string', required: true },
   *   preferences: { type: 'string', defaultValue: '{}' },
   * }
   * ```
   */
  additionalUserFields?: Record<string, IBetterAuthUserField>;

  /**
   * Whether BetterAuthModule should be auto-registered in CoreModule.
   *
   * When false (default), projects integrate BetterAuth via an extended module
   * in their project (e.g., `src/server/modules/better-auth/better-auth.module.ts`).
   * This follows the same pattern as Legacy Auth and allows for custom resolvers,
   * controllers, and project-specific authentication logic.
   *
   * Set to true only for simple projects that don't need customization.
   *
   * @default false
   *
   * @example
   * ```typescript
   * // Recommended: Extend BetterAuthModule in your project
   * // src/server/modules/better-auth/better-auth.module.ts
   * import { BetterAuthModule as CoreBetterAuthModule } from '@lenne.tech/nest-server';
   *
   * @Module({})
   * export class BetterAuthModule {
   *   static forRoot(options) {
   *     return {
   *       imports: [CoreBetterAuthModule.forRoot(options)],
   *       // Add custom providers, controllers, etc.
   *     };
   *   }
   * }
   *
   * // Then import in ServerModule
   * import { BetterAuthModule } from './modules/better-auth/better-auth.module';
   * ```
   */
  autoRegister?: boolean;

  /**
   * Base path for better-auth endpoints
   * default: '/iam'
   */
  basePath?: string;

  /**
   * Base URL of the application
   * e.g. 'http://localhost:3000'
   */
  baseUrl?: string;

  /**
   * Custom controller class to use instead of the default CoreBetterAuthController.
   * The class should extend CoreBetterAuthController.
   *
   * This allows projects to customize REST endpoints via config instead of creating
   * a separate module. Use this with CoreModule.forRoot(envConfig) (IAM-only mode).
   *
   * @example
   * ```typescript
   * // config.env.ts
   * betterAuth: {
   *   controller: IamController,
   * }
   * ```
   *
   * @since 11.14.0
   */
  controller?: Type<any>;

  /**
   * Email/password authentication configuration.
   * Enabled by default.
   * Set `enabled: false` to explicitly disable email/password auth.
   */
  emailAndPassword?: {
    /**
     * Disable user registration (sign-up) via BetterAuth.
     * Passed through to better-auth's native emailAndPassword.disableSignUp.
     * Custom endpoints (GraphQL + REST) also check this flag early.
     * @default false
     */
    disableSignUp?: boolean;

    /**
     * Whether email/password authentication is enabled.
     * @default true
     */
    enabled?: boolean;
  };

  /**
   * Email verification configuration.
   *
   * **Enabled by Default:** Email verification is enabled by default.
   * Users receive a verification email after sign-up.
   *
   * Accepts:
   * - `undefined`: Enabled with defaults (zero-config)
   * - `true` or `{}`: Enable with defaults (same as undefined)
   * - `{ locale: 'de', ... }`: Enable with custom settings
   * - `false` or `{ enabled: false }`: Explicitly disable
   *
   * @default undefined (enabled by default)
   * @since 11.13.0
   *
   * @example
   * ```typescript
   * // Email verification enabled by default - no config needed
   *
   * // Custom configuration
   * betterAuth: {
   *   emailVerification: {
   *     locale: 'de',
   *     autoSignInAfterVerification: true,
   *   }
   * }
   *
   * // Disable email verification
   * betterAuth: { emailVerification: false }
   * ```
   */
  emailVerification?: boolean | IBetterAuthEmailVerificationConfig;

  /**
   * Whether better-auth is enabled.
   *
   * **Zero-Config Philosophy:** BetterAuth is enabled by default.
   * Set to `false` to explicitly disable it.
   *
   * @default true (enabled by default)
   */
  enabled?: boolean;

  /**
   * JWT plugin configuration for API clients.
   *
   * **Enabled by Default:** JWT is enabled by default when BetterAuth is active.
   * This provides stateless authentication for API clients.
   *
   * Accepts:
   * - `undefined`: Enabled with defaults (zero-config)
   * - `true` or `{}`: Enable with defaults (same as undefined)
   * - `{ expiresIn: '1h' }`: Enable with custom settings
   * - `false` or `{ enabled: false }`: Explicitly disable
   *
   * @default undefined (enabled by default)
   *
   * @example
   * ```typescript
   * // JWT enabled by default - no config needed
   *
   * // Customize JWT expiry
   * betterAuth: { jwt: { expiresIn: '1h' } },
   *
   * // Explicitly disable JWT (session-only mode)
   * betterAuth: { jwt: false },
   * ```
   */
  jwt?: boolean | IBetterAuthJwtConfig;

  /**
   * Advanced Better-Auth options passthrough.
   * These options are passed directly to Better-Auth, allowing full customization.
   * Use this for any Better-Auth options not explicitly defined in this interface.
   * @see https://www.better-auth.com/docs/reference/options
   * @example
   * ```typescript
   * options: {
   *   emailAndPassword: {
   *     enabled: true,
   *     requireEmailVerification: true,
   *     sendResetPassword: async ({ user, url }) => { ... },
   *   },
   *   account: {
   *     accountLinking: { enabled: true },
   *   },
   *   session: {
   *     expiresIn: 60 * 60 * 24 * 7, // 7 days
   *     updateAge: 60 * 60 * 24, // 1 day
   *   },
   *   advanced: {
   *     cookiePrefix: 'my-app',
   *     useSecureCookies: true,
   *   },
   * }
   * ```
   */
  options?: Record<string, unknown>;

  /**
   * Additional Better-Auth plugins to include.
   * These will be merged with the built-in plugins (jwt, twoFactor, passkey).
   * @see https://www.better-auth.com/docs/plugins
   * @example
   * ```typescript
   * import { organization } from 'better-auth/plugins';
   * import { magicLink } from 'better-auth/plugins';
   *
   * plugins: [
   *   organization({ ... }),
   *   magicLink({ ... }),
   * ]
   * ```
   */
  plugins?: unknown[];

  /**
   * Rate limiting configuration for Better-Auth endpoints
   * Protects against brute-force attacks
   */
  rateLimit?: IBetterAuthRateLimit;

  /**
   * Custom resolver class to use instead of the default DefaultBetterAuthResolver.
   * The class should extend CoreBetterAuthResolver.
   *
   * This allows projects to customize GraphQL operations via config instead of creating
   * a separate module. Use this with CoreModule.forRoot(envConfig) (IAM-only mode).
   *
   * @example
   * ```typescript
   * // config.env.ts
   * betterAuth: {
   *   resolver: IamResolver,
   * }
   * ```
   *
   * @since 11.14.0
   */
  resolver?: Type<any>;

  /**
   * Secret for better-auth session cookie signing.
   *
   * **Used for:**
   * - Session cookie integrity (HMAC-SHA256 signature)
   * - Cookie encryption (when using JWE strategy)
   *
   * **NOT used for:**
   * - JWT signing (JWT plugin generates asymmetric keys stored in `jwks` collection)
   * - Refresh tokens (Better-Auth uses DB sessions, not refresh JWTs)
   *
   * **REQUIRED for Production!** Without a persistent secret:
   * - Session cookies become invalid on server restart
   * - Sessions cannot be shared across cluster instances
   *
   * **Note:** Unlike Legacy Auth, Better-Auth sessions are stored in the database.
   * The secret only signs the session cookie, not the session itself.
   *
   * **Minimum:** 32 characters
   *
   * **Fallback Chain (nest-server implementation):**
   * 1. `betterAuth.secret` (if set)
   * 2. `jwt.secret` (if ≥32 chars, for backwards compatibility)
   * 3. `jwt.refresh.secret` (if ≥32 chars, for backwards compatibility)
   * 4. Auto-generated (with warning, not persistent!)
   *
   * **Environment Variable:** `BETTER_AUTH_SECRET`
   *
   * **Generate a secure secret:**
   * ```bash
   * node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
   * ```
   *
   * @example
   * ```typescript
   * // Via environment variable (recommended)
   * secret: process.env.BETTER_AUTH_SECRET,
   *
   * // Or direct value (not recommended for production)
   * secret: 'your-32-character-minimum-secret-here',
   * ```
   */
  secret?: string;

  /**
   * Sign-up checks configuration.
   *
   * **Enabled by Default:** Sign-up checks are enabled by default with
   * `requiredFields: ['termsAndPrivacyAccepted']`.
   *
   * Accepts:
   * - `undefined`: Enabled with defaults (termsAndPrivacyAccepted required)
   * - `true` or `{}`: Enable with defaults (same as undefined)
   * - `{ requiredFields: [...] }`: Enable with custom required fields
   * - `false` or `{ enabled: false }`: Disable sign-up checks entirely
   *
   * @default undefined (enabled by default)
   * @since 11.13.0
   *
   * @example
   * ```typescript
   * // Default: termsAndPrivacyAccepted is required during sign-up
   *
   * // Custom required fields
   * betterAuth: {
   *   signUpChecks: {
   *     requiredFields: ['termsAndPrivacyAccepted', 'ageConfirmed'],
   *   }
   * }
   *
   * // Disable sign-up checks (no fields required)
   * betterAuth: { signUpChecks: false }
   * ```
   */
  signUpChecks?: boolean | IBetterAuthSignUpChecksConfig;

  /**
   * Social login providers configuration
   * Supports all Better-Auth providers dynamically (google, github, apple, discord, etc.)
   *
   * **Enabled by default:** Providers are automatically enabled when credentials
   * are configured. Set `enabled: false` to explicitly disable a provider.
   *
   * @see https://www.better-auth.com/docs/authentication/social-sign-in
   * @example
   * ```typescript
   * socialProviders: {
   *   // These providers are enabled (no need for enabled: true)
   *   google: { clientId: '...', clientSecret: '...' },
   *   github: { clientId: '...', clientSecret: '...' },
   *   // This provider is explicitly disabled
   *   discord: { clientId: '...', clientSecret: '...', enabled: false },
   * }
   * ```
   */
  socialProviders?: Record<string, IBetterAuthSocialProvider>;

  /**
   * Two-factor authentication configuration.
   *
   * **Enabled by Default:** 2FA is enabled by default when BetterAuth is active.
   * Users can optionally set up 2FA for their accounts.
   *
   * Accepts:
   * - `undefined`: Enabled with defaults (zero-config)
   * - `true` or `{}`: Enable with defaults (same as undefined)
   * - `{ appName: 'My App' }`: Enable with custom settings
   * - `false` or `{ enabled: false }`: Explicitly disable
   *
   * @default undefined (enabled by default)
   *
   * @example
   * ```typescript
   * // 2FA enabled by default - no config needed
   *
   * twoFactor: { appName: 'My App' }, // Customize app name in authenticator
   * twoFactor: false,    // Explicitly disable 2FA
   * ```
   */
  twoFactor?: boolean | IBetterAuthTwoFactorConfig;
}

/**
 * Passkey configuration that is considered "disabled".
 * This includes:
 * - `false` (boolean shorthand)
 * - `{ enabled: false, ...otherProps }` (explicit disabled, can include other props)
 * - `undefined` (not configured = disabled by default)
 *
 * ## TypeScript Type Narrowing Note
 *
 * When using `enabled: false` in an object literal, TypeScript may infer the type
 * as `boolean` instead of the literal `false`. To ensure proper type narrowing,
 * use `as const` assertion:
 *
 * ```typescript
 * // MAY NOT TYPE-CHECK CORRECTLY (TypeScript infers boolean)
 * const config: IBetterAuth = {
 *   passkey: { enabled: false },
 * };
 *
 * // CORRECT: Use 'as const' for literal type
 * const config: IBetterAuth = {
 *   passkey: { enabled: false as const },
 * };
 *
 * // ALTERNATIVE: Use boolean shorthand (recommended)
 * const config: IBetterAuth = {
 *   passkey: false,
 * };
 * ```
 */
type IBetterAuthPasskeyDisabled = false | (Omit<IBetterAuthPasskeyConfig, 'enabled'> & { enabled: false }) | undefined;

/**
 * Passkey configuration that is considered "enabled".
 * This includes:
 * - `true` (boolean shorthand)
 * - `{}` (empty object = defaults)
 * - `{ enabled: true, ... }` (explicit enabled)
 * - `{ rpName: 'My App', ... }` (config without explicit enabled = defaults to true)
 */
type IBetterAuthPasskeyEnabled = (Omit<IBetterAuthPasskeyConfig, 'enabled'> & { enabled?: true }) | true;

/**
 * BetterAuth configuration WITHOUT Passkey (or Passkey disabled).
 * When Passkey is disabled, trustedOrigins is optional.
 * If not set, all origins are allowed (CORS `*`).
 *
 * @example
 * ```typescript
 * // Without Passkey: trustedOrigins optional
 * betterAuth: {
 *   twoFactor: true,
 *   // trustedOrigins is optional here
 * }
 *
 * // Explicitly disabled Passkey
 * betterAuth: {
 *   passkey: false,
 *   trustedOrigins: ['https://app.example.com'], // Still optional
 * }
 * ```
 */
interface IBetterAuthWithoutPasskey extends IBetterAuthBase {
  /**
   * Passkey/WebAuthn configuration (DISABLED or not configured).
   */
  passkey?: IBetterAuthPasskeyDisabled;

  /**
   * Trusted origins for CORS configuration.
   *
   * Optional when Passkey is disabled.
   * If not set, all origins are allowed (CORS `*`).
   *
   * @example
   * ```typescript
   * // Restrict origins even without Passkey
   * trustedOrigins: ['https://app.example.com'],
   *
   * // Or leave undefined for open CORS
   * ```
   */
  trustedOrigins?: string[];
}

/**
 * BetterAuth configuration WITH Passkey enabled.
 * When Passkey is enabled, trustedOrigins is REQUIRED because:
 * - Passkey uses `credentials: 'include'` for WebAuthn API calls
 * - Browsers don't allow CORS wildcard `*` with credentials
 * - Explicit origins must be configured for CORS to work
 *
 * @example
 * ```typescript
 * // CORRECT: Passkey with trustedOrigins
 * betterAuth: {
 *   passkey: true,
 *   trustedOrigins: ['http://localhost:3000', 'http://localhost:3001'],
 * }
 *
 * // TypeScript ERROR: trustedOrigins missing
 * betterAuth: {
 *   passkey: true,
 *   // Missing trustedOrigins!
 * }
 * ```
 */
interface IBetterAuthWithPasskey extends IBetterAuthBase {
  /**
   * Passkey/WebAuthn configuration (ENABLED).
   * @see IBetterAuthPasskeyConfig
   */
  passkey: IBetterAuthPasskeyEnabled;

  /**
   * Trusted origins for CORS configuration.
   *
   * **REQUIRED when Passkey is enabled!**
   * Passkey uses `credentials: 'include'` which requires explicit CORS origins.
   * Browsers don't allow wildcard `*` with credentials.
   *
   * @example
   * ```typescript
   * // Development
   * trustedOrigins: ['http://localhost:3000', 'http://localhost:3001'],
   *
   * // Production
   * trustedOrigins: process.env.TRUSTED_ORIGINS?.split(',') || [],
   * ```
   */
  trustedOrigins: string[];
}
