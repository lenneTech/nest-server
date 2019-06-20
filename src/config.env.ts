import { join } from 'path';
import { IServerOptions } from './core/common/interfaces/server-options.interface';

/**
 * Configuration for the different environments
 */
const config: { [env: string]: Partial<IServerOptions> } = {

  // ===========================================================================
  // Development environment
  // ===========================================================================
  development: {
    env: 'development',
    jwt: {
      secretOrPrivateKey: 'SECRET_OR_PRIVATE_KEY',
    },
    port: 3000,
    staticAssets: {
      path: join(__dirname, '..', 'public'),
      options: { prefix: '/public/' },
    },
    typeOrm: {
      type: 'mongodb',
      host: 'localhost',
      port: 27017,
      database: 'nest-server-dev',
      synchronize: true,
      entities: [__dirname + '/**/*.{entity,model}.{ts,js}'],
      useNewUrlParser: true,
    },
  },

  // ===========================================================================
  // Production environment
  // ===========================================================================
  production: {
    env: 'productive',
    port: 3000,
    jwt: {
      secretOrPrivateKey: 'SECRET_OR_PRIVATE_KEY',
    },
    staticAssets: {
      path: join(__dirname, '..', 'public'),
      options: { prefix: '/public/' },
    },
    typeOrm: {
      type: 'mongodb',
      host: 'localhost',
      port: 27017,
      database: 'nest-server-prod',
      synchronize: false, // https://typeorm.io/#/migrations/how-migrations-work
      entities: [__dirname + '/**/*.{entity,model}.{ts,js}'],
      useNewUrlParser: true,
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
