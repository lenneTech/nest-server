import { Injectable, Logger, OnApplicationBootstrap, OnApplicationShutdown, OnModuleInit } from '@nestjs/common';

import { type ExpirySweep, scheduleExpirySweep } from './expiry-sweep.js';
import { getPersistenceRuntime } from './persistence-runtime.registry.js';

/**
 * Opens the framework's lease store, releases the owner connections once the application is up, removes expired rows
 * from SQL tables, and closes the connections of every SQL data source on shutdown. Registered by `CoreModule` only
 * when a SQL source is configured; the sources themselves are opened while Nest creates the stores, so a misconfigured
 * one stops the boot.
 */
@Injectable()
export class CorePersistenceLifecycle implements OnApplicationBootstrap, OnApplicationShutdown, OnModuleInit {
  protected readonly logger = new Logger('DataSources');
  protected expirySweep?: ExpirySweep;

  async onModuleInit(): Promise<void> {
    // The lease table of the default source, while the boot's owner connection is still open — and an unsafe
    // application role stops the boot here even when no model of the default source is registered
    await getPersistenceRuntime()?.defaultLockStore();
  }

  async onApplicationBootstrap(): Promise<void> {
    const runtime = getPersistenceRuntime();
    // Every store exists by now: providers are created before any bootstrap hook runs
    await runtime?.releaseBootConnections();
    if (runtime) {
      // A model's TTL (`expires`, `index: { expireAfterSeconds }`) is a plain index on SQL — this does the deleting
      this.expirySweep = scheduleExpirySweep(
        'models',
        async () => {
          for (const { deleted, model } of await runtime.sweepExpired()) {
            if (deleted) {
              this.logger.debug(`Removed ${deleted} expired ${model} record(s)`);
            }
          }
        },
        { logger: this.logger },
      );
    }
  }

  async onApplicationShutdown(): Promise<void> {
    await this.expirySweep?.stop();
    await getPersistenceRuntime()?.close();
  }
}
