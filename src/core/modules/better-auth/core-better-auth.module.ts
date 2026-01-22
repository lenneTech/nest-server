import {
  DynamicModule,
  Global,
  Logger,
  MiddlewareConsumer,
  Module,
  NestModule,
  OnModuleInit,
  Optional,
  Type,
} from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { getConnectionToken } from '@nestjs/mongoose';
import mongoose, { Connection } from 'mongoose';

import { IBetterAuth } from '../../common/interfaces/server-options.interface';
import { ConfigService } from '../../common/services/config.service';
import { RolesGuard } from '../auth/guards/roles.guard';
import { BetterAuthTokenService } from './better-auth-token.service';
import { BetterAuthInstance, createBetterAuthInstance } from './better-auth.config';
import { DefaultBetterAuthResolver } from './better-auth.resolver';
import { CoreBetterAuthApiMiddleware } from './core-better-auth-api.middleware';
import { CoreBetterAuthChallengeService } from './core-better-auth-challenge.service';
import { CoreBetterAuthRateLimitMiddleware } from './core-better-auth-rate-limit.middleware';
import { CoreBetterAuthRateLimiter } from './core-better-auth-rate-limiter.service';
import { CoreBetterAuthUserMapper } from './core-better-auth-user.mapper';
import { CoreBetterAuthController } from './core-better-auth.controller';
import { CoreBetterAuthMiddleware } from './core-better-auth.middleware';
import { CoreBetterAuthResolver } from './core-better-auth.resolver';
import { BETTER_AUTH_CONFIG, CoreBetterAuthService } from './core-better-auth.service';

/**
 * Token for injecting the better-auth instance
 */
export const BETTER_AUTH_INSTANCE = 'BETTER_AUTH_INSTANCE';

/**
 * Options for CoreBetterAuthModule.forRoot()
 */
export interface CoreBetterAuthModuleOptions {
  /**
   * Better-auth configuration (optional - auto-read from ConfigService).
   * Accepts:
   * - `true`: Enable with all defaults (including JWT)
   * - `false`: Disable BetterAuth
   * - `{ ... }`: Enable with custom configuration
   * - `undefined`: Auto-read from ConfigService (Zero-Config)
   */
  config?: boolean | IBetterAuth;

  /**
   * Custom controller class to use instead of the default CoreBetterAuthController.
   * The class must extend CoreBetterAuthController.
   *
   * @example
   * ```typescript
   * // Your custom controller
   * @Controller('iam')
   * export class MyBetterAuthController extends CoreBetterAuthController {
   *   override async signUp(res: Response, input: BetterAuthSignUpInput) {
   *     const result = await super.signUp(res, input);
   *     await this.emailService.sendWelcomeEmail(result.user?.email);
   *     return result;
   *   }
   * }
   *
   * // In your module
   * CoreBetterAuthModule.forRoot({
   *   config: environment.betterAuth,
   *   controller: MyBetterAuthController,
   * })
   * ```
   */
  controller?: Type<CoreBetterAuthController>;

  /**
   * Fallback secrets to try if no betterAuth.secret is configured.
   * The array is iterated and the first valid secret (≥32 chars) is used.
   *
   * @example
   * ```typescript
   * fallbackSecrets: [config.jwt?.secret, config.jwt?.refresh?.secret]
   * ```
   */
  fallbackSecrets?: (string | undefined)[];

  /**
   * Register RolesGuard as a global guard.
   *
   * This should be set to `true` for IAM-only setups (CoreModule.forRoot with 1 parameter)
   * where CoreAuthModule is not imported (which normally registers RolesGuard globally).
   *
   * When `true`, all `@Roles()` decorators will be enforced automatically without
   * needing explicit `@UseGuards(RolesGuard)` on each endpoint.
   *
   * @default false
   */
  registerRolesGuardGlobally?: boolean;

  /**
   * Custom resolver class to use instead of the default DefaultBetterAuthResolver.
   * The class must extend CoreBetterAuthResolver.
   *
   * @example
   * ```typescript
   * // Your custom resolver
   * @Resolver(() => BetterAuthAuthModel)
   * export class MyDefaultBetterAuthResolver extends CoreBetterAuthResolver {
   *   override async betterAuthSignUp(...) {
   *     const result = await super.betterAuthSignUp(...);
   *     await this.sendWelcomeEmail(result.user);
   *     return result;
   *   }
   * }
   *
   * // In your module
   * CoreBetterAuthModule.forRoot({
   *   config: environment.betterAuth,
   *   resolver: MyDefaultBetterAuthResolver,
   * })
   * ```
   */
  resolver?: Type<CoreBetterAuthResolver>;

