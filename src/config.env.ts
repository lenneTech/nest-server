import { join } from 'path';
import { IServerOptions } from './core/common/interfaces/server-options.interface';

/**
 * Configuration for the different environments
 */
const config: { [env: string]: IServerOptions } = {
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
      defaultSender: {
        email: 'rebeca68@ethereal.email',
        name: 'Rebeca Sixtyeight',
      },
      verificationLink: 'http://localhost:4200/user/verification',
      passwordResetLink: 'http://localhost:4200/user/password-reset',
    },
    env: 'development',
    graphQl: {
      debug: true,
      introspection: true,
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
      options: { prefix: '/public/' },
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
      defaultSender: {
        email: 'rebeca68@ethereal.email',
        name: 'Rebeca Sixtyeight',
      },
      verificationLink: 'http://localhost:4200/user/verification',
      passwordResetLink: 'http://localhost:4200/user/password-reset',
    },
    env: 'productive',
    graphQl: {
      debug: false,
      introspection: true,
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
      options: { prefix: '/public/' },
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
const envConfig = config[process.env['NODE' + '_ENV'] || 'development'] || config.development;
console.log('Server starts in mode: ', process.env['NODE' + '_ENV'] || 'development');

/**
 * Export envConfig as default
 */
export default envConfig;
