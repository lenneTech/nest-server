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
import { Falsy } from '../types/falsy.type';
import { CronJobConfig } from './cron-job-config.interface';
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
   * and expand them as OR query with string and ObjectId
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
  cronJobs?: Record<string, CronExpression | string | Date | Falsy | CronJobConfig>;

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
   * Ignore selections in fieldSelection
   * [ConfigService must be integrated in ModuleService]
   * If falsy (default): select and populate information in fieldSelection will be respected
   * If truly: select fields will be ignored and only populate fields in fieldSelection will be respected
   */
  ignoreSelectionsForPopulate?: boolean;

  /**
   * Configuration of JavaScript Web Token (JWT) module
   */
  jwt?: {
    refresh?: IJwt;
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
    collation?: CollationOptions;

    /**
     * Mongoose connection string
     */
    uri: string;

    /**
     * Mongoose module options
     */
    options?: MongooseModuleOptions;
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
