import { GqlModuleOptions } from '@nestjs/graphql';
import { JwtModuleOptions } from '@nestjs/jwt';
import { ServeStaticOptions } from '@nestjs/platform-express/interfaces/serve-static-options.interface';
import { TypeOrmModuleOptions } from '@nestjs/typeorm';
import { PlaygroundConfig } from 'apollo-server-core/src/playground';
import * as SMTPTransport from 'nodemailer/lib/smtp-transport';

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
     * Autogenerated schema file
     * e.g. 'schema.gql'
     */
    autoSchemaFile?: string;

    /**
     * Function for context manipulation
     * e.g. ({ req }) => ({ req })
     */
    context?: (context: { [key: string]: any; req: any }) => { [key: string]: any; req: any };

    /**
     * Enables and disables development mode helpers of apollo
     * e.g. true
     */
    debug?: boolean;

    /**
     * Determines whether or not to install subscription handlers
     * e.g. true
     */
    installSubscriptionHandlers?: boolean;

    /**
     * Enables and disables schema introspection
     * e.g. true
     */
    introspection?: boolean;

    /**
     * Enables and disables playground and allows configuration of GraphQL Playground. The options can be found on GraphQL Playground's
     * [documentation](https://github.com/prisma-labs/graphql-playground#usage)
     * e.g. true
     */
    playground?: PlaygroundConfig;
  } & GqlModuleOptions;

  /**
   * Configuration of JavaScript Web Token (JWT) module
   */
  jwt?: {
    /**
     * Secret to encrypt the JWT
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
  };

  /**
   * Configuration of TypeORM
   * see https://github.com/typeorm/typeorm/blob/master/docs/connection-options.md
   */
  typeOrm?: {
    /**
     * Type of database
     * e.g. 'mongodb'
     */
    type?: string;

    /**
     * Host of the database
     * e.g. 'localhost'
     */
    host?: string;

    /**
     * Port of the database
     * e.g. 27017
     */
    port?: number;

    /**
     * Name of the database
     * e.g. 'my-project'
     */
    database?: string;

    /**
     * Indicates if database schema should be auto created on every application launch
     * e.g. false
     */
    synchronize?: boolean;

    /**
     * Entities to be loaded and used for this connection
     * e.g. [Post, Category, 'entity/*.js', 'modules/** /entity/*.js']
     */
    entities?: string[];

    /**
     * Determines whether or not to use the new url parser. Default: false
     * e.g. true
     */
    useNewUrlParser?: boolean;

    /**
     * Determines whether or not to use the new Server Discovery and Monitoring engine. Default: false
     * https://github.com/mongodb/node-mongodb-native/releases/tag/v3.2.1
     * e.g. true
     */
    useUnifiedTopology?: boolean;
  } & TypeOrmModuleOptions;

  /**
   * Determines whether or not to integrate models from the module
   * additionally into TypeORM
   */
  typeOrmModelIntegration?: boolean;
}
