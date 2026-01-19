import { Module } from '@nestjs/common';
import { ScheduleModule } from '@nestjs/schedule';

import envConfig from '../config.env';
import { CoreModule } from '../core.module';
import { Any } from '../core/common/scalars/any.scalar';
import { DateScalar } from '../core/common/scalars/date.scalar';
import { JSON } from '../core/common/scalars/json.scalar';
import { CoreAuthService } from '../core/modules/auth/services/core-auth.service';
import { ErrorCodeModule } from '../core/modules/error-code/error-code.module';
import { TusModule } from '../core/modules/tus';
import { CronJobs } from './common/services/cron-jobs.service';
import { AuthController } from './modules/auth/auth.controller';
import { AuthModule } from './modules/auth/auth.module';
import { BetterAuthModule } from './modules/better-auth/better-auth.module';
import { ErrorCodeController } from './modules/error-code/error-code.controller';
import { ErrorCodeService } from './modules/error-code/error-code.service';
import { FileModule } from './modules/file/file.module';
import { ServerController } from './server.controller';

/**
 * Server module (dynamic)
 *
 * This is the server module, which includes all modules which are necessary
 * for the project API
 */
@Module({
  // Include REST controllers
  controllers: [ServerController, AuthController],

  // Export modules for reuse in other modules
  exports: [CoreModule, AuthModule, BetterAuthModule, FileModule, TusModule],

  // Include modules
  imports: [
    // Include CoreModule for standard processes
    // Note: BetterAuthModule is imported manually below (autoRegister defaults to false)
    CoreModule.forRoot(CoreAuthService, AuthModule.forRoot(envConfig.jwt), envConfig),

    // Include cron job handling
    ScheduleModule.forRoot(),

    // Include AuthModule for authorization handling,
    // which will also include UserModule
    AuthModule.forRoot(envConfig.jwt),

    // Include BetterAuthModule for better-auth integration
    // This allows project-specific customization via BetterAuthResolver
    BetterAuthModule.forRoot({
      config: envConfig.betterAuth,
      fallbackSecrets: [envConfig.jwt?.secret, envConfig.jwt?.refresh?.secret],
    }),

    // Include ErrorCodeModule with project-specific error codes
    // Uses Core ErrorCodeModule.forRoot() with custom service and controller
    ErrorCodeModule.forRoot({
      controller: ErrorCodeController,
      service: ErrorCodeService,
    }),

    // Include FileModule for file handling
    FileModule,

    // Include TusModule for resumable file uploads
    TusModule.forRoot(),
  ],

  providers: [Any, CronJobs, DateScalar, JSON],
})
export class ServerModule {}
