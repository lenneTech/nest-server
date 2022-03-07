import { Module } from '@nestjs/common';
import envConfig from '../config.env';
import { CoreModule } from '../core.module';
import { AuthModule } from './modules/auth/auth.module';
import { FileController } from './modules/file/file.controller';
import { ServerController } from './server.controller';
import { CoreAuthService } from '../core/modules/auth/services/core-auth.service';

/**
 * Server module (dynamic)
 *
 * This is the server module, which includes all modules which are necessary
 * for the project API
 */
@Module({
  // Include modules
  imports: [
    // Include CoreModule for standard processes
    CoreModule.forRoot(CoreAuthService, AuthModule.forRoot(envConfig.jwt), envConfig),

    // Include AuthModule for authorization handling,
    // which will also include UserModule
    AuthModule.forRoot(envConfig.jwt),
  ],

  // Include REST controllers
  controllers: [FileController, ServerController],

  // Export modules for reuse in other modules
  exports: [CoreModule, AuthModule],
})
export class ServerModule {}
