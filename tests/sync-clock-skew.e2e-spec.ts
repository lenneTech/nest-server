import { randomBytes } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { generateUuidV7 } from '../src/core/common/persistence/id-format';
import { SYNC_CLIENT_PASSWORD, serverState } from './helpers/sync-client-harness';
import type { SyncDriver } from './helpers/sync-contract-matrix';
import { startSyncServerProcess, type SyncServerProcess } from './helpers/sync-server-processes';
import { type SyncTestDatabase, syncTestDatabase } from './helpers/sync-test-databases';

/**
 * No change lost with parallel writers on two application instances whose clocks disagree (DEV-3819 acceptance).
 *
 * Two reference servers run as processes of their own (two Nest applications in one process share the persistence
 * registry), one clock 5 s ahead, one 5 s behind (`tests/helpers/skewed-clock.mjs`), on one database. Writers push
 * creates, changes and deletes to both at once; readers pull from both in turn, cursor handed from one instance to the
 * other, all the while. Afterwards each reader's latest version of every record must equal what the server holds.
 *
 * The columns cover both change orders and both SQL numbering paths: MongoDB orders by the database clock with a window
 * (standalone and replica set), PostgreSQL numbers under an advisory lock, MySQL through its counter row. The store-level
 * prototype measured all seven targets (`.claude/plans/offline-sync/PLAN.md` §5); this suite proves the assembled
 * servers. Excluded from the `postgres` vitest project: it brings its own databases.
 */
const CLOCK_DRIVERS: readonly SyncDriver[] = ['mongodb', 'mongodb-rs', 'postgres-typeorm', 'mysql'];
const SKEW_MS = 5000;
const WRITERS = 6;
const STEPS = 30;
const READERS = 2;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const objectId = () => Math.floor(Date.now() / 1000).toString(16).padStart(8, '0') + randomBytes(8).toString('hex');

