import { DynamicModule, Global, Logger, Module, OnModuleInit, Type } from '@nestjs/common';
import { PATH_METADATA } from '@nestjs/common/constants';
import { ModuleRef } from '@nestjs/core';
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

  /**
   * Custom service class to use instead of CoreTusService.
   * The class must extend CoreTusService and keep its constructor signature
   * `(connection, options?)`: the module constructs it with exactly those arguments, so it cannot
   * declare constructor dependencies of its own. Project providers are reached at call time through
   * `this.options?.moduleRef`.
   *
   * The seam for project-specific upload rules — e.g. override `onUploadCreate()` to enforce a quota
   * from the declared `Upload-Length` before a single byte is written, or `onUploadComplete()` to
   * post-process the finished file.
   *
   * @example
   * ```typescript
   * export class TusService extends CoreTusService {
   *   protected override async onUploadCreate(req: any, upload: Upload) {
   *     const quota = this.options?.moduleRef?.get(QuotaService, { strict: false });
   *     await quota?.assertRoomFor(req, upload.size); // throw an Error with status_code 413 to refuse
   *     return super.onUploadCreate(req, upload);
   *   }
   * }
   *
   * TusModule.forRoot({ service: TusService })
   * ```
   */
  service?: Type<CoreTusService>;
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
  private static customService: null | Type<CoreTusService> = null;
  /** The route each controller class declared, before applyPath() moved it. */
  private static declaredPaths = new WeakMap<Type<CoreTusController>, unknown>();

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
   * Makes the controller's route and `tus.path` agree. A configured `path` mounts the controller there
   * — config wins over a re-declared `@Controller()`, as it does for the roles; without one, `path`
   * follows the route the controller declared. Before 11.42.9 the two were independent: the core
   * controller always listened at `/tus` while a configured `path` only changed the URLs handed to the
   * client, so every resume after a non-default `path` answered 404.
   *
   * The declared route is remembered per class, so a later forRoot() without `path` restores it.
   */
  private static applyPath(controller: Type<CoreTusController>, config: ITusConfig, configuredPath: unknown): void {
    if (!this.declaredPaths.has(controller)) {
      this.declaredPaths.set(controller, Reflect.getMetadata(PATH_METADATA, controller));
    }
    const trim = (value: string) => value.replace(/^\/+|\/+$/g, '');
    const configured = typeof configuredPath === 'string' ? trim(configuredPath) : '';
    const declared = this.declaredPaths.get(controller);
    const declaredRoute = typeof declared === 'string' ? trim(declared) : '';
    // A path that ENDS with the controller's own route (`api/tus` for `tus`) names the URL the route is
    // publicly reachable under — a global prefix or a proxy in front of it. That is how `path` had to be
    // used before 11.42.9, and those setups keep working: the controller stays, upload URLs use the
    // path. Mounting it there would put the prefix in twice (`/api/api/tus`).
    const publicUrl = !!declaredRoute && configured !== declaredRoute && configured.endsWith(`/${declaredRoute}`);
    const route = configured && !publicUrl ? configured : declared;
    Reflect.defineMetadata(PATH_METADATA, route, controller);
    if (configured) {
      config.path = `/${configured}`;
    } else if (typeof route === 'string') {
      config.path = `/${trim(route)}`;
    }
  }

  /**
   * Creates a dynamic module for TUS uploads
   *
   * @param options - Configuration options (optional)
   * @returns Dynamic module configuration
   */
  static forRoot(options: TusModuleOptions = {}): DynamicModule {
    const { config: explicitConfig, controller, service } = options;

    // Without an explicit `config`, the server configuration's `tus` key applies — the zero-config rule
    // BetterAuthModule.forRoot() follows too: CoreModule.forRoot() runs first and fills ConfigService.
    // Before 11.42.9 that key was never read, so `tus: false`, `allowedTypes` or `maxSize` in
    // config.env.ts did nothing at all.
    const rawConfig =
      explicitConfig !== undefined ? explicitConfig : ConfigService.get<boolean | ITusConfig | undefined>('tus');

    // Normalize config: undefined/true → enabled with defaults, false → disabled
    const config = normalizeTusConfig(rawConfig);

    // Store config for service configuration
    this.currentConfig = config;
    // Store custom controller and service if provided
    this.customController = controller || null;
    this.customService = service || null;
    const ServiceClass = this.customService || CoreTusService;

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
              const tusService = new ServiceClass(connection);
              tusService.configure(false);
              return tusService;
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
    // A custom controller is covered whether it inherits the handlers or
    // re-declares them. Re-declaring @All()/@Roles() does NOT opt out: this
    // writes onto `controller.prototype[member]`, which for an override resolves
    // to the SUBCLASS's own function, and forRoot() runs after decorator
    // evaluation — so config wins either way.
    //
    // That differs from the file module on purpose. `applyFileRoles()` targets
    // the BASE class by name, so a subclass override there genuinely does keep
    // its own metadata. Do not reason from one to the other.
    //
    // The real opt-outs here are: give the handler a different name (this only
    // touches the members it knows), or register the controller outside
    // TusModule entirely.
    this.applyRoles(this.getControllerClass(), config.roles);
    this.applyPath(this.getControllerClass(), config, typeof rawConfig === 'object' ? rawConfig?.path : undefined);

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
            ModuleRef,
          ],
          provide: CoreTusService,
          useFactory: async (
            connection: Connection,
            tusConfig: ITusConfig,
            configService: ConfigService,
            s3Service?: CoreS3Service,
            redisService?: CoreRedisService,
            moduleRef?: ModuleRef,
          ) => {
            const tusService = new ServiceClass(connection, { configService, moduleRef, redisService, s3Service });
            tusService.configure(tusConfig);
            // NestJS DOES call onModuleInit on a factory-provided instance — its hook iterates
            // every non-alias provider, however it was constructed. Calling it here as well ran
            // init TWICE per boot: two TUS servers, two S3 stores, and two hourly expiration
            // intervals of which onModuleDestroy clears only the second.
            return tusService;
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
    this.customService = null;
  }
}
