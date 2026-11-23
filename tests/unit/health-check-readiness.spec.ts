import { Global, Injectable, type INestApplication, Logger, Module } from '@nestjs/common';
import { type HealthIndicatorFunction } from '@nestjs/terminus';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { markShutdownDraining, resetShutdownDraining } from '../../src/core/common/helpers/shutdown-state.helper';
import { ConfigService } from '../../src/core/common/services/config.service';
import {
  type CoreHealthCheckKind,
  resolveHealthCheckReadiness,
} from '../../src/core/modules/health-check/core-health-check.helpers';
import {
  CoreHealthCheckModule,
  type ICoreHealthCheckModuleOptions,
} from '../../src/core/modules/health-check/core-health-check.module';
import { CoreHealthCheckService } from '../../src/core/modules/health-check/core-health-check.service';

/**
 * The health check's extension point and its readiness endpoint (12.11.0).
 *
 * Until 12.11.0 `CoreHealthCheckService` ran the checks `healthCheck.configs` enabled and nothing else, and could not be
 * replaced: a project with checks of its own (a queue, a third-party API) had no way to report them, and there was no
 * readiness endpoint next to the liveness check. A project now extends the service, overrides
 * `additionalHealthIndicators(kind)`, and `healthCheck.readiness` registers `GET /health-check/ready`.
 */

/** What a project's checks answer — a case switches them */
const state = { erp: true, worker: true };

@Injectable()
class ProjectHealthCheckService extends CoreHealthCheckService {
  protected override additionalHealthIndicators(kind: CoreHealthCheckKind): HealthIndicatorFunction[] {
    return kind === 'readiness'
      ? [
          () =>
            this.indicators!.check('erp').attempt(async () => {
              if (!state.erp) {
                throw new Error('ERP not reachable');
              }
            }),
        ]
      : [
          () => {
            const session = this.indicators!.check('worker');
            return state.worker ? session.up() : session.down({ reason: 'stalled' });
          },
        ];
  }
}

