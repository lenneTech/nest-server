import type { IServerOptions } from '../interfaces/server-options.interface.js';
import { ConfigService } from '../services/config.service.js';
import { isLocalEnv } from './cookies.helper.js';

/**
 * Whether `setupSwagger()` serves the API documentation (`swagger`, 12.7.0+).
 *
 * | `swagger` | `local` / `ci` / `e2e` | every other environment (`develop`, `test`, `production`, …) |
 * |-----------|------------------------|---------------------------------------------------------------|
 * | not set   | served                 | **off** — none of the four paths is mounted                   |
 * | `true`    | served                 | served                                                        |
 * | `false`   | off                    | off                                                           |
 *
 * Off means nothing is mounted: neither the UI (`/swagger`, `/swagger-api-tokens`) nor the JSON documents
 * (`/api-docs-json`, `/api-docs-api-tokens-json`), so they answer 404 like any unknown route. Before 12.7.0 every
 * project that called `setupSwagger()` published the full API description on every stage, production included.
 *
 * A value that is not a boolean (the string `'true'` from `NEST_SERVER_CONFIG`) counts as not set, so a string
 * cannot switch the documentation on by truthiness; `NSC__SWAGGER=true` arrives as a boolean. The environment is the
 * configured `env`, else `NODE_ENV`, compared with `isLocalEnv()`.
 *
 * @param config - defaults to the running configuration
 * @since 12.7.0
 */
export function isSwaggerEnabled(
  config: Partial<IServerOptions> | undefined = ConfigService.configFastButReadOnly,
): boolean {
  const setting = config?.swagger;
  if (setting === true || setting === false) {
    return setting;
  }
  return isLocalEnv(config?.env ?? process.env.NODE_ENV);
}
