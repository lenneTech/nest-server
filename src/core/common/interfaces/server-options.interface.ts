import { ApolloDriverConfig } from '@nestjs/apollo';
import { GqlModuleAsyncOptions } from '@nestjs/graphql';
import { JwtModuleOptions } from '@nestjs/jwt';
import { MongooseModuleOptions } from '@nestjs/mongoose';
import { ServeStaticOptions } from '@nestjs/platform-express/interfaces/serve-static-options.interface';
import { CronExpression } from '@nestjs/schedule';
import * as SMTPTransport from 'nodemailer/lib/smtp-transport';
import { Falsy } from '../types/falsy.type';
import { CronJobConfig } from './cron-job-config.interface';
import { MailjetOptions } from './mailjet-options.interface';

/**
 * Options for the server
 */
export interface IServerOptions {
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
     * Module options (forRootAsync)
     */
    options?: GqlModuleAsyncOptions;
  };

  /**
   * Configuration of JavaScript Web Token (JWT) module
   */
  jwt?: {
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
  } & JwtModuleOptions;

  /**
   * Configuration for Mongoose
   */
  mongoose?: { uri: string; options?: MongooseModuleOptions };

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
