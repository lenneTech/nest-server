/**
 * Runtime registry for the optional cron-job infrastructure.
 *
 * `CoreCronJobs` is abstract and instantiated by the consuming project, so the
 * framework cannot inject the Mongoose connection or `CoreRedisService` into it.
 * Registering them here instead keeps multi-replica deduplication working WITHOUT
 * any change to an existing subclass — the same shape as
 * `core-better-auth.registry.ts`.
 *
 * The file uses only `import type`, which both tsc and SWC erase entirely, so it
 * emits no `require()` at all and is a true leaf: it can never be mid-evaluation
 * when someone imports it (see .claude/rules/architecture.md → "DI Token Placement
 * (SWC-Safe)"). Its exports are hoisted `function` declarations for the same reason.
 *
 * @internal Populated by CoreModule. `CoreCronJobs` reads it lazily on every access,
 * so a registration that happens after the service was constructed still takes effect.
 */

import type { CoreRedisService } from './core-redis.service';
import type { Connection } from 'mongoose';

export interface CronJobsInfrastructure {
  /** Mongoose connection used for the per-tick MongoDB lease */
  connection?: Connection;

  /** Central Redis service; enables the BullMQ job-scheduler mode */
  redisService?: CoreRedisService;
}

let infrastructure: CronJobsInfrastructure = {};

/**
 * Returns the registered cron-job infrastructure; empty when nothing was registered.
 */
export function getCronJobsInfrastructure(): CronJobsInfrastructure {
  return infrastructure;
}

/**
 * Registers the cron-job infrastructure. Pass `{}` to clear it (tests).
 * @internal
 */
export function setCronJobsInfrastructure(value: CronJobsInfrastructure): void {
  infrastructure = value ?? {};
}