  /**
   * Server-level app/frontend URL (from IServerOptions.appUrl).
   * This is the frontend application URL where the browser runs.
   *
   * Used for:
   * - CORS trustedOrigins
   * - Passkey/WebAuthn origin
   *
   * Auto-Detection:
   * - If not set, derived from `serverBaseUrl`:
   *   - 'https://api.example.com' → 'https://example.com'
   *   - 'https://example.com' → 'https://example.com'
   * - When `serverEnv: 'local'` and not set: defaults to 'http://localhost:3001'
   *
   * @example 'https://example.com'
   */
  serverAppUrl?: string;

  /**
   * Server-level base URL (from IServerOptions.baseUrl).
   * This is the API server URL.
   *
   * Used for:
   * - Email links (password reset, verification)
   * - OAuth callback URLs
   * - As fallback for betterAuth.baseUrl
   *
   * Auto-Detection:
   * - When `serverEnv: 'local'` and not set: defaults to 'http://localhost:3000'
   *
   * @example 'https://api.example.com'
   */
  serverBaseUrl?: string;

  /**
   * Server environment (from IServerOptions.env).
   * Used for local environment defaults:
   * - When `env: 'local'` and no URLs are set:
   *   - `serverBaseUrl` defaults to 'http://localhost:3000'
   *   - `serverAppUrl` defaults to 'http://localhost:3001'
   */
  serverEnv?: string;
}

/**
 * Normalizes betterAuth config from boolean | IBetterAuth to IBetterAuth | null
 * - `true` → `{}` (enabled with defaults)
 * - `false` → `null` (disabled)
 * - `undefined` → `{}` (enabled by default - zero-config)
 * - `{ enabled: false }` → `null` (disabled)
 * - `{ ... }` → `{ ... }` (pass through)
 */
function normalizeBetterAuthConfig(config: boolean | IBetterAuth | undefined): IBetterAuth | null {
  // BetterAuth is enabled by default (zero-config)
  if (config === undefined || config === null) return {};
  if (config === true) return {};
  if (config === false) return null;
  // Check for explicit { enabled: false }
  if (typeof config === 'object' && config.enabled === false) return null;
  return config;
}

/**
 * CoreBetterAuthModule provides integration with the better-auth authentication framework.
 *
 * This module:
 * - Creates and configures a better-auth instance based on server configuration
 * - Provides REST controller (CoreBetterAuthController) and GraphQL resolver (CoreBetterAuthResolver)
 * - Supports JWT, 2FA, Passkey, and Social Login based on configuration
 * - Enabled by default (zero-config) - set `enabled: false` to disable explicitly
 * - Uses the global mongoose connection for MongoDB access
 *
 * @example
 * ```typescript
 * // In your AppModule - import after CoreModule so mongoose is connected
 * @Module({
 *   imports: [
 *     CoreModule.forRoot(...),
 *     CoreBetterAuthModule.forRoot({ config: environment.betterAuth }),
 *   ],
 * })
 * export class AppModule {}
 * ```
 */
@Global()
@Module({})
export class CoreBetterAuthModule implements NestModule, OnModuleInit {
  private static logger = new Logger(CoreBetterAuthModule.name);
  private static authInstance: BetterAuthInstance | null = null;
  private static initialized = false;
  private static initLogged = false;
  private static betterAuthEnabled = false;
  private static currentConfig: IBetterAuth | null = null;
  private static customController: null | Type<CoreBetterAuthController> = null;
  private static customResolver: null | Type<CoreBetterAuthResolver> = null;
  private static shouldRegisterRolesGuardGlobally = false;

  /**
   * Gets the controller class to use (custom or default)
   */
  private static getControllerClass(): Type<CoreBetterAuthController> {
    return this.customController || CoreBetterAuthController;
  }

  /**
   * Gets the resolver class to use (custom or default)
   */
  private static getResolverClass(): Type<CoreBetterAuthResolver> {
    return this.customResolver || DefaultBetterAuthResolver;
  }

  constructor(
    @Optional() private readonly betterAuthService?: CoreBetterAuthService,
    @Optional() private readonly rateLimiter?: CoreBetterAuthRateLimiter,
  ) {}

