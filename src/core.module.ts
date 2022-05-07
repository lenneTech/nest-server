import { DynamicModule, Global, Module, UnauthorizedException } from '@nestjs/common';
import { APP_PIPE } from '@nestjs/core';
import { GraphQLModule } from '@nestjs/graphql';
import { merge } from './core/common/helpers/config.helper';
import { IServerOptions } from './core/common/interfaces/server-options.interface';
import { MapAndValidatePipe } from './core/common/pipes/map-and-validate.pipe';
import { ConfigService } from './core/common/services/config.service';
import { EmailService } from './core/common/services/email.service';
import { TemplateService } from './core/common/services/template.service';
import { MongooseModule } from '@nestjs/mongoose';
import { MailjetService } from './core/common/services/mailjet.service';
import { ApolloDriver, ApolloDriverConfig } from '@nestjs/apollo';

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
export class CoreModule {
  /**
   * Dynamic module
   * see https://docs.nestjs.com/modules#dynamic-modules
   */
  static forRoot(AuthService: any, AuthModule: any, options: Partial<IServerOptions>): DynamicModule {
    // Process config
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
                  context: ({ req }) => ({ req }),
                  installSubscriptionHandlers: true,
                  subscriptions: {
                    'subscriptions-transport-ws': {
                      onConnect: async (connectionParams) => {
                        if (config.graphQl.enableSubscriptionAuth) {
                          // get authToken from authorization header
                          const authToken: string =
                            'Authorization' in connectionParams && connectionParams?.Authorization?.split(' ')[1];

                          if (authToken) {
                            // verify authToken/getJwtPayLoad
                            const payload = authService.decodeJwt(authToken);
                            const user = await authService.validateUser(payload);
                            // the user/jwtPayload object found will be available as context.currentUser/jwtPayload in your GraphQL resolvers
                            return { user: user, headers: connectionParams };
                          }

                          throw new UnauthorizedException();
                        }
                      },
                    },
                  },
                },
                options?.graphQl?.driver
              ),
          },
          enableSubscriptionAuth: true,
        },
        port: 3000,
        mongoose: {
          uri: 'mongodb://localhost/nest-server-default',
          options: {
            connectionFactory: (connection) => {
              // eslint-disable-next-line @typescript-eslint/no-var-requires
              connection.plugin(require('./core/common/plugins/mongoose-id.plugin'));
              return connection;
            },
          },
        },
      } as IServerOptions,
      options
    );

    // Set providers
    const providers = [
      // The ConfigService provides access to the current configuration of the module
      {
        provide: ConfigService,
        useValue: new ConfigService(config),
      },

      // [Global] Map plain objects to metatype and validate
      {
        provide: APP_PIPE,
        useClass: MapAndValidatePipe,
      },

      // Core Services
      EmailService,
      TemplateService,
      MailjetService,
    ];

    // Return dynamic module
    return {
      module: CoreModule,
      imports: [
        MongooseModule.forRoot(config.mongoose.uri, config.mongoose.options),
        GraphQLModule.forRootAsync<ApolloDriverConfig>(Object.assign({ driver: ApolloDriver }, config.graphQl.driver)),
      ],
      providers,
      exports: [ConfigService, EmailService, TemplateService, MailjetService],
    };
  }
}
