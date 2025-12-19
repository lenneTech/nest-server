import {
  DynamicModule,
  Global,
  Logger,
  MiddlewareConsumer,
  Module,
  NestModule,
  OnModuleInit,
  Optional,
} from '@nestjs/common';
import { getConnectionToken } from '@nestjs/mongoose';
import { AuthModule, AuthService } from '@thallesp/nestjs-better-auth';
import mongoose, { Connection } from 'mongoose';

import { IBetterAuth } from '../../common/interfaces/server-options.interface';
import { ConfigService } from '../../common/services/config.service';
import { BetterAuthRateLimitMiddleware } from './better-auth-rate-limit.middleware';
import { BetterAuthRateLimiter } from './better-auth-rate-limiter.service';
import { BetterAuthUserMapper } from './better-auth-user.mapper';
import { BetterAuthInstance, createBetterAuthInstance } from './better-auth.config';
import { BetterAuthMiddleware } from './better-auth.middleware';
import { BetterAuthResolver } from './better-auth.resolver';
import { BetterAuthService } from './better-auth.service';

/**
 * Token for injecting the better-auth instance
 */
export const BETTER_AUTH_INSTANCE = 'BETTER_AUTH_INSTANCE';

/**
 * Options for BetterAuthModule.forRoot()
 */
export interface BetterAuthModuleOptions {
  /**
   * Better-auth configuration
   */
  config: IBetterAuth;

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
}

/**
 * BetterAuthModule provides integration with the better-auth authentication framework.
 *
 * This module:
 * - Creates and configures a better-auth instance based on server configuration
 * - Integrates with @thallesp/nestjs-better-auth for NestJS support
 * - Supports JWT, 2FA, Passkey, and Social Login based on configuration
 * - Only activates when betterAuth.enabled is true in configuration
 * - Uses the global mongoose connection for MongoDB access
 *
 * @example
 * ```typescript
 * // In your AppModule - import after CoreModule so mongoose is connected
 * @Module({
 *   imports: [
 *     CoreModule.forRoot(...),
 *     BetterAuthModule.forRoot({ config: environment.betterAuth }),
 *   ],
 * })
 * export class AppModule {}
 * ```
 */
@Global()
@Module({})
export class BetterAuthModule implements NestModule, OnModuleInit {
  private static logger = new Logger(BetterAuthModule.name);
  private static authInstance: BetterAuthInstance | null = null;
  private static initialized = false;
  private static betterAuthEnabled = false;
  private static currentConfig: IBetterAuth | null = null;

  constructor(
    @Optional() private readonly betterAuthService?: BetterAuthService,
    @Optional() private readonly rateLimiter?: BetterAuthRateLimiter,
  ) {}

  onModuleInit() {
    if (BetterAuthModule.authInstance && !BetterAuthModule.initialized) {
      BetterAuthModule.initialized = true;
      BetterAuthModule.logger.log('BetterAuthModule ready');
    }

    // Configure rate limiter with stored config
    if (this.rateLimiter && BetterAuthModule.currentConfig?.rateLimit) {
      this.rateLimiter.configure(BetterAuthModule.currentConfig.rateLimit);
    }
  }

