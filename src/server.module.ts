import { Module } from '@nestjs/common';
import envConfig from './config.env';
import { CoreModule } from './core.module';
import { AuthModule } from './server/modules/auth/auth.module';

/**
 * Server module (dynamic)
 *
 * This is the server module, which includes all modules which are necessary
 * for the project API
 */
@Module({
  imports: [

    // Include CoreModule for standard processes
    CoreModule.forRoot(envConfig),

    // Include AuthModule for authorization handling,
    // which will also include UserModule
    AuthModule.forRoot(envConfig),
  ],

  exports: [CoreModule, AuthModule],
})
export class ServerModule {}
