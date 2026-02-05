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
import { BrevoService } from '../../common/services/brevo.service';
import { ConfigService } from '../../common/services/config.service';
import { RolesGuardRegistry } from '../auth/guards/roles-guard-registry';
import { RolesGuard } from '../auth/guards/roles.guard';
import { BetterAuthTokenService } from './better-auth-token.service';
import { BetterAuthInstance, createBetterAuthInstance } from './better-auth.config';
import { DefaultBetterAuthResolver } from './better-auth.resolver';
import { CoreBetterAuthApiMiddleware } from './core-better-auth-api.middleware';
import { CoreBetterAuthChallengeService } from './core-better-auth-challenge.service';
import { CoreBetterAuthEmailVerificationService } from './core-better-auth-email-verification.service';
import { CoreBetterAuthRateLimitMiddleware } from './core-better-auth-rate-limit.middleware';
import { CoreBetterAuthRateLimiter } from './core-better-auth-rate-limiter.service';
import { CoreBetterAuthSignUpValidatorService } from './core-better-auth-signup-validator.service';
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
   * When `true`, all `@Roles()` decorators will be enforced automatically without
   * needing explicit `@UseGuards(RolesGuard)` on each endpoint.
   *
   * **Important:** This should be `false` in Legacy mode (3-parameter CoreModule.forRoot)
   * because CoreAuthModule already registers RolesGuard globally. Setting it to `true`
   * in Legacy mode would cause duplicate guard registration.
   *
   * @default true (secure by default - ensures @Roles() decorators are enforced)
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
  // Track if registerRolesGuardGlobally was explicitly set to false (for warning)
  private static rolesGuardExplicitlyDisabled = false;
  // Static reference to email verification service for Better-Auth hooks (outside DI context)
  private static emailVerificationService: CoreBetterAuthEmailVerificationService | null = null;
  private static mongoConnection: Connection | null = null;
  // Track if forRoot() has been called to prevent duplicate imports
  private static forRootCalled = false;
  private static cachedDynamicModule: DynamicModule | null = null;

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

    // Configuration warning: cookies: false without jwt enabled
    // When cookies are disabled, BetterAuth needs JWT plugin to issue tokens via Authorization header
    // JWT is enabled by default (same logic as CoreBetterAuthService.isJwtEnabled()),
    // so only warn when explicitly disabled via `jwt: false` or `jwt: { enabled: false }`
    if (CoreBetterAuthModule.currentConfig) {
      const globalConfig = ConfigService.configFastButReadOnly;
      const cookiesDisabled = globalConfig?.cookies === false;
      const jwtExplicitlyDisabled =
        CoreBetterAuthModule.currentConfig.jwt === false ||
        (typeof CoreBetterAuthModule.currentConfig.jwt === 'object' &&
          CoreBetterAuthModule.currentConfig.jwt?.enabled === false);

      if (cookiesDisabled && jwtExplicitlyDisabled) {
        CoreBetterAuthModule.logger.warn(
          'CONFIGURATION WARNING: cookies is set to false, but betterAuth.jwt is not enabled. ' +
            'Without cookies, BetterAuth cannot establish sessions via Set-Cookie headers. ' +
            'Enable betterAuth.jwt (set jwt: true in betterAuth config) to use Bearer token authentication, ' +
            'or set cookies: true to use cookie-based sessions.',
        );
      }
    }

    // Security warning: Check if RolesGuard is registered when explicitly disabled
    // This warning helps developers identify potential security misconfigurations
    if (CoreBetterAuthModule.rolesGuardExplicitlyDisabled && !RolesGuardRegistry.isRegistered()) {
      CoreBetterAuthModule.logger.warn(
        '⚠️ SECURITY WARNING: registerRolesGuardGlobally is explicitly set to false, ' +
          'but no RolesGuard is registered globally. @Roles() decorators will NOT enforce access control! ' +
          'Either set registerRolesGuardGlobally: true, or ensure CoreAuthModule (Legacy) is imported.',
      );
    }
  }

  /**
   * Configure middleware for Better-Auth session validation, API handling, and rate limiting.
   *
   * Middleware order (important!):
   * 1. CoreBetterAuthMiddleware - Session validation and user mapping for all routes
   *    Must run FIRST so that req.betterAuthSession is available for downstream middleware.
   *    In JWT mode, this resolves the JWT to a real DB session (via getActiveSessionForUser).
   * 2. CoreBetterAuthRateLimitMiddleware - Rate limiting for auth endpoints
   * 3. CoreBetterAuthApiMiddleware - Forwards plugin endpoints (passkey, 2FA, etc.) to Better Auth's native handler
   *    Runs AFTER session middleware so it can use req.betterAuthSession.session.token
   *    to authenticate requests in JWT mode.
   */
  configure(consumer: MiddlewareConsumer) {
    // Only apply middleware if Better-Auth is enabled.
    // We rely on the service-level check (this.betterAuthService?.isEnabled()) because it checks
    // the injected authInstance, which is the definitive source of truth. The static
    // betterAuthEnabled field can be stale after reset() since the createDeferredModule()
    // factory may not have re-set it before configure() is called.
    if (this.betterAuthService?.isEnabled()) {
      const basePath = CoreBetterAuthModule.currentConfig?.basePath || '/iam';

      // Apply session middleware to all routes FIRST
      // This resolves JWT tokens to DB sessions, making req.betterAuthSession available
      // for the API middleware to use when forwarding to Better Auth's native handler.
      consumer.apply(CoreBetterAuthMiddleware).forRoutes('(.*)'); // New path-to-regexp syntax for wildcard
      CoreBetterAuthModule.logger.debug('CoreBetterAuthMiddleware registered for all routes');

      // Apply rate limiting to Better-Auth endpoints only
      if (CoreBetterAuthModule.currentConfig?.rateLimit?.enabled) {
        consumer.apply(CoreBetterAuthRateLimitMiddleware).forRoutes(`${basePath}/*path`);
        CoreBetterAuthModule.logger.debug(`Rate limiting middleware registered for ${basePath}/*path endpoints`);
      }

      // Apply API middleware to Better-Auth endpoints LAST
      // This handles plugin endpoints (passkey, 2FA, social login, etc.) that are not defined in the controller.
      // It uses req.betterAuthSession (set by session middleware above) for JWT mode authentication.
      consumer.apply(CoreBetterAuthApiMiddleware).forRoutes(`${basePath}/*path`);
      CoreBetterAuthModule.logger.debug(`CoreBetterAuthApiMiddleware registered for ${basePath}/*path endpoints`);
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
    // Prevent duplicate imports - return cached module if forRoot() was already called
    // This protects against issues where both CoreModule.forRoot() and a project's IamModule
    // try to import CoreBetterAuthModule.forRoot(), which would corrupt the DI container
    // Skip cache in test environments (VITEST) to allow different test configurations
    if (this.forRootCalled && this.cachedDynamicModule && !process.env.VITEST) {
      this.logger.warn(
        'CoreBetterAuthModule.forRoot() was called multiple times. ' +
          'This can happen when both CoreModule.forRoot(envConfig) and a separate IamModule import CoreBetterAuthModule. ' +
          'In IAM-only mode, CoreModule.forRoot(envConfig) already imports CoreBetterAuthModule - do not import it again. ' +
          'Returning cached module to prevent DI corruption.',
      );
      return this.cachedDynamicModule;
    }

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
    const effectiveFallbackSecrets =
      fallbackSecrets ??
      (globalConfig?.jwt ? [globalConfig.jwt.secret, globalConfig.jwt.refresh?.secret].filter(Boolean) : undefined);

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
    // Store whether to register RolesGuard globally
    // Default is true (secure by default) - ensures @Roles() decorators are enforced
    // CoreModule.forRoot sets this to false in Legacy mode (where CoreAuthModule handles it)
    this.shouldRegisterRolesGuardGlobally = registerRolesGuardGlobally ?? true;
    // Track if explicitly disabled (for security warning in onModuleInit)
    this.rolesGuardExplicitlyDisabled = registerRolesGuardGlobally === false;

    // If better-auth is disabled (config is null or enabled: false), return minimal module
    // Note: We don't provide middleware classes when disabled because they depend on CoreBetterAuthService
    // and won't be used anyway (middleware is only applied when enabled)
    // Note: EmailVerificationService and SignUpValidatorService are not provided in disabled mode
    // because they require ConfigService and are only useful when BetterAuth is enabled
    if (config === null || config?.enabled === false) {
      this.logger.debug('BetterAuth is disabled - skipping initialization');
      this.betterAuthEnabled = false;
      const disabledModule: DynamicModule = {
        exports: [
          BETTER_AUTH_INSTANCE,
          CoreBetterAuthService,
          CoreBetterAuthUserMapper,
          CoreBetterAuthRateLimiter,
          BetterAuthTokenService,
          CoreBetterAuthChallengeService,
        ],
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
          // Note: EmailVerificationService and SignUpValidatorService are NOT provided when disabled
          // because they require ConfigService and have no purpose when BetterAuth is disabled
        ],
      };

      // Cache and mark as called
      this.forRootCalled = true;
      this.cachedDynamicModule = disabledModule;

      return disabledModule;
    }

    // Enable middleware registration
    this.betterAuthEnabled = true;

    // Note: Secret validation is now handled in createBetterAuthInstance
    // with fallback to jwt.secret, jwt.refresh.secret, or auto-generation

    // Always use deferred initialization to ensure MongoDB is ready
    // This prevents timing issues during application startup
    // Pass server-level URLs for Passkey auto-detection (using effective values from ConfigService fallback)
    const dynamicModule = this.createDeferredModule(config, {
      fallbackSecrets: effectiveFallbackSecrets,
      serverAppUrl: effectiveServerAppUrl,
      serverBaseUrl: effectiveServerBaseUrl,
      serverEnv: effectiveServerEnv,
    });

    // Cache the module and mark forRoot() as called to prevent duplicate imports
    this.forRootCalled = true;
    this.cachedDynamicModule = dynamicModule;

    return dynamicModule;
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
      exports: [
        BETTER_AUTH_INSTANCE,
        CoreBetterAuthService,
        CoreBetterAuthUserMapper,
        CoreBetterAuthRateLimiter,
        BetterAuthTokenService,
        CoreBetterAuthChallengeService,
        CoreBetterAuthEmailVerificationService,
        CoreBetterAuthSignUpValidatorService,
      ],
      imports: [],
      module: CoreBetterAuthModule,
      providers: [
        // Optional BrevoService: uses factory to avoid constructor error when brevo config is missing
        {
          inject: [ConfigService],
          provide: CoreBetterAuthEmailVerificationService.BREVO_SERVICE_TOKEN,
          useFactory: (configService: ConfigService) => {
            if (configService.configFastButReadOnly?.brevo?.apiKey) {
              return new BrevoService(configService);
            }
            return null;
          },
        },
        // Email verification service - must be initialized early for callbacks
        CoreBetterAuthEmailVerificationService,
        // Sign-up validator service
        CoreBetterAuthSignUpValidatorService,
        {
          inject: [ConfigService, CoreBetterAuthEmailVerificationService],
          provide: BETTER_AUTH_INSTANCE,
          useFactory: async (
            configService: ConfigService,
            emailVerificationService: CoreBetterAuthEmailVerificationService,
          ) => {
            // Set static reference for callbacks BEFORE creating Better-Auth instance
            this.setEmailVerificationService(emailVerificationService);

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

            // Create email verification callbacks that delegate to the NestJS service
            const { onEmailVerified, sendVerificationEmail } = this.createEmailVerificationCallbacks();

            // Note: Secret validation is now handled in createBetterAuthInstance
            // with fallback to jwt.secret, jwt.refresh.secret, or auto-generation
            this.authInstance = createBetterAuthInstance({
              config,
              db,
              fallbackSecrets,
              onEmailVerified,
              sendVerificationEmail,
            });

            // Store a config copy with the resolved secret so that consumers
            // (CoreBetterAuthService, CoreBetterAuthController) can sign cookies.
            // The original config object may be frozen (from ConfigService), so we
            // create a shallow copy with the resolved fallback secret applied.
            const resolvedSecret = config.secret || fallbackSecrets?.find((s) => s && s.length >= 32);
            this.currentConfig =
              resolvedSecret && resolvedSecret !== config.secret ? { ...config, secret: resolvedSecret } : config;

            if (this.authInstance) {
              this.logger.log('BetterAuth initialized successfully');
              this.logEnabledFeatures(config);
            }

            return this.authInstance;
          },
        },
        // Provide the resolved config for CoreBetterAuthService
        // IMPORTANT: Must depend on BETTER_AUTH_INSTANCE to ensure currentConfig is set
        {
          inject: [BETTER_AUTH_INSTANCE],
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
    this.rolesGuardExplicitlyDisabled = false;
    this.emailVerificationService = null;
    // Reset forRoot() tracking to allow re-initialization (important for tests)
    this.forRootCalled = false;
    this.cachedDynamicModule = null;
    // Reset shared RolesGuard registry (shared with CoreAuthModule)
    RolesGuardRegistry.reset();
  }

  /**
   * Set the email verification service instance for Better-Auth hooks.
   * Called internally during module initialization.
   * @internal
   */
  static setEmailVerificationService(service: CoreBetterAuthEmailVerificationService): void {
    this.emailVerificationService = service;
  }

  /**
   * Get the email verification service instance.
   * @internal
   */
  static getEmailVerificationService(): CoreBetterAuthEmailVerificationService | null {
    return this.emailVerificationService;
  }

  /**
   * Create email verification callbacks that delegate to the NestJS service.
   * These callbacks are passed to Better-Auth during initialization.
   * They access the service via static reference since Better-Auth hooks run outside DI context.
   * @internal
   */
  private static createEmailVerificationCallbacks(): {
    onEmailVerified: (userId: string) => Promise<void>;
    sendVerificationEmail: (options: {
      token: string;
      url: string;
      user: { email: string; id: string; name?: null | string };
    }) => Promise<void>;
  } {
    return {
      onEmailVerified: async (userId: string) => {
        // This callback is called by Better-Auth when email is verified
        // Sync nest-server's verified/verifiedAt fields with Better-Auth's emailVerified
        try {
          const db = this.mongoConnection?.db;
          if (db) {
            const { ObjectId } = await import('mongodb');
            await db
              .collection('users')
              .updateOne({ _id: new ObjectId(userId) }, { $set: { verified: true, verifiedAt: new Date() } });
            this.logger.debug(`Email verified for user ${userId} - synced verified/verifiedAt`);
          } else {
            this.logger.warn(`Cannot sync verifiedAt for user ${userId} - no database connection`);
          }
        } catch (error) {
          this.logger.error(
            `Failed to sync verifiedAt for user ${userId}: ${error instanceof Error ? error.message : 'Unknown error'}`,
          );
        }
      },
      sendVerificationEmail: async (options) => {
        // Delegate to the NestJS service
        if (this.emailVerificationService) {
          await this.emailVerificationService.sendVerificationEmail(options);
        } else {
          // Fallback: Log verification URL if service not available
          this.logger.warn('Email verification service not available, logging URL for development');
          this.logger.log(`[DEV] Verification URL for ${options.user.email}: ${options.url}`);
        }
      },
    };
  }

  /**
   * Creates a deferred initialization module that waits for mongoose connection
   * By injecting the Connection token, NestJS ensures Mongoose is ready first
   *
   * @param config - BetterAuth configuration
   * @param options - Optional deferred module options (fallback secrets, server URLs)
   */
  private static createDeferredModule(
    config: IBetterAuth,
    options?: {
      fallbackSecrets?: (string | undefined)[];
      serverAppUrl?: string;
      serverBaseUrl?: string;
      serverEnv?: string;
    },
  ): DynamicModule {
    return {
      controllers: [this.getControllerClass()],
      exports: [
        BETTER_AUTH_INSTANCE,
        CoreBetterAuthService,
        CoreBetterAuthUserMapper,
        CoreBetterAuthRateLimiter,
        BetterAuthTokenService,
        CoreBetterAuthChallengeService,
        CoreBetterAuthEmailVerificationService,
        CoreBetterAuthSignUpValidatorService,
      ],
      module: CoreBetterAuthModule,
      providers: [
        // Optional BrevoService: uses factory to avoid constructor error when brevo config is missing
        {
          inject: [ConfigService],
          provide: CoreBetterAuthEmailVerificationService.BREVO_SERVICE_TOKEN,
          useFactory: (configService: ConfigService) => {
            if (configService.configFastButReadOnly?.brevo?.apiKey) {
              return new BrevoService(configService);
            }
            return null;
          },
        },
        // Email verification service - must be initialized early for callbacks
        CoreBetterAuthEmailVerificationService,
        // Sign-up validator service
        CoreBetterAuthSignUpValidatorService,
        {
          // Inject Mongoose Connection to ensure NestJS waits for it to be ready
          // Also inject EmailVerificationService to set static reference before Better-Auth init
          inject: [getConnectionToken(), CoreBetterAuthEmailVerificationService],
          provide: BETTER_AUTH_INSTANCE,
          useFactory: async (
            connection: Connection,
            emailVerificationService: CoreBetterAuthEmailVerificationService,
          ) => {
            // Set static references for callbacks BEFORE creating Better-Auth instance
            this.setEmailVerificationService(emailVerificationService);
            this.mongoConnection = connection;

            // Create email verification callbacks that delegate to the NestJS service
            const { onEmailVerified, sendVerificationEmail } = this.createEmailVerificationCallbacks();

            // Build shared instance options
            const sharedInstanceOptions = {
              config,
              fallbackSecrets: options?.fallbackSecrets,
              onEmailVerified,
              sendVerificationEmail,
              serverAppUrl: options?.serverAppUrl,
              serverBaseUrl: options?.serverBaseUrl,
              serverEnv: options?.serverEnv,
            };

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
                ...sharedInstanceOptions,
                db: globalDb,
              });
            } else {
              this.authInstance = createBetterAuthInstance({
                ...sharedInstanceOptions,
                db,
              });
            }

            // Store a config copy with the resolved secret (same as first forRoot variant)
            const fallbacks = options?.fallbackSecrets;
            const resolvedSecret2 = config.secret || fallbacks?.find((s) => s && s.length >= 32);
            this.currentConfig =
              resolvedSecret2 && resolvedSecret2 !== config.secret ? { ...config, secret: resolvedSecret2 } : config;

            // Keep static betterAuthEnabled in sync with the authInstance state.
            // This is important because forRoot() sets it synchronously, but reset()
            // clears it and this factory needs to re-establish it.
            this.betterAuthEnabled = !!this.authInstance;

            if (this.authInstance && !this.initLogged) {
              this.initLogged = true;
              this.logger.log('BetterAuth initialized');
              this.logEnabledFeatures(config);
            }

            return this.authInstance;
          },
        },
        // Provide the resolved config for CoreBetterAuthService
        // IMPORTANT: Must depend on BETTER_AUTH_INSTANCE to ensure currentConfig is set
        {
          inject: [BETTER_AUTH_INSTANCE],
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
        // Uses shared RolesGuardRegistry to prevent duplicate registration across modules
        ...(this.shouldRegisterRolesGuardGlobally && !RolesGuardRegistry.isRegistered()
          ? (() => {
              RolesGuardRegistry.markRegistered('CoreBetterAuthModule');
              return [
                {
                  provide: APP_GUARD,
                  useClass: RolesGuard,
                },
              ];
            })()
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

    // Email verification is enabled by default unless explicitly disabled
    if (!isExplicitlyDisabled(config.emailVerification)) {
      features.push('Email Verification');
    }

    // Sign-up checks are enabled by default unless explicitly disabled
    if (!isExplicitlyDisabled(config.signUpChecks)) {
      features.push('Sign-Up Checks');
    }

    if (features.length > 0) {
      this.logger.log(`Enabled features: ${features.join(', ')}`);
    }
  }
}
