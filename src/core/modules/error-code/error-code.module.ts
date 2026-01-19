import { DynamicModule, Global, Module, Type } from '@nestjs/common';

import { CoreErrorCodeController } from './core-error-code.controller';
import { CoreErrorCodeService } from './core-error-code.service';
import { IErrorCodeModuleConfig } from './interfaces/error-code.interfaces';

/**
 * Error Code Module
 *
 * Provides error code translations via REST endpoint.
 * Translations are defined in the error registry (Single Source of Truth).
 *
 * @example
 * ```typescript
 * // Basic usage (auto-register in CoreModule)
 * // No explicit import needed - included in CoreModule
 *
 * // Extended usage (with custom error registry - RECOMMENDED)
 * const ProjectErrors = {
 *   ORDER_NOT_FOUND: {
 *     code: 'PROJ_0001',
 *     message: 'Order not found',
 *     translations: { de: 'Bestellung nicht gefunden.', en: 'Order not found.' }
 *   }
 * } as const satisfies IErrorRegistry;
 *
 * ErrorCodeModule.forRoot({ additionalErrorRegistry: ProjectErrors })
 *
 * // Extended usage (with custom controller and service)
 * ErrorCodeModule.forRoot({
 *   additionalErrorRegistry: ProjectErrors,
 *   controller: ErrorCodeController,
 *   service: ErrorCodeService,
 * })
 * ```
 */
@Global()
@Module({
  // IMPORTANT: Controllers are NOT registered here - they are registered via forRoot()
  // This prevents duplicate controller registration when using custom controllers,
  // which would cause route conflicts (e.g., :locale intercepting /codes)
  exports: [CoreErrorCodeService],
  providers: [CoreErrorCodeService],
})
export class ErrorCodeModule {
  /**
   * Gets the controller class to use (custom or default)
   */
  private static getControllerClass(config?: IErrorCodeModuleConfig): Type<any> {
    return config?.controller || CoreErrorCodeController;
  }

  /**
   * Gets the service class to use (custom or default)
   */
  private static getServiceClass(config?: IErrorCodeModuleConfig): Type<CoreErrorCodeService> {
    return config?.service || CoreErrorCodeService;
  }

  /**
   * Register the module with configuration
   *
   * Supports the following patterns:
   * 1. **No config**: Uses CoreErrorCodeService and CoreErrorCodeController with core errors only
   * 2. **additionalErrorRegistry only**: Adds project errors to core errors
   * 3. **service only**: Uses custom service class (should register its own errors in constructor)
   * 4. **controller only**: Uses custom controller class with CoreErrorCodeService
   * 5. **Full config**: Uses custom service and controller
   *
   * @param config - Module configuration
   * @returns Dynamic module
   */
  static forRoot(config?: IErrorCodeModuleConfig): DynamicModule {
    const ControllerClass = this.getControllerClass(config);
    const ServiceClass = this.getServiceClass(config);

    // Build providers array
    const providers: any[] = [];

    if (config?.service) {
      // If a custom service is provided, register it under both tokens:
      // 1. Its own class (for direct injection in custom controllers)
      // 2. CoreErrorCodeService (for backward compatibility)
      providers.push(ServiceClass);
      providers.push({
        provide: CoreErrorCodeService,
        useExisting: ServiceClass,
      });
    } else {
      // Use factory to register additional errors
      providers.push({
        provide: CoreErrorCodeService,
        useFactory: () => {
          const service = new CoreErrorCodeService();

          // Add additional error registry
          if (config?.additionalErrorRegistry) {
            service.registerErrorRegistry(config.additionalErrorRegistry);
          }

          return service;
        },
      });
    }

    // Export both the base class and custom service class (if provided)
    const exports: any[] = [CoreErrorCodeService];
    if (config?.service && ServiceClass !== CoreErrorCodeService) {
      exports.push(ServiceClass);
    }

    return {
      controllers: [ControllerClass],
      exports,
      module: ErrorCodeModule,
      providers,
    };
  }
}
