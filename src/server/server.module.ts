import { Module } from '@nestjs/common';
import { APP_INTERCEPTOR } from '@nestjs/core';
import { ScheduleModule } from '@nestjs/schedule';

import envConfig from '../config.env';
import { CoreModule } from '../core.module';
import { CheckSecurityInterceptor } from '../core/common/interceptors/check-security.interceptor';
import { Any } from '../core/common/scalars/any.scalar';
import { DateScalar } from '../core/common/scalars/date.scalar';
import { JSON } from '../core/common/scalars/json.scalar';
import { CoreAuthService } from '../core/modules/auth/services/core-auth.service';
import { CronJobs } from './common/services/cron-jobs.service';
import { AuthModule } from './modules/auth/auth.module';
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
  controllers: [ServerController],

  // Export modules for reuse in other modules
  exports: [CoreModule, AuthModule, FileModule],

  // Include modules
  imports: [
    // Include CoreModule for standard processes
    CoreModule.forRoot(CoreAuthService, AuthModule.forRoot(envConfig.jwt), envConfig),

    // Include cron job handling
    ScheduleModule.forRoot(),

    // Include AuthModule for authorization handling,
    // which will also include UserModule
    AuthModule.forRoot(envConfig.jwt),

    // Include FileModule for file handling
    FileModule,
  ],

  providers: [
    Any,
    CronJobs,
    DateScalar,
    JSON,
    {
      provide: APP_INTERCEPTOR,
      useClass: CheckSecurityInterceptor,
    },
  ],
})
export class ServerModule {}
