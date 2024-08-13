import { CronExpression } from '@nestjs/schedule';
import { join } from 'path';

import { merge } from './core/common/helpers/config.helper';
import { IServerOptions } from './core/common/interfaces/server-options.interface';

/**
 * Configuration for the different environments
 */
const config: { [env: string]: IServerOptions } = {
  // ===========================================================================
  // Local environment
  // ===========================================================================
  development: {
    automaticObjectIdFiltering: true,
    compression: true,
    cookies: false,
    email: {
      defaultSender: {
        email: 'oren.satterfield@ethereal.email',
        name: 'Nest Server Development',
      },
      mailjet: {
        api_key_private: 'MAILJET_API_KEY_PRIVATE',
        api_key_public: 'MAILJET_API_KEY_PUBLIC',
      },
      passwordResetLink: 'http://localhost:4200/user/password-reset',
      smtp: {
        auth: {
          pass: 'K4DvD8U31VKseT7vQC',
          user: 'oren.satterfield@ethereal.email',
        },
        host: 'mailhog.lenne.tech',
        port: 1025,
        secure: false,
      },
      verificationLink: 'http://localhost:4200/user/verification',
    },
    env: 'development',
    execAfterInit: 'npm run docs:bootstrap',
    filter: {
      maxLimit: null,
    },
    graphQl: {
      driver: {
        introspection: true,
      },
      maxComplexity: 20,
    },
    healthCheck: {
      configs: {
        database: {
          enabled: true,
        },
      },
      enabled: true,
    },
    ignoreSelectionsForPopulate: true,
    jwt: {
      // Each secret should be unique and not reused in other environments,
      // also the JWT secret should be different from the Refresh secret!
      // crypto.randomBytes(512).toString('base64') (see https://nodejs.org/api/crypto.html#crypto)
      refresh: {
        renewal: true,
        // Each secret should be unique and not reused in other environments,
        // also the JWT secret should be different from the Refresh secret!
        // crypto.randomBytes(512).toString('base64') (see https://nodejs.org/api/crypto.html#crypto)
        // tslint:disable-next-line:max-line-length
        secret: 'SECRET_OR_PRIVATE_KEY_DEV_REFRESH',
        signInOptions: {
          expiresIn: '7d',
        },
      },
      sameTokenIdPeriod: 2000,
      // tslint:disable-next-line:max-line-length
      secret: 'SECRET_OR_PRIVATE_KEY_DEV',
      signInOptions: {
        expiresIn: '15m',
      },
    },
    loadLocalConfig: false,
    logExceptions: true,
    mongoose: {
      collation: {
        locale: 'de',
      },
      modelDocumentation: false,
      uri: 'mongodb://127.0.0.1/nest-server-dev',
    },
    port: 3000,
    security: {
      checkResponseInterceptor: {
        checkObjectItself: false,
        debug: false,
        ignoreUndefined: true,
        mergeRoles: true,
        removeUndefinedFromResultArray: true,
        throwError: false,
      },
      checkSecurityInterceptor: true,
      mapAndValidatePipe: true,
    },
    sha256: true,
    staticAssets: {
      options: { prefix: '' },
      path: join(__dirname, '..', 'public'),
    },
    templates: {
      engine: 'ejs',
      path: join(__dirname, 'templates'),
    },
  },

  // ===========================================================================
  // Development environment
  // ===========================================================================
  local: {
    automaticObjectIdFiltering: true,
    compression: true,
    cookies: false,
    cronJobs: {
      sayHello: {
        cronTime: CronExpression.EVERY_10_SECONDS,
        disabled: false,
        runOnInit: false,
        runParallel: 1,
        throwException: false,
        timeZone: 'Europe/Berlin',
      },
    },
    email: {
      defaultSender: {
        email: 'oren.satterfield@ethereal.email',
        name: 'Nest Server Local',
      },
      mailjet: {
        api_key_private: 'MAILJET_API_KEY_PRIVATE',
        api_key_public: 'MAILJET_API_KEY_PUBLIC',
      },
      passwordResetLink: 'http://localhost:4200/user/password-reset',
      smtp: {
        auth: {
          pass: 'K4DvD8U31VKseT7vQC',
          user: 'oren.satterfield@ethereal.email',
        },
        host: 'mailhog.lenne.tech',
        port: 1025,
        secure: false,
      },
      verificationLink: 'http://localhost:4200/user/verification',
    },
    env: 'local',
    execAfterInit: 'npm run docs:bootstrap',
    filter: {
      maxLimit: null,
    },
    graphQl: {
      driver: {
        introspection: true,
      },
      maxComplexity: 20,
    },
    healthCheck: {
      configs: {
        database: {
          enabled: true,
        },
      },
      enabled: true,
    },
    hostname: '127.0.0.1',
    ignoreSelectionsForPopulate: true,
    jwt: {
      // Each secret should be unique and not reused in other environments,
      // also the JWT secret should be different from the Refresh secret!
      // crypto.randomBytes(512).toString('base64') (see https://nodejs.org/api/crypto.html#crypto)
      refresh: {
        renewal: true,
        // Each secret should be unique and not reused in other environments,
        // also the JWT secret should be different from the Refresh secret!
        // crypto.randomBytes(512).toString('base64') (see https://nodejs.org/api/crypto.html#crypto)
        // tslint:disable-next-line:max-line-length
        secret: 'SECRET_OR_PRIVATE_KEY_LOCAL_REFRESH',
        signInOptions: {
          expiresIn: '7d',
        },
      },
      sameTokenIdPeriod: 2000,
      // tslint:disable-next-line:max-line-length
      secret: 'SECRET_OR_PRIVATE_KEY_LOCAL',
      signInOptions: {
        expiresIn: '15m',
      },
    },
    loadLocalConfig: true,
    logExceptions: true,
    mongoose: {
      collation: {
        locale: 'de',
      },
      modelDocumentation: true,
      uri: 'mongodb://127.0.0.1/nest-server-local',
    },
    port: 3000,
    security: {
      checkResponseInterceptor: {
        checkObjectItself: false,
        debug: false,
        ignoreUndefined: true,
        mergeRoles: true,
        removeUndefinedFromResultArray: true,
        throwError: false,
      },
      checkSecurityInterceptor: true,
      mapAndValidatePipe: true,
    },
    sha256: true,
    staticAssets: {
      options: { prefix: '' },
      path: join(__dirname, '..', 'public'),
    },
    templates: {
      engine: 'ejs',
      path: join(__dirname, 'templates'),
    },
  },

  // ===========================================================================
  // Production environment
  // ===========================================================================
  production: {
    automaticObjectIdFiltering: true,
    compression: true,
    cookies: false,
    email: {
      defaultSender: {
        email: 'oren.satterfield@ethereal.email',
        name: 'Nest Server Production',
      },
      mailjet: {
        api_key_private: 'MAILJET_API_KEY_PRIVATE',
        api_key_public: 'MAILJET_API_KEY_PUBLIC',
      },
      passwordResetLink: 'http://localhost:4200/user/password-reset',
      smtp: {
        auth: {
          pass: 'K4DvD8U31VKseT7vQC',
          user: 'oren.satterfield@ethereal.email',
        },
        host: 'mailhog.lenne.tech',
        port: 1025,
        secure: false,
      },
      verificationLink: 'http://localhost:4200/user/verification',
    },
    env: 'production',
    execAfterInit: 'npm run docs:bootstrap',
    filter: {
      maxLimit: null,
    },
    graphQl: {
      driver: {
        introspection: true,
      },
      maxComplexity: 20,
    },
    healthCheck: {
      configs: {
        database: {
          enabled: true,
        },
      },
      enabled: true,
    },
    ignoreSelectionsForPopulate: true,
    jwt: {
      // Each secret should be unique and not reused in other environments,
      // also the JWT secret should be different from the Refresh secret!
      // crypto.randomBytes(512).toString('base64') (see https://nodejs.org/api/crypto.html#crypto)
      refresh: {
        renewal: true,
        // Each secret should be unique and not reused in other environments,
        // also the JWT secret should be different from the Refresh secret!
        // crypto.randomBytes(512).toString('base64') (see https://nodejs.org/api/crypto.html#crypto)
        // tslint:disable-next-line:max-line-length
        secret: 'SECRET_OR_PRIVATE_KEY_PROD_REFRESH',
        signInOptions: {
          expiresIn: '7d',
        },
      },
      sameTokenIdPeriod: 2000,
      // tslint:disable-next-line:max-line-length
      secret: 'SECRET_OR_PRIVATE_KEY_PROD',
      signInOptions: {
        expiresIn: '15m',
      },
    },
    loadLocalConfig: false,
    logExceptions: true,
    mongoose: {
      collation: {
        locale: 'de',
      },
      modelDocumentation: false,
      uri: 'mongodb://127.0.0.1/nest-server-prod',
    },
    port: 3000,
    security: {
      checkResponseInterceptor: {
        checkObjectItself: false,
        debug: false,
        ignoreUndefined: true,
        mergeRoles: true,
        removeUndefinedFromResultArray: true,
        throwError: false,
      },
      checkSecurityInterceptor: true,
      mapAndValidatePipe: true,
    },
    sha256: true,
    staticAssets: {
      options: { prefix: '' },
      path: join(__dirname, '..', 'public'),
    },
    templates: {
      engine: 'ejs',
      path: join(__dirname, 'templates'),
    },
  },
};

/**
 * Environment specific config
 *
 * default: local
 */
const env = process.env['NODE' + '_ENV'] || 'local';
const envConfig = config[env] || config.local;
console.info(`Configured for: ${envConfig.env}${env !== envConfig.env ? ` (requested: ${env})` : ''}`);
// Merge with localConfig (e.g. config.json)
if (envConfig.loadLocalConfig) {
  let localConfig;
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

/**
 * Export envConfig as default
 */
export default envConfig;
