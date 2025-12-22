import { DynamicModule, Global, Logger, Module, OnModuleInit, Type } from '@nestjs/common';
import { getConnectionToken } from '@nestjs/mongoose';
import { Connection } from 'mongoose';

import { ITusConfig } from '../../common/interfaces/server-options.interface';
import { CoreTusController } from './core-tus.controller';
import { CoreTusService } from './core-tus.service';
import { normalizeTusConfig } from './interfaces/tus-config.interface';

/**
 * Token for injecting the TUS configuration
 */
export const TUS_CONFIG = 'TUS_CONFIG';

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
          inject: [getConnectionToken(), TUS_CONFIG],
          provide: CoreTusService,
          useFactory: async (connection: Connection, tusConfig: ITusConfig) => {
            const service = new CoreTusService(connection);
            service.configure(tusConfig);
            // Manually call onModuleInit since useFactory bypasses lifecycle hooks
            await service.onModuleInit();
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
