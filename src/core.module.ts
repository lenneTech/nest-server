import { MikroOrmModule } from '@mikro-orm/nestjs';
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

/**
 * Core module (dynamic)
 *
 * Which includes the following standard modules and services:
 * - MikroORM
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
        },
        port: 3000,
        mikroOrm: {
          host: options.typeOrm && options.typeOrm.host ? options.typeOrm.host : 'localhost',
          port: options.typeOrm && options.typeOrm.port ? options.typeOrm.port : 27017,
          dbName: options.typeOrm && options.typeOrm.database ? options.typeOrm.database : 'develop',
          type: 'mongo',
        },
      } as IServerOptions,
      options
    );

    // Migrate from TypeOrm to MikroOrm
    if (!options.mikroOrm?.type && options.typeOrm?.type) {
      if (options.typeOrm.type === 'mongodb') {
        config.mikroOrm.type = 'mongo';
      } else if (['mysql', 'mariadb', 'sqlite', 'mongo', 'postgresql'].includes(options.typeOrm.type)) {
        config.mikroOrm.type = options.typeOrm.type as any;
      }
    }

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
    ];

    // Return dynamic module
    return {
      module: CoreModule,
      imports: [MikroOrmModule.forRoot(config.mikroOrm), GraphQLModule.forRoot(config.graphQl)],
      providers,
      exports: [ConfigService, EmailService, TemplateService],
    };
  }
}
