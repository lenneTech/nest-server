import { describe, expect, it } from 'vitest';

import { RoleEnum } from '../../src/core/common/enums/role.enum';
import { resolveSyncOptions } from '../../src/core/common/persistence/sync-model';
import { ConfigService } from '../../src/core/common/services/config.service';
import {
  decodeSyncCursor,
  deriveCursorKey,
  encodeSyncCursor,
  type SyncCursorState,
} from '../../src/core/modules/sync/core-sync-cursor';
import {
  getSyncFieldStrategies,
  getSyncServiceOptions,
  SyncField,
  SyncService,
} from '../../src/core/modules/sync/core-sync.decorators';
import { CoreSyncService } from '../../src/core/modules/sync/core-sync.service';

/**
 * The parts of the sync module that need no database: the cursor codec, the declarations, the request rules of a push
 * and the rate limit. The protocol itself is proven against every database in `tests/sync-contract.e2e-spec.ts`.
 */

const KEY = deriveCursorKey('unit-secret');

const STATE: SyncCursorState = {
  epochs: 'epochs-hash',
  fingerprint: 'fingerprint-hash',
  model: 'Note',
  position: { seq: 42 },
  runStart: 1_700_000_000_000,
  since: 1_699_999_000_000,
  user: '6720c0aa0000000000000001',
};

