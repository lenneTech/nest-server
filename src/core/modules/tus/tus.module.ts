import { DynamicModule, Global, Logger, Module, OnModuleInit, Type } from '@nestjs/common';
import { getConnectionToken } from '@nestjs/mongoose';
import { Connection } from 'mongoose';

import { ITusConfig } from '../../common/interfaces/server-options.interface';
import { ConfigService } from '../../common/services/config.service';
import { CoreRedisService } from '../../common/services/core-redis.service';
import { CoreS3Service } from '../../common/services/core-s3.service';
import { CoreTusController } from './core-tus.controller';
import { CoreTusService } from './core-tus.service';
import { TUS_CONFIG } from './tus.constants';
import { DEFAULT_TUS_CONFIG, normalizeTusConfig } from './interfaces/tus-config.interface';

/**
 * @deprecated Import from `./tus.constants` instead. Re-exported only so existing deep imports keep
 * working; the token is declared in an import-free leaf so module and services stay acyclic
 * (SWC-safe — see tus.constants.ts).
 *
 * Do NOT import it from here inside the TUS module itself — that is what re-creates the cycle.
 */
export { TUS_CONFIG } from './tus.constants';

/**
 * Options for TusModule.forRoot()
 */
export interface TusModuleOptions {
  /**
   * TUS configuration.
   * Accepts:
   * - `true` or `undefined`: Enable with defaults (enabled by default)
   * - `false`: Disable TUS uploads
   * - `{ ... }`: Enable with custom configuration
   */
  config?: boolean | ITusConfig;

  /**
   * Custom controller class to use instead of CoreTusController.
   * The class must extend CoreTusController.
   *
   * @example
   * ```typescript
   * @Controller('tus')
   * @Roles(RoleEnum.S_USER) // Require authentication
   * export class TusController extends CoreTusController {
   *   override async handleTus(...) {
   *     // Custom logic
   *     return super.handleTus(...);
   *   }
   * }
   *
   * TusModule.forRoot({
   *   controller: TusController,
   * })
   * ```
   */
  controller?: Type<CoreTusController>;
}

/**
 * TUS Module for resumable file uploads
 *
 * This module provides integration with the tus.io protocol via @tus/server.
 * It is enabled by default with sensible defaults - no configuration required.
 *
 * Features:
 * - Resumable uploads via tus.io protocol
 * - Automatic migration to GridFS after upload completion
 * - Configurable extensions (creation, termination, expiration, etc.)
 * - Module Inheritance Pattern for customization
 *
 * @example
 * ```typescript
 * // Default usage - enabled with all defaults
 * @Module({
 *   imports: [
 *     CoreModule.forRoot(envConfig),
 *     TusModule.forRoot(), // No config needed
 *   ],
 * })
 * export class AppModule {}
 *
 * // Custom configuration
 * TusModule.forRoot({
 *   config: {
 *     maxSize: 100 * 1024 * 1024, // 100 MB
 *     path: '/uploads',
 *   },
 * })
 *
 * // Disable TUS
 * TusModule.forRoot({ config: false })
 * ```
 */
@Global()
@Module({})
export class TusModule implements OnModuleInit {
  private static logger = new Logger(TusModule.name);
  private static tusEnabled = false;
  private static currentConfig: ITusConfig | null = null;
  private static customController: null | Type<CoreTusController> = null;

  constructor(private readonly tusService?: CoreTusService) {}

  async onModuleInit(): Promise<void> {
    if (TusModule.tusEnabled && this.tusService?.isEnabled()) {
      TusModule.logger.log('TusModule ready');
    }
  }

  /**
   * Gets the controller class to use (custom or default)
   */
  private static getControllerClass(): Type<CoreTusController> {
    return this.customController || CoreTusController;
  }

