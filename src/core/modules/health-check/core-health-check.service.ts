import { Injectable, Optional } from '@nestjs/common';
import {
  DiskHealthIndicator,
  type DiskHealthIndicatorOptions,
  HealthCheckResult,
  HealthCheckService,
  HealthIndicatorService,
  MemoryHealthIndicator,
  MongooseHealthIndicator,
  type MongoosePingCheckSettings,
} from '@nestjs/terminus';

import { getBuildInfo } from '../../common/helpers/meta.helper.js';
import { getPersistenceRuntime } from '../../common/persistence/persistence-runtime.registry.js';
import { ConfigService } from '../../common/services/config.service.js';

/**
 * Core health check service
 * Inspired by https://mobileappcircular.com/marketplace-backend-creating-a-health-check-endpoint-in-nestjs-app-using-terminus-25727e96c7d2
 */
@Injectable()
export class CoreHealthCheckService {
  constructor(
    protected config: ConfigService,
    protected db: MongooseHealthIndicator,
    protected disk: DiskHealthIndicator,
    protected health: HealthCheckService,
    protected memory: MemoryHealthIndicator,
    @Optional() protected indicators?: HealthIndicatorService,
  ) {}

  healthCheck(): Promise<HealthCheckResult> {
    const healthIndicatorFunctions = [];
    if (this.config.get<boolean>('healthCheck.configs.database.enabled')) {
      healthIndicatorFunctions.push(() => {
        // `timeout` stays part of the config contract, but @nestjs/terminus 12 deprecated it on the
        // indicator in favour of `.withTimeout()` on the returned attempt — translate it here, so the
        // configuration keeps working once the option is gone from the indicator.
        // Same effective timeouts as before: 300 ms without configured options, otherwise the
        // configured `timeout`, otherwise Terminus' own default (1000 ms).
        const { timeout, ...options } = this.config.get<MongoosePingCheckSettings>(
          'healthCheck.configs.database.options',
        ) ?? { timeout: 300 };
        const attempt = this.db.pingCheck(
          this.config.get<string>('healthCheck.configs.database.key') ?? 'database',
          options,
        );
        return timeout === undefined ? attempt : attempt.withTimeout(timeout);
      });
    }
    if (this.config.get<boolean>('healthCheck.configs.database.enabled')) {
      // Every SQL source answers on its own key, next to the MongoDB ping: `<key>:<source>` (`database:default`). A
      // database the application cannot reach is down, whichever one it is
      const key = this.config.get<string>('healthCheck.configs.database.key') ?? 'database';
      const timeout =
        this.config.get<MongoosePingCheckSettings>('healthCheck.configs.database.options')?.timeout ?? 1000;
      for (const source of getPersistenceRuntime()?.sqlSources() ?? []) {
        if (this.indicators) {
          healthIndicatorFunctions.push(() =>
            this.indicators
              .check(`${key}:${source.name}`)
              .attempt(() => source.ping())
              .withTimeout(timeout),
          );
        }
      }
    }
    if (this.config.get<boolean>('healthCheck.configs.memoryHeap.enabled')) {
      healthIndicatorFunctions.push(() =>
        this.memory.checkHeap(
          this.config.get<string>('healthCheck.configs.memoryHeap.key') ?? 'memoryHeap',
          // memory in bytes (4GB default)
          this.config.get<number>('healthCheck.configs.memoryHeap.heapUsedThreshold') ?? 4 * 1024 * 1024 * 1024,
        ),
      );
    }
    if (this.config.get<boolean>('healthCheck.configs.memoryRss.enabled')) {
      healthIndicatorFunctions.push(() =>
        this.memory.checkRSS(
          this.config.get<string>('healthCheck.configs.memoryRss.key') ?? 'memoryRss',
          // memory in bytes (4GB default)
          this.config.get<number>('healthCheck.configs.memoryRss.rssThreshold') ?? 4 * 1024 * 1024 * 1024,
        ),
      );
    }
    if (this.config.get<boolean>('healthCheck.configs.storage.enabled')) {
      healthIndicatorFunctions.push(() =>
        this.disk.checkStorage(
          this.config.get<string>('healthCheck.configs.storage.key') ?? 'storage',
          this.config.get<DiskHealthIndicatorOptions>('healthCheck.configs.storage.options') ?? {
            path: '/',
            thresholdPercent: 0.8,
          },
        ),
      );
    }
    // Build identity (commit / version / env) — always reported as "up", so it
    // surfaces under `info`/`details` without ever affecting the overall health
    // status. Lets ops/monitoring detect a drifted or stale container after a
    // partial rollout (the same commit-SHA signal the admin UI compares). The
    // commit is baked into the image at build time (APP_VERSION_COMMIT, fed from
    // the CI commit SHA); `version`/`env` come from the config. Opt out with
    // `healthCheck.configs.build.enabled: false`.
    if (this.config.get<boolean>('healthCheck.configs.build.enabled') !== false) {
      const build = getBuildInfo({ env: this.config.get<string>('env'), version: this.config.get<string>('version') });
      healthIndicatorFunctions.push(async () => ({ build: { ...build, status: 'up' as const } }));
    }

    return this.health.check(healthIndicatorFunctions);
  }
}
