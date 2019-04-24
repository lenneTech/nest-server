import { DynamicModule, Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { JwtModule } from '@nestjs/jwt';
import { PassportModule } from '@nestjs/passport';
import { ServerOptions } from '../../common/interfaces/server-options.interface';
import { ConfigService } from '../../common/services/config.service';
import { UserModule } from '../../modules/user/user.module';
import { AuthResolver } from './auth.resolver';
import { AuthService } from './auth.service';
import { RolesGuard } from './guards/roles.guard';
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
  static forRoot(options: Partial<ServerOptions>): DynamicModule {
    return {
      module: AuthModule,
      imports: [
        PassportModule.register({ defaultStrategy: 'jwt' }),
        JwtModule.register(options.jwt),
        UserModule,
      ],
      providers: [
        AuthService, AuthResolver, JwtStrategy,

        // [Global] The GraphQLAuthGard integrates the user into context
        {
          provide: APP_GUARD,
          useClass: RolesGuard,
        },
        {
          provide: ConfigService,
          useValue: new ConfigService(options),
        },
      ],
      exports: [PassportModule, AuthService],
    };
  }
}
