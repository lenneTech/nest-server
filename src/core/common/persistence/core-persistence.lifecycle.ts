import { Injectable, OnApplicationBootstrap, OnApplicationShutdown } from '@nestjs/common';

import { getPersistenceRuntime } from './persistence-runtime.registry.js';

/**
 * Releases the owner connections once the application is up, and closes the connections of every SQL data source on
 * shutdown. Registered by `CoreModule` only when a SQL source is configured; the sources themselves are opened while
 * Nest creates the stores, so a misconfigured one stops the boot.
 */
@Injectable()
export class CorePersistenceLifecycle implements OnApplicationBootstrap, OnApplicationShutdown {
  async onApplicationBootstrap(): Promise<void> {
    // Every store exists by now: providers are created before any bootstrap hook runs
    await getPersistenceRuntime()?.releaseBootConnections();
  }

  async onApplicationShutdown(): Promise<void> {
    await getPersistenceRuntime()?.close();
  }
}