  /**
   * Write the configured roles onto the tus handlers.
   *
   * An empty array is rejected rather than honoured: the guards read an
   * all-empty role set as "no roles required" and return true, so `roles: []`
   * would OPEN the endpoints instead of closing them.
   */
  private static applyRoles(controller: Type<CoreTusController>, roles?: string[]): void {
    if (
      roles !== undefined &&
      (!Array.isArray(roles) || roles.length === 0 || roles.some((r) => typeof r !== 'string'))
    ) {
      this.logger.warn(
        `Ignoring tus.roles: expected a non-empty array of role strings, got ${JSON.stringify(roles)}. ` +
          `Falling back to ${JSON.stringify(DEFAULT_TUS_CONFIG.roles)}.`,
      );
    }

    const effective =
      Array.isArray(roles) && roles.length > 0 && roles.every((r) => typeof r === 'string')
        ? roles
        : DEFAULT_TUS_CONFIG.roles;

    Reflect.defineMetadata('roles', effective, controller);
    // NOTE: handleTusOptions / handleTusOptionsWithId are deliberately absent.
    // They answer the CORS preflight, which a browser sends WITHOUT credentials,
    // so gating them would break every browser upload. They expose capabilities
    // only, never upload data — see CoreTusController.
    for (const member of ['handleTus', 'handleTusWithId']) {
      const handler = (controller.prototype as Record<string, unknown>)[member];
      if (typeof handler === 'function') {
        Reflect.defineMetadata('roles', effective, handler);
      }
    }
  }

  /**
   * Creates a dynamic module for TUS uploads
   *
   * @param options - Configuration options (optional)
   * @returns Dynamic module configuration
   */
  static forRoot(options: TusModuleOptions = {}): DynamicModule {
    const { config: rawConfig, controller } = options;

    // Normalize config: undefined/true → enabled with defaults, false → disabled
    const config = normalizeTusConfig(rawConfig);

    // Store config for service configuration
    this.currentConfig = config;
    // Store custom controller if provided
    this.customController = controller || null;

    // If TUS is disabled, return minimal module
    if (config === null) {
      this.logger.debug('TUS uploads disabled');
      this.tusEnabled = false;
      return {
        exports: [TUS_CONFIG, CoreTusService],
        module: TusModule,
        providers: [
          {
            provide: TUS_CONFIG,
            useValue: null,
          },
          {
            inject: [getConnectionToken()],
            provide: CoreTusService,
            useFactory: (connection: Connection) => {
              const service = new CoreTusService(connection);
              service.configure(false);
              return service;
            },
          },
        ],
      };
    }

    // Enable TUS
    this.tusEnabled = true;

    // Apply the configured roles to the controller that will actually be
    // registered. Same mechanism as CorePermissionsModule: the value is only
    // known at runtime, and the guards read exactly this metadata key.
    //
    // A custom controller is covered too, as long as it INHERITS the handlers.
    // One that re-declares @All()/@Roles() carries its own metadata and thereby
    // opts out — which is the documented way to hard-code a policy that config
    // must not be able to change.
    this.applyRoles(this.getControllerClass(), config.roles);

    return {
      controllers: [this.getControllerClass()],
      exports: [TUS_CONFIG, CoreTusService],
      module: TusModule,
      providers: [
        {
          provide: TUS_CONFIG,
          useValue: config,
        },
        {
          inject: [
            getConnectionToken(),
            TUS_CONFIG,
            ConfigService,
            { optional: true, token: CoreS3Service },
            { optional: true, token: CoreRedisService },
          ],
          provide: CoreTusService,
          useFactory: async (
            connection: Connection,
            tusConfig: ITusConfig,
            configService: ConfigService,
            s3Service?: CoreS3Service,
            redisService?: CoreRedisService,
          ) => {
            const service = new CoreTusService(connection, { configService, redisService, s3Service });
            service.configure(tusConfig);
            // NestJS DOES call onModuleInit on a factory-provided instance — its hook iterates
            // every non-alias provider, however it was constructed. Calling it here as well ran
            // init TWICE per boot: two TUS servers, two S3 stores, and two hourly expiration
            // intervals of which onModuleDestroy clears only the second.
            return service;
          },
        },
      ],
    };
  }

  /**
   * Resets the static state of TusModule
   * Useful for testing
   */
  static reset(): void {
    this.tusEnabled = false;
    this.currentConfig = null;
    this.customController = null;
  }
}
