import { ApolloDriver, ApolloDriverConfig } from '@nestjs/apollo';
import { DynamicModule, Global, MiddlewareConsumer, Module, NestModule, UnauthorizedException } from '@nestjs/common';
import { APP_PIPE } from '@nestjs/core';
import { GraphQLModule } from '@nestjs/graphql';
import { MongooseModule } from '@nestjs/mongoose';
import { Context } from 'apollo-server-core';
import graphqlUploadExpress = require('graphql-upload/graphqlUploadExpress.js');
import { merge } from './core/common/helpers/config.helper';
import { IServerOptions } from './core/common/interfaces/server-options.interface';
import { MapAndValidatePipe } from './core/common/pipes/map-and-validate.pipe';
import { ComplexityPlugin } from './core/common/plugins/complexity.plugin';
import { ConfigService } from './core/common/services/config.service';
import { EmailService } from './core/common/services/email.service';
import { MailjetService } from './core/common/services/mailjet.service';
import { TemplateService } from './core/common/services/template.service';
import { CoreHealthCheckModule } from './core/modules/health-check/core-health-check.module';
import { ModelDocService } from './core/common/services/model-doc.service';

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
                    'subscriptions-transport-ws': {
                      onConnect: async (connectionParams) => {
                        if (config.graphQl.enableSubscriptionAuth) {
                          // get authToken from authorization header
                          const authToken: string = connectionParams?.Authorization?.split(' ')[1];

                          if (authToken) {
                            // verify authToken/getJwtPayLoad
                            const payload = authService.decodeJwt(authToken);
                            const user = await authService.validateUser(payload);
                            // the user/jwtPayload object found will be available as context.currentUser/jwtPayload in your GraphQL resolvers
                            return { user, headers: connectionParams };
                          }

                          throw new UnauthorizedException('Missing authentication token');
                        }
                      },
                    },
                    'graphql-ws': {
                      onConnect: async (context: Context<any>) => {
                        const { connectionParams, extra } = context;
                        if (config.graphQl.enableSubscriptionAuth) {
                          // get authToken from authorization header
                          const authToken: string = connectionParams?.Authorization?.split(' ')[1];
                          if (authToken) {
                            // verify authToken/getJwtPayLoad
                            const payload = authService.decodeJwt(authToken);
                            const user = await authService.validateUser(payload);
                            // the user/jwtPayload object found will be available as context.currentUser/jwtPayload in your GraphQL resolvers
                            extra.user = user;
                            extra.header = connectionParams;
                            return extra;
                          }

                          throw new UnauthorizedException('Missing authentication token');
                        }
                      },
                      context: ({ extra }) => extra,
                    },
                  },
                },
                options?.graphQl?.driver,
              ),
          },
          enableSubscriptionAuth: true,
        },
        port: 3000,
        mongoose: {
          uri: 'mongodb://localhost/nest-server-default',
          options: {
            connectionFactory: (connection) => {
              connection.plugin(require('./core/common/plugins/mongoose-id.plugin'));
              return connection;
            },
          },
        },
      } as IServerOptions,
      options,
    );

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
      module: CoreModule,
      imports,
      providers,
      exports: [ConfigService, EmailService, TemplateService, MailjetService, ComplexityPlugin],
    };
  }
}
