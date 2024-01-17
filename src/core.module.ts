import { ApolloDriver, ApolloDriverConfig } from '@nestjs/apollo';
import { DynamicModule, Global, MiddlewareConsumer, Module, NestModule, UnauthorizedException } from '@nestjs/common';
import { APP_PIPE } from '@nestjs/core';
import { GraphQLModule } from '@nestjs/graphql';
import { MongooseModule } from '@nestjs/mongoose';
import { Context } from 'apollo-server-core';
import mongoose from 'mongoose';

import { merge } from './core/common/helpers/config.helper';
import { IServerOptions } from './core/common/interfaces/server-options.interface';
import { MapAndValidatePipe } from './core/common/pipes/map-and-validate.pipe';
import { ComplexityPlugin } from './core/common/plugins/complexity.plugin';
import { ConfigService } from './core/common/services/config.service';
import { EmailService } from './core/common/services/email.service';
import { MailjetService } from './core/common/services/mailjet.service';
import { ModelDocService } from './core/common/services/model-doc.service';
import { TemplateService } from './core/common/services/template.service';
import { CoreHealthCheckModule } from './core/modules/health-check/core-health-check.module';

import graphqlUploadExpress = require('graphql-upload/graphqlUploadExpress.js');

/**
 * Core module (dynamic)
 *
 * Which includes the following standard modules and services:
 * - MongooseModule
 * - GraphQL
 * - ConfigService
 *
 * and sets the following services as globals:
 * - ConfigService
 * - EmailService
 * - TemplateService
 */
@Global()
@Module({})
export class CoreModule implements NestModule {
  /**
   * Integrate middleware, e.g. GraphQL upload handing for express
   */
  configure(consumer: MiddlewareConsumer) {
    consumer.apply(graphqlUploadExpress()).forRoutes('graphql');
  }

  /**
   * Convert array with key value entries to header object
   * e.g. ['Sec-WebSocket-Version', '13', 'Sec-WebSocket-Key', 'Yu4Lewa60jLk41YXcVrw0w==']
   * => {
   *   'Sec-WebSocket-Version': '13',
   *   'Sec-WebSocket-Key': 'Yu4Lewa60jLk41YXcVrw0w==',
   * }
   */
  static getHeaderFromArray(array): Record<string, string> {
    const result: Record<string, string> = {};
    if (!array.length) {
      return result;
    }
    for (let i = 0; i < array.length; i += 2) {
      const key = array[i];
      result[key] = array[i + 1];
    }
    return result;
  }

  /**
   * Dynamic module
   * see https://docs.nestjs.com/modules#dynamic-modules
   */
  static forRoot(AuthService: any, AuthModule: any, options: Partial<IServerOptions>): DynamicModule {
    // Process config
    let cors = {};
    if (options?.cookies) {
      cors = {
        credentials: true,
        origin: true,
      };
    }
    const config: IServerOptions = merge(
      {
        env: 'develop',
        graphQl: {
          driver: {
            imports: [AuthModule],
            inject: [AuthService],
            useFactory: async (authService: any) =>
              Object.assign(
                {
                  autoSchemaFile: 'schema.gql',
                  context: ({ req, res }) => ({ req, res }),
                  cors,
                  installSubscriptionHandlers: true,
                  subscriptions: {
                    'graphql-ws': {
                      context: ({ extra }) => extra,
                      onConnect: async (context: Context<any>) => {
                        const { connectionParams, extra } = context;
                        if (config.graphQl.enableSubscriptionAuth) {
                          // get authToken from authorization header
                          const headers = this.getHeaderFromArray(extra.request?.rawHeaders);
                          const authToken: string
                            = connectionParams?.Authorization?.split(' ')[1] ?? headers.Authorization?.split(' ')[1];
                          if (authToken) {
                            // verify authToken/getJwtPayLoad
                            const payload = authService.decodeJwt(authToken);
                            const user = await authService.validateUser(payload);
                            if (!user) {
                              throw new UnauthorizedException('No user found for token');
                            }
                            // the user/jwtPayload object found will be available as context.currentUser/jwtPayload in your GraphQL resolvers
                            extra.user = user;
                            extra.headers = connectionParams ?? headers;
                            return extra;
                          }

                          throw new UnauthorizedException('Missing authentication token');
                        }
                      },
                    },
                    'subscriptions-transport-ws': {
                      onConnect: async (connectionParams) => {
                        if (config.graphQl.enableSubscriptionAuth) {
                          // get authToken from authorization header
                          const authToken: string = connectionParams?.Authorization?.split(' ')[1];

                          if (authToken) {
                            // verify authToken/getJwtPayLoad
                            const payload = authService.decodeJwt(authToken);
                            const user = await authService.validateUser(payload);
                            if (!user) {
                              throw new UnauthorizedException('No user found for token');
                            }
                            // the user/jwtPayload object found will be available as context.currentUser/jwtPayload in your GraphQL resolvers
                            return { headers: connectionParams, user };
                          }

                          throw new UnauthorizedException('Missing authentication token');
                        }
                      },
                    },
                  },
                },
                options?.graphQl?.driver,
              ),
          },
          enableSubscriptionAuth: true,
        },
        mongoose: {
          options: {
            connectionFactory: (connection) => {
              connection.plugin(require('./core/common/plugins/mongoose-id.plugin'));
              return connection;
            },
          },
          uri: 'mongodb://localhost/nest-server-default',
        },
        port: 3000,
      } as IServerOptions,
      options,
    );

    // Check secrets
    const jwtConfig = config.jwt;
    if (jwtConfig?.secret && jwtConfig.secret && jwtConfig.refresh && jwtConfig.refresh.secret === jwtConfig.secret) {
      console.warn('JWT secret and refresh secret are equal, this can lead to security vulnerabilities!');
    }

    // Set providers
    const providers: any[] = [
      // The ConfigService provides access to the current configuration of the module
      {
        provide: ConfigService,
        useValue: new ConfigService(config),
      },

      // [Global] Map plain objects to meta-type and validate
      {
        provide: APP_PIPE,
        useClass: MapAndValidatePipe,
      },

      // Core Services
      EmailService,
      TemplateService,
      MailjetService,

      // Plugins
      ComplexityPlugin,
    ];

    if (config.mongoose?.modelDocumentation) {
      providers.push(ModelDocService);
    }

    // Set strict query to false by default
    // See: https://github.com/Automattic/mongoose/issues/10763
    // and: https://mongoosejs.com/docs/guide.html#strictQuery
    mongoose.set('strictQuery', config.mongoose.strictQuery || false);

    const imports: any[] = [
      MongooseModule.forRoot(config.mongoose.uri, config.mongoose.options),
      GraphQLModule.forRootAsync<ApolloDriverConfig>(
        Object.assign({ driver: ApolloDriver }, config.graphQl.driver, config.graphQl.options),
      ),
    ];
    if (config.healthCheck) {
      imports.push(CoreHealthCheckModule);
    }

    // Return dynamic module
    return {
      exports: [ConfigService, EmailService, TemplateService, MailjetService, ComplexityPlugin],
      imports,
      module: CoreModule,
      providers,
    };
  }
}
