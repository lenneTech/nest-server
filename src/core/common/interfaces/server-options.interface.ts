import { ApolloDriverConfig } from '@nestjs/apollo';
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
   * @default true
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
 * Interface for better-auth configuration
 */
export interface IBetterAuth {
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
   * Email/password authentication configuration.
   * Enabled by default.
   * Set `enabled: false` to explicitly disable email/password auth.
   */
  emailAndPassword?: {
    /**
     * Whether email/password authentication is enabled.
     * @default true
     */
    enabled?: boolean;
  };

  /**
   * Whether better-auth is enabled.
   * BetterAuth is enabled by default (zero-config philosophy).
   * Set to false to explicitly disable it.
   * @default true
   */
  enabled?: boolean;

  /**
   * JWT plugin configuration for API clients.
   *
   * **Default: Enabled** - JWT is enabled by default when BetterAuth is enabled.
   * This ensures a minimal config (`betterAuth: true`) provides full functionality.
   *
   * Accepts:
   * - `true` or `{}`: Enable with defaults (same as not specifying)
   * - `{ expiresIn: '1h' }`: Enable with custom settings
   * - `false` or `{ enabled: false }`: Explicitly disable
   * - `undefined`: Enabled with defaults (JWT is on by default)
   *
   * @example
   * ```typescript
   * // JWT is enabled by default, no config needed
   * betterAuth: true,
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
   * Passkey/WebAuthn configuration.
   *
   * Accepts:
   * - `true` or `{}`: Enable with defaults
   * - `{ rpName: 'My App' }`: Enable with custom settings
   * - `false` or `{ enabled: false }`: Disable
   * - `undefined`: Disabled (default)
   *
   * @example
   * ```typescript
   * passkey: true,       // Enable with defaults
   * passkey: {},         // Enable with defaults
   * passkey: { rpName: 'My App', rpId: 'example.com' }, // Enable with custom settings
   * passkey: false,      // Disable
   * ```
   */
  passkey?: boolean | IBetterAuthPasskeyConfig;

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
   * Secret for better-auth (min 32 characters)
   * Used for session encryption
   */
  secret?: string;

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
   * Trusted origins for CORS and OAuth callbacks
   * If not specified, defaults to [baseUrl]
   * e.g. ['https://example.com', 'https://app.example.com']
   */
  trustedOrigins?: string[];

  /**
   * Two-factor authentication configuration.
   *
   * Accepts:
   * - `true` or `{}`: Enable with defaults
   * - `{ appName: 'My App' }`: Enable with custom settings
   * - `false` or `{ enabled: false }`: Disable
   * - `undefined`: Disabled (default)
   *
   * @example
   * ```typescript
   * twoFactor: true,     // Enable with defaults
   * twoFactor: {},       // Enable with defaults
   * twoFactor: { appName: 'My App' }, // Enable with custom app name
   * twoFactor: false,    // Disable
   * ```
   */
  twoFactor?: boolean | IBetterAuthTwoFactorConfig;
}

/**
 * JWT plugin configuration for Better-Auth
 */
export interface IBetterAuthJwtConfig {
  /**
   * Whether JWT plugin is enabled.
   * @default true (when config block is present)
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
 */
export interface IBetterAuthPasskeyConfig {
  /**
   * Whether passkey authentication is enabled.
   * @default true (when config block is present)
   */
  enabled?: boolean;

  /**
   * Origin URL for WebAuthn
   * e.g. 'http://localhost:3000'
   */
  origin?: string;

  /**
   * Relying Party ID (usually the domain)
   * e.g. 'localhost' or 'example.com'
   */
  rpId?: string;

  /**
   * Relying Party Name (displayed to users)
   * e.g. 'My Application'
   */
  rpName?: string;
}

/**
 * Interface for Better-Auth rate limiting configuration
 */
export interface IBetterAuthRateLimit {
  /**
   * Whether rate limiting is enabled
   * default: false
   */
  enabled?: boolean;

  /**
   * Maximum number of requests within the time window
   * default: 10
   */
  max?: number;

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
 * Interface for better-auth social provider configuration
 *
 * **Enabled by default:** A social provider is automatically enabled when
 * both `clientId` and `clientSecret` are provided. You only need to set
 * `enabled: false` to explicitly disable a configured provider.
 *
 * @example
 * ```typescript
 * // Provider is enabled (has credentials, no explicit enabled flag needed)
 * google: { clientId: '...', clientSecret: '...' }
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
 */
export interface IBetterAuthTwoFactorConfig {
  /**
   * App name shown in authenticator apps
   * e.g. 'My Application'
   */
  appName?: string;

  /**
   * Whether 2FA is enabled.
   * @default true (when config block is present)
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
   * Configuration for better-auth authentication framework.
   * See: https://better-auth.com
   *
   * Accepts:
   * - `true`: Enable with all defaults (including JWT)
   * - `false`: Disable BetterAuth completely
   * - `{ ... }`: Enable with custom configuration
   * - `undefined`: Disabled (default for backward compatibility)
   *
   * @example
   * ```typescript
   * betterAuth: true,  // Enable with defaults (JWT enabled)
   * betterAuth: { baseUrl: 'https://example.com' },  // Custom config
   * betterAuth: false, // Explicitly disabled
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
