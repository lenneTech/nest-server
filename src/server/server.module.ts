import { Module } from '@nestjs/common';
import { ScheduleModule } from '@nestjs/schedule';

import envConfig from '../config.env.js';
import { CoreModule } from '../core.module.js';
import { Any } from '../core/common/scalars/any.scalar.js';
import { DateScalar } from '../core/common/scalars/date.scalar.js';
import { JSON } from '../core/common/scalars/json.scalar.js';
import { CoreAuthService } from '../core/modules/auth/services/core-auth.service.js';
import { TusModule } from '../core/modules/tus/index.js';
import { CronJobs } from './common/services/cron-jobs.service.js';
import { AiToolsModule } from './modules/ai/ai-tools.module.js';
import { AuthController } from './modules/auth/auth.controller.js';
import { AuthModule } from './modules/auth/auth.module.js';
import { BetterAuthModule } from './modules/better-auth/better-auth.module.js';
import { ErrorCodeController } from './modules/error-code/error-code.controller.js';
import { ErrorCodeService } from './modules/error-code/error-code.service.js';
import { FileModule } from './modules/file/file.module.js';
import { ServerController } from './server.controller.js';

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
    // ErrorCodeModule is auto-registered by CoreModule with overrides for custom controller/service
    CoreModule.forRoot(CoreAuthService, AuthModule.forRoot(envConfig.jwt), envConfig, {
      errorCode: {
        controller: ErrorCodeController,
        service: ErrorCodeService,
      },
    }),

    // Include cron job handling
    ScheduleModule.forRoot(),

    // Include AuthModule for authorization handling,
    // which will also include UserModule
    AuthModule.forRoot(envConfig.jwt),

    // Include BetterAuthModule for better-auth integration
    // Zero-Config: All values are auto-read from ConfigService (set by CoreModule.forRoot)
    // This allows project-specific customization via BetterAuthResolver
    BetterAuthModule.forRoot({}),

    // Include FileModule for file handling
    FileModule,

    // Include TusModule for resumable file uploads
    TusModule.forRoot(),

    // Register example AI tools (CoreAiModule itself is auto-registered by CoreModule
    // when an `ai` config block is present)
    AiToolsModule,
  ],

  providers: [Any, CronJobs, DateScalar, JSON],
})
export class ServerModule {}
