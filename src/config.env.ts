import { CronExpression } from '@nestjs/schedule';
import * as dotenv from 'dotenv';
import { join } from 'path';

import { getEnvironmentConfig } from './core/common/helpers/config.helper';
import { IServerOptions } from './core/common/interfaces/server-options.interface';

/**
 * Configuration for the different environments
 */
dotenv.config();
const config: { [env: string]: IServerOptions } = {
  // ===========================================================================
  // Development environment
  // ===========================================================================
  development: {
    // Legacy Auth endpoint controls (for migration to BetterAuth)
    // Set to false after all users have migrated to BetterAuth (IAM)
    // See: .claude/rules/module-deprecation.md
    auth: {
      legacyEndpoints: {
        enabled: true, // Set to false to disable legacy auth endpoints (returns HTTP 410)
        // graphql: true, // Optionally disable only GraphQL endpoints
        // rest: true,    // Optionally disable only REST endpoints
      },
    },
    automaticObjectIdFiltering: true,
    betterAuth: {
      basePath: '/iam',
      baseUrl: 'http://localhost:3000',
      // enabled: true by default - set false to explicitly disable
      jwt: {
        enabled: true,
        expiresIn: '15m',
      },
      passkey: {
        enabled: false,
        origin: 'http://localhost:3000',
        rpId: 'localhost',
        rpName: 'Nest Server Development',
      },
      rateLimit: {
        enabled: true,
        max: 20,
        message: 'Too many requests, please try again later.',
        skipEndpoints: ['/session', '/callback'],
        strictEndpoints: ['/sign-in', '/sign-up', '/forgot-password', '/reset-password'],
        windowSeconds: 60,
      },
      secret: 'BETTER_AUTH_SECRET_DEV_32_CHARS_MIN',
      socialProviders: {
        apple: {
          clientId: process.env.SOCIAL_APPLE_CLIENT_ID || '',
          clientSecret: process.env.SOCIAL_APPLE_CLIENT_SECRET || '',
          enabled: false,
        },
        github: {
          clientId: process.env.SOCIAL_GITHUB_CLIENT_ID || '',
          clientSecret: process.env.SOCIAL_GITHUB_CLIENT_SECRET || '',
          enabled: false,
        },
        google: {
          clientId: process.env.SOCIAL_GOOGLE_CLIENT_ID || '',
          clientSecret: process.env.SOCIAL_GOOGLE_CLIENT_SECRET || '',
          enabled: false,
        },
      },
      twoFactor: {
        appName: 'Nest Server Development',
        enabled: false,
      },
    },
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
  // Local environment
  // ===========================================================================
  local: {
    // Legacy Auth endpoint controls (for migration to BetterAuth)
    // Set to false after all users have migrated to BetterAuth (IAM)
    // See: .claude/rules/module-deprecation.md
    auth: {
      legacyEndpoints: {
        enabled: true, // Set to false to disable legacy auth endpoints (returns HTTP 410)
        // graphql: true, // Optionally disable only GraphQL endpoints
        // rest: true,    // Optionally disable only REST endpoints
      },
    },
    automaticObjectIdFiltering: true,
    betterAuth: {
      basePath: '/iam',
      baseUrl: 'http://localhost:3000',
      enabled: true, // Enable for Scenario 2 (Legacy + IAM) testing
      jwt: {
        enabled: true,
        expiresIn: '15m',
      },
      passkey: {
        enabled: true,
        origin: 'http://localhost:3000',
        rpId: 'localhost',
        rpName: 'Nest Server Local',
      },
      rateLimit: {
        enabled: true,
        max: 100, // Higher limit for local testing
        message: 'Too many requests, please try again later.',
        skipEndpoints: ['/session', '/callback'],
        strictEndpoints: ['/sign-in', '/sign-up', '/forgot-password', '/reset-password'],
        windowSeconds: 60,
      },
      secret: 'BETTER_AUTH_SECRET_LOCAL_32_CHARS_M',
      socialProviders: {
        apple: {
          clientId: process.env.SOCIAL_APPLE_CLIENT_ID || '',
          clientSecret: process.env.SOCIAL_APPLE_CLIENT_SECRET || '',
          enabled: false,
        },
        github: {
          clientId: process.env.SOCIAL_GITHUB_CLIENT_ID || '',
          clientSecret: process.env.SOCIAL_GITHUB_CLIENT_SECRET || '',
          enabled: false,
        },
        google: {
          clientId: process.env.SOCIAL_GOOGLE_CLIENT_ID || '',
          clientSecret: process.env.SOCIAL_GOOGLE_CLIENT_SECRET || '',
          enabled: false,
        },
      },
      twoFactor: {
        appName: 'Nest Server Local',
        enabled: true,
      },
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
    env: 'local',
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
    // Legacy Auth endpoint controls (for migration to BetterAuth)
    // Set to false after all users have migrated to BetterAuth (IAM)
    // See: .claude/rules/module-deprecation.md
    auth: {
      legacyEndpoints: {
        enabled: process.env.LEGACY_AUTH_ENABLED !== 'false', // Disable via env var
        // graphql: true, // Optionally disable only GraphQL endpoints
        // rest: true,    // Optionally disable only REST endpoints
      },
    },
    automaticObjectIdFiltering: true,
    betterAuth: {
      basePath: '/iam',
      baseUrl: process.env.BETTER_AUTH_URL || 'https://example.com',
      // enabled: true by default - set false to explicitly disable
      jwt: {
        enabled: true,
        expiresIn: '15m',
      },
      passkey: {
        enabled: false,
        origin: process.env.BETTER_AUTH_URL || 'https://example.com',
        rpId: process.env.PASSKEY_RP_ID || 'example.com',
        rpName: process.env.PASSKEY_RP_NAME || 'Nest Server Production',
      },
      rateLimit: {
        enabled: process.env.RATE_LIMIT_ENABLED !== 'false',
        max: parseInt(process.env.RATE_LIMIT_MAX || '10', 10),
        message: process.env.RATE_LIMIT_MESSAGE || 'Too many requests, please try again later.',
        skipEndpoints: ['/session', '/callback'],
        strictEndpoints: ['/sign-in', '/sign-up', '/forgot-password', '/reset-password'],
        windowSeconds: parseInt(process.env.RATE_LIMIT_WINDOW_SECONDS || '60', 10),
      },
      // IMPORTANT: Set BETTER_AUTH_SECRET in production!
      // Without it, an insecure default is used which allows session forgery.
      // Generate with: node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
      secret: process.env.BETTER_AUTH_SECRET,
      socialProviders: {
        apple: {
          clientId: process.env.SOCIAL_APPLE_CLIENT_ID || '',
          clientSecret: process.env.SOCIAL_APPLE_CLIENT_SECRET || '',
          enabled: !!process.env.SOCIAL_APPLE_CLIENT_ID,
        },
        github: {
          clientId: process.env.SOCIAL_GITHUB_CLIENT_ID || '',
          clientSecret: process.env.SOCIAL_GITHUB_CLIENT_SECRET || '',
          enabled: !!process.env.SOCIAL_GITHUB_CLIENT_ID,
        },
        google: {
          clientId: process.env.SOCIAL_GOOGLE_CLIENT_ID || '',
          clientSecret: process.env.SOCIAL_GOOGLE_CLIENT_SECRET || '',
          enabled: !!process.env.SOCIAL_GOOGLE_CLIENT_ID,
        },
      },
      twoFactor: {
        appName: process.env.TWO_FACTOR_APP_NAME || 'Nest Server',
        enabled: process.env.TWO_FACTOR_ENABLED === 'true',
      },
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
 * Export config merged with other configs and environment variables as default
 */
export default getEnvironmentConfig({ config });
