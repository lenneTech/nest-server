import { Injectable } from '@nestjs/common';
import {
  DiskHealthIndicator,
  HealthCheckResult,
  HealthCheckService,
  MemoryHealthIndicator,
  MongooseHealthIndicator,
} from '@nestjs/terminus';
import { MongoosePingCheckSettings } from '@nestjs/terminus/dist/health-indicator/database/mongoose.health';
import { DiskHealthIndicatorOptions } from '@nestjs/terminus/dist/health-indicator/disk/disk-health-options.type';

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
    return this.health.check(healthIndicatorFunctions);
  }
}