  onModuleInit() {
    if (CoreBetterAuthModule.authInstance && !CoreBetterAuthModule.initialized) {
      CoreBetterAuthModule.initialized = true;
      CoreBetterAuthModule.logger.log('CoreBetterAuthModule ready');
    }

    // Configure rate limiter with stored config
    if (this.rateLimiter && CoreBetterAuthModule.currentConfig?.rateLimit) {
      this.rateLimiter.configure(CoreBetterAuthModule.currentConfig.rateLimit);
    }
  }

  /**
   * Configure middleware for Better-Auth API handling, session validation, and rate limiting.
   *
   * Middleware order (important!):
   * 1. CoreBetterAuthApiMiddleware - Forwards plugin endpoints (passkey, etc.) to Better Auth's native handler
   * 2. CoreBetterAuthRateLimitMiddleware - Rate limiting for auth endpoints
   * 3. CoreBetterAuthMiddleware - Session validation and user mapping for all routes
   */
  configure(consumer: MiddlewareConsumer) {
    // Only apply middleware if Better-Auth is enabled
    if (CoreBetterAuthModule.betterAuthEnabled && this.betterAuthService?.isEnabled()) {
      const basePath = CoreBetterAuthModule.currentConfig?.basePath || '/iam';

      // Apply API middleware to Better-Auth endpoints FIRST
      // This handles plugin endpoints (passkey, social login, etc.) that are not defined in the controller
      consumer.apply(CoreBetterAuthApiMiddleware).forRoutes(`${basePath}/*path`);
      CoreBetterAuthModule.logger.debug(`CoreBetterAuthApiMiddleware registered for ${basePath}/*path endpoints`);

      // Apply rate limiting to Better-Auth endpoints only
      if (CoreBetterAuthModule.currentConfig?.rateLimit?.enabled) {
        consumer.apply(CoreBetterAuthRateLimitMiddleware).forRoutes(`${basePath}/*path`);
        CoreBetterAuthModule.logger.debug(`Rate limiting middleware registered for ${basePath}/*path endpoints`);
      }

      // Apply session middleware to all routes
      consumer.apply(CoreBetterAuthMiddleware).forRoutes('(.*)'); // New path-to-regexp syntax for wildcard
      CoreBetterAuthModule.logger.debug('CoreBetterAuthMiddleware registered for all routes');
    }
  }

  /**
   * Waits for mongoose connection to be ready using polling
   * This is more reliable than event-based waiting in test environments
   * @throws Error if connection times out or fails
   */
  private static async waitForMongoConnection(): Promise<void> {
    const maxAttempts = 60; // 60 attempts * 500ms = 30 seconds max
    const pollInterval = 500;

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      // Check if already connected
      if (mongoose.connection.readyState === 1 && mongoose.connection.db) {
        return;
      }

      // Check for error state
      if (mongoose.connection.readyState === 0) {
        // Disconnected - wait for reconnection
        this.logger.debug(`MongoDB not connected (attempt ${attempt + 1}/${maxAttempts})`);
      }

      // Wait before next check
      await new Promise((resolve) => setTimeout(resolve, pollInterval));
    }