describe('sync cursor', () => {
  it('round-trips both positions, with and without a run in progress', () => {
    expect(decodeSyncCursor(encodeSyncCursor(STATE, KEY), KEY)).toEqual(STATE);
    const clock: SyncCursorState = { ...STATE, position: { at: 1_700_000_000_123, id: '' }, runStart: undefined };
    const { runStart: _runStart, ...withoutRun } = clock;
    expect(decodeSyncCursor(encodeSyncCursor(clock, KEY), KEY)).toEqual(withoutRun);
  });

  it('is opaque to the client: base64url payload and signature only', () => {
    expect(encodeSyncCursor(STATE, KEY)).toMatch(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
  });

  it('refuses a cursor edited into another user, signed with another key, or malformed', () => {
    const cursor = encodeSyncCursor(STATE, KEY);
    const [payload, signature] = cursor.split('.');
    const edited = Buffer.from(
      JSON.stringify({ ...JSON.parse(Buffer.from(payload, 'base64url').toString()), u: 'someone-else' }),
    ).toString('base64url');
    expect(decodeSyncCursor(`${edited}.${signature}`, KEY)).toBeUndefined();
    expect(decodeSyncCursor(cursor, deriveCursorKey('other-secret'))).toBeUndefined();
    for (const value of [undefined, '', 'abc', `${payload}.`, `${cursor}.x`, `${'a'.repeat(3000)}.b`, 42, ['a']]) {
      expect(decodeSyncCursor(value, KEY)).toBeUndefined();
    }
  });
});

describe('sync declarations', () => {
  it('validates strategy and roles of @PersistedModel({ sync })', () => {
    expect(resolveSyncOptions({ roles: { pull: [RoleEnum.S_USER] }, strategy: 'merge' }, 'Note')).toEqual({
      idFormat: 'objectId',
      scope: [],
    });
    expect(() => resolveSyncOptions({ strategy: 'newest' as any }, 'Note')).toThrow(/sync\.strategy/);
    expect(() => resolveSyncOptions({ roles: { read: ['admin'] } as any }, 'Note')).toThrow(/sync\.roles/);
    expect(() => resolveSyncOptions({ roles: { pull: 'admin' } as any }, 'Note')).toThrow(/sync\.roles/);
  });

  it('collects @SyncField() strategies along the class hierarchy, a child declaration winning', () => {
    class Base {
      @SyncField('reject')
      price?: number;

      @SyncField('reject')
      title?: string;
    }
    class Child extends Base {
      @SyncField('lww')
      declare title?: string;
    }
    expect(getSyncFieldStrategies(Base)).toEqual({ price: 'reject', title: 'reject' });
    expect(getSyncFieldStrategies(Child)).toEqual({ price: 'reject', title: 'lww' });
    expect(() => SyncField('merge' as any)).toThrow(/@SyncField/);
  });

  it('records @SyncService() on the service class, inherited by a subclass', () => {
    class Input {}
    class Model {}
    @SyncService({ createInput: Input, model: Model, updateInput: Input })
    class Service {}
    class ProjectService extends Service {}
    expect(getSyncServiceOptions(ProjectService)).toMatchObject({ createInput: Input, model: Model });
  });
});

describe('sync requests', () => {
  /** The service with no stores behind it — enough for the request rules, which touch none */
  const service = () => new CoreSyncService({} as any, {} as any, {} as any, {} as any);
  const configure = (config: Record<string, unknown>) =>
    new ConfigService({ appUrl: 'https://app.example.com', baseUrl: 'https://api.example.com', ...config } as any, {
      warn: false,
    });
  const request = (headers: Record<string, string>) => ({ headers: { 'content-type': 'application/json', ...headers } });

  it('refuses a push that is not JSON, comes cross-site, or names a foreign origin — while cookies are in use', () => {
    configure({ cookies: true, cors: {}, env: 'production' });
    const sync = service();
    expect(() => sync.assertPushRequest({ headers: { 'content-type': 'text/plain' } })).toThrow(/Content-Type/);
    expect(() => sync.assertPushRequest(request({ 'sec-fetch-site': 'cross-site' }))).toThrow();
    expect(() => sync.assertPushRequest(request({ origin: 'https://evil.example' }))).toThrow();
    // The app, the API itself, and a client without fetch metadata pass
    expect(() => sync.assertPushRequest(request({ origin: 'https://app.example.com', 'sec-fetch-site': 'same-site' }))).not.toThrow();
    expect(() => sync.assertPushRequest(request({ origin: 'https://api.example.com' }))).not.toThrow();
    expect(() => sync.assertPushRequest(request({}))).not.toThrow();
  });

  it('accepts any origin under cors.allowAll (a development setting), and checks none without cookies', () => {
    configure({ cookies: true, cors: { allowAll: true }, env: 'local' });
    expect(() => service().assertPushRequest(request({ origin: 'https://anything.example' }))).not.toThrow();
    configure({ cookies: false, env: 'production' });
    expect(() => service().assertPushRequest(request({ origin: 'https://evil.example', 'sec-fetch-site': 'cross-site' }))).not.toThrow();
  });

  it('counts pulls and pushes per user and answers the seconds until the window resets once exceeded', async () => {
    configure({ sync: { rateLimit: { pull: { max: 2, windowSeconds: 60 }, push: false } } });
    const sync = service();
    const alice = { id: 'alice' };
    expect(await sync.rateLimit('pull', alice)).toBeUndefined();
    expect(await sync.rateLimit('pull', alice)).toBeUndefined();
    const retryAfter = await sync.rateLimit('pull', alice);
    expect(retryAfter).toBeGreaterThan(0);
    expect(retryAfter).toBeLessThanOrEqual(60);
    // Per user, and per kind
    expect(await sync.rateLimit('pull', { id: 'bob' })).toBeUndefined();
    for (let index = 0; index < 5; index++) {
      expect(await sync.rateLimit('push', alice)).toBeUndefined();
    }
  });

  it('refuses to start in production without a cursor secret', () => {
    const previous = process.env.SECRETS_ENCRYPTION_KEY;
    delete process.env.SECRETS_ENCRYPTION_KEY;
    try {
      configure({ env: 'production', sync: {} });
      expect(() => (service() as any).resolveCursorSecret()).toThrow(/cursorSecret/);
      configure({ env: 'production', sync: { cursorSecret: 'configured' } });
      expect((service() as any).resolveCursorSecret()).toBe('configured');
    } finally {
      if (previous !== undefined) {
        process.env.SECRETS_ENCRYPTION_KEY = previous;
      }
    }
  });
});
