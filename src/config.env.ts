import { CronExpression } from '@nestjs/schedule';
import * as dotenv from 'dotenv';
import { join } from 'path';

import { getEnvironmentConfig } from './core/common/helpers/config.helper';
import { IServerOptions } from './core/common/interfaces/server-options.interface';

/**
 * Configuration for the different environments
 * @see IServerOptions for documentation of all options
 */
dotenv.config();
const config: { [env: string]: IServerOptions } = {
  // ===========================================================================
  // CI environment
  // ===========================================================================
  ci: {
    auth: {
      legacyEndpoints: { enabled: true },
    },
    automaticObjectIdFiltering: true,
    betterAuth: {
      // Email verification disabled for test environment (no real mailbox available)
      emailVerification: false,
      // JWT enabled by default (zero-config)
      jwt: { enabled: true, expiresIn: '15m' },
      // Passkey auto-activated when URLs can be resolved (env: 'local' → localhost defaults)
      passkey: { enabled: true, origin: 'http://localhost:3001', rpId: 'localhost', rpName: 'Nest Server Local' },
      rateLimit: { enabled: true, max: 100, windowSeconds: 60 },
      secret: 'BETTER_AUTH_SECRET_LOCAL_32_CHARS_M',
      // Social providers disabled in local environment (no credentials)
      socialProviders: {
        apple: { clientId: '', clientSecret: '', enabled: false },
        github: { clientId: '', clientSecret: '', enabled: false },
        google: { clientId: '', clientSecret: '', enabled: false },
      },
      // Trusted origins for Passkey (localhost defaults)
      trustedOrigins: ['http://localhost:3000', 'http://localhost:3001'],
      // 2FA enabled for local testing
      twoFactor: { appName: 'Nest Server Local', enabled: true },
    },
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
    env: 'ci',
    // Disable auto-registration to allow Server ErrorCodeModule with SRV_* codes
    errorCode: {
      autoRegister: false,
    },
    execAfterInit: 'npm run docs:bootstrap',
    filter: {
      maxLimit: null,
    },
    graphQl: {
      driver: {
        introspection: true,
      },
      maxComplexity: 1000,
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
        secret: 'SECRET_OR_PRIVATE_KEY_LOCAL_REFRESH',
        signInOptions: {
          expiresIn: '7d',
        },
      },
      sameTokenIdPeriod: 2000,
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
      uri: 'mongodb://127.0.0.1/nest-server-ci',
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
  development: {
    auth: {
      legacyEndpoints: { enabled: true },
    },
    automaticObjectIdFiltering: true,
    baseUrl: 'http://localhost:3000',
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
      maxComplexity: 1000,
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
        secret: 'SECRET_OR_PRIVATE_KEY_DEV_REFRESH',
        signInOptions: {
          expiresIn: '7d',
        },
      },
      sameTokenIdPeriod: 2000,
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
  // E2E environment
  // ===========================================================================
  e2e: {
    auth: {
      legacyEndpoints: { enabled: true },
    },
    automaticObjectIdFiltering: true,
    betterAuth: {
      // Email verification disabled for test environment (no real mailbox available)
      emailVerification: false,
      // JWT enabled by default (zero-config)
      jwt: { enabled: true, expiresIn: '15m' },
      // Passkey auto-activated when URLs can be resolved (env: 'local' → localhost defaults)
      passkey: { enabled: true, origin: 'http://localhost:3001', rpId: 'localhost', rpName: 'Nest Server Local' },
      rateLimit: { enabled: true, max: 100, windowSeconds: 60 },
      secret: 'BETTER_AUTH_SECRET_LOCAL_32_CHARS_M',
      // Social providers disabled in local environment (no credentials)
      socialProviders: {
        apple: { clientId: '', clientSecret: '', enabled: false },
        github: { clientId: '', clientSecret: '', enabled: false },
        google: { clientId: '', clientSecret: '', enabled: false },
      },
      // Trusted origins for Passkey (localhost defaults)
      trustedOrigins: ['http://localhost:3000', 'http://localhost:3001'],
      // 2FA enabled for local testing
      twoFactor: { appName: 'Nest Server Local', enabled: true },
    },
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
    env: 'e2e',
    // Disable auto-registration to allow Server ErrorCodeModule with SRV_* codes
    errorCode: {
      autoRegister: false,
    },
    execAfterInit: 'npm run docs:bootstrap',
    filter: {
      maxLimit: null,
    },
    graphQl: {
      driver: {
        introspection: true,
      },
      maxComplexity: 1000,
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
        secret: 'SECRET_OR_PRIVATE_KEY_LOCAL_REFRESH',
        signInOptions: {
          expiresIn: '7d',
        },
      },
      sameTokenIdPeriod: 2000,
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
      uri: 'mongodb://127.0.0.1/nest-server-e2e',
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
  // Local environment (env: 'local' → auto URLs + Passkey)
  // ===========================================================================
  local: {
    auth: {
      legacyEndpoints: { enabled: true },
    },
    automaticObjectIdFiltering: true,
    compression: true,
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
    // Disable auto-registration to allow Server ErrorCodeModule with SRV_* codes
    errorCode: {
      autoRegister: false,
    },
    execAfterInit: 'npm run docs:bootstrap',
    filter: {
      maxLimit: null,
    },
    graphQl: {
      driver: {
        introspection: true,
      },
      maxComplexity: 1000,
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
        secret: 'SECRET_OR_PRIVATE_KEY_LOCAL_REFRESH',
        signInOptions: {
          expiresIn: '7d',
        },
      },
      sameTokenIdPeriod: 2000,
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
  // Production environment (set BASE_URL env var for auto Passkey)
  // ===========================================================================
  production: {
    auth: {
      legacyEndpoints: { enabled: process.env.LEGACY_AUTH_ENABLED !== 'false' },
    },
    automaticObjectIdFiltering: true,
    baseUrl: process.env.BASE_URL,
    betterAuth: {
      rateLimit: {
        enabled: process.env.RATE_LIMIT_ENABLED !== 'false',
        max: parseInt(process.env.RATE_LIMIT_MAX || '10', 10),
      },
      secret: process.env.BETTER_AUTH_SECRET,
      socialProviders: {
        github: {
          clientId: process.env.SOCIAL_GITHUB_CLIENT_ID || '',
          clientSecret: process.env.SOCIAL_GITHUB_CLIENT_SECRET || '',
        },
        google: {
          clientId: process.env.SOCIAL_GOOGLE_CLIENT_ID || '',
          clientSecret: process.env.SOCIAL_GOOGLE_CLIENT_SECRET || '',
        },
      },
      twoFactor: { appName: process.env.TWO_FACTOR_APP_NAME || 'Nest Server' },
    },
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
      maxComplexity: 1000,
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
        secret: 'SECRET_OR_PRIVATE_KEY_PROD_REFRESH',
        signInOptions: {
          expiresIn: '7d',
        },
      },
      sameTokenIdPeriod: 2000,
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
 * Export config merged with other configs and environment variables as default
 */
export default getEnvironmentConfig({ config });
