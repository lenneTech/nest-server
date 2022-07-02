import { CronExpression } from '@nestjs/schedule';
import { join } from 'path';
import { IServerOptions } from './core/common/interfaces/server-options.interface';

/**
 * Configuration for the different environments
 */
const config: { [env: string]: IServerOptions } = {
  // ===========================================================================
  // Local environment
  // ===========================================================================
  local: {
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
          user: 'rebeca68@ethereal.email',
          pass: 'v5WUScAN98AzGbRjpc',
        },
        host: 'smtp.ethereal.email',
        port: 587,
        secure: false,
      },
      mailjet: {
        api_key_public: 'MAILJET_API_KEY_PUBLIC',
        api_key_private: 'MAILJET_API_KEY_PRIVATE',
      },
      defaultSender: {
        email: 'rebeca68@ethereal.email',
        name: 'Rebeca Sixtyeight',
      },
      verificationLink: 'http://localhost:4200/user/verification',
      passwordResetLink: 'http://localhost:4200/user/password-reset',
    },
    env: 'local',
    execAfterInit: 'npm run docs:bootstrap',
    graphQl: {
      driver: {
        debug: true,
        introspection: true,
      },
    },
    jwt: {
      secret: 'SECRET_OR_PRIVATE_KEY_DEV',
    },
    mongoose: {
      uri: 'mongodb://localhost/nest-server-dev',
    },
    port: 3000,
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
    email: {
      smtp: {
        auth: {
          user: 'rebeca68@ethereal.email',
          pass: 'v5WUScAN98AzGbRjpc',
        },
        host: 'smtp.ethereal.email',
        port: 587,
        secure: false,
      },
      mailjet: {
        api_key_public: 'MAILJET_API_KEY_PUBLIC',
        api_key_private: 'MAILJET_API_KEY_PRIVATE',
      },
      defaultSender: {
        email: 'rebeca68@ethereal.email',
        name: 'Rebeca Sixtyeight',
      },
      verificationLink: 'http://localhost:4200/user/verification',
      passwordResetLink: 'http://localhost:4200/user/password-reset',
    },
    env: 'development',
    execAfterInit: 'npm run docs:bootstrap',
    graphQl: {
      driver: {
        debug: true,
        introspection: true,
      },
    },
    jwt: {
      secret: 'SECRET_OR_PRIVATE_KEY_DEV',
    },
    mongoose: {
      uri: 'mongodb://localhost/nest-server-dev',
    },
    port: 3000,
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
    email: {
      smtp: {
        auth: {
          user: 'rebeca68@ethereal.email',
          pass: 'v5WUScAN98AzGbRjpc',
        },
        host: 'smtp.ethereal.email',
        port: 587,
        secure: false,
      },
      mailjet: {
        api_key_public: 'MAILJET_API_KEY_PUBLIC',
        api_key_private: 'MAILJET_API_KEY_PRIVATE',
      },
      defaultSender: {
        email: 'rebeca68@ethereal.email',
        name: 'Rebeca Sixtyeight',
      },
      verificationLink: 'http://localhost:4200/user/verification',
      passwordResetLink: 'http://localhost:4200/user/password-reset',
    },
    env: 'productive',
    execAfterInit: 'npm run docs:bootstrap',
    graphQl: {
      driver: {
        debug: false,
        introspection: true,
      },
    },
    jwt: {
      secret: 'SECRET_OR_PRIVATE_KEY_PROD',
    },
    mongoose: {
      uri: 'mongodb://localhost/nest-server-prod',
    },
    port: 3000,
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

/**
 * Export envConfig as default
 */
export default envConfig;
