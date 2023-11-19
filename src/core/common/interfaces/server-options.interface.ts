import { ApolloDriverConfig } from '@nestjs/apollo';
import { GqlModuleAsyncOptions } from '@nestjs/graphql';
import { JwtModuleOptions } from '@nestjs/jwt';
import { JwtSignOptions } from '@nestjs/jwt/dist/interfaces';
import { MongooseModuleOptions } from '@nestjs/mongoose';
import { ServeStaticOptions } from '@nestjs/platform-express/interfaces/serve-static-options.interface';
import { CronExpression } from '@nestjs/schedule';
import compression from 'compression';
import { CollationOptions } from 'mongodb';
import * as SMTPTransport from 'nodemailer/lib/smtp-transport';
import { MongoosePingCheckSettings } from '@nestjs/terminus/dist/health-indicator/database/mongoose.health';
import { DiskHealthIndicatorOptions } from '@nestjs/terminus/dist/health-indicator/disk/disk-health-options.type';
import { Falsy } from '../types/falsy.type';
import { CronJobConfigWithTimeZone } from './cron-job-config-with-time-zone.interface';
import { CronJobConfigWithUtcOffset } from './cron-job-config-with-utc-offset.interface';
import { MailjetOptions } from './mailjet-options.interface';

/**
 * Interface for JWT configuration (main and refresh)
 */
export interface IJwt {
  /**
   * Private key
   */
  privateKey?: string;

  /**
   * Public key
   */
  publicKey?: string;

  /**
   * Secret to encrypt the JWT
   * Each secret should be unique and not reused in other environments,
   * also the JWT secret should be different from the Refresh secret!
   */
  secret?: string;

  /**
   * JWT Provider
   * See https://github.com/mikenicholson/passport-jwt/blob/master/README.md#configure-strategy
   */
  secretOrKeyProvider?: (
    request: Record<string, any>,
    rawJwtToken: string,
    done: (err: any, secret: string) => any
  ) => any;

  /**
   * Alias of secret (for backwards compatibility)
   */
  secretOrPrivateKey?: string;

  /**
   * SignIn Options like expiresIn
   */
  signInOptions?: JwtSignOptions;
}

/**
 * Options for the server
 */
export interface IServerOptions {
  /**
   * Automatically detect ObjectIds in string values in FilterQueries
   * and expand them as OR query with string and ObjectId.
   * Fields with the name "id" are renamed to "_id" and the value is converted to ObjectId,
   * without changing the filter into an OR combined filter.
   * See generateFilterQuery in Filter helper (src/core/common/helpers/filter.helper.ts)
   */
  automaticObjectIdFiltering?: boolean;

  /**
   * Whether to use the compression middleware package to enable gzip compression.
   * See: https://docs.nestjs.com/techniques/compression
   */
  compression?: boolean | compression.CompressionOptions;

  /**
   * Whether to use cookies for authentication handling
   * See: https://docs.nestjs.com/techniques/cookies
   */
  cookies?: boolean;

  /**
   * Cron jobs configuration object with the name of the cron job function as key
   * and the cron expression or config as value
   */
  cronJobs?: Record<string, CronExpression | string | Date | Falsy | CronJobConfigWithTimeZone | CronJobConfigWithUtcOffset>;

  /**
   * SMTP and template configuration for sending emails
   */
  email?: {
    /**
     * Data for default sender
     */
    defaultSender?: {
      /**
       * Default email for sending emails
       */
      email?: string;

      /**
       * Default name for sending emails
       */
      name?: string;
    };

    /**
     * Options for Mailjet
     */
    mailjet?: MailjetOptions;

    /**
     * Password reset link for email
     */
    passwordResetLink?: string;

    /**
     * SMTP configuration for nodemailer
     */
    smtp?: SMTPTransport | SMTPTransport.Options | string;

    /**
     * Verification link for email
     */
    verificationLink?: string;
  };

  /**
   * Environment
   * e.g. 'development'
   */
  env?: string;

  /**
   * Exec a command after server is initialized
   * e.g. 'npm run docs:bootstrap'
   */
  execAfterInit?: string;

  /**
   * Filter configuration and defaults
   */
  filter?: {
    /**
     * Maximum limit for the number of results
     */
    maxLimit?: number;
  };

  /**
   * Configuration of the GraphQL module
   * see https://docs.nestjs.com/graphql/quick-start
   * and https://www.apollographql.com/docs/apollo-server/api/apollo-server/
   */
  graphQl?: {
    /**
     * Driver configuration for Apollo
     */
    driver?: ApolloDriverConfig;

    /**
     * Subscription authentication
     */
    enableSubscriptionAuth?: boolean;

    /**
     * Maximum complexity of GraphQL requests
     */
    maxComplexity?: number;

    /**
     * Module options (forRootAsync)
     */
    options?: GqlModuleAsyncOptions;
  };

