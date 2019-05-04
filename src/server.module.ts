import { Module } from '@nestjs/common';
import envConfig from './config.env';
import { CoreModule } from './core.module';
import { AuthModule } from './server/modules/auth/auth.module';

import { UserModule } from './server/modules/user/user.module';

// =============================================================================
// Server module
// =============================================================================
/**
 * Server module (dynamic)
 */
@Module({
  imports: [
    CoreModule.forRoot(envConfig),
    AuthModule.forRoot(envConfig),
  ],
})
export class ServerModule {}
