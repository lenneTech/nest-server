import { describe, expect, it } from 'vitest';

import { HubTraceBufferService } from './hub-trace-buffer.service';
import { ResolvedHubConfig } from '../interfaces/hub-config.interface';

function makeConfig(overrides: Partial<ResolvedHubConfig> = {}): ResolvedHubConfig {
  return {
    actions: true,
    allowPublicAccessInProduction: false,
    collectors: {
      logs: false,
      queries: false,
      traces: { capacity: 50, captureGraphQlOperation: true, excludePaths: [], slowMs: 1000 },
    },
    db: false,
    emailPreview: true,
    env: 'local',
    links: {},
    loginEndpoint: '/iam/sign-in/email',
    logoutEndpoint: '/iam/sign-out',
    mailbox: false,
    migrations: false,
    path: 'hub',
    pollIntervalMs: 5000,
    roles: ['admin'],
    version: '1.0.0',
    ...overrides,
  };
}

/** Minimal Express req/res doubles for record(). */
function reqRes(path: string, method = 'GET', statusCode = 200) {
  return {
    req: { baseUrl: '', method, path, route: undefined } as never,
    res: { getHeader: () => undefined, statusCode, writableFinished: true } as never,
  };
}

describe('HubTraceBufferService', () => {
  describe('isExcluded (boundary-aware)', () => {
    it('excludes the Hub base path and its sub-paths', () => {
      const service = new HubTraceBufferService(makeConfig());
      expect(service.isExcluded('/hub')).toBe(true);
      expect(service.isExcluded('/hub/logs.json')).toBe(true);
      expect(service.isExcluded('/hub/actions/collectors/traces/clear')).toBe(true);
    });

    it('does NOT exclude a sibling route that merely shares the prefix string', () => {
      const service = new HubTraceBufferService(makeConfig());
      // Regression guard for the over-broad `startsWith(prefix)` bug: `/hubble` is not a Hub route.
      expect(service.isExcluded('/hubble')).toBe(false);
      expect(service.isExcluded('/hub-admin')).toBe(false);
      expect(service.isExcluded('/hubbard/x')).toBe(false);
    });

    it('honours additional configured exclude prefixes with the same boundary rule', () => {
      const service = new HubTraceBufferService(
        makeConfig({
          collectors: {
            logs: false,
            queries: false,
            traces: { capacity: 50, captureGraphQlOperation: true, excludePaths: ['/health'], slowMs: 1000 },
          },
        }),
      );
      expect(service.isExcluded('/health')).toBe(true);
      expect(service.isExcluded('/health/live')).toBe(true);
      expect(service.isExcluded('/healthcheck')).toBe(false);
    });
  });

  describe('record + getData', () => {
    it('records a completed request with method, path and duration, and summarises', () => {
      const service = new HubTraceBufferService(makeConfig());
      const { req, res } = reqRes('/permissions/json');
      service.record(req, res, 12.5, false, '/permissions/json');

      const data = service.getData();
      expect(data.traces).toHaveLength(1);
      expect(data.traces[0].method).toBe('GET');
      expect(data.traces[0].path).toBe('/permissions/json');
      expect(data.traces[0].durationMs).toBe(12.5);
      expect(data.summary.total).toBe(1);
      expect(data.summary.avgMs).toBe(12.5);
    });

    it('flags slow and error traces in the summary', () => {
      const service = new HubTraceBufferService(makeConfig());
      const slow = reqRes('/slow');
      service.record(slow.req, slow.res, 5000, false, '/slow');
      const err = reqRes('/boom', 'GET', 500);
      service.record(err.req, err.res, 3, false, '/boom');

      const data = service.getData();
      expect(data.summary.slowCount).toBe(1);
      expect(data.summary.errorCount).toBe(1);
    });

    it('supports cursor-based polling via since', () => {
      const service = new HubTraceBufferService(makeConfig());
      const a = reqRes('/a');
      service.record(a.req, a.res, 1, false, '/a');
      const cursor = service.getData().cursor;
      const b = reqRes('/b');
      service.record(b.req, b.res, 2, false, '/b');

      const next = service.getData(cursor);
      expect(next.traces).toHaveLength(1);
      expect(next.traces[0].path).toBe('/b');
    });
  });
});