  /**
   * Configure middleware for Better-Auth session handling and rate limiting
   * The session middleware runs on all routes and maps Better-Auth sessions to users
   * The rate limit middleware runs only on Better-Auth endpoints
   */
  configure(consumer: MiddlewareConsumer) {
    // Only apply middleware if Better-Auth is enabled
    if (BetterAuthModule.betterAuthEnabled && this.betterAuthService?.isEnabled()) {
      const basePath = BetterAuthModule.currentConfig?.basePath || '/iam';

      // Apply rate limiting to Better-Auth endpoints only
      if (BetterAuthModule.currentConfig?.rateLimit?.enabled) {
        consumer.apply(BetterAuthRateLimitMiddleware).forRoutes(`${basePath}/*`);
        BetterAuthModule.logger.debug(`Rate limiting enabled for ${basePath}/* endpoints`);
      }

      // Apply session middleware to all routes
      consumer.apply(BetterAuthMiddleware).forRoutes('*');
      BetterAuthModule.logger.debug('BetterAuthMiddleware registered for all routes');
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
  static forRoot(options: BetterAuthModuleOptions): DynamicModule {
    const { config, fallbackSecrets } = options;

    // Store config for middleware configuration
    this.currentConfig = config;

    // If better-auth is explicitly disabled, return minimal module
    // Note: We don't provide middleware classes when disabled because they depend on BetterAuthService
    // and won't be used anyway (middleware is only applied when enabled)
    // BetterAuth is enabled by default unless explicitly set to false
    if (config?.enabled === false) {
      this.logger.debug('BetterAuth is explicitly disabled - skipping initialization');
      this.betterAuthEnabled = false;
      return {
        exports: [BETTER_AUTH_INSTANCE, BetterAuthService, BetterAuthUserMapper, BetterAuthRateLimiter],
        module: BetterAuthModule,
        providers: [
          {
            provide: BETTER_AUTH_INSTANCE,
            useValue: null,
          },
          // Note: ConfigService is provided globally by CoreModule
          // Tests need to provide their own ConfigService
          BetterAuthService,
          BetterAuthUserMapper,
          BetterAuthRateLimiter,
        ],
      };
    }

    // Enable middleware registration
    this.betterAuthEnabled = true;

    // Note: Secret validation is now handled in createBetterAuthInstance
    // with fallback to jwt.secret, jwt.refresh.secret, or auto-generation

    // Always use deferred initialization to ensure MongoDB is ready
    // This prevents timing issues during application startup
    return this.createDeferredModule(config, fallbackSecrets);
  }

  /**
   * Creates an async dynamic module for BetterAuth
   * This is the preferred method as it properly waits for mongoose connection.
   *
   * @param configService - ConfigService instance (optional, can use inject pattern)
   * @returns Dynamic module configuration
   */
  static forRootAsync(): DynamicModule {
    return {
      exports: [BETTER_AUTH_INSTANCE, BetterAuthService, BetterAuthUserMapper, BetterAuthRateLimiter],
      imports: [],
      module: BetterAuthModule,
      providers: [
        {
          inject: [ConfigService],
          provide: BETTER_AUTH_INSTANCE,
          useFactory: async (configService: ConfigService) => {
            const config = configService.get<IBetterAuth>('betterAuth');

            // Store config for middleware configuration
            this.currentConfig = config || null;

            // BetterAuth is enabled by default unless explicitly set to false
            if (config?.enabled === false) {
              this.logger.debug('BetterAuth is explicitly disabled');
              this.betterAuthEnabled = false;
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

            if (this.authInstance) {
              this.logger.log('BetterAuth initialized successfully');
              this.logEnabledFeatures(config);
            }

            return this.authInstance;
          },
        },
        // Note: ConfigService is provided globally by CoreModule
        BetterAuthService,
        BetterAuthUserMapper,
        BetterAuthMiddleware,
        BetterAuthRateLimiter,
        BetterAuthRateLimitMiddleware,
        BetterAuthResolver,
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
   * Resets the static state of BetterAuthModule
   * This is primarily useful for testing to ensure clean state between tests
   *
   * @example
   * ```typescript
   * afterEach(() => {
   *   BetterAuthModule.reset();
   * });
   * ```
   */
  static reset(): void {
    this.authInstance = null;
    this.initialized = false;
    this.betterAuthEnabled = false;
    this.currentConfig = null;
    this.logger.debug('BetterAuthModule state reset');
  }

  /**
   * Creates the actual module with better-auth
   */
  private static createModule(config: IBetterAuth, db: any, fallbackSecrets?: (string | undefined)[]): DynamicModule {
    // Create the better-auth instance
    this.authInstance = createBetterAuthInstance({ config, db, fallbackSecrets });

    if (!this.authInstance) {
      throw new Error('Failed to create better-auth instance');
    }

    this.logger.log('BetterAuth initialized successfully');
    this.logEnabledFeatures(config);

    // Use @thallesp/nestjs-better-auth's AuthModule
    const authModule = AuthModule.forRoot({
      auth: this.authInstance,
      disableControllers: false, // Enable REST endpoints
      disableGlobalAuthGuard: true, // We use our own RolesGuard
    });

    return {
      exports: [
        BETTER_AUTH_INSTANCE,
        AuthModule,
        AuthService,
        BetterAuthService,
        BetterAuthUserMapper,
        BetterAuthRateLimiter,
      ],
      imports: [authModule],
      module: BetterAuthModule,
      providers: [
        {
          provide: BETTER_AUTH_INSTANCE,
          useValue: this.authInstance,
        },
        // Note: ConfigService is provided globally by CoreModule
        BetterAuthService,
        BetterAuthUserMapper,
        BetterAuthMiddleware,
        BetterAuthRateLimiter,
        BetterAuthRateLimitMiddleware,
        BetterAuthResolver,
      ],
    };
  }

  /**
   * Creates a deferred initialization module that waits for mongoose connection
   * By injecting the Connection token, NestJS ensures Mongoose is ready first
   */
  private static createDeferredModule(config: IBetterAuth, fallbackSecrets?: (string | undefined)[]): DynamicModule {
    return {
      exports: [BETTER_AUTH_INSTANCE, BetterAuthService, BetterAuthUserMapper, BetterAuthRateLimiter],
      module: BetterAuthModule,
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
              this.authInstance = createBetterAuthInstance({ config, db: globalDb, fallbackSecrets });
            } else {
              this.authInstance = createBetterAuthInstance({ config, db, fallbackSecrets });
            }

            if (this.authInstance) {
              this.logger.log('BetterAuth initialized');
              this.logEnabledFeatures(config);
            }

            return this.authInstance;
          },
        },
        // Note: ConfigService is provided globally by CoreModule
        BetterAuthService,
        BetterAuthUserMapper,
        BetterAuthMiddleware,
        BetterAuthRateLimiter,
        BetterAuthRateLimitMiddleware,
        BetterAuthResolver,
      ],
    };
  }

  /**
   * Logs which features are enabled
   */
  private static logEnabledFeatures(config: IBetterAuth): void {
    const features: string[] = [];

    if (config.jwt?.enabled) {
      features.push('JWT');
    }
    if (config.twoFactor?.enabled) {
      features.push('2FA/TOTP');
    }
    if (config.passkey?.enabled) {
      features.push('Passkey/WebAuthn');
    }
    if (config.legacyPassword?.enabled) {
      features.push('Legacy Password Handling');
    }

    const socialProviders: string[] = [];
    if (config.socialProviders?.google?.enabled) {
      socialProviders.push('Google');
    }
    if (config.socialProviders?.github?.enabled) {
      socialProviders.push('GitHub');
    }
    if (config.socialProviders?.apple?.enabled) {
      socialProviders.push('Apple');
    }

    if (socialProviders.length > 0) {
      features.push(`Social Login (${socialProviders.join(', ')})`);
    }

    if (config.rateLimit?.enabled) {
      features.push(`Rate Limiting (${config.rateLimit.max || 10}/${config.rateLimit.windowSeconds || 60}s)`);
    }

    if (features.length > 0) {
      this.logger.log(`Enabled features: ${features.join(', ')}`);
    }
  }
}
