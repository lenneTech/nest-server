import { Module, type INestApplication } from '@nestjs/common';
import { ScheduleModule } from '@nestjs/schedule';
import { Test, type TestingModule } from '@nestjs/testing';
import { PubSub } from 'graphql-subscriptions';
import type { AddressInfo } from 'node:net';

// Relative imports name the emitted `.js` file: `tests/helpers/sync-server.process.ts` runs this module under the
// framework's SWC loader in a process of its own, where ESM resolves no extension (vitest maps `.js` to `.ts` too)
import { CoreBetterAuthModule } from '../../src/core/modules/better-auth/core-better-auth.module.js';
import { CoreAuthService } from '../../src/core/modules/auth/services/core-auth.service.js';
import { HttpExceptionLogFilter } from '../../src/core/common/filters/http-exception-log.filter.js';
import { Any } from '../../src/core/common/scalars/any.scalar.js';
import { DateScalar } from '../../src/core/common/scalars/date.scalar.js';
import { JSON as JSONScalar } from '../../src/core/common/scalars/json.scalar.js';
import { CoreModule } from '../../src/core.module.js';
import { CronJobs } from '../../src/server/common/services/cron-jobs.service.js';
import { AuthController } from '../../src/server/modules/auth/auth.controller.js';
import { AuthModule } from '../../src/server/modules/auth/auth.module.js';
import { BetterAuthModule } from '../../src/server/modules/better-auth/better-auth.module.js';
import { FileModule } from '../../src/server/modules/file/file.module.js';
import { SyncNoteModule } from '../../src/server/modules/sync-note/sync-note.module.js';
import { ServerController } from '../../src/server/server.controller.js';

/** A booted reference server with offline sync, listening on a real port (SSE, WebSockets and browsers need one) */
export interface SyncTestApp {
  app: INestApplication;
  baseUrl: string;
  moduleRef: TestingModule;
  port: number;
  /** Closes open connections, the server and the application */
  close(): Promise<void>;
}

export interface SyncTestAppOptions {
  /** Runs before `app.init()` — where Express middleware must be registered to sit ahead of Nest's 404 handler */
  beforeInit?: (app: INestApplication) => void;
  /** Further modules beside the reference server's (the extra models of a suite) */
  imports?: any[];
  /** The port to listen on; `0` (default) takes a free one */
  port?: number;
}

/**
 * The reference server as the offline-sync suites assemble it: legacy auth and Better-Auth side by side, the file
 * module, `SyncNote` (`src/server/modules/sync-note/`) and whatever a suite adds. Shared by the contract matrix, the two
 * test clients and the server processes of the clock-skew suite, so all of them answer through the same application.
 */
export async function bootSyncTestApp(
  config: Record<string, any>,
  options: SyncTestAppOptions = {},
): Promise<SyncTestApp> {
  CoreBetterAuthModule.reset();

  @Module({
    controllers: [ServerController, AuthController],
    imports: [
      CoreModule.forRoot(CoreAuthService, AuthModule.forRoot(config.jwt), config as any),
      ScheduleModule.forRoot(),
      AuthModule.forRoot(config.jwt),
      BetterAuthModule.forRoot({}),
      FileModule,
      SyncNoteModule,
      ...(options.imports ?? []),
    ],
    providers: [Any, CronJobs, DateScalar, JSONScalar, { provide: 'PUB_SUB', useValue: new PubSub() }],
  })
  class SyncTestServerModule {}

  const moduleRef = await Test.createTestingModule({ imports: [SyncTestServerModule] }).compile();
  const app = moduleRef.createNestApplication();
  app.useGlobalFilters(new HttpExceptionLogFilter());
  (app as any).setBaseViewsDir(config.templates.path);
  (app as any).setViewEngine(config.templates.engine);
  options.beforeInit?.(app);
  await app.init();
  const server = app.getHttpServer();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(options.port ?? 0, '127.0.0.1', () => resolve());
  });
  const { port } = server.address() as AddressInfo;
  return {
    app,
    baseUrl: `http://127.0.0.1:${port}`,
    close: async () => {
      if (server.listening) {
        server.closeAllConnections?.();
        await new Promise<void>((resolve) => server.close(() => resolve()));
      }
      await app.close();
      CoreBetterAuthModule.reset();
    },
    moduleRef,
    port,
  };
}