  /**
   * Whether to activate health check endpoints
   */
  healthCheck?: {

    /**
     * Whether health check is enabled
     */
    enabled?: boolean;

    /**
     * Configuration of single health checks
     */
    configs?: {

      /**
       * Configuration for database health check
       */
      database?: {

        /**
         * Whether to enable the database health check
         */
        enabled?: boolean;

        /**
         * Key in result JSON
         */
        key?: string;

        /**
         * Database health check options
         */
        options?: MongoosePingCheckSettings;
      };

      /**
       * Configuration for memory heap health check
       */
      memoryHeap?: {

        /**
         * Whether to enable the memory heap health check
         */
        enabled?: boolean;

        /**
         * Key in result JSON
         */
        key?: string;

        /**
         * Memory limit in bytes
         */
        heapUsedThreshold?: number;
      };

      /**
       * Configuration for memory resident set size health check
       */
      memoryRss?: {

        /**
         * Whether to enable the memory resident set size health check
         */
        enabled?: boolean;

        /**
         * Key in result JSON
         */
        key?: string;

        /**
         * Memory limit in bytes
         */
        rssThreshold?: number;
      };

      /**
       * Configuration for disk space health check
       */
      storage?: {

        /**
         * Whether to enable the disk space health check
         */
        enabled?: boolean;

        /**
         * Key in result JSON
         */
        key?: string;

        /**
         * Disk health indicator options
         */
        options?: DiskHealthIndicatorOptions;
      };
    };
  };

  /**
   * Hostname of the server
   * default: localhost
   */
  hostname?: string;

  /**
   * Ignore selections in fieldSelection
   * [ConfigService must be integrated in ModuleService]
   * If truly (default): select fields will be ignored and only populate fields in fieldSelection will be respected
   * If falsy: select and populate information in fieldSelection will be respected
   *
   * Hint: falsy may cause problems with CheckSecurityInterceptor
   * because the checks may miss fields that were not explicitly requested
   */
  ignoreSelectionsForPopulate?: boolean;

  /**
   * Configuration of JavaScript Web Token (JWT) module
   *
   * Hint: The secrets of the different environments should be different, otherwise a JWT can be used in different
   * environments, which can lead to security vulnerabilities.
   */
  jwt?: {
    /**
     * Configuration for refresh Token (JWT)
     * Hint: The secret of the JWT and the Refresh Token should be different, otherwise a new RefreshToken can also be
     * requested with the JWT, which can lead to a security vulnerability.
     */
    refresh?: {
      /**
       * Whether renewal of the refresh token is permitted
       * If falsy (default): during refresh only a new token, the refresh token retains its original term
       * If true: during refresh not only a new token but also a new refresh token is created
       */
      renewal?: boolean;
    } & IJwt;
  } & IJwt &
    JwtModuleOptions;

  /**
   * Load local configuration
   * false: no local configuration is loaded,
   * true: it tries to load ./config.json or ../config.json,
   * string: path to configuration
   */
  loadLocalConfig?: boolean | string;

  /**
   * Log exceptions (for better debugging)
   */
  logExceptions?: boolean;

  /**
   * Configuration for Mongoose
   */
  mongoose?: {

    /**
     * Collation allows users to specify language-specific rules for string comparison,
     * such as rules for letter-case and accent marks.
     */
    collation?: CollationOptions;

    /**
     * Whether to create SVG-Diagrams of mongoose models
     * @beta
     */
    modelDocumentation?: boolean;

    /**
     * Mongoose connection string
     */
    uri: string;

    /**
     * Mongoose module options
     */
    options?: MongooseModuleOptions;

    /**
     * Mongoose supports a separate strictQuery option to avoid strict mode for query filters.
     * This is because empty query filters cause Mongoose to return all documents in the model, which can cause issues.
     * See: https://github.com/Automattic/mongoose/issues/10763
     * and: https://mongoosejs.com/docs/guide.html#strictQuery
     * default: false
     */
    strictQuery?: boolean;
  };

  /**
   * Port number of the server
   * e.g. 8080
   */
  port?: number;

  /**
   * Configuration for useStaticAssets
   */
  staticAssets?: {
    /**
     * Additional options for useStaticAssets
     * e.g. {prefix: '/public/'}
     */
    options?: ServeStaticOptions;

    /**
     * Root directory for static assets
     * e.g. join(__dirname, '..', 'public')
     */
    path?: string;
  };

  /**
   * Whether to enable verification and automatic encryption for received passwords that are not in sha256 format
   * default = false, sha256 format check: /^[a-f0-9]{64}$/i
   */
  sha256?: boolean;

  /**
   * Templates
   */
  templates?: {
    /**
     * View engine
     * e.g. 'ejs'
     */
    engine?: string;

    /**
     * Directory for templates
     *  e.g. join(__dirname, '..', 'templates')
     */
    path?: string;
  };
}
