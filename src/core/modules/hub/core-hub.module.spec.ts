import { PATH_METADATA } from '@nestjs/common/constants';
import { describe, expect, it } from 'vitest';

import { CoreHubController } from './core-hub.controller';
import { CoreHubModule } from './core-hub.module';

const ctx = { env: 'local', version: '1.0.0' };

describe('CoreHubModule.forRoot', () => {
  it('builds a dynamic module with the hub controller', () => {
    const mod = CoreHubModule.forRoot({ config: {}, ctx });
    expect(mod.module).toBe(CoreHubModule);
    expect(mod.controllers?.length).toBeGreaterThan(0);
  });

  it('becomes global and provides the email-capture binding when the mailbox is enabled', () => {
    const mod = CoreHubModule.forRoot({ config: { mailbox: { mode: 'capture' } }, ctx });
    expect(mod.global).toBe(true);
  });

  it('is not global when the mailbox is disabled', () => {
    const mod = CoreHubModule.forRoot({ config: {}, ctx });
    expect(mod.global).toBeFalsy();
  });

  it('throws when mailbox capture mode is used in production (silent mail suppression guard)', () => {
    expect(() =>
      CoreHubModule.forRoot({ config: { mailbox: { mode: 'capture' } }, ctx: { env: 'production', version: '1' } }),
    ).toThrow(/capture.*not permitted/i);
  });

  it('allows mailbox copy mode in production', () => {
    expect(() =>
      CoreHubModule.forRoot({ config: { mailbox: { mode: 'copy' } }, ctx: { env: 'production', version: '1' } }),
    ).not.toThrow();
  });

  describe('public-access guard (roles: false in a reachable env)', () => {
    it('throws when roles:false in production without acknowledgment', () => {
      expect(() =>
        CoreHubModule.forRoot({ config: { roles: false }, ctx: { env: 'production', version: '1' } }),
      ).toThrow(/roles: false.*not permitted/i);
    });

    it('throws when roles:false in staging without acknowledgment', () => {
      expect(() => CoreHubModule.forRoot({ config: { roles: false }, ctx: { env: 'staging', version: '1' } })).toThrow(
        /not permitted/i,
      );
    });

    it('throws for CUSTOM reachable env names too (fail-safe — not just production/staging)', () => {
      // Regression guard for the exact-string bypass: prod / live / preprod / production-eu / staging-2
      // must all be treated as reachable.
      for (const env of ['prod', 'live', 'preprod', 'production-eu', 'staging-2']) {
        expect(() => CoreHubModule.forRoot({ config: { roles: false }, ctx: { env, version: '1' } })).toThrow(
          /not permitted/i,
        );
      }
    });

    it('allows roles:false in production ONLY with explicit allowPublicAccessInProduction', () => {
      expect(() =>
        CoreHubModule.forRoot({
          config: { allowPublicAccessInProduction: true, roles: false },
          ctx: { env: 'production', version: '1' },
        }),
      ).not.toThrow();
    });

    it('allows roles:false in non-reachable envs (local, development)', () => {
      expect(() => CoreHubModule.forRoot({ config: { roles: false }, ctx })).not.toThrow(); // ctx = local
      expect(() =>
        CoreHubModule.forRoot({ config: { roles: false }, ctx: { env: 'development', version: '1' } }),
      ).not.toThrow();
    });

    it('allows the default ADMIN gate in production (no roles set)', () => {
      expect(() => CoreHubModule.forRoot({ config: {}, ctx: { env: 'production', version: '1' } })).not.toThrow();
    });
  });

  describe('runtime path/roles metadata (shared controller class)', () => {
    it('writes the configured base path onto the controller class', () => {
      CoreHubModule.forRoot({ config: { path: 'cockpit' }, ctx });
      expect(Reflect.getMetadata(PATH_METADATA, CoreHubController)).toBe('cockpit');
    });

    it('fully overwrites stale metadata on a second forRoot (no cross-instance pollution)', () => {
      // The controller class is shared across app instances in the same process (parallel tests). A
      // second forRoot must overwrite the first, never leak the previous path/roles.
      CoreHubModule.forRoot({ config: { path: 'first', roles: 'admin' }, ctx });
      expect(Reflect.getMetadata(PATH_METADATA, CoreHubController)).toBe('first');
      expect(Reflect.getMetadata('roles', CoreHubController)).toEqual(['admin']);

      CoreHubModule.forRoot({ config: { path: 'second', roles: ['ops', 'admin'] }, ctx });
      expect(Reflect.getMetadata(PATH_METADATA, CoreHubController)).toBe('second');
      expect(Reflect.getMetadata('roles', CoreHubController)).toEqual(['ops', 'admin']);
    });

    it('clears the roles metadata when roles: false (public opt-out)', () => {
      CoreHubModule.forRoot({ config: { roles: 'admin' }, ctx });
      expect(Reflect.getMetadata('roles', CoreHubController)).toEqual(['admin']);

      CoreHubModule.forRoot({ config: { roles: false }, ctx });
      expect(Reflect.getMetadata('roles', CoreHubController)).toBeUndefined();
    });
  });
});
