import { Module } from '@nestjs/common';
import envConfig from './config.env';
import { CoreModule } from './core.module';
import { ConfigService } from './core/common/services/config.service';
import { Auth } from './server/modules/auth/auth.model';
import { AuthResolver } from './server/modules/auth/auth.resolver';
import { User } from './server/modules/user/user.model';
import { UserResolver } from './server/modules/user/user.resolver';
import { UserService } from './server/modules/user/user.service';

// =============================================================================
// Server module
// =============================================================================
/**
 * Server module (dynamic)
 */
@Module({
  imports: [
    CoreModule.forRoot(Auth, new ConfigService(envConfig), User, UserService, Object.assign(envConfig, {
      authResolverClass: AuthResolver,
      userResolverClass: UserResolver,
      userServiceClass: UserService,
    })),
  ],
})
export class ServerModule {}
