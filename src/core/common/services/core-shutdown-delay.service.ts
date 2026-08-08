import { BeforeApplicationShutdown, Injectable, Logger } from '@nestjs/common';

import { ConfigService } from './config.service';

/**
 * Delays the NestJS shutdown sequence by `IServerOptions.shutdownDelayMs` (see there).
 *
 * On a rolling deploy the orchestrator sends SIGTERM and deregisters the instance from the
 * load balancer at the same time — but deregistration is not instant, so requests keep
 * arriving for a moment after the signal. Waiting before the shutdown hooks run lets those
 * in-flight requests land on a still-healthy instance.
 *
 * `beforeApplicationShutdown` is the right hook: it runs BEFORE `onApplicationShutdown`,
 * where the framework's connections (Redis, Mongo) are closed.
 *
 * Requires `enableShutdownHooks()` in main.ts. Inert (no delay, no log) when the option is
 * unset or zero.
 */
@Injectable()
export class CoreShutdownDelayService implements BeforeApplicationShutdown {
  protected readonly logger = new Logger(CoreShutdownDelayService.name);

  constructor(protected readonly configService: ConfigService) {}

  async beforeApplicationShutdown(): Promise<void> {
    const delayMs = this.configService.getFastButReadOnly<number | undefined>('shutdownDelayMs');
    if (typeof delayMs !== 'number' || !(delayMs > 0)) {
      return;
    }
    this.logger.log(`delaying shutdown by ${delayMs}ms for load-balancer deregistration`);
    await new Promise<void>((resolve) => setTimeout(resolve, delayMs));
  }
}
