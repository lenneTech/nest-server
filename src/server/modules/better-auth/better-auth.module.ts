import { DynamicModule, Module } from '@nestjs/common';

import { IBetterAuth } from '../../../core/common/interfaces/server-options.interface';
import { CoreBetterAuthModule } from '../../../core/modules/better-auth/core-better-auth.module';
import { BetterAuthController } from './better-auth.controller';
import { BetterAuthResolver } from './better-auth.resolver';

/**
 * Options for BetterAuthModule.forRoot()
 */
export interface ServerBetterAuthModuleOptions {
  /**
   * Better-auth configuration.
   * Accepts:
   * - `true`: Enable with all defaults (including JWT)
   * - `false`: Disable BetterAuth
   * - `{ ... }`: Enable with custom configuration
   */
  config: boolean | IBetterAuth;

  /**
   * Fallback secrets for backwards compatibility with JWT config.
   * If no betterAuth.secret is configured, these secrets are tried in order.
   */
  fallbackSecrets?: (string | undefined)[];
}

/**
 * Server BetterAuthModule - Project-specific Better-Auth integration
 *
 * This module wraps the core BetterAuthModule and provides project-specific
 * customization through the BetterAuthController and BetterAuthResolver.
 *
 * Following the same pattern as src/server/modules/auth/auth.module.ts:
 * - Core module provides abstract/base functionality
 * - Server module provides project-specific implementations
 *
 * @example
 * ```typescript
 * // In server.module.ts
 * import { BetterAuthModule } from './modules/better-auth/better-auth.module';
 *
 * @Module({
 *   imports: [
 *     CoreModule.forRoot(CoreAuthService, AuthModule.forRoot(envConfig.jwt), {
 *       ...envConfig,
 *       betterAuth: { ...envConfig.betterAuth, autoRegister: false },
 *     }),
 *     BetterAuthModule.forRoot({
 *       config: envConfig.betterAuth,
 *       fallbackSecrets: [envConfig.jwt?.secret, envConfig.jwt?.refresh?.secret],
 *     }),
 *   ],
 * })
 * export class ServerModule {}
 * ```
 */
@Module({})
export class BetterAuthModule {
  /**
   * Creates a dynamic module with project-specific Better-Auth configuration
   *
   * @param options - Configuration options
   * @returns Dynamic module configuration
   */
  static forRoot(options: ServerBetterAuthModuleOptions): DynamicModule {
    const { config, fallbackSecrets } = options;

    // If better-auth is explicitly disabled, return minimal module
    // Supports: false, { enabled: false }, or undefined/null
    const isDisabled = config === false || (typeof config === 'object' && config?.enabled === false);
    if (isDisabled) {
      return {
        exports: [],
        module: BetterAuthModule,
        providers: [],
      };
    }

    return {
      exports: [CoreBetterAuthModule],
      imports: [
        CoreBetterAuthModule.forRoot({
          config,
          controller: BetterAuthController,
          fallbackSecrets,
          resolver: BetterAuthResolver,
        }),
      ],
      module: BetterAuthModule,
      providers: [],
    };
  }
}
