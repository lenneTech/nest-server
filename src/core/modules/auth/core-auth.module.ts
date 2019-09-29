import { DynamicModule, Module, Type } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { JwtModule, JwtModuleOptions } from '@nestjs/jwt';
import { PassportModule } from '@nestjs/passport';
import { RolesGuard } from './guards/roles.guard';
import { JwtStrategy } from './jwt.strategy';
import { CoreAuthUserService } from './services/core-auth-user.service';
import { CoreAuthService } from './services/core-auth.service';

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
    options: JwtModuleOptions
  ): DynamicModule {
    return {
      module: CoreAuthModule,
      imports: [UserModule, PassportModule.register({ defaultStrategy: 'jwt' }), JwtModule.register(options)],
      providers: [
        // [Global] The GraphQLAuthGard integrates the user into context
        {
          provide: APP_GUARD,
          useClass: RolesGuard
        },
        {
          provide: CoreAuthUserService,
          useClass: UserService
        },

        // Standard services
        CoreAuthService,
        JwtStrategy
      ],
      exports: [CoreAuthService, JwtModule, JwtStrategy, PassportModule, UserModule]
    };
  }
}
