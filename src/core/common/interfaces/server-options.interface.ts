import { ApolloDriverConfig } from '@nestjs/apollo';
import { JwtModuleOptions } from '@nestjs/jwt';
import { MongooseModuleOptions } from '@nestjs/mongoose/dist/interfaces/mongoose-options.interface';
import { ServeStaticOptions } from '@nestjs/platform-express/interfaces/serve-static-options.interface';
import * as SMTPTransport from 'nodemailer/lib/smtp-transport';
import { MailjetOptions } from './mailjet-options.interface';

/**
 * Options for the server
 */
export interface IServerOptions {
  /**
   * Environment
   * e.g. 'development'
   */
  env?: string;

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
   * Port number of the server
   * e.g. 8080
   */
  port?: number;

  /**
   * SMTP and template configuration for sending emails
   */
  email?: {
    /**
     * SMTP configuration for nodemailer
     */
    smtp?: SMTPTransport | SMTPTransport.Options | string;

    mailjet?: MailjetOptions;
    /**
     * Verification link for email
     */
    verificationLink?: string;

    /**
     * Password reset link for email
     */
    passwordResetLink?: string;

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
  };

  /**
   * Configuration for Mongoose
   */
  mongoose?: { uri: string; options?: MongooseModuleOptions };

  /**
   * Configuration for useStaticAssets
   */
  staticAssets?: {
    /**
     * Root directory for static assets
     * e.g. join(__dirname, '..', 'public')
     */
    path?: string;

    /**
     * Additional options for useStaticAssets
     * e.g. {prefix: '/public/'}
     */
    options?: ServeStaticOptions;
  };

  /**
   * Templates
   */
  templates?: {
    /**
     * Directory for templates
     *  e.g. join(__dirname, '..', 'templates')
     */
    path?: string;

    /**
     * View engine
     * e.g. 'ejs'
     */
    engine?: string;
  };
}
