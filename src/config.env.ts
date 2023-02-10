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
  local: {
    automaticObjectIdFiltering: true,
    cronJobs: {
      sayHello: {
        cronTime: CronExpression.EVERY_10_SECONDS,
        runOnInit: false,
        runParallel: 1,
        timeZone: 'Europe/Berlin',
        throwException: false,
      },
    },
    email: {
      smtp: {
        auth: {
          user: 'oren.satterfield@ethereal.email',
          pass: 'K4DvD8U31VKseT7vQC',
        },
        host: 'mailhog.lenne.tech',
        port: 1025,
        secure: false,
      },
      mailjet: {
        api_key_public: 'MAILJET_API_KEY_PUBLIC',
        api_key_private: 'MAILJET_API_KEY_PRIVATE',
      },
      defaultSender: {
        email: 'oren.satterfield@ethereal.email',
        name: 'Nest Server Local',
      },
      verificationLink: 'http://localhost:4200/user/verification',
      passwordResetLink: 'http://localhost:4200/user/password-reset',
    },
    env: 'local',
    execAfterInit: 'npm run docs:bootstrap',
    filter: {
      maxLimit: null,
    },
    graphQl: {
      driver: {
        debug: true,
        introspection: true,
      },
      maxComplexity: 20,
    },
    jwt: {
      secret: 'SECRET_OR_PRIVATE_KEY_DEV',
    },
    loadLocalConfig: false,
    mongoose: {
      collation: {
        locale: 'de',
      },
      uri: 'mongodb://127.0.0.1/nest-server-dev',
    },
    port: 3000,
    sha256: true,
    staticAssets: {
      path: join(__dirname, '..', 'public'),
      options: { prefix: '' },
    },
    templates: {
      path: join(__dirname, 'templates'),
      engine: 'ejs',
    },
  },

  // ===========================================================================
  // Development environment
  // ===========================================================================
  development: {
    automaticObjectIdFiltering: true,
    email: {
      smtp: {
        auth: {
          user: 'oren.satterfield@ethereal.email',
          pass: 'K4DvD8U31VKseT7vQC',
        },
        host: 'mailhog.lenne.tech',
        port: 1025,
        secure: false,
      },
      mailjet: {
        api_key_public: 'MAILJET_API_KEY_PUBLIC',
        api_key_private: 'MAILJET_API_KEY_PRIVATE',
      },
      defaultSender: {
        email: 'oren.satterfield@ethereal.email',
        name: 'Nest Server Development',
      },
      verificationLink: 'http://localhost:4200/user/verification',
      passwordResetLink: 'http://localhost:4200/user/password-reset',
    },
    env: 'development',
    execAfterInit: 'npm run docs:bootstrap',
    filter: {
      maxLimit: null,
    },
    graphQl: {
      driver: {
        debug: true,
        introspection: true,
      },
      maxComplexity: 20,
    },
    jwt: {
      secret: 'SECRET_OR_PRIVATE_KEY_DEV',
    },
    loadLocalConfig: false,
    mongoose: {
      collation: {
        locale: 'de',
      },
      uri: 'mongodb://127.0.0.1/nest-server-dev',
    },
    port: 3000,
    sha256: true,
    staticAssets: {
      path: join(__dirname, '..', 'public'),
      options: { prefix: '' },
    },
    templates: {
      path: join(__dirname, 'templates'),
      engine: 'ejs',
    },
  },

  // ===========================================================================
  // Production environment
  // ===========================================================================
  production: {
    automaticObjectIdFiltering: true,
    email: {
      smtp: {
        auth: {
          user: 'oren.satterfield@ethereal.email',
          pass: 'K4DvD8U31VKseT7vQC',
        },
        host: 'mailhog.lenne.tech',
        port: 1025,
        secure: false,
      },
      mailjet: {
        api_key_public: 'MAILJET_API_KEY_PUBLIC',
        api_key_private: 'MAILJET_API_KEY_PRIVATE',
      },
      defaultSender: {
        email: 'oren.satterfield@ethereal.email',
        name: 'Nest Server Production',
      },
      verificationLink: 'http://localhost:4200/user/verification',
      passwordResetLink: 'http://localhost:4200/user/password-reset',
    },
    env: 'production',
    execAfterInit: 'npm run docs:bootstrap',
    filter: {
      maxLimit: null,
    },
    graphQl: {
      driver: {
        debug: false,
        introspection: true,
      },
      maxComplexity: 20,
    },
    jwt: {
      secret: 'SECRET_OR_PRIVATE_KEY_PROD',
    },
    loadLocalConfig: false,
    mongoose: {
      collation: {
        locale: 'de',
      },
      uri: 'mongodb://127.0.0.1/nest-server-prod',
    },
    port: 3000,
    sha256: true,
    staticAssets: {
      path: join(__dirname, '..', 'public'),
      options: { prefix: '' },
    },
    templates: {
      path: join(__dirname, 'templates'),
      engine: 'ejs',
    },
  },
};

/**
 * Environment specific config
 *
 * default: development
 */
const env = process.env['NODE' + '_ENV'] || 'development';
const envConfig = config[env] || config.development;
console.info('Configured for: ' + envConfig.env + (env !== envConfig.env ? ' (requested: ' + env + ')' : ''));

// Merge with localConfig (e.g. config.json)
if (envConfig.loadLocalConfig) {
  let localConfig;
  if (typeof envConfig.loadLocalConfig === 'string') {
    localConfig = require(envConfig.loadLocalConfig);
    merge(envConfig, localConfig);
  } else {
    try {
      // get config from src directory
      localConfig = require(__dirname + '/config.json');
      merge(envConfig, localConfig);
    } catch {
      try {
        // if not found try to find in project directory
        localConfig = require(__dirname + '/../config.json');
        merge(envConfig, localConfig);
      } catch (e) {
        // No config.json found => nothing to do
      }
    }
  }
}

/**
 * Export envConfig as default
 */
export default envConfig;
