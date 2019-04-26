import { DynamicModule, Module } from '@nestjs/common';
import { APP_INTERCEPTOR, APP_PIPE } from '@nestjs/core';
import { GraphQLModule } from '@nestjs/graphql';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Config } from './common/helpers/config.helper';
import { CheckResponseInterceptor } from './common/interceptors/check-response.interceptor';
import { ServerOptions } from './common/interfaces/server-options.interface';
import { CheckPipe } from './common/pipes/check.pipe';
import { ConfigService } from './common/services/config.service';
import { AuthModule } from './modules/auth/auth.module';
import { UserModule } from './modules/user/user.module';

// =============================================================================
// Server module
// =============================================================================
/**
 * Core module (dynamic)
 */
@Module({
  imports: [
    UserModule,
  ],
})
export class CoreModule {

  /**
   * Dynamic module
   * see https://docs.nestjs.com/modules#dynamic-modules
   */
  static forRoot(options: Partial<ServerOptions>): DynamicModule {

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
    } as ServerOptions, options);

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

      // [Global] The CheckPipe checks the permissibility of individual properties of inputs for the resolvers
      // in relation to the current user
      {
        provide: APP_PIPE,
        useClass: CheckPipe,
      },
    ];

    // Return dynamic module
    return {
      module: CoreModule,
      imports: [
        AuthModule.forRoot(options),
        GraphQLModule.forRoot(options.graphQl),
        TypeOrmModule.forRoot(options.typeOrm),
      ],
      providers,
      exports: [AuthModule, ConfigService, GraphQLModule, TypeOrmModule],
    };
  }
}
