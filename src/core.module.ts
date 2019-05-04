import { DynamicModule, Module } from '@nestjs/common';
import { APP_INTERCEPTOR, APP_PIPE } from '@nestjs/core';
import { GraphQLModule } from '@nestjs/graphql';
import { TypeOrmModule } from '@nestjs/typeorm';
import envConfig from './config.env';
import { Config } from './core/common/helpers/config.helper';
import { CheckResponseInterceptor } from './core/common/interceptors/check-response.interceptor';
import { IServerOptions } from './core/common/interfaces/server-options.interface';
import { CheckInputPipe } from './core/common/pipes/check-input-pipe.service';
import { ConfigService } from './core/common/services/config.service';

/**
 * Core module (dynamic)
 *
 * Which includes the following standard modules and services:
 * - TypeORM
 * - GraphQL
 * - ConfigService
 * - CheckInput
 * - CheckResponse
 */
@Module({})
export class CoreModule {

  /**
   * Dynamic module
   * see https://docs.nestjs.com/modules#dynamic-modules
   */
  static forRoot(options: Partial<IServerOptions>): DynamicModule {

    // Process config
    options = Config.merge({
      env: 'develop',
      graphQl: {
        autoSchemaFile: 'schema.gql',
        context: ({ req }) => ({ req }),
        installSubscriptionHandlers: true,
      },
      port: 3000,
      typeOrm: {
        type: 'mongodb',
        host: 'localhost',
        port: 27017,
        database: 'develop',
        authSource: 'admin',
        synchronize: false, // https://typeorm.io/#/migrations/how-migrations-work
        entities: [],
        useNewUrlParser: true,
      },
      typeOrmModelIntegration: true,
    } as IServerOptions, options);

    // Add models for TypeORM
    if (options.typeOrmModelIntegration) {
      options.typeOrm.entities.push(__dirname + '/**/*.{entity,model}.{ts,js}');
    }

    // Set providers
    const providers = [

      // The ConfigService provides access to the current configuration of the module
      {
        provide: ConfigService,
        useValue: new ConfigService(options),
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
        useClass: CheckInputPipe,
      },
    ];

    // Return dynamic module
    return {
      module: CoreModule,
      imports: [
        TypeOrmModule.forRoot(envConfig.typeOrm),
        GraphQLModule.forRoot(options.graphQl),
      ],
      providers,
      exports: [ConfigService, GraphQLModule, TypeOrmModule],
    };
  }
}
