import { NotFoundException } from '@nestjs/common';

import type { IServerOptions } from '../interfaces/server-options.interface.js';
import { ConfigService } from '../services/config.service.js';
import { isLocalEnv } from './cookies.helper.js';

/**
 * Whether a project's `GET /config` may answer (`configEndpoint`, 12.5.0+).
 *
 * | `configEndpoint` | `local` / `ci` / `e2e` | every other environment (`develop`, `test`, `production`, …) |
 * |------------------|------------------------|---------------------------------------------------------------|
 * | not set          | answers                | **404**                                                       |
 * | `true`           | answers                | answers                                                       |
 * | `false`          | 404                    | 404                                                           |
 *
 * Answering always means the REDACTED configuration ({@link configEndpointResponse}). A value that is not a boolean
 * (the string `'true'` from `NEST_SERVER_CONFIG`) counts as not set, so a string cannot open the endpoint by
 * truthiness. The environment is the configured `env`, else `NODE_ENV`, compared with {@link isLocalEnv}.
 *
 * @param config - defaults to the running configuration
 * @since 12.5.0
 */
export function isConfigEndpointEnabled(
  config: Partial<IServerOptions> | undefined = ConfigService.configFastButReadOnly,
): boolean {
  const setting = config?.configEndpoint;
  if (setting === true || setting === false) {
    return setting;
  }
  return isLocalEnv(config?.env ?? process.env.NODE_ENV);
}

/**
 * The body of a project's `GET /config`: the redacted configuration, or a 404 where `configEndpoint` keeps the
 * endpoint closed ({@link isConfigEndpointEnabled}).
 *
 * 404 rather than 403, so a closed endpoint reads like one that does not exist. The route's own `@Roles(ADMIN)`
 * still runs first, so an anonymous caller keeps getting 401.
 *
 * ```typescript
 * @Get('config')
 * @Roles(RoleEnum.ADMIN)
 * config() {
 *   return configEndpointResponse();
 * }
 * ```
 *
 * @throws NotFoundException when the endpoint is closed in this environment
 * @since 12.5.0
 */
export function configEndpointResponse(): Record<string, unknown> {
  if (!isConfigEndpointEnabled(ConfigService.configFastButReadOnly)) {
    throw new NotFoundException();
  }
  return ConfigService.getRedactedConfig();
}
