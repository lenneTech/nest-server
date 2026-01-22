import { DynamicModule, Module } from '@nestjs/common';

import { IBetterAuth } from '../../../core/common/interfaces/server-options.interface';
import { CoreBetterAuthModule } from '../../../core/modules/better-auth/core-better-auth.module';
import { BetterAuthController } from './better-auth.controller';
import { BetterAuthResolver } from './better-auth.resolver';

/**
 * Options for BetterAuthModule.forRoot()
 *
 * All options are optional when using Zero-Config:
 * All values are auto-read from ConfigService (set by CoreModule.forRoot)
 *
 * @example
 * // Zero-Config - all values auto-detected from ConfigService
 * BetterAuthModule.forRoot({})
 *
 * // Or with explicit overrides
 * BetterAuthModule.forRoot({
 *   config: { secret: 'custom-secret' },
 *   serverAppUrl: 'https://custom-app.com',
 * })
 */
export interface ServerBetterAuthModuleOptions {
  /**
   * Better-auth configuration.
   * Accepts:
   * - `true`: Enable with all defaults (including JWT)
   * - `false`: Disable BetterAuth
   * - `{ ... }`: Enable with custom configuration
   * - `undefined`: Auto-read from ConfigService (Zero-Config)
   */
  config?: boolean | IBetterAuth;

  /**
   * Fallback secrets for backwards compatibility with JWT config.
   * If no betterAuth.secret is configured, these secrets are tried in order.
   */
  fallbackSecrets?: (string | undefined)[];

  /**
   * Server-level app URL for Passkey auto-detection.
   * @see IServerOptions.appUrl
   */
  serverAppUrl?: string;

  /**
   * Server-level base URL for Passkey auto-detection.
   * @see IServerOptions.baseUrl
   */
  serverBaseUrl?: string;

  /**
   * Server environment for localhost defaults (local, ci, e2e).
   * @see IServerOptions.env
   */
  serverEnv?: string;
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
 *     CoreModule.forRoot(CoreAuthService, AuthModule.forRoot(envConfig.jwt), envConfig),
 *     // Zero-Config: All values auto-read from ConfigService
 *     BetterAuthModule.forRoot({}),
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
    const { config, fallbackSecrets, serverAppUrl, serverBaseUrl, serverEnv } = options;

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
          serverAppUrl,
          serverBaseUrl,
          serverEnv,
        }),
      ],
      module: BetterAuthModule,
      providers: [],
    };
  }
}
