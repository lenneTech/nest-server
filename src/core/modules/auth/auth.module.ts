import { DynamicModule, Module, Type } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { JwtModule } from '@nestjs/jwt';
import { PassportModule } from '@nestjs/passport';
import { ConfigService } from '../../common/services/config.service';
import { AuthResolver } from './auth.resolver';
import { AuthService } from './auth.service';
import { RolesGuard } from './guards/roles.guard';
import { IAuthModel } from './interfaces/auth-model.interface';
import { IAuthResolver } from './interfaces/auth-resolver.interface';
import { IAuthService } from './interfaces/auth-service.interface';
import { IAuthUserService } from './interfaces/auth-user-service.interface';
import { JwtStrategy } from './jwt.strategy';

/**
 * AuthModule to handle user authentication
 */
@Module({})
export class AuthModule {

  /**
   * Dynamic module
   * see https://docs.nestjs.com/modules#dynamic-modules
   */
  static forRoot(
    authModelClass: Type<IAuthModel>,
    configService: ConfigService,
    userServiceClass: Type<IAuthUserService>,
    options?: {
      authResolverClass?: Type<IAuthResolver>,
      authServiceClass?: Type<IAuthService>,
    },
  ): DynamicModule {
    return {
      module: AuthModule,
      imports: [
        PassportModule.register({ defaultStrategy: 'jwt' }),
        JwtModule.register(configService.get('jwt')),
      ],
      providers: [
        JwtStrategy,

        // Dynamic AuthResolver
        {
          provide: AuthResolver,
          useClass: options.authResolverClass ? options.authResolverClass : AuthResolver(authModelClass),
        },

        // Dynamic AuthService
        {
          provide: AuthService,
          useClass: options.authServiceClass ? options.authServiceClass : AuthService,
        },

        // [Global] The GraphQLAuthGard integrates the user into context
        {
          provide: APP_GUARD,
          useClass: RolesGuard,
        },
        {
          provide: ConfigService,
          useValue: configService,
        },
        {
          provide: 'UserService',
          useClass: userServiceClass,
        },
      ],
      exports: [PassportModule, AuthService],
    };
  }
}
