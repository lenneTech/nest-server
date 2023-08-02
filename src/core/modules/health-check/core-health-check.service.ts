import { Injectable } from '@nestjs/common';
import {
  DiskHealthIndicator, HealthCheckResult,
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
  ) {
  }

  healthCheck(): Promise<HealthCheckResult> {
    const healthIndicatorFunctions = [];
    if (!this.config.get<boolean>('healthCheck.configs.database.disabled')) {
      healthIndicatorFunctions.push(() =>
        this.db.pingCheck(
          this.config.get<string>('healthCheck.configs.database.key') ?? 'database',
          this.config.get<MongoosePingCheckSettings>('healthCheck.configs.database.options') ?? { timeout: 300 },
        ));
    }
    if (!this.config.get<boolean>('healthCheck.configs.memoryHeap.disabled')) {
      healthIndicatorFunctions.push(() => this.memory.checkHeap(
        this.config.get<string>('healthCheck.configs.memoryHeap.key') ?? 'memoryHeap',
        this.config.get<number>('healthCheck.configs.memoryHeap.heapUsedThreshold') ?? 150 * 1024 * 1024,
      ));
    }
    if (!this.config.get<boolean>('healthCheck.configs.memoryRss.disabled')) {
      healthIndicatorFunctions.push(() => this.memory.checkRSS(
        this.config.get<string>('healthCheck.configs.memoryRss.key') ?? 'memoryRss',
        this.config.get<number>('healthCheck.configs.memoryRss.rssThreshold') ?? 150 * 1024 * 1024,
      ));
    }
    if (!this.config.get<boolean>('healthCheck.configs.storage.disabled')) {
      healthIndicatorFunctions.push(() => this.disk.checkStorage(
        this.config.get<string>('healthCheck.configs.storage.key') ?? 'storage',
        this.config.get<DiskHealthIndicatorOptions>('healthCheck.configs.storage.options') ?? {
          thresholdPercent: 0.8,
          path: '/',
        },
      ));
    }
    return this.health.check(healthIndicatorFunctions);
  }
}
