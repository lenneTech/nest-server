import { DynamicModule, Module, Type } from '@nestjs/common';
import { APP_INTERCEPTOR, APP_PIPE } from '@nestjs/core';
import { GraphQLModule } from '@nestjs/graphql';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Config } from './core/common/helpers/config.helper';
import { CheckResponseInterceptor } from './core/common/interceptors/check-response.interceptor';
import { IServerOptions } from './core/common/interfaces/server-options.interface';
import { CheckPipe } from './core/common/pipes/check.pipe';
import { ConfigService } from './core/common/services/config.service';
import { AuthModule } from './core/modules/auth/auth.module';
import { IAuthModel } from './core/modules/auth/interfaces/auth-model.interface';
import { IAuthResolver } from './core/modules/auth/interfaces/auth-resolver.interface';
import { IAuthService } from './core/modules/auth/interfaces/auth-service.interface';
import { IAuthUserService } from './core/modules/auth/interfaces/auth-user-service.interface';
import { IUserResolver } from './core/modules/user/interfaces/user-resolver.interface';
import { IUserService } from './core/modules/user/interfaces/user-service.interface';
import { IUser } from './core/modules/user/interfaces/user.interface';
import { UserModule } from './core/modules/user/user.module';

// =============================================================================
// Server module
// =============================================================================
/**
 * Core module (dynamic)
 */
@Module({})
export class CoreModule {

  /**
   * Dynamic module
   * see https://docs.nestjs.com/modules#dynamic-modules
   */
  static forRoot(
    authModelClass: Type<IAuthModel>,
    configService: ConfigService,
    userClass: Type<IUser>,
    userServiceClass: Type<IAuthUserService>,
    options: {
      authResolverClass?: Type<IAuthResolver>,
      authServiceClass?: Type<IAuthService>,
      userResolverClass?: Type<IUserResolver>,
      userServiceClass?: Type<IUserService>,
    } & Partial<IServerOptions>,
  ): DynamicModule {

    console.log('UserClass', userClass);

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
    } as IServerOptions, options);

    console.log('Entitie', options.typeOrm.entities);

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
        GraphQLModule.forRoot(options.graphQl),
        TypeOrmModule.forRoot(options.typeOrm),
        AuthModule.forRoot(authModelClass, configService, userServiceClass, {
          authResolverClass: options.authResolverClass,
          authServiceClass: options.authServiceClass,
        }),
        UserModule.forRoot(userClass, {
          userResolverClass: options.userResolverClass,
          userServiceClass: options.userServiceClass,
        }),
      ],
      providers,
      exports: [AuthModule, ConfigService, GraphQLModule, TypeOrmModule, UserModule],
    };
  }
}
