import { DynamicModule, Global, Module, Scope } from '@nestjs/common';
import { APP_INTERCEPTOR, APP_PIPE } from '@nestjs/core';
import { GraphQLModule } from '@nestjs/graphql';
import { Config } from './core/common/helpers/config.helper';
import { CheckResponseInterceptor } from './core/common/interceptors/check-response.interceptor';
import { IServerOptions } from './core/common/interfaces/server-options.interface';
import { CheckInputPipe } from './core/common/pipes/check-input.pipe';
import { ConfigService } from './core/common/services/config.service';
import { EmailService } from './core/common/services/email.service';
import { TemplateService } from './core/common/services/template.service';
import { MongooseModule } from '@nestjs/mongoose';
import { MailjetService } from './core/common/services/mailjet.service';

/**
 * Core module (dynamic)
 *
 * Which includes the following standard modules and services:
 * - MongooseModule
 * - GraphQL
 * - ConfigService
 * - CheckInput
 * - CheckResponse
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
  static forRoot(options: Partial<IServerOptions>): DynamicModule {
    // Process config
    const config: IServerOptions = Config.merge(
      {
        env: 'develop',
        graphQl: {
          autoSchemaFile: 'schema.gql',
          context: ({ req }) => ({ req }),
          installSubscriptionHandlers: true,
          subscriptions: {
            'subscriptions-transport-ws': {
              onConnect: (connectionParams) => {
                // TODO: Handle Authorization
                const authToken = connectionParams.Authorization;
              },
            },
          },
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

      // [Global] The CheckResponseInterceptor restricts the response to the properties
      // that are permitted for the current user
      {
        provide: APP_INTERCEPTOR,
        useClass: CheckResponseInterceptor,
      },

      // [Global] The CheckInputPipe checks the permissibility of individual properties of inputs for the resolvers
      // in relation to the current user
      {
        provide: APP_PIPE,
        scope: Scope.REQUEST,
        useClass: CheckInputPipe,
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
        GraphQLModule.forRoot(config.graphQl),
      ],
      providers,
      exports: [ConfigService, EmailService, TemplateService, MailjetService],
    };
  }
}
