import * as dotenv from 'dotenv';
import _ = require('lodash');
import * as process from 'node:process';
import { join } from 'path';

/**
 * Helper class for configurations
 * @deprecated use functions directly
 */
export default class Config {
  /**
   * Special merge function (e.g. for configurations)
   *
   * It acts like the merge function of lodash:
   * - Source objects are merged into the destination object
   * - Source objects are applied from left to right
   * - Subsequent sources overwrite property assignments of previous sources
   *
   * except that arrays are not merged but overwrite arrays of previous sources.
   *
   * @param {any} obj destination object
   * @param {any[]} sources source objects
   * @returns {any}
   */
  public static merge(obj: Record<string, any>, ...sources: any[]): any {
    return merge(obj, sources);
  }
}

/**
 * Get environment configuration (deeply merged into config object set via options)
 *
 * The configuration is extended via deep merge in the following order:
 * 1. config[env] (if set)
 * 2.
 *
 * @param options options for processing
 * @param options.config config object with different environments as main keys (see config.env.ts) to merge environment configurations into (default: {})
 * @param options.defaultEnv default environment to use if no NODE_ENV is set (default: 'local')
 * @param options.envPath path to .env file (default: undefined => default of dotenv)
 */
export function getEnvironmentConfig(options: { config?: Record<string, any>; defaultEnv?: string; envPath?: string }) {
  const { config, defaultEnv, envPath } = {
    config: {},
    defaultEnv: 'local',
    ...options,
  };

  if (envPath) {
    dotenv.config({ path: envPath });
  } else {
    dotenv.config();
  }

  const env = process.env['NODE_ENV'] || defaultEnv;
  const envConfig = config[env] || config.local || {};

  // Merge with localConfig (e.g. config.json)
  if (envConfig.loadLocalConfig) {
    let localConfig: Record<string, any>;
    if (typeof envConfig.loadLocalConfig === 'string') {
      import(envConfig.loadLocalConfig)
        .then((loadedConfig) => {
          localConfig = loadedConfig.default || loadedConfig;
          merge(envConfig, localConfig);
        })
        .catch(() => {
          console.info(`Configuration ${envConfig.loadLocalConfig} not found!`);
        });
    } else {
      // get config from src directory
      import(join(__dirname, 'config.json'))
        .then((loadedConfig) => {
          localConfig = loadedConfig.default || loadedConfig;
          merge(envConfig, localConfig);
        })
        .catch(() => {
          // if not found try to find in project directory
          import(join(__dirname, '..', 'config.json'))
            .then((loadedConfig) => {
              localConfig = loadedConfig.default || loadedConfig;
              merge(envConfig, localConfig);
            })
            .catch(() => {
              console.info('No local config.json found!');
            });
        });
    }
  }

  // .env handling via dotenv
  if (process.env['NEST_SERVER_CONFIG']) {
    try {
      const dotEnvConfig = JSON.parse(process.env['NEST_SERVER_CONFIG']);
      if (dotEnvConfig && Object.keys(dotEnvConfig).length > 0) {
        merge(envConfig, dotEnvConfig);
        console.info('NEST_SERVER_CONFIG used from .env');
      }
    } catch (e) {
      console.error('Error parsing NEST_SERVER_CONFIG from .env: ', e);
      console.error(
        'Maybe the JSON is invalid? Please check the value of NEST_SERVER_CONFIG in .env file (e.g. via https://jsonlint.com/)',
      );
    }
  }

  // Merge with environment variables
  const environmentObject = getEnvironmentObject();
  const environmentObjectKeyCount = Object.keys(environmentObject).length;
  if (environmentObjectKeyCount > 0) {
    merge(envConfig, environmentObject);
    console.info(
      `Environment object from the environment integrated into the configuration with ${environmentObjectKeyCount} keys`,
    );
  }

  console.info(`Configured for: ${envConfig.env}${env !== envConfig.env ? ` (requested: ${env})` : ''}`);
  return envConfig;
}

/**
 * Get environment object from environment variables
 */
export function getEnvironmentObject(options?: {
  prefix?: string;
  processEnv?: Record<string, boolean | number | string>;
}) {
  const config = {
    prefix: 'NSC__',
    processEnv: process.env,
    ...options,
  };
  const output = {};

  Object.entries(config.processEnv)
    .filter(([key]) => key.startsWith(config.prefix))
    .forEach(([key, value]) => {
      // Remove prefix from key
      const adjustedKey = key.slice(config.prefix?.length || 0);

      // Convert key to path
      const path = adjustedKey.split('__').map((part) =>
        part
          .split('_')
          .map((s, i) => (i === 0 ? s.toLowerCase() : s[0].toUpperCase() + s.slice(1).toLowerCase()))
          .join(''),
      );

      // Set value in output object
      let current = output;
      for (let i = 0; i < path.length; i++) {
        const segment = path[i];
        if (i === path.length - 1) {
          // value preparation
          if (value === 'true') {
            value = true;
          } else if (value === 'false') {
            value = false;
          } else if (!isNaN(Number(value))) {
            value = Number(value);
          }

          current[segment] = value;
        } else {
          current = current[segment] = current[segment] || {};
        }
      }
    });

  return output;
}

/**
 * Special merge function (e.g. for configurations)
 *
 * It acts like the merge function of lodash:
 * - Source objects are merged into the destination object
 * - Source objects are applied from left to right
 * - Subsequent sources overwrite property assignments of previous sources
 *
 * except that arrays are not merged but overwrite arrays of previous sources.
 *
 * @param {any} obj destination object
 * @param {any[]} sources source objects
 * @returns {any}
 */
export function merge(obj: Record<string, any>, ...sources: any[]): any {
  return _.mergeWith(obj, ...sources, (objValue: any, srcValue: any) => {
    if (Array.isArray(srcValue)) {
      return srcValue;
    }
  });
}
