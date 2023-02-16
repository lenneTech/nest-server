import { DynamicModule, ForwardReference, Module, Provider, Type } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { JwtModule, JwtModuleOptions } from '@nestjs/jwt';
import { PassportModule } from '@nestjs/passport';
import { RolesGuard } from './guards/roles.guard';
import { JwtRefreshStrategy } from './strategies/jwt-refresh.strategy';
import { JwtStrategy } from './strategies/jwt.strategy';
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
      authService?: Type<CoreAuthService>;
      jwtStrategy?: Type<JwtStrategy>;
      jwtRefreshStrategy?: Type<JwtRefreshStrategy>;
      imports?: Array<Type<any> | DynamicModule | Promise<DynamicModule> | ForwardReference>;
      providers?: Provider[];
    }
  ): DynamicModule {
    // Process imports
    let imports: any[] = [
      UserModule,
      PassportModule.register({ defaultStrategy: ['jwt', 'jwt-refresh'] }),
      JwtModule.register(options),
    ];
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
      {
        provide: CoreAuthService,
        useClass: options.authService || CoreAuthService,
      },
      {
        provide: JwtStrategy,
        useClass: options.jwtStrategy || JwtStrategy,
      },
      {
        provide: JwtRefreshStrategy,
        useClass: options.jwtRefreshStrategy || JwtRefreshStrategy,
      },
    ];
    if (Array.isArray(options?.providers)) {
      providers = imports.concat(options.providers);
    }

    // Return CoreAuthModule
    return {
      module: CoreAuthModule,
      imports: imports,
      providers: providers,
      exports: [CoreAuthService, JwtModule, JwtStrategy, JwtRefreshStrategy, PassportModule, UserModule],
    };
  }
}
