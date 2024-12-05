import { ApolloDriverConfig } from '@nestjs/apollo';
import { GqlModuleAsyncOptions } from '@nestjs/graphql';
import { JwtModuleOptions } from '@nestjs/jwt';
import { JwtSignOptions } from '@nestjs/jwt/dist/interfaces';
import { MongooseModuleOptions } from '@nestjs/mongoose';
import { ServeStaticOptions } from '@nestjs/platform-express/interfaces/serve-static-options.interface';
import { CronExpression } from '@nestjs/schedule';
import { MongoosePingCheckSettings } from '@nestjs/terminus/dist/health-indicator/database/mongoose.health';
import { DiskHealthIndicatorOptions } from '@nestjs/terminus/dist/health-indicator/disk/disk-health-options.type';
import compression from 'compression';
import { CollationOptions } from 'mongodb';
import * as SMTPTransport from 'nodemailer/lib/smtp-transport';

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
    done: (err: any, secret: string) => any,
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
   * Configuration for Brevo
   * See: https://developers.brevo.com/
   */
  brevo?: {
    /**
     * API key for Brevo
     */
    apiKey: string;

    /**
     * Regular expression for excluding (test) users
     * e.g. /@testuser.com$/i
     */
    exclude?: RegExp;

    /**
     * Default sender for Brevo
     */
    sender: {
      email: string;
      name: string;
    };
  };

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
  cronJobs?: Record<
    string,
    CronExpression | CronJobConfigWithTimeZone | CronJobConfigWithUtcOffset | Date | Falsy | string
  >;

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
         * Memory limit in bytes
         */
        heapUsedThreshold?: number;

        /**
         * Key in result JSON
         */
        key?: string;
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

    /**
     * Whether health check is enabled
     */
    enabled?: boolean;
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

    /**
     * Time period in milliseconds
     * in which the same token ID is used so that all parallel token refresh requests of a device can be generated.
     * default: 0 (every token includes a new token ID, all parallel token refresh requests must be prevented by the client or processed accordingly)
     */
    sameTokenIdPeriod?: number;
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

    /**
     * Mongoose connection string
     */
    uri: string;
  };

  /**
   * Port number of the server
   * e.g. 8080
   */
  port?: number;

  /**
   * Configuration for security pipes and interceptors
   */
  security?: {
    /**
     * Check restrictions for output (models and output objects)
     * See @lenne.tech/nest-server/src/core/common/interceptors/check-response.interceptor.ts
     */
    checkResponseInterceptor?:
      | {
          /**
           * Check the object itself for restrictions
           * (the class restriction is not only default for properties but object itself)
           * default = false (to act like Roles)
           */
          checkObjectItself?: boolean;

          /**
           * Whether to log if a restricted field is found or process is slow
           * boolean or number (time in ms)
           * default = false
           */
          debug?: boolean | number;

          /**
           * Whether to ignore fields with undefined values
           * default = true
           */
          ignoreUndefined?: boolean;

          /**
           * Merge roles of object and properties
           * default = true (to act like Roles)
           */
          mergeRoles?: boolean;

          /**
           * Whether objects that have already been checked should be ignored
           * Objects with truly property `_objectAlreadyCheckedForRestrictions` will be ignored
           * default = true
           */
          noteCheckedObjects?: boolean;

          /**
           * Remove undefined values from result array
           * default = true
           */
          removeUndefinedFromResultArray?: boolean;

          /**
           * Whether to throw an error if a restricted field is found
           * default = false (for output objects)
           */
          throwError?: boolean;
        }
      | boolean;

    /**
     * Process securityCheck() methode of Object before response
     * See @lenne.tech/nest-server/src/core/common/interceptors/check-security.interceptor.ts
     * default = true
     */
    checkSecurityInterceptor?:
      | {
          /**
           * Whether to log if a process is slow
           * boolean or number (time in ms)
           * default = false
           */
          debug?: boolean | number;

          /**
           * Whether objects with truly property `_objectAlreadyCheckedForRestrictions` will be ignored
           * default = true
           */
          noteCheckedObjects?: boolean;
        }
      | boolean;

    /**
     * Map incoming plain objects to meta-type and validate
     * See @lenne.tech/nest-server/src/core/common/pipes/map-and-validate.pipe.ts
     * default = true
     */
    mapAndValidatePipe?: boolean;
  };

  /**
   * Whether to enable verification and automatic encryption for received passwords that are not in sha256 format
   * default = false, sha256 format check: /^[a-f0-9]{64}$/i
   */
  sha256?: boolean;

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
