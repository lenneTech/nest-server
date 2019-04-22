import { DynamicModule, Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { PassportModule } from '@nestjs/passport';
import { ServerOptions } from '../../common/interfaces/server-options.interface';
import { ConfigService } from '../../common/services/config.service';
import { UserModule } from '../../modules/user/user.module';
import { AuthResolver } from './auth.resolver';
import { AuthService } from './auth.service';
import { JwtStrategy } from './jwt.strategy';

/**
 * AuthModule to handle user authentication
 */
@Module({
  imports: [
    UserModule,
    PassportModule.register({ defaultStrategy: 'jwt' }),
  ],
  providers: [AuthService, AuthResolver, JwtStrategy],
  exports: [AuthService, PassportModule],
})
export class AuthModule {

  /**
   * Dynamic module
   * see https://docs.nestjs.com/modules#dynamic-modules
   */
  static forRoot(options: Partial<ServerOptions>): DynamicModule {
    return {
      module: AuthModule,
      imports: [JwtModule.register(options.jwt)],
      providers: [
        {
          provide: ConfigService,
          useValue: new ConfigService(options),
        },
      ],
      exports: [JwtModule],
    };
  }
}