describe('health check readiness and project checks', () => {
  let app: INestApplication | undefined;

  /** Boot the health check module as CoreModule imports it, on a configuration of `healthCheck` alone */
  async function boot(healthCheck: Record<string, any>, options: ICoreHealthCheckModuleOptions = {}) {
    const values: Record<string, any> = { healthCheck, version: '12.11.0-test' };
    const config = {
      get: (path: string) => path.split('.').reduce((value: any, part) => value?.[part], values),
    };
    @Global()
    @Module({ exports: [ConfigService], providers: [{ provide: ConfigService, useValue: config }] })
    class ConfigTestModule {}

    const moduleRef = await Test.createTestingModule({
      imports: [ConfigTestModule, CoreHealthCheckModule.forRoot({ readiness: healthCheck.readiness, ...options })],
    }).compile();
    app = moduleRef.createNestApplication({ logger: false });
    await app.init();
    return { http: () => request(app!.getHttpServer()), moduleRef };
  }

  beforeEach(() => {
    state.erp = true;
    state.worker = true;
    vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  });

  afterEach(async () => {
    await app?.close();
    app = undefined;
    resetShutdownDraining();
    vi.restoreAllMocks();
  });

  describe('without readiness and without a project service', () => {
    it('answers the liveness check as before and has no readiness route', async () => {
      const { http, moduleRef } = await boot({ configs: { memoryHeap: { enabled: true } } });
      expect(moduleRef.get(CoreHealthCheckService).constructor).toBe(CoreHealthCheckService);

      const live = await http().get('/health-check').expect(200);
      expect(Object.keys(live.body.details)).toEqual(['memoryHeap', 'build']);
      expect(live.body.details.build).toMatchObject({ status: 'up', version: '12.11.0-test' });
      await http().get('/health-check/ready').expect(404);
    });
  });

  describe('GET /health-check/ready', () => {
    /**
     * @regression   12.11.0 (found in review) — readiness was documented to answer 503 once the shutdown starts, but
     *   only Terminus' own state applied, set inside app.close() right before the server closes: during the whole
     *   `shutdownDelayMs` wait a load balancer polling readiness saw 200 and kept routing to the replica.
     * @seen-failing Drop the shutdown check from CoreHealthCheckService.readinessCheck()
     *   (src/core/modules/health-check/core-health-check.service.ts) — registered as mutation
     *   `readiness-ignores-shutdown` in tests/regression-mutations.json.
     */
    it('answers 503 shutting_down from the first shutdown signal on, while liveness stays healthy', async () => {
      const { http } = await boot({ readiness: true });
      await http().get('/health-check/ready').expect(200);

      markShutdownDraining(); // what installGracefulShutdown() does on SIGTERM, before its wait
      const draining = await http().get('/health-check/ready').expect(503);
      expect(draining.body.status).toBe('shutting_down');
      await http().get('/health-check').expect(200);
    });

    it('runs the default checks and the project readiness indicators, and turns 503 when one is down', async () => {
      const { http } = await boot({ readiness: true }, { service: ProjectHealthCheckService });

      const ready = await http().get('/health-check/ready').expect(200);
      expect(ready.body.status).toBe('ok');
      // `database` is a default check — without MongoDB or a SQL source there is nothing to ping here
      expect(Object.keys(ready.body.details)).toEqual(['build', 'erp']);

      state.erp = false;
      const notReady = await http().get('/health-check/ready').expect(503);
      expect(notReady.body.status).toBe('error');
      expect(notReady.body.error.erp.status).toBe('down');
      // The liveness check does not ask the readiness indicators
      await http().get('/health-check').expect(200);
    });

    it('runs the checks readiness.checks lists, whatever configs.<check>.enabled says', async () => {
      const { http } = await boot({
        configs: { memoryHeap: { enabled: false, key: 'heap' }, memoryRss: { enabled: true } },
        readiness: { checks: ['memoryHeap'] },
      });

      const ready = await http().get('/health-check/ready').expect(200);
      expect(Object.keys(ready.body.details)).toEqual(['heap']);
      const live = await http().get('/health-check').expect(200);
      expect(Object.keys(live.body.details)).toEqual(['memoryRss', 'build']);
    });

    it('is left out with readiness: false or { enabled: false }', async () => {
      for (const readiness of [false, { checks: ['build'], enabled: false }]) {
        const { http } = await boot({ readiness });
        await http().get('/health-check/ready').expect(404);
        await app!.close();
        app = undefined;
      }
    });
  });

  describe('additionalHealthIndicators() — the extension point', () => {
    it('adds the project liveness indicators to GET /health-check and the service replaces the core one', async () => {
      const { http, moduleRef } = await boot({}, { service: ProjectHealthCheckService });
      expect(moduleRef.get(CoreHealthCheckService)).toBeInstanceOf(ProjectHealthCheckService);
      expect(moduleRef.get(CoreHealthCheckService)).toBe(moduleRef.get(ProjectHealthCheckService));

      const live = await http().get('/health-check').expect(200);
      expect(Object.keys(live.body.details)).toEqual(['build', 'worker']);
      state.worker = false;
      await http().get('/health-check').expect(503);
    });
  });

  describe('resolveHealthCheckReadiness()', () => {
    it('follows boolean shorthand and "presence implies enabled"', () => {
      expect(resolveHealthCheckReadiness(undefined)).toEqual({ checks: [], enabled: false });
      expect(resolveHealthCheckReadiness({})).toEqual({ checks: [], enabled: false });
      expect(resolveHealthCheckReadiness({ readiness: false })).toEqual({ checks: [], enabled: false });
      expect(resolveHealthCheckReadiness({ readiness: { enabled: false } })).toEqual({ checks: [], enabled: false });
      expect(resolveHealthCheckReadiness({ readiness: true })).toEqual({
        checks: ['database', 'build'],
        enabled: true,
      });
      expect(resolveHealthCheckReadiness({ readiness: {} })).toEqual({ checks: ['database', 'build'], enabled: true });
    });

    it('reads checks as a list or a comma-separated string, in report order, ignoring unknown names', () => {
      expect(resolveHealthCheckReadiness({ readiness: { checks: ['build', 'storage'] } }).checks).toEqual([
        'storage',
        'build',
      ]);
      expect(resolveHealthCheckReadiness({ readiness: { checks: ' memoryRss, database ' } }).checks).toEqual([
        'database',
        'memoryRss',
      ]);
      expect(resolveHealthCheckReadiness({ readiness: { checks: [] } }).checks).toEqual([]);
      expect(resolveHealthCheckReadiness({ readiness: { checks: ['database', 'redis' as any] } }).checks).toEqual([
        'database',
      ]);
      expect(Logger.prototype.warn).toHaveBeenCalledWith(expect.stringContaining('unknown check "redis"'));
      // Not a list: the default checks, never "no checks"
      expect(resolveHealthCheckReadiness({ readiness: { checks: 7 as any } }).checks).toEqual(['database', 'build']);
    });
  });
});
