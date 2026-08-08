import { INestApplication, Logger } from '@nestjs/common';

import { ConfigService } from '../services/config.service';

/** Signals an orchestrator uses to ask a container to stop */
const SHUTDOWN_SIGNALS: NodeJS.Signals[] = ['SIGTERM', 'SIGINT'];

/**
 * A delay this long is almost certainly a typo (seconds written as milliseconds, or the other way
 * round). Orchestrators SIGKILL after their grace period anyway — typically 10-30s — so a longer
 * wait cannot be honored, it only guarantees the ungraceful ending it was meant to avoid.
 */
const MAX_SHUTDOWN_DELAY_MS = 60_000;

/**
 * Install signal handling that keeps the app healthy for `IServerOptions.shutdownDelayMs`
 * before shutting it down, then closes it cleanly.
 *
 * **Why this is not a NestJS lifecycle hook.** The obvious place looks like
 * `beforeApplicationShutdown`, but Nest's `close()` runs
 * `onModuleDestroy` → `beforeApplicationShutdown` → dispose (close the HTTP server) →
 * `onApplicationShutdown`. A delay in that hook therefore waits AFTER every module has been
 * destroyed while the socket is still accepting — so the instance keeps taking traffic with its
 * services already torn down. That is worse than not waiting at all, which is why the wait has to
 * happen before `close()` is entered, i.e. in the signal handler.
 *
 * **What the delay is for.** An orchestrator sends SIGTERM and deregisters the instance from the
 * load balancer at the same moment, but deregistration propagates asynchronously — for a beat,
 * requests still arrive. Staying fully healthy through that beat is what lets them be answered
 * instead of dropped.
 *
 * Without a configured delay this is exactly `app.enableShutdownHooks()`, which is what the
 * framework did before.
 *
 * @param app the Nest application to shut down
 * @returns the same app, so it can be chained
 */
export function installGracefulShutdown<T extends INestApplication>(app: T): T {
  const logger = new Logger('GracefulShutdown');
  const configured = ConfigService.getFastButReadOnly<number | undefined>('shutdownDelayMs');
  const delayMs = typeof configured === 'number' && configured > 0 ? configured : 0;

  if (!delayMs) {
    // Nest's own handling: close immediately on a signal, running every lifecycle hook.
    app.enableShutdownHooks();
    return app;
  }

  if (delayMs > MAX_SHUTDOWN_DELAY_MS) {
    logger.warn(
      `shutdownDelayMs is ${delayMs}ms, which exceeds the ${MAX_SHUTDOWN_DELAY_MS}ms cap and is longer than a typical ` +
        `orchestrator grace period — capping it, since a longer wait only ends in SIGKILL.`,
    );
  }
  const effectiveDelayMs = Math.min(delayMs, MAX_SHUTDOWN_DELAY_MS);

  // Deliberately NOT enableShutdownHooks(): Nest would install its own listener for the same
  // signals and close the app immediately, in parallel with the wait below.
  let shuttingDown = false;

  const handle = (signal: NodeJS.Signals): void => {
    if (shuttingDown) {
      // A second signal means someone is impatient. Stop waiting and close now.
      logger.warn(`${signal} received again — closing immediately`);
      void app.close();
      return;
    }
    shuttingDown = true;
    logger.log(`${signal} received — staying healthy for ${effectiveDelayMs}ms so the load balancer can deregister`);

    const timer = setTimeout(() => {
      app
        .close()
        .then(() => logger.log('Shutdown complete'))
        .catch((error) => logger.error(`Shutdown failed: ${error instanceof Error ? error.message : 'Unknown error'}`));
    }, effectiveDelayMs);
    // The listening server keeps the loop alive on its own; this timer must not be what holds it.
    timer.unref?.();
  };

  for (const signal of SHUTDOWN_SIGNALS) {
    process.on(signal, handle);
  }

  return app;
}
