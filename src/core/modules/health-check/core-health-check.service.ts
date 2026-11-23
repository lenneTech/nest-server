import { Inject, Injectable, Optional, ServiceUnavailableException } from '@nestjs/common';
import {
  DiskHealthIndicator,
  type DiskHealthIndicatorOptions,
  HealthCheckResult,
  HealthCheckService,
  type HealthIndicatorFunction,
  HealthIndicatorService,
  MemoryHealthIndicator,
  MongooseHealthIndicator,
  type MongoosePingCheckSettings,
} from '@nestjs/terminus';

import { getBuildInfo } from '../../common/helpers/meta.helper.js';
import { isShutdownDraining } from '../../common/helpers/shutdown-state.helper.js';
import { getPersistenceRuntime } from '../../common/persistence/persistence-runtime.registry.js';
import { ConfigService } from '../../common/services/config.service.js';
import {
  CORE_HEALTH_CHECK_NAMES,
  type CoreHealthCheckKind,
  type CoreHealthCheckName,
  resolveHealthCheckReadiness,
} from './core-health-check.helpers.js';

/**
 * Core health check service
 * Inspired by https://mobileappcircular.com/marketplace-backend-creating-a-health-check-endpoint-in-nestjs-app-using-terminus-25727e96c7d2
 *
 * Two checks (12.11.0): {@link healthCheck} answers `GET /health-check` and the `healthCheck` query (liveness), with
 * the checks `healthCheck.configs` enables; {@link readinessCheck} answers `GET /health-check/ready`, registered with
 * `healthCheck.readiness`, with the checks `healthCheck.readiness.checks` lists. A project adds checks of its own by
 * extending this class and overriding {@link additionalHealthIndicators} — see there — and registers the subclass with
 * `CoreModule.forRoot(env, { healthCheck: { service: HealthCheckService } })`.
 */
@Injectable()
export class CoreHealthCheckService {
  constructor(
    protected config: ConfigService,
    // Explicit token: a union type gives Nest no class to inject; `null` where no MongoDB is configured (module factory)
    @Inject(MongooseHealthIndicator) protected db: MongooseHealthIndicator | null,
    protected disk: DiskHealthIndicator,
    protected health: HealthCheckService,
    protected memory: MemoryHealthIndicator,
    @Optional() protected indicators?: HealthIndicatorService,
  ) {}

  /**
   * The liveness check (`GET /health-check`, the `healthCheck` query): every check `healthCheck.configs` enables, then
   * the project's own (`additionalHealthIndicators('liveness')`). Answers the Terminus result; rejects with 503 when a
   * check is down.
   */
  async healthCheck(): Promise<HealthCheckResult> {
    const checks = CORE_HEALTH_CHECK_NAMES.filter((check) => this.isLivenessCheckEnabled(check));
    return this.health.check([
      ...checks.flatMap((check) => this.configuredHealthIndicators(check)),
      ...(await this.additionalHealthIndicators('liveness')),
    ]);
  }

  /**
   * The readiness check (`GET /health-check/ready`, 12.11.0): the checks `healthCheck.readiness.checks` lists (default
   * `database` and `build`), then the project's own (`additionalHealthIndicators('readiness')`). Rejects with 503 when
   * a check is down — and from the first shutdown signal on (`shutting_down`): `installGracefulShutdown()` marks it
   * before its `shutdownDelayMs` wait, so a load balancer polling readiness stops routing to the replica while it is
   * still serving. Without `installGracefulShutdown()` only Terminus' own state applies, which comes inside
   * `app.close()`, right before the server closes.
   */
  async readinessCheck(): Promise<HealthCheckResult> {
    if (isShutdownDraining()) {
      throw new ServiceUnavailableException({ details: {}, error: {}, info: {}, status: 'shutting_down' });
    }
    const { checks } = resolveHealthCheckReadiness(this.config.get('healthCheck'));
    return this.health.check([
      ...checks.flatMap((check) => this.configuredHealthIndicators(check)),
      ...(await this.additionalHealthIndicators('readiness')),
    ]);
  }

