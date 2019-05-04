import { DynamicModule, Module } from '@nestjs/common';
import { IServerOptions } from '../../../core/common/interfaces/server-options.interface';
import { CoreAuthModule } from '../../../core/modules/auth/core-auth.module';
import { UserModule } from '../user/user.module';
import { UserService } from '../user/user.service';
import { AuthResolver } from './auth.resolver';

/**
 * CoreAuthModule to handle user authentication
 */
@Module({})
export class AuthModule {

  /**
   * Dynamic module
   * see https://docs.nestjs.com/modules#dynamic-modules
   */
  static forRoot(options: Partial<IServerOptions>): DynamicModule {
    return {
      module: AuthModule,
      imports: [
        CoreAuthModule.forRoot(UserModule, UserService, options),
      ],
      providers: [AuthResolver],
    };
  }
}
