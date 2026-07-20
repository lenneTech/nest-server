import { describe, expect, it } from 'vitest';

import { isHubEnabled, isHubQueriesEnabled, normalizeHubConfig } from './hub-config.helper';

describe('hub-config.helper', () => {
  describe('isHubEnabled', () => {
    it('is disabled by default (undefined)', () => {
      expect(isHubEnabled(undefined)).toBe(false);
      expect(isHubEnabled(false)).toBe(false);
    });

    it('is enabled for true / {} / a config object', () => {
      expect(isHubEnabled(true)).toBe(true);
      expect(isHubEnabled({})).toBe(true);
      expect(isHubEnabled({ path: 'x' })).toBe(true);
    });

    it('respects explicit { enabled: false }', () => {
      expect(isHubEnabled({ enabled: false, path: 'x' })).toBe(false);
    });
  });

  describe('isHubQueriesEnabled', () => {
    it('is off by default even when the hub is enabled', () => {
      expect(isHubQueriesEnabled(true)).toBe(false);
      expect(isHubQueriesEnabled({})).toBe(false);
    });

    it('is on when queries collector is explicitly enabled', () => {
      expect(isHubQueriesEnabled({ collectors: { queries: true } })).toBe(true);
      expect(isHubQueriesEnabled({ collectors: { queries: { warnMs: 5 } } })).toBe(true);
      expect(isHubQueriesEnabled({ collectors: { queries: { enabled: false } } })).toBe(false);
    });

    it('is off when the hub itself is disabled', () => {
      expect(isHubQueriesEnabled(false)).toBe(false);
      expect(isHubQueriesEnabled({ collectors: { queries: true }, enabled: false })).toBe(false);
    });
  });

  describe('normalizeHubConfig', () => {
    it('applies defaults for the boolean-true form', () => {
      const cfg = normalizeHubConfig(true, { env: 'local', version: '1.2.3' });

      expect(cfg.path).toBe('hub');
      expect(cfg.roles).toEqual(['admin']);
      expect(cfg.actions).toBe(true);
      expect(cfg.pollIntervalMs).toBe(5000);
      expect(cfg.env).toBe('local');
      expect(cfg.version).toBe('1.2.3');
      // Default collectors: logs + traces on, queries off.
      expect(cfg.collectors.logs).not.toBe(false);
      expect(cfg.collectors.traces).not.toBe(false);
      expect(cfg.collectors.queries).toBe(false);
    });

    it('clamps the poll interval to the minimum', () => {
      const cfg = normalizeHubConfig({ pollIntervalMs: 10 }, { env: 'local', version: '1' });
      expect(cfg.pollIntervalMs).toBe(1000);
    });

    it('normalizes a single role string to an array', () => {
      const cfg = normalizeHubConfig({ roles: 'S_USER' }, { env: 'local', version: '1' });
      expect(cfg.roles).toEqual(['S_USER']);
    });

    it('keeps roles: false (opt-out of auth)', () => {
      const cfg = normalizeHubConfig({ roles: false }, { env: 'local', version: '1' });
      expect(cfg.roles).toBe(false);
    });

    it('resolves the queries collector with thresholds when enabled', () => {
      const cfg = normalizeHubConfig({ collectors: { queries: { warnMs: 5 } } }, { env: 'local', version: '1' });
      expect(cfg.collectors.queries).not.toBe(false);
      if (cfg.collectors.queries) {
        expect(cfg.collectors.queries.warnMs).toBe(5);
        expect(cfg.collectors.queries.criticalMs).toBe(200);
        expect(cfg.collectors.queries.capacity).toBe(500);
      }
    });

    it('defaults the mailbox to disabled but enables it with capture mode when present', () => {
      expect(normalizeHubConfig({}, { env: 'local', version: '1' }).mailbox).toBe(false);

      const cfg = normalizeHubConfig({ mailbox: true }, { env: 'local', version: '1' });
      expect(cfg.mailbox).not.toBe(false);
      if (cfg.mailbox) {
        expect(cfg.mailbox.mode).toBe('capture');
        expect(cfg.mailbox.capacity).toBe(100);
      }
    });

    it('resolves default external links', () => {
      const cfg = normalizeHubConfig(
        {},
        { env: 'local', graphQlEnabled: true, permissionsPath: 'permissions', version: '1' },
      );
      expect(cfg.links.swagger).toBe('/swagger');
      expect(cfg.links.graphql).toBe('/graphql');
      expect(cfg.links.permissions).toBe('/permissions');
    });

    it('omits the graphql link when GraphQL is disabled', () => {
      const cfg = normalizeHubConfig({}, { env: 'local', graphQlEnabled: false, version: '1' });
      expect(cfg.links.graphql).toBeUndefined();
    });
  });
});