describe.each(CLOCK_DRIVERS)('offline sync — two server processes with skewed clocks — %s (e2e)', (driver) => {
  let database: SyncTestDatabase;
  const instances: SyncServerProcess[] = [];

  beforeAll(async () => {
    database = await syncTestDatabase(driver, 'clock');
    const overrides = {
      ...database.config,
      auth: { rateLimit: { enabled: false } },
      // A window W of 2 s (the contract matrix's): the derived one (30 s standalone, 90 s replica set) would cover any
      // stamp a skewed application clock wrote, and MongoDB could not lose a change here whatever clock it used. The
      // derived window itself is pinned by the contract case `pull-window-derived`
      sync: { cursorSecret: 'sync-clock-cursor-secret', hints: false, pull: { windowSeconds: 2 }, rateLimit: false },
    };
    // One after the other: the first applies the schema, the second finds it in place
    instances.push(await startSyncServerProcess(overrides, SKEW_MS));
    instances.push(await startSyncServerProcess(overrides, -SKEW_MS));
  }, 420_000);

  afterAll(async () => {
    await Promise.all(instances.map((instance) => instance.stop()));
    await database?.drop();
  }, 60_000);

  const request = async (base: string, path: string, init: RequestInit & { token?: string } = {}) => {
    const { token, ...rest } = init;
    const response = await fetch(`${base}${path}`, {
      ...rest,
      headers: {
        ...(rest.body ? { 'content-type': 'application/json' } : {}),
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
    });
    const text = await response.text();
    if (!response.ok) {
      throw new Error(`${rest.method ?? 'GET'} ${path} on ${base} answered ${response.status}: ${text.slice(0, 500)}`);
    }
    return { body: text ? JSON.parse(text) : undefined, response };
  };

  /** Sign up and in on one instance; the session lives in the shared database, so both accept the token */
  const account = async (): Promise<string> => {
    const email = `sync-clock-${driver}-${Date.now()}-${randomBytes(3).toString('hex')}@test.com`;
    const [first] = instances;
    await request(first.baseUrl, '/iam/sign-up/email', {
      body: JSON.stringify({ email, name: 'Sync Clock', password: SYNC_CLIENT_PASSWORD, termsAndPrivacyAccepted: true }),
      method: 'POST',
    });
    const { response } = await request(first.baseUrl, '/iam/sign-in/email', {
      body: JSON.stringify({ email, password: SYNC_CLIENT_PASSWORD }),
      method: 'POST',
    });
    const cookie = response.headers.getSetCookie().find((entry) => entry.includes('session_token='));
    if (!cookie) {
      throw new Error('the sign-in set no session cookie');
    }
    return decodeURIComponent(/session_token=([^;]+)/.exec(cookie)![1]).split('.')[0];
  };

  /**
   * @regression   DEV-3903 — an application clock must never stamp a change: two instances whose clocks differ by more
   *   than the window W would order changes by their skew, and a cursor handed between them would pass some for good.
   * @seen-failing Stamp MongoDB writes with the process clock in mongoServerNow()
   *   (src/core/common/persistence/mongo/sync-schema.plugin.ts) — registered as mutation `sync-mongo-stamp-app-clock`
   *   in tests/regression-mutations.json.
   */
  it('loses no change while writers on both instances race readers that switch instances', async () => {
    const token = await account();
    const known = new Map<string, number>();
    const unexpected: any[] = [];
    let writes = 0;

    const push = async (base: string, item: Record<string, unknown>) =>
      (await request(base, '/sync/SyncNote', { body: JSON.stringify({ items: [item] }), method: 'POST', token })).body
        .results[0];

    const writer = async (index: number) => {
      for (let step = 0; step < STEPS; step++) {
        const base = instances[(index + step) % instances.length].baseUrl;
        const ids = [...known.keys()];
        const roll = Math.random();
        const target = ids[Math.floor(Math.random() * ids.length)];
        const item =
          roll < 0.5 || ids.length < 5
            ? { data: { title: `w${index}-${step}` }, id: objectId(), mutationId: generateUuidV7(), op: 'upsert' }
            : roll < 0.9
              ? { baseVersion: known.get(target), data: { body: `w${index}-${step}` }, id: target, mutationId: generateUuidV7(), op: 'upsert' }
              : { baseVersion: known.get(target), id: target, mutationId: generateUuidV7(), op: 'delete' };
        const result = await push(base, item);
        writes++;
        if (result.status === 'applied') {
          if (item.op === 'delete') {
            known.delete(item.id);
          } else {
            known.set(item.id, result.version);
          }
        } else if (result.status === 'merged' || result.status === 'conflict') {
          // Another writer changed the record first: continue from what the server holds
          if (result.record?.deletedAt) {
            known.delete(item.id);
          } else {
            known.set(item.id, result.record.version);
          }
        } else if (result.status === 'not_found') {
          known.delete(item.id);
        } else if (result.status !== 'retry') {
          unexpected.push(result);
        }
      }
    };

    const progress = { writing: true };
    const reader = async (index: number) => {
      const seen = new Map<string, { deletedAt: unknown; version: number }>();
      let cursor: string | undefined;
      let turn = index;
      const run = async () => {
        for (let page = 0; page < 5000; page++) {
          // Every page from the other instance than the one before: the cursor one issued, the other continues
          const base = instances[turn++ % instances.length].baseUrl;
          const query = new URLSearchParams({ limit: '25', ...(cursor ? { cursor } : {}) });
          const { body } = await request(base, `/sync/SyncNote?${query}`, { token });
          for (const item of body.items) {
            const previous = seen.get(item.id);
            if (!previous || previous.version <= item.version) {
              seen.set(item.id, { deletedAt: item.deletedAt, version: item.version });
            }
          }
          cursor = body.cursor;
          if (!body.hasMore) {
            return;
          }
        }
        throw new Error('pull did not end');
      };
      while (progress.writing) {
        await run();
        await sleep(25);
      }
      // Runs that start after the last write: every change committed before them is delivered (protocol §5.3)
      await run();
      await run();
      return seen;
    };

    const readers = Array.from({ length: READERS }, (_, index) => reader(index));
    await Promise.all(Array.from({ length: WRITERS }, (_, index) => writer(index)));
    progress.writing = false;
    const views = await Promise.all(readers);

    expect(unexpected).toEqual([]);
    expect(writes).toBe(WRITERS * STEPS);
    const final = await serverState(instances[0].baseUrl, token);
    expect(final.size).toBeGreaterThan(WRITERS * STEPS * 0.3);
    for (const view of views) {
      const lost = [...final.values()]
        .filter((item) => view.get(item.id)?.version !== item.version || Boolean(view.get(item.id)?.deletedAt) !== Boolean(item.deletedAt))
        .map((item) => ({ client: view.get(item.id), id: item.id, server: { deletedAt: item.deletedAt, version: item.version } }));
      expect(lost).toEqual([]);
      expect([...view.keys()].filter((id) => !final.has(id))).toEqual([]);
    }
  }, 300_000);
});
