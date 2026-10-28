import { Injectable, OnApplicationBootstrap, OnApplicationShutdown, OnModuleInit } from '@nestjs/common';

import { getPersistenceRuntime } from './persistence-runtime.registry.js';

/**
 * Opens the framework's lease store, releases the owner connections once the application is up, and closes the connections of every SQL data source on
 * shutdown. Registered by `CoreModule` only when a SQL source is configured; the sources themselves are opened while
 * Nest creates the stores, so a misconfigured one stops the boot.
 */
@Injectable()
export class CorePersistenceLifecycle implements OnApplicationBootstrap, OnApplicationShutdown, OnModuleInit {
  async onModuleInit(): Promise<void> {
    // The lease table of the default source, while the boot's owner connection is still open — and an unsafe
    // application role stops the boot here even when no model of the default source is registered
    await getPersistenceRuntime()?.defaultLockStore();
  }

  async onApplicationBootstrap(): Promise<void> {
    // Every store exists by now: providers are created before any bootstrap hook runs
    await getPersistenceRuntime()?.releaseBootConnections();
  }

  async onApplicationShutdown(): Promise<void> {
    await getPersistenceRuntime()?.close();
  }
}