  /**
   * The extension point for checks of a project's own (12.11.0): override it in a subclass and return Terminus health
   * indicators for the check that asks — `'liveness'` (`GET /health-check`, the `healthCheck` query) or `'readiness'`
   * (`GET /health-check/ready`). They run after the configured checks; one that is down turns the check red (503).
   *
   * Keep liveness to what restarting the process would cure; what the process needs from outside (a queue, a third-
   * party API) belongs to readiness, so an outage there takes the replica out of rotation instead of restarting it.
   *
   * @example
   * ```typescript
   * @Injectable()
   * export class HealthCheckService extends CoreHealthCheckService {
   *   protected override additionalHealthIndicators(kind: CoreHealthCheckKind): HealthIndicatorFunction[] {
   *     return kind === 'readiness'
   *       ? [() => this.indicators.check('erp').attempt(() => this.erpClient.ping()).withTimeout(1000)]
   *       : [];
   *   }
   * }
   * ```
   * The injected `indicators` (`HealthIndicatorService`) builds an indicator from any check; `memory`, `disk` and `db`
   * are Terminus' own indicators.
   *
   * @default no additional indicators
   */
  protected additionalHealthIndicators(
    _kind: CoreHealthCheckKind,
  ): HealthIndicatorFunction[] | Promise<HealthIndicatorFunction[]> {
    return [];
  }

  /**
   * Whether `GET /health-check` runs a configured check: `configs.<check>.enabled` — set, except for `build`, which runs
   * unless switched off
   */
  protected isLivenessCheckEnabled(check: CoreHealthCheckName): boolean {
    const enabled = this.config.get<boolean>(`healthCheck.configs.${check}.enabled`);
    return check === 'build' ? enabled !== false : !!enabled;
  }

  /** The indicators of one check of `healthCheck.configs`, with its key, thresholds and options from there */
  protected configuredHealthIndicators(check: CoreHealthCheckName): HealthIndicatorFunction[] {
    switch (check) {
      case 'build':
        return this.buildHealthIndicators();
      case 'database':
        return this.databaseHealthIndicators();
      case 'memoryHeap':
        return [
          () =>
            this.memory.checkHeap(
              this.config.get<string>('healthCheck.configs.memoryHeap.key') ?? 'memoryHeap',
              // memory in bytes (4GB default)
              this.config.get<number>('healthCheck.configs.memoryHeap.heapUsedThreshold') ?? 4 * 1024 * 1024 * 1024,
            ),
        ];
      case 'memoryRss':
        return [
          () =>
            this.memory.checkRSS(
              this.config.get<string>('healthCheck.configs.memoryRss.key') ?? 'memoryRss',
              // memory in bytes (4GB default)
              this.config.get<number>('healthCheck.configs.memoryRss.rssThreshold') ?? 4 * 1024 * 1024 * 1024,
            ),
        ];
      case 'storage':
        return [
          () =>
            this.disk.checkStorage(
              this.config.get<string>('healthCheck.configs.storage.key') ?? 'storage',
              this.config.get<DiskHealthIndicatorOptions>('healthCheck.configs.storage.options') ?? {
                path: '/',
                thresholdPercent: 0.8,
              },
            ),
        ];
      default:
        return [];
    }
  }

  /** The MongoDB ping where MongoDB is configured, and every SQL source on its own key */
  protected databaseHealthIndicators(): HealthIndicatorFunction[] {
    const healthIndicatorFunctions: HealthIndicatorFunction[] = [];
    // The MongoDB ping where MongoDB is configured — a project on PostgreSQL alone has no MongoDB to ping
    if (this.db) {
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
    // Every SQL source answers on its own key, next to the MongoDB ping: `<key>:<source>` (`database:default`). A
    // database the application cannot reach is down, whichever one it is
    const key = this.config.get<string>('healthCheck.configs.database.key') ?? 'database';
    const timeout = this.config.get<MongoosePingCheckSettings>('healthCheck.configs.database.options')?.timeout ?? 1000;
    if (this.indicators) {
      for (const source of getPersistenceRuntime()?.sqlSources() ?? []) {
        healthIndicatorFunctions.push(() =>
          this.indicators
            .check(`${key}:${source.name}`)
            .attempt(() => source.ping())
            .withTimeout(timeout),
        );
      }
    }
    return healthIndicatorFunctions;
  }

  /**
   * Build identity (commit / version / env) — always reported as "up", so it surfaces under `info`/`details` without
   * ever affecting the overall health status. Lets ops/monitoring detect a drifted or stale container after a partial
   * rollout (the same commit-SHA signal the admin UI compares). The commit is baked into the image at build time
   * (APP_VERSION_COMMIT, fed from the CI commit SHA); `version`/`env` come from the config. Opt out with
   * `healthCheck.configs.build.enabled: false`.
   */
  protected buildHealthIndicators(): HealthIndicatorFunction[] {
    const build = getBuildInfo({ env: this.config.get<string>('env'), version: this.config.get<string>('version') });
    return [async () => ({ build: { ...build, status: 'up' as const } })];
  }
}
