import { Injectable } from '@nestjs/common';
import {
  DiskHealthIndicator,
  HealthCheckResult,
  HealthCheckService,
  MemoryHealthIndicator,
  MongooseHealthIndicator,
} from '@nestjs/terminus';
import type { MongoosePingCheckSettings } from '@nestjs/terminus/dist/health-indicator/database/mongoose.health.js';
import type { DiskHealthIndicatorOptions } from '@nestjs/terminus/dist/health-indicator/disk/disk-health-options.type.js';

import { getBuildInfo } from '../../common/helpers/meta.helper';
import { ConfigService } from '../../common/services/config.service';

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
  ) {}

  healthCheck(): Promise<HealthCheckResult> {
    const healthIndicatorFunctions = [];
    if (this.config.get<boolean>('healthCheck.configs.database.enabled')) {
      healthIndicatorFunctions.push(() =>
        this.db.pingCheck(
          this.config.get<string>('healthCheck.configs.database.key') ?? 'database',
          this.config.get<MongoosePingCheckSettings>('healthCheck.configs.database.options') ?? { timeout: 300 },
        ),
      );
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