    throw new Error('MongoDB connection timeout - ensure MongoDB is running and accessible');
  }

  /**
   * Creates a dynamic module for BetterAuth (synchronous)
   * Note: This requires mongoose connection to be already established.
   * For async initialization, use forRootAsync.
   *
   * @param options - Configuration options
   * @returns Dynamic module configuration
   */
  static forRoot(options: CoreBetterAuthModuleOptions): DynamicModule {
    const {
      config: rawConfig,
      controller,
      fallbackSecrets,
      registerRolesGuardGlobally,
      resolver,
      serverAppUrl,
      serverBaseUrl,
      serverEnv,
    } = options;

    // Auto-read from global ConfigService if not explicitly provided
    // This allows projects to use BetterAuthModule.forRoot({}) for true Zero-Config
    // as all values are already available from CoreModule.forRoot(envConfig)
    const globalConfig = ConfigService.configFastButReadOnly;

    // Auto-detect config from ConfigService if not explicitly provided
    const effectiveRawConfig = rawConfig ?? globalConfig?.betterAuth;

    // Auto-detect fallbackSecrets from ConfigService if not explicitly provided
    const effectiveFallbackSecrets = fallbackSecrets ?? (
      globalConfig?.jwt
        ? [globalConfig.jwt.secret, globalConfig.jwt.refresh?.secret].filter(Boolean)
        : undefined
    );

    // Auto-detect server URLs from ConfigService if not explicitly provided
    const effectiveServerAppUrl = serverAppUrl ?? globalConfig?.appUrl;
    const effectiveServerBaseUrl = serverBaseUrl ?? globalConfig?.baseUrl;
    const effectiveServerEnv = serverEnv ?? globalConfig?.env;

    // Normalize config: true → {}, false/undefined → null
    const config = normalizeBetterAuthConfig(effectiveRawConfig);

    // Store config for middleware configuration
    this.currentConfig = config;
    // Store custom controller if provided
    this.customController = controller || null;
    // Store custom resolver if provided
    this.customResolver = resolver || null;
    // Store whether to register RolesGuard globally (for IAM-only setups)
    this.shouldRegisterRolesGuardGlobally = registerRolesGuardGlobally ?? false;

    // If better-auth is disabled (config is null or enabled: false), return minimal module
    // Note: We don't provide middleware classes when disabled because they depend on CoreBetterAuthService
    // and won't be used anyway (middleware is only applied when enabled)
    if (config === null || config?.enabled === false) {
      this.logger.debug('BetterAuth is disabled - skipping initialization');
      this.betterAuthEnabled = false;
      return {
        exports: [BETTER_AUTH_INSTANCE, CoreBetterAuthService, CoreBetterAuthUserMapper, CoreBetterAuthRateLimiter, BetterAuthTokenService, CoreBetterAuthChallengeService],
        module: CoreBetterAuthModule,
        providers: [
          {
            provide: BETTER_AUTH_INSTANCE,
            useValue: null,
          },
          // Note: ConfigService is provided globally by CoreModule
          // Tests need to provide their own ConfigService
          CoreBetterAuthService,
          CoreBetterAuthUserMapper,
          CoreBetterAuthRateLimiter,
          BetterAuthTokenService,
          CoreBetterAuthChallengeService,
        ],
      };
    }

    // Enable middleware registration
    this.betterAuthEnabled = true;

    // Note: Secret validation is now handled in createBetterAuthInstance
    // with fallback to jwt.secret, jwt.refresh.secret, or auto-generation

    // Always use deferred initialization to ensure MongoDB is ready
    // This prevents timing issues during application startup
    // Pass server-level URLs for Passkey auto-detection (using effective values from ConfigService fallback)
    return this.createDeferredModule(config, effectiveFallbackSecrets, {
      serverAppUrl: effectiveServerAppUrl,
      serverBaseUrl: effectiveServerBaseUrl,
      serverEnv: effectiveServerEnv,
    });
  }

  /**
   * Creates an async dynamic module for BetterAuth
   * This is the preferred method as it properly waits for mongoose connection.
   *
   * @returns Dynamic module configuration
   */
  static forRootAsync(): DynamicModule {
    return {
      controllers: [this.getControllerClass()],
      exports: [BETTER_AUTH_INSTANCE, CoreBetterAuthService, CoreBetterAuthUserMapper, CoreBetterAuthRateLimiter, BetterAuthTokenService, CoreBetterAuthChallengeService],
      imports: [],
      module: CoreBetterAuthModule,
      providers: [
        {
          inject: [ConfigService],
          provide: BETTER_AUTH_INSTANCE,
          useFactory: async (configService: ConfigService) => {
            // Get raw config (can be boolean or object)
            const rawConfig = configService.get<boolean | IBetterAuth>('betterAuth');
            // Normalize: true → {}, false/undefined → null
            const config = normalizeBetterAuthConfig(rawConfig);

            // BetterAuth is disabled if config is null or enabled: false
            if (config === null || config?.enabled === false) {
              this.logger.debug('BetterAuth is disabled');
              this.betterAuthEnabled = false;
              this.currentConfig = config;
              return null;
            }

            // Enable middleware registration
            this.betterAuthEnabled = true;

            await this.waitForMongoConnection();

            const db = mongoose.connection.db;
            if (!db) {
              throw new Error('MongoDB database not available');
            }

            // Get JWT secrets from config for backwards compatibility fallback
            const jwtConfig = configService.get<{ refresh?: { secret?: string }; secret?: string }>('jwt');
            const fallbackSecrets = [jwtConfig?.secret, jwtConfig?.refresh?.secret];

            // Note: Secret validation is now handled in createBetterAuthInstance
            // with fallback to jwt.secret, jwt.refresh.secret, or auto-generation
            this.authInstance = createBetterAuthInstance({ config, db, fallbackSecrets });

            // IMPORTANT: Store the config AFTER createBetterAuthInstance mutates it
            // This ensures CoreBetterAuthService has access to the resolved secret (with fallback applied)
            this.currentConfig = config;

            if (this.authInstance) {
              this.logger.log('BetterAuth initialized successfully');
              this.logEnabledFeatures(config);
            }

            return this.authInstance;
          },
        },
        // Provide the resolved config for CoreBetterAuthService
        {
          provide: BETTER_AUTH_CONFIG,
          useFactory: () => this.currentConfig,
        },
        // CoreBetterAuthService needs to be a factory that explicitly depends on BETTER_AUTH_INSTANCE
        // to ensure proper initialization order
        {
          inject: [BETTER_AUTH_INSTANCE, BETTER_AUTH_CONFIG, getConnectionToken()],
          provide: CoreBetterAuthService,
          useFactory: (
            authInstance: BetterAuthInstance | null,
            resolvedConfig: IBetterAuth | null,
            connection: Connection,
          ) => {
            return new CoreBetterAuthService(authInstance, connection, resolvedConfig);
          },
        },
        CoreBetterAuthUserMapper,
        CoreBetterAuthMiddleware,
        CoreBetterAuthApiMiddleware,
        CoreBetterAuthRateLimiter,
        CoreBetterAuthRateLimitMiddleware,
        // BetterAuthTokenService needs explicit factory to ensure proper dependency injection
        {
          inject: [CoreBetterAuthService, getConnectionToken()],
          provide: BetterAuthTokenService,
          useFactory: (betterAuthService: CoreBetterAuthService, connection: Connection) => {
            return new BetterAuthTokenService(betterAuthService, connection);
          },
        },
        CoreBetterAuthChallengeService,
        this.getResolverClass(),
      ],
    };
  }

  /**
   * Gets the current better-auth instance
   * Useful for accessing the auth API directly
   */
  static getInstance(): BetterAuthInstance | null {
    return this.authInstance;
  }

  /**
   * Resets the static state of CoreBetterAuthModule
   * This is primarily useful for testing to ensure clean state between tests
   *
   * @example
   * ```typescript
   * afterEach(() => {
   *   CoreBetterAuthModule.reset();
   * });
   * ```
   */
  static reset(): void {
    this.authInstance = null;
    this.initialized = false;
    this.initLogged = false;
    this.betterAuthEnabled = false;
    this.currentConfig = null;
    this.customController = null;
    this.customResolver = null;
    this.shouldRegisterRolesGuardGlobally = false;
  }

  /**
   * Creates a deferred initialization module that waits for mongoose connection
   * By injecting the Connection token, NestJS ensures Mongoose is ready first
   *
   * @param config - BetterAuth configuration
   * @param fallbackSecrets - Fallback secrets for backwards compatibility
   * @param serverUrls - Server-level URLs for Passkey auto-detection
   */
  private static createDeferredModule(
    config: IBetterAuth,
    fallbackSecrets?: (string | undefined)[],
    serverUrls?: { serverAppUrl?: string; serverBaseUrl?: string; serverEnv?: string },
  ): DynamicModule {
    return {
      controllers: [this.getControllerClass()],
      exports: [BETTER_AUTH_INSTANCE, CoreBetterAuthService, CoreBetterAuthUserMapper, CoreBetterAuthRateLimiter, BetterAuthTokenService, CoreBetterAuthChallengeService],
      module: CoreBetterAuthModule,
      providers: [
        {
          // Inject Mongoose Connection to ensure NestJS waits for it to be ready
          inject: [getConnectionToken()],
          provide: BETTER_AUTH_INSTANCE,
          useFactory: async (connection: Connection) => {
            // Connection is now guaranteed to be established
            const db = connection.db;
            if (!db) {
              // Fallback to global mongoose if connection.db is not yet available
              await this.waitForMongoConnection();
              const globalDb = mongoose.connection.db;
              if (!globalDb) {
                throw new Error('MongoDB database not available');
              }
              this.authInstance = createBetterAuthInstance({
                config,
                db: globalDb,
                fallbackSecrets,
                serverAppUrl: serverUrls?.serverAppUrl,
                serverBaseUrl: serverUrls?.serverBaseUrl,
                serverEnv: serverUrls?.serverEnv,
              });
            } else {
              this.authInstance = createBetterAuthInstance({
                config,
                db,
                fallbackSecrets,
                serverAppUrl: serverUrls?.serverAppUrl,
                serverBaseUrl: serverUrls?.serverBaseUrl,
                serverEnv: serverUrls?.serverEnv,
              });
            }

            // IMPORTANT: Store the config AFTER createBetterAuthInstance mutates it
            // This ensures CoreBetterAuthService has access to the resolved secret (with fallback applied)
            this.currentConfig = config;

            if (this.authInstance && !this.initLogged) {
              this.initLogged = true;
              this.logger.log('BetterAuth initialized');
              this.logEnabledFeatures(config);
            }

            return this.authInstance;
          },
        },
        // Provide the resolved config for CoreBetterAuthService
        {
          provide: BETTER_AUTH_CONFIG,
          useFactory: () => this.currentConfig,
        },
        // CoreBetterAuthService needs to be a factory that explicitly depends on BETTER_AUTH_INSTANCE
        // to ensure proper initialization order
        {
          inject: [BETTER_AUTH_INSTANCE, BETTER_AUTH_CONFIG, getConnectionToken()],
          provide: CoreBetterAuthService,
          useFactory: (
            authInstance: BetterAuthInstance | null,
            resolvedConfig: IBetterAuth | null,
            connection: Connection,
          ) => {
            return new CoreBetterAuthService(authInstance, connection, resolvedConfig);
          },
        },
        CoreBetterAuthUserMapper,
        CoreBetterAuthMiddleware,
        CoreBetterAuthApiMiddleware,
        CoreBetterAuthRateLimiter,
        CoreBetterAuthRateLimitMiddleware,
        // BetterAuthTokenService needs explicit factory to ensure proper dependency injection
        {
          inject: [CoreBetterAuthService, getConnectionToken()],
          provide: BetterAuthTokenService,
          useFactory: (betterAuthService: CoreBetterAuthService, connection: Connection) => {
            return new BetterAuthTokenService(betterAuthService, connection);
          },
        },
        CoreBetterAuthChallengeService,
        this.getResolverClass(),
        // Conditionally register RolesGuard globally for IAM-only setups
        // In Legacy mode, RolesGuard is already registered globally via CoreAuthModule
        ...(this.shouldRegisterRolesGuardGlobally
          ? [
              {
                provide: APP_GUARD,
                useClass: RolesGuard,
              },
            ]
          : []),
      ],
    };
  }

  /**
   * Logs which features are enabled.
   * Features are enabled by default when their config block is present,
   * unless explicitly disabled with enabled: false.
   */
  private static logEnabledFeatures(config: IBetterAuth): void {
    const features: string[] = [];

    // Helper to check if a plugin is explicitly disabled
    const isExplicitlyDisabled = <T extends { enabled?: boolean }>(value: boolean | T | undefined): boolean => {
      if (value === false) return true;
      if (typeof value === 'object' && value?.enabled === false) return true;
      return false;
    };

    // JWT and 2FA are enabled by default unless explicitly disabled
    if (!isExplicitlyDisabled(config.jwt)) {
      features.push('JWT');
    }
    if (!isExplicitlyDisabled(config.twoFactor)) {
      features.push('2FA/TOTP');
    }
    // Passkey is enabled by default, unless explicitly set to false
    if (config.passkey !== false && !(typeof config.passkey === 'object' && config.passkey?.enabled === false)) {
      const passkeyConfig = typeof config.passkey === 'object' ? config.passkey : null;
      // Challenge storage is 'database' by default, can be overridden via config
      const challengeStorage = passkeyConfig?.challengeStorage || 'database';
      features.push(`Passkey/WebAuthn (challenges: ${challengeStorage})`);
    }

    // Dynamically collect enabled social providers
    // Providers are enabled by default if they have credentials configured
    // Only disabled when explicitly set to enabled: false
    const socialProviders: string[] = [];
    if (config.socialProviders) {
      for (const [name, provider] of Object.entries(config.socialProviders)) {
        if (provider?.clientId && provider?.clientSecret && provider?.enabled !== false) {
          // Capitalize first letter for display
          socialProviders.push(name.charAt(0).toUpperCase() + name.slice(1));
        }
      }
    }

    if (socialProviders.length > 0) {
      features.push(`Social Login (${socialProviders.join(', ')})`);
    }

    // Rate limiting still requires explicit enabled: true
    if (config.rateLimit?.enabled) {
      features.push(`Rate Limiting (${config.rateLimit.max || 10}/${config.rateLimit.windowSeconds || 60}s)`);
    }

    if (features.length > 0) {
      this.logger.log(`Enabled features: ${features.join(', ')}`);
    }
  }
}
