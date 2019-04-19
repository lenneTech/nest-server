/**
 * Configuration for the different environments
 */
const config = {

  // ===========================================================================
  // Development environment
  // ===========================================================================
  development: {
    env: 'development',
    port: 3000,
    typeOrm: {
      type: 'mongodb',
      host: 'localhost',
      port: 27017,
      database: 'uni-tools',
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
    typeOrm: {
      type: 'mongodb',
      host: 'localhost',
      port: '27017',
      database: 'uni-tools',
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
const envConfig = config[process.env.NODE_ENV || 'development'] || config['development'];

/**
 * Export envConfig as default
 */
export default envConfig;
