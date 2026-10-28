import { Test } from '@nestjs/testing';
import { TerminusModule } from '@nestjs/terminus';
import { afterEach, describe, expect, it } from 'vitest';

import { setPersistenceRuntime } from '../../src/core/common/persistence/persistence-runtime.registry';
import { ConfigService } from '../../src/core/common/services/config.service';
import { CoreHealthCheckService } from '../../src/core/modules/health-check/core-health-check.service';

/**
 * A SQL source the application cannot reach must turn the health check red under its own key — a load balancer that
 * keeps routing to a replica whose database is gone serves nothing but errors.
 */
describe('health check of SQL sources', () => {
  afterEach(() => {
    setPersistenceRuntime(undefined);
  });

  async function healthCheckWith(ping: () => Promise<void>) {
    setPersistenceRuntime({ sqlSources: () => [{ name: 'default', ping }] } as any);
    const config = {
      get: (path: string) =>
        ({
          'healthCheck.configs.build.enabled': false,
          'healthCheck.configs.database.enabled': true,
        })[path],
    };
    const moduleRef = await Test.createTestingModule({
      imports: [TerminusModule],
      providers: [CoreHealthCheckService, { provide: ConfigService, useValue: config }],
    }).compile();
    const service = moduleRef.get(CoreHealthCheckService);
    // Only the SQL indicators: the MongoDB ping has no connection in a unit test
    (service as any).db = { pingCheck: () => ({ withTimeout: async () => ({ database: { status: 'up' } }) }) };
    return service.healthCheck().then(
      (result) => result,
      (error) => error.getResponse(),
    );
  }

  it('reports a reachable source as up', async () => {
    const result = await healthCheckWith(async () => undefined);
    expect(result.status).toBe('ok');
    expect(result.details['database:default'].status).toBe('up');
  });

  /**
   * @regression   DEV-3830 (db-agnostic phase 2) — the health check pinged MongoDB only, so a replica whose SQL
   *   database was unreachable still answered "ok".
   * @seen-failing Drop the SQL-source loop from CoreHealthCheckService.healthCheck() in
   *   src/core/modules/health-check/core-health-check.service.ts — registered as mutation
   *   `health-check-skips-sql-sources` in tests/regression-mutations.json.
   */
  it('reports an unreachable source as down and fails the check', async () => {
    const result = await healthCheckWith(() => Promise.reject(new Error('connection refused')));
    expect(result.status).toBe('error');
    expect(result.details['database:default'].status).toBe('down');
  });
});
