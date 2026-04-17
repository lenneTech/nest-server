import { CronExpression } from '@nestjs/schedule';
import * as dotenv from 'dotenv';
import { join } from 'path';

import { getEnvironmentConfig } from './core/common/helpers/config.helper';
import { IServerOptions } from './core/common/interfaces/server-options.interface';

/**
 * Configuration for the different environments
 *
 * IMPORTANT: All secrets (passwords, API keys, signing secrets) MUST come from
 * environment variables. Test environments use fallback values so tests work
 * without a .env file. Production has no fallbacks — missing secrets will cause
 * startup errors.
 *
 * @see IServerOptions for documentation of all options
 * @see .env.example for all available environment variables
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
      secret: process.env.BETTER_AUTH_SECRET || 'BETTER_AUTH_SECRET_LOCAL_32_CHARS_M',
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
    cookies: { exposeTokenInBody: true },
    cors: { allowAll: true },
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
        email: process.env.EMAIL_DEFAULT_SENDER || 'noreply@test.local',
        name: 'Nest Server CI',
      },
      smtp: {
        auth: {
          pass: process.env.SMTP_PASS || '',
          user: process.env.SMTP_USER || '',
        },
        host: process.env.SMTP_HOST || 'mailhog.lenne.tech',
        jsonTransport: !process.env.SMTP_HOST || undefined,
        port: parseInt(process.env.SMTP_PORT || '1025', 10),
        secure: false,
      },
    },
    env: 'ci',
    // Disable auto-registration to allow Server ErrorCodeModule with SRV_* codes
    errorCode: {
      autoRegister: false,
    },
    execAfterInit: 'pnpm run docs:bootstrap',
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
      refresh: {
        renewal: true,
        secret: process.env.JWT_REFRESH_SECRET || 'SECRET_OR_PRIVATE_KEY_LOCAL_REFRESH',
        signInOptions: {
          expiresIn: '7d',
        },
      },
      sameTokenIdPeriod: 2000,
      secret: process.env.JWT_SECRET || 'SECRET_OR_PRIVATE_KEY_LOCAL',
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
      modelDocumentation: false,
      uri: process.env.MONGODB_URI || 'mongodb://127.0.0.1/nest-server-ci',
    },
    permissions: true,
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
    baseUrl: process.env.BASE_URL || 'http://localhost:3000',
    betterAuth: {
      emailVerification: false,
      jwt: { enabled: true, expiresIn: '15m' },
      rateLimit: { enabled: true, max: 100, windowSeconds: 60 },
      secret: process.env.BETTER_AUTH_SECRET || 'BETTER_AUTH_SECRET_LOCAL_32_CHARS_M',
      twoFactor: { appName: 'Nest Server Dev', enabled: true },
    },
    // Brevo transactional API — optional overlay for template-based emails.
    // Activated only when BREVO_API_KEY is set; otherwise SMTP handles everything.
    ...(process.env.BREVO_API_KEY
      ? {
          brevo: {
            apiKey: process.env.BREVO_API_KEY,
            sender: {
              email: process.env.EMAIL_DEFAULT_SENDER || 'noreply@test.local',
              name: process.env.EMAIL_DEFAULT_SENDER_NAME || 'Nest Server Development',
            },
          },
        }
      : {}),
    compression: true,
    cors: { allowAll: true },
    email: {
      defaultSender: {
        email: process.env.EMAIL_DEFAULT_SENDER || 'noreply@test.local',
        name: 'Nest Server Development',
      },
      smtp: {
        auth: {
          pass: process.env.SMTP_PASS || '',
          user: process.env.SMTP_USER || '',
        },
        host: process.env.SMTP_HOST || 'mailhog.lenne.tech',
        jsonTransport: !process.env.SMTP_HOST || undefined,
        port: parseInt(process.env.SMTP_PORT || '1025', 10),
        secure: false,
      },
    },
    env: 'development',
    execAfterInit: 'pnpm run docs:bootstrap',
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
      refresh: {
        renewal: true,
        secret: process.env.JWT_REFRESH_SECRET || 'SECRET_OR_PRIVATE_KEY_DEV_REFRESH',
        signInOptions: {
          expiresIn: '7d',
        },
      },
      sameTokenIdPeriod: 2000,
      secret: process.env.JWT_SECRET || 'SECRET_OR_PRIVATE_KEY_DEV',
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
      uri: process.env.MONGODB_URI || 'mongodb://127.0.0.1/nest-server-dev',
    },
    permissions: true,
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
      secret: process.env.BETTER_AUTH_SECRET || 'BETTER_AUTH_SECRET_LOCAL_32_CHARS_M',
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
    cookies: { exposeTokenInBody: true },
    cors: { allowAll: true },
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
        email: process.env.EMAIL_DEFAULT_SENDER || 'noreply@test.local',
        name: 'Nest Server E2E',
      },
      smtp: {
        auth: {
          pass: process.env.SMTP_PASS || '',
          user: process.env.SMTP_USER || '',
        },
        host: process.env.SMTP_HOST || 'mailhog.lenne.tech',
        jsonTransport: !process.env.SMTP_HOST || undefined,
        port: parseInt(process.env.SMTP_PORT || '1025', 10),
        secure: false,
      },
    },
    env: 'e2e',
    // Disable auto-registration to allow Server ErrorCodeModule with SRV_* codes
    errorCode: {
      autoRegister: false,
    },
    execAfterInit: 'pnpm run docs:bootstrap',
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
      refresh: {
        renewal: true,
        secret: process.env.JWT_REFRESH_SECRET || 'SECRET_OR_PRIVATE_KEY_LOCAL_REFRESH',
        signInOptions: {
          expiresIn: '7d',
        },
      },
      sameTokenIdPeriod: 2000,
      secret: process.env.JWT_SECRET || 'SECRET_OR_PRIVATE_KEY_LOCAL',
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
      modelDocumentation: false,
      uri: process.env.MONGODB_URI || 'mongodb://127.0.0.1/nest-server-e2e',
    },
    permissions: true,
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
    // Brevo transactional API — optional overlay for template-based emails.
    // Activated only when BREVO_API_KEY is set; otherwise SMTP handles everything.
    ...(process.env.BREVO_API_KEY
      ? {
          brevo: {
            apiKey: process.env.BREVO_API_KEY,
            sender: {
              email: process.env.EMAIL_DEFAULT_SENDER || 'noreply@test.local',
              name: process.env.EMAIL_DEFAULT_SENDER_NAME || 'Nest Server Local',
            },
          },
        }
      : {}),
    compression: true,
    cors: { allowAll: true },
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
        email: process.env.EMAIL_DEFAULT_SENDER || 'noreply@test.local',
        name: 'Nest Server Local',
      },
      smtp: {
        auth: {
          pass: process.env.SMTP_PASS || '',
          user: process.env.SMTP_USER || '',
        },
        host: process.env.SMTP_HOST || 'mailhog.lenne.tech',
        jsonTransport: !process.env.SMTP_HOST || undefined,
        port: parseInt(process.env.SMTP_PORT || '1025', 10),
        secure: false,
      },
    },
    env: 'local',
    // Disable auto-registration to allow Server ErrorCodeModule with SRV_* codes
    errorCode: {
      autoRegister: false,
    },
    execAfterInit: 'pnpm run docs:bootstrap',
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
      refresh: {
        renewal: true,
        secret: process.env.JWT_REFRESH_SECRET || 'SECRET_OR_PRIVATE_KEY_LOCAL_REFRESH',
        signInOptions: {
          expiresIn: '7d',
        },
      },
      sameTokenIdPeriod: 2000,
      secret: process.env.JWT_SECRET || 'SECRET_OR_PRIVATE_KEY_LOCAL',
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
      uri: process.env.MONGODB_URI || 'mongodb://127.0.0.1/nest-server-local',
    },
    permissions: {
      role: false,
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
    // Brevo transactional API (optional overlay for template-based emails).
    // Activated only when BREVO_API_KEY is set — otherwise remains undefined
    // and all emails flow through the SMTP transport below.
    ...(process.env.BREVO_API_KEY
      ? {
          brevo: {
            apiKey: process.env.BREVO_API_KEY,
            sender: {
              email: process.env.EMAIL_DEFAULT_SENDER || 'noreply@example.com',
              name: process.env.EMAIL_DEFAULT_SENDER_NAME || 'Nest Server',
            },
          },
        }
      : {}),
    compression: true,
    cors: {
      allowedOrigins: process.env.CORS_ALLOWED_ORIGINS?.split(',').filter(Boolean),
    },
    email: {
      defaultSender: {
        email: process.env.EMAIL_DEFAULT_SENDER || 'noreply@example.com',
        name: process.env.EMAIL_DEFAULT_SENDER_NAME || 'Nest Server',
      },
      smtp: {
        auth: {
          pass: process.env.SMTP_PASS,
          user: process.env.SMTP_USER,
        },
        host: process.env.SMTP_HOST,
        port: parseInt(process.env.SMTP_PORT || '587', 10),
        secure: process.env.SMTP_SECURE !== 'false',
      },
    },
    env: 'production',
    execAfterInit: 'pnpm run docs:bootstrap',
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
      refresh: {
        renewal: true,
        secret: process.env.JWT_REFRESH_SECRET,
        signInOptions: {
          expiresIn: '7d',
        },
      },
      sameTokenIdPeriod: 2000,
      secret: process.env.JWT_SECRET,
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
      // No fallback in production — missing MONGODB_URI must cause immediate startup failure
      // to prevent accidental connection to localhost (silent data-integrity risk).
      uri: process.env.MONGODB_URI,
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
