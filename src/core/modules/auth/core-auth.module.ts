import { DynamicModule, ForwardReference, Module, Provider, Type } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { JwtModule, JwtModuleOptions } from '@nestjs/jwt';
import { PassportModule } from '@nestjs/passport';
import { RolesGuard } from './guards/roles.guard';
import { JwtStrategy } from './jwt.strategy';
import { CoreAuthUserService } from './services/core-auth-user.service';
import { CoreAuthService } from './services/core-auth.service';
import { PubSub } from 'graphql-subscriptions';

/**
 * CoreAuthModule to handle user authentication and enables Roles
 */
@Module({})
export class CoreAuthModule {
  /**
   * Dynamic module
   * see https://docs.nestjs.com/modules#dynamic-modules
   */
  static forRoot(
    UserModule: Type<any>,
    UserService: Type<CoreAuthUserService>,
    options: JwtModuleOptions & {
      imports?: Array<Type<any> | DynamicModule | Promise<DynamicModule> | ForwardReference>[];
      providers?: Provider[];
    }
  ): DynamicModule {
    // Porcess imports
    let imports: any[] = [UserModule, PassportModule.register({ defaultStrategy: 'jwt' }), JwtModule.register(options)];
    if (Array.isArray(options?.imports)) {
      imports = imports.concat(options.imports);
    }

    // Process providers
    let providers = [
      // [Global] The GraphQLAuthGard integrates the user into context
      {
        provide: APP_GUARD,
        useClass: RolesGuard,
      },
      {
        provide: CoreAuthUserService,
        useClass: UserService,
      },
      {
        provide: 'PUB_SUB',
        useValue: new PubSub(),
      },

      // Standard services
      CoreAuthService,
      JwtStrategy,
    ];
    if (Array.isArray(options?.providers)) {
      providers = imports.concat(options.providers);
    }

    // Return CoreAuthModule
    return {
      module: CoreAuthModule,
      imports: imports,
      providers: providers,
      exports: [CoreAuthService, JwtModule, JwtStrategy, PassportModule, UserModule],
    };
  }
}
