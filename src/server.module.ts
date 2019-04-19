import { DynamicModule, Module } from '@nestjs/common';
import { APP_GUARD, APP_INTERCEPTOR, APP_PIPE } from '@nestjs/core';
import { GraphQLModule } from '@nestjs/graphql';
import { TypeOrmModule } from '@nestjs/typeorm';
import { RolesGuard } from './common/guards/roles.guard';
import { Config } from './common/helpers/config.helper';
import { CheckResponseInterceptor } from './common/interceptors/check-response.interceptor';
import { ServerOptions } from './common/interfaces/server-options.interface';
import { CheckPipe } from './common/pipes/check.pipe';
import { ConfigService } from './common/services/config.service';
import { UserModule } from './modules/user/user.module';

// =============================================================================
// Server module
// =============================================================================
/**
 * Server module (dynamic)
 */
@Module({
  imports: [
    UserModule,
  ],
})
export class ServerModule {

  /**
   * Dynamic module
   * see https://docs.nestjs.com/modules#dynamic-modules
   */
  static forRoot(options: Partial<ServerOptions>): DynamicModule {

    // Process config
    options = Config.merge(<ServerOptions>{
      env: 'develop',
      graphQl: {
        autoSchemaFile: 'schema.gql',
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
    }, options);

    // Add models for TypeORM
    if (options.typeOrmModelIntegration) {
      options.typeOrm.entities.push(__dirname + '/**/*.{entity,model}.{ts,js}');
    }

    // Set providers
    const providers = [

      // [Global] The RolesGuard checks the execution authorizations of resolvers in relation to the current user
      {
        provide: APP_GUARD,
        useClass: RolesGuard,
      },

      // [Global] The CheckResponseInterceptor restricts the response to the properties
      // that are permitted for the current user
      {
        provide: APP_INTERCEPTOR,
        useClass: CheckResponseInterceptor
      },

      // [Global] The CheckPipe checks the permissibility of individual properties of inputs for the resolvers
      // in relation to the current user
      {
        provide: APP_PIPE,
        useClass: CheckPipe,
      },

      // The ConfigService provides access to the current configuration of the module
      {
        provide: ConfigService,
        useValue: new ConfigService(options),
      },
    ];

    // Return dynamic module
    return {
      module: ServerModule,
      imports: [
        GraphQLModule.forRoot(options.graphQl),
        TypeOrmModule.forRoot(options.typeOrm),
      ],
      providers: providers,
      exports: [ConfigService]
    };
  }
}
