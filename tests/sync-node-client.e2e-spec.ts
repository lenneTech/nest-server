import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { CoreBetterAuthService } from '../src';
import { SqliteStore } from './clients/sqlite-store.mjs';
import { SyncClient } from './clients/sync-client.mjs';
import { SYNC_CLIENT_SCENARIOS, type SyncClientScenario } from './helpers/sync-client-scenarios';
import { serverState, signInSyncUser, signUpSyncUser, syncClientConfig, type SyncClientUser } from './helpers/sync-client-harness';
import { bootSyncTestApp, type SyncTestApp } from './helpers/sync-test-app';

/**
 * The client without a browser (DEV-3819 acceptance): the shared test client (`tests/clients/sync-client.mjs`) on
 * SQLite (`node:sqlite`), as a desktop or React Native app keeps its data, authenticated with a bearer session token.
 * Same scenarios, same API as the PWA in `tests/sync-pwa-client.e2e-spec.ts` (`tests/helpers/sync-client-scenarios.ts`).
 *
 * "Offline" is a fetch that cannot reach the server — what a device without a network sees. Runs on MongoDB in the
 * `e2e` vitest project and on PostgreSQL in the `postgres` one.
 */
describe('offline sync — Node client on SQLite (e2e)', () => {
  let server: SyncTestApp;
  let directory: string;
  let files = 0;
  const stores: SqliteStore[] = [];

  /** A device's network: off, and every request fails as `fetch` fails without one */
  const network = () => {
    const state = { online: true };
    const fetchFn = ((input: any, init?: any) =>
      state.online ? fetch(input, init) : Promise.reject(new TypeError('fetch failed'))) as typeof fetch;
    return { fetch: fetchFn, state };
  };

  /** A storage file of a device; two clients on one file are two tabs */
  const storeFile = () => join(directory, `device-${++files}.sqlite`);
  const openStore = (path: string) => {
    const store = new SqliteStore(path);
    stores.push(store);
    return store;
  };

  /** A client of `user`, on its own file unless one is given, behind its own network unless one is given */
  const device = (user: { token: string }, options: { net?: ReturnType<typeof network>; path?: string } = {}) => {
    const net = options.net ?? network();
    const path = options.path ?? storeFile();
    const store = openStore(path);
    const client = new SyncClient({
      baseUrl: server.baseUrl,
      fetch: net.fetch,
      headers: () => ({ authorization: `Bearer ${user.token}` }),
      model: 'SyncNote',
      store,
    });
    return { client, net, path, store };
  };

  const account = async (label: string): Promise<SyncClientUser & { token: string }> => {
    const user = await signUpSyncUser(server.app, label);
    return { ...user, token: user.sessionToken };
  };

  const outboxOf = (store: SqliteStore) => store.run((tx) => tx.listOutbox());

  const scenario = (id: SyncClientScenario, fn: () => Promise<void>) => it(`${id}: ${SYNC_CLIENT_SCENARIOS[id]}`, fn);

  beforeAll(async () => {
    directory = mkdtempSync(join(tmpdir(), 'sync-node-client-'));
    server = await bootSyncTestApp(syncClientConfig());
  });

  afterAll(async () => {
    for (const store of stores) {
      try {
        store.close();
      } catch {
        // already closed by its scenario
      }
    }
    rmSync(directory, { force: true, recursive: true });
    await server?.close();
  });

  scenario('offline-crud', async () => {
    const alice = await account('crud');
    const phone = device(alice);
    const kept = await phone.client.create({ title: 'kept' });
    const gone = await phone.client.create({ title: 'gone' });
    expect((await phone.client.sync()).applied).toBe(2);

    phone.net.state.online = false;
    const created = await phone.client.create({ priority: 1, title: 'made offline' });
    await phone.client.update(kept.id, { title: 'changed offline' });
    await phone.client.remove(gone.id);
    expect(await phone.client.sync()).toMatchObject({ offline: true });
    expect(await outboxOf(phone.store)).toHaveLength(3);

    phone.net.state.online = true;
    const result = await phone.client.sync();
    expect(result).toMatchObject({ applied: 3, conflicts: [], offline: false, rejected: [] });
    expect(await outboxOf(phone.store)).toEqual([]);

    const state = await serverState(server.baseUrl, alice.token);
    expect(state.get(created.id)).toMatchObject({ data: { priority: 1, title: 'made offline' }, deletedAt: null, version: 1 });
    expect(state.get(kept.id)).toMatchObject({ data: { title: 'changed offline' }, version: 2 });
    expect(state.get(gone.id)).toMatchObject({ version: 2 });
    expect(state.get(gone.id).deletedAt).toBeTruthy();
    expect((await phone.client.list()).map((note) => note.id).sort()).toEqual([created.id, kept.id].sort());
  });

  scenario('conflict', async () => {
    const alice = await account('conflict');
    const phone = device(alice);
    const laptop = device(alice);
    const note = await phone.client.create({ priority: 1, title: 'shared' });
    await phone.client.sync();
    await laptop.client.sync();
    expect(await laptop.client.get(note.id)).toMatchObject({ version: 1 });

    await laptop.client.update(note.id, { priority: 2 });
    expect((await laptop.client.sync()).applied).toBe(1);

    phone.net.state.online = false;
    await phone.client.update(note.id, { priority: 3 });
    phone.net.state.online = true;
    const result = await phone.client.sync();
    // `priority` is a `reject` field of SyncNote: the stale change conflicts, and the server's version wins
    expect(result.conflicts).toHaveLength(1);
    expect(result.conflicts[0]).toMatchObject({ id: note.id, status: 'conflict', version: 2 });
    expect(await phone.client.get(note.id)).toMatchObject({ data: { priority: 2 }, version: 2 });
    expect(await outboxOf(phone.store)).toEqual([]);
    expect((await serverState(server.baseUrl, alice.token)).get(note.id)).toMatchObject({ data: { priority: 2 }, version: 2 });
  });

  scenario('two-tabs', async () => {
    const alice = await account('tabs');
    const net = network();
    const first = device(alice, { net });
    const second = device(alice, { net, path: first.path });
    const note = await first.client.create({ title: 'one tab' });
    await first.client.sync();

    net.state.online = false;
    await first.client.update(note.id, { title: 'both tabs push this' });
    const made = await second.client.create({ title: 'made in the second tab' });
    expect(await outboxOf(first.store)).toHaveLength(2);

    net.state.online = true;
    const results = await Promise.all([first.client.sync(), second.client.sync()]);
    // A tab whose copy was still in progress elsewhere got `retry`; one more round settles it
    await Promise.all([first.client.sync(), second.client.sync()]);
    for (const result of results) {
      expect(result.conflicts).toEqual([]);
      expect(result.rejected).toEqual([]);
    }
    expect(await outboxOf(first.store)).toEqual([]);

    const state = await serverState(server.baseUrl, alice.token);
    expect(state.get(note.id)).toMatchObject({ data: { title: 'both tabs push this' }, version: 2 });
    expect(state.get(made.id)).toMatchObject({ version: 1 });
    expect(state.size).toBe(2);
    for (const tab of [first, second]) {
      expect(await tab.client.get(note.id)).toMatchObject({ version: 2 });
    }
  });

  scenario('expired-session', async () => {
    const alice = await account('session');
    const phone = device(alice);
    const note = await phone.client.create({ title: 'before' });
    await phone.client.sync();

    phone.net.state.online = false;
    await phone.client.update(note.id, { title: 'after signing in again' });
    const made = await phone.client.create({ title: 'made while signed out' });
    // The session ends while the device is offline
    expect(await server.moduleRef.get(CoreBetterAuthService, { strict: false }).revokeSession(alice.token)).toBe(true);

    phone.net.state.online = true;
    expect(await phone.client.sync()).toMatchObject({ applied: 0, needsLogin: true });
    expect(await outboxOf(phone.store)).toHaveLength(2);

    alice.token = await signInSyncUser(server.app, alice.email);
    expect(await phone.client.sync()).toMatchObject({ applied: 2, conflicts: [], needsLogin: false });
    // Sent again: nothing doubles
    expect(await phone.client.sync()).toMatchObject({ applied: 0 });

    const state = await serverState(server.baseUrl, alice.token);
    expect(state.get(note.id)).toMatchObject({ data: { title: 'after signing in again' }, version: 2 });
    expect(state.get(made.id)).toMatchObject({ version: 1 });
    expect(state.size).toBe(2);
  });

  scenario('cleared-storage', async () => {
    const alice = await account('cleared');
    const phone = device(alice);
    for (const title of ['one', 'two', 'three']) {
      await phone.client.create({ title });
    }
    const removed = await phone.client.create({ title: 'removed' });
    await phone.client.sync();
    await phone.client.remove(removed.id);
    await phone.client.sync();
    const before = await phone.client.list();

    // The device loses its storage: a new, empty file
    phone.store.close();
    rmSync(phone.path, { force: true });
    const fresh = device(alice, { net: phone.net });
    expect(await fresh.client.list()).toEqual([]);
    expect(await fresh.client.sync()).toMatchObject({ conflicts: [], offline: false, resynced: false });
    expect((await fresh.client.list()).map(({ id, version }) => ({ id, version }))).toEqual(
      before.map(({ id, version }) => ({ id, version })),
    );
    expect(await fresh.client.get(removed.id)).toBeUndefined();
  });
});
