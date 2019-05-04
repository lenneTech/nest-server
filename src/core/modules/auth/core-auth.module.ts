import { DynamicModule, Module, Type } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { JwtModule } from '@nestjs/jwt';
import { PassportModule } from '@nestjs/passport';
import { IServerOptions } from '../../common/interfaces/server-options.interface';
import { ConfigService } from '../../common/services/config.service';
import { RolesGuard } from './guards/roles.guard';
import { CoreAuthService } from './services/core-auth.service';
import { CoreAuthUserService } from './services/core-auth-user.service';
import { JwtStrategy } from './jwt.strategy';

/**
 * CoreAuthModule to handle user authentication
 */
@Module({})
export class CoreAuthModule {

  /**
   * Dynamic module
   * see https://docs.nestjs.com/modules#dynamic-modules
   */
  static forRoot(UserModule: Type<any>, UserService: Type<CoreAuthUserService>, options: Partial<IServerOptions>): DynamicModule {
    return {
      module: CoreAuthModule,
      imports: [
        UserModule,
        PassportModule.register({ defaultStrategy: 'jwt' }),
        JwtModule.register(options.jwt),
      ],
      providers: [
        CoreAuthService, JwtStrategy,

        // [Global] The GraphQLAuthGard integrates the user into context
        {
          provide: APP_GUARD,
          useClass: RolesGuard,
        },
        {
          provide: ConfigService,
          useValue: new ConfigService(options),
        },
        {
          provide: CoreAuthUserService,
          useClass: UserService,
        },
      ],
      exports: [PassportModule, CoreAuthService],
    };
  }
}
