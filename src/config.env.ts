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
    },
    env: 'development',
    graphQl: {
      debug: true,
      introspection: true,
    },
    jwt: {
      secret: 'SECRET_OR_PRIVATE_KEY_DEV',
    },
    mikroOrm: {
      autoLoadEntities: true,
      dbName: 'nest-server-dev',
      host: 'localhost',
      port: 27017,
      type: 'mongo',
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
    },
    env: 'productive',
    graphQl: {
      debug: false,
      introspection: true,
      playground: false,
    },
    jwt: {
      secret: 'SECRET_OR_PRIVATE_KEY_PROD',
    },
    mikroOrm: {
      autoLoadEntities: true,
      dbName: 'nest-server-prod',
      host: 'localhost',
      port: 27017,
      type: 'mongo',
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
const envConfig = config[process.env.NODE_ENV || 'development'] || config.development;

/**
 * Export envConfig as default
 */
export default envConfig;
