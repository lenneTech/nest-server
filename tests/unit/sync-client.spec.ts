import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, describe, expect, it } from 'vitest';

import { SqliteStore } from '../clients/sqlite-store.mjs';
import { SyncClient } from '../clients/sync-client.mjs';

/**
 * The shared offline-sync test client (`tests/clients/sync-client.mjs`) on its SQLite storage, against a small
 * in-memory server that answers like protocol §5–§8 — the client's own logic (outbox, folding, base versions, the
 * answer to every item status, 401, 410) without a database. The real server is the e2e suites' job
 * (`tests/sync-node-client.e2e-spec.ts`, `tests/sync-pwa-client.e2e-spec.ts`); this keeps a client bug from costing one.
 */
class FakeSyncServer {
  /** Apply the next push, then fail like a connection lost before the answer arrived */
  dropNextAnswer = false;
  forbidden = false;
  /** Runs while a push is in flight, before the server answers it */
  duringPush?: () => Promise<void>;
  gone = false;
  inProgress = new Set<string>();
  outcomes = new Map<string, any>();
  pushes: any[][] = [];
  records = new Map<string, { data?: any; deletedAt: null | string; id: string; seq: number; version: number }>();
  seq = 0;
  unauthorized = false;

  fetch = (async (input: any, init: any = {}) => {
    const url = new URL(String(input), 'http://sync.test');
    if (this.unauthorized) {
      return this.answer(401, { message: 'Unauthorized' });
    }
    if (init.method === 'POST') {
      const { items } = JSON.parse(init.body);
      this.pushes.push(items);
      const during = this.duringPush;
      this.duringPush = undefined;
      await during?.();
      const results = items.map((item: any) => this.apply(item));
      if (this.dropNextAnswer) {
        this.dropNextAnswer = false;
        throw new TypeError('fetch failed');
      }
      return this.answer(200, { results });
    }
    if (this.forbidden) {
      return this.answer(403, { message: 'Forbidden' });
    }
    if (this.gone && url.searchParams.get('cursor')) {
      this.gone = false;
      return this.answer(410, { code: 'SYNC_RESYNC_REQUIRED', reason: 'horizon' });
    }
    const after = Number(url.searchParams.get('cursor') ?? 0);
    const limit = Number(url.searchParams.get('limit') ?? 100);
    const changed = [...this.records.values()].filter((record) => record.seq > after).sort((a, b) => a.seq - b.seq);
    const page = changed.slice(0, limit);
    return this.answer(200, {
      cursor: String(page.at(-1)?.seq ?? after),
      hasMore: changed.length > limit,
      items: page.map((record) => this.item(record)),
    });
  }) as unknown as typeof fetch;

  answer(status: number, body: unknown) {
    return new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' }, status });
  }

  item({ seq, ...record }: any) {
    return record.deletedAt ? { ...record, data: undefined } : record;
  }

  write(id: string, change: { data?: any; deletedAt?: string }) {
    const current = this.records.get(id);
    const record = {
      data: change.deletedAt ? undefined : { ...current?.data, ...change.data },
      deletedAt: change.deletedAt ?? null,
      id,
      seq: ++this.seq,
      version: (current?.version ?? 0) + 1,
    };
    this.records.set(id, record);
    return record;
  }

  apply(item: any) {
    const recorded = this.outcomes.get(item.mutationId);
    if (recorded) {
      return recorded;
    }
    if (this.inProgress.has(item.mutationId)) {
      return { id: item.id, mutationId: item.mutationId, status: 'retry' };
    }
    const existing = this.records.get(item.id);
    const conflict = (record: any) => ({ id: item.id, mutationId: item.mutationId, record: this.item(record), status: 'conflict', version: record.version });
    let outcome: any;
    if (item.op === 'upsert') {
      if (!existing) {
        outcome =
          item.baseVersion === undefined
            ? { id: item.id, mutationId: item.mutationId, status: 'applied', version: this.write(item.id, { data: item.data }).version }
            : { id: item.id, mutationId: item.mutationId, status: 'not_found' };
      } else if (existing.deletedAt || item.baseVersion !== existing.version) {
        outcome = conflict(existing);
      } else {
        outcome = { id: item.id, mutationId: item.mutationId, status: 'applied', version: this.write(item.id, { data: item.data }).version };
      }
    } else if (!existing) {
      outcome = { id: item.id, mutationId: item.mutationId, status: 'not_found' };
    } else if (existing.deletedAt) {
      outcome = { id: item.id, mutationId: item.mutationId, status: 'applied', version: existing.version };
    } else if (item.baseVersion !== existing.version) {
      outcome = conflict(existing);
    } else {
      const tombstone = this.write(item.id, { deletedAt: new Date().toISOString() });
      outcome = { id: item.id, mutationId: item.mutationId, status: 'applied', version: tombstone.version };
    }
    this.outcomes.set(item.mutationId, outcome);
    return outcome;
  }
}

describe('offline-sync test client (sync-client.mjs on SQLite)', () => {
  const directory = mkdtempSync(join(tmpdir(), 'sync-client-unit-'));
  let files = 0;
  const stores: SqliteStore[] = [];

  afterAll(() => {
    for (const store of stores) {
      store.close();
    }
    rmSync(directory, { force: true, recursive: true });
  });

  const setup = (server = new FakeSyncServer(), path = join(directory, `client-${++files}.sqlite`)) => {
    const network = { online: true };
    const store = new SqliteStore(path);
    stores.push(store);
    const client = new SyncClient({
      fetch: ((input: any, init: any) =>
        network.online ? server.fetch(input, init) : Promise.reject(new TypeError('fetch failed'))) as typeof fetch,
      model: 'Note',
      pageLimit: 100,
      store,
    });
    const outbox = () => store.run((tx) => tx.listOutbox());
    return { client, network, outbox, path, server, store };
  };

  it('keeps every change made offline and pushes it once online, in order and with the right base versions', async () => {
    const { client, network, outbox, server } = setup();
    const kept = await client.create({ title: 'kept' });
    const gone = await client.create({ title: 'gone' });
    await client.sync();
    network.online = false;
    const made = await client.create({ title: 'made' });
    await client.update(made.id, { body: 'folded into the create' });
    await client.update(kept.id, { title: 'changed' });
    await client.remove(gone.id);
    expect(await client.sync()).toMatchObject({ offline: true });
    const queued = await outbox();
    expect(queued.map(({ baseVersion, id, op }) => ({ baseVersion, id, op }))).toEqual([
      { baseVersion: undefined, id: made.id, op: 'upsert' },
      { baseVersion: 1, id: kept.id, op: 'upsert' },
      { baseVersion: 1, id: gone.id, op: 'delete' },
    ]);
    expect(queued[0].data).toEqual({ body: 'folded into the create', title: 'made' });

    network.online = true;
    expect(await client.sync()).toMatchObject({ applied: 3, conflicts: [], offline: false });
    expect(await outbox()).toEqual([]);
    expect(server.records.get(made.id)).toMatchObject({ data: { body: 'folded into the create', title: 'made' }, version: 1 });
    expect(server.records.get(kept.id)).toMatchObject({ data: { title: 'changed' }, version: 2 });
    expect(server.records.get(gone.id)?.deletedAt).toBeTruthy();
    expect((await client.list()).map((note) => note.id).sort()).toEqual([kept.id, made.id].sort());
    expect(await client.get(kept.id)).toMatchObject({ version: 2 });
  });

  it('drops a record created and deleted offline without telling the server', async () => {
    const { client, network, outbox, server } = setup();
    network.online = false;
    const draft = await client.create({ title: 'draft' });
    await client.remove(draft.id);
    expect(await outbox()).toEqual([]);
    network.online = true;
    await client.sync();
    expect(server.pushes).toEqual([]);
    expect(await client.get(draft.id)).toBeUndefined();
  });

  it('lets the server win a conflict and drops the changes that built on the lost one', async () => {
    const { client, network, outbox, server } = setup();
    const note = await client.create({ priority: 1 });
    await client.sync();
    server.write(note.id, { data: { priority: 2 } });
    network.online = false;
    await client.update(note.id, { priority: 3 });
    network.online = true;
    const result = await client.sync();
    expect(result.conflicts).toHaveLength(1);
    expect(await client.get(note.id)).toMatchObject({ data: { priority: 2 }, version: 2 });
    expect(await outbox()).toEqual([]);
  });

  it('keeps the outbox through a 401 and sends the same changes after the next sign-in', async () => {
    const { client, outbox, server } = setup();
    await client.create({ title: 'while signed out' });
    server.unauthorized = true;
    expect(await client.sync()).toMatchObject({ applied: 0, needsLogin: true });
    const queued = await outbox();
    expect(queued).toHaveLength(1);
    expect(queued[0].attempted).toBe(true);
    server.unauthorized = false;
    expect(await client.sync()).toMatchObject({ applied: 1, needsLogin: false });
    expect(server.pushes.at(-1)?.[0].mutationId).toBe(queued[0].mutationId);
  });

  /**
   * @regression   DEV-3903 review — the push read the outbox in one transaction and marked it in a second one, with the
   *   copy it read first; an edit in between folded into an item already on its way and was lost on both sides.
   * @seen-failing Fold an edit into a change a push has carried, in SyncClient.update() (tests/clients/sync-client.mjs)
   *   — registered as mutation `sync-client-folds-into-carried-change` in tests/regression-mutations.json.
   */
  it('keeps an edit made while a push is in flight, as a change of its own', async () => {
    const { client, outbox, server } = setup();
    const note = await client.create({ title: 'draft' });
    server.duringPush = async () => {
      await client.update(note.id, { body: 'typed while the push was in flight' });
    };
    // The edit is a change of its own, and the same sync carries it right after the create
    await client.sync();
    expect(await outbox()).toEqual([]);
    expect(server.pushes.map((items) => items.map((item: any) => item.baseVersion))).toEqual([[undefined], [1]]);
    expect(server.records.get(note.id)).toMatchObject({ data: { body: 'typed while the push was in flight', title: 'draft' }, version: 2 });
    expect(await client.get(note.id)).toMatchObject({ data: { body: 'typed while the push was in flight' }, version: 2 });
  });

  /**
   * @regression   DEV-3903 review — after a lost answer a later edit folded into the change the server had already
   *   recorded under its mutation id; the repeat was answered with the recorded outcome and the edit was gone.
   * @seen-failing Fold an edit into a change a push has carried, in SyncClient.update() (tests/clients/sync-client.mjs)
   *   — registered as mutation `sync-client-folds-into-carried-change` in tests/regression-mutations.json.
   */
  it('never folds an edit into a change a push has carried — the server may have recorded it', async () => {
    const { client, outbox, server } = setup();
    const note = await client.create({ title: 'one' });
    await client.sync();
    await client.update(note.id, { title: 'edit 1' });
    server.dropNextAnswer = true;
    expect(await client.sync()).toMatchObject({ offline: true });
    expect(server.records.get(note.id)).toMatchObject({ version: 2 });
    await client.update(note.id, { body: 'edit 2' });
    const queued = await outbox();
    expect(queued.map(({ attempted, baseVersion }) => ({ attempted, baseVersion }))).toEqual([
      { attempted: true, baseVersion: 1 },
      { attempted: undefined, baseVersion: 2 },
    ]);
    expect(await client.sync()).toMatchObject({ applied: 2, conflicts: [] });
    expect(server.records.get(note.id)).toMatchObject({ data: { body: 'edit 2', title: 'edit 1' }, version: 3 });
  });

  it('sends a change again that was still in progress elsewhere (`retry`), and settles it once recorded', async () => {
    const { client, outbox, server } = setup();
    const note = await client.create({ title: 'tab' });
    const [item] = await outbox();
    server.inProgress.add(item.mutationId);
    expect(await client.sync()).toMatchObject({ applied: 0, retried: 1 });
    expect(await outbox()).toHaveLength(1);
    server.inProgress.clear();
    expect(await client.sync()).toMatchObject({ applied: 1 });
    expect(await client.get(note.id)).toMatchObject({ version: 1 });
  });

  it('resyncs on 410: drops the local copies, keeps the unsent changes, pulls from scratch and pushes them', async () => {
    const { client, outbox, server } = setup();
    const synced = await client.create({ title: 'synced' });
    await client.sync();
    server.write(synced.id, { data: { title: 'changed on the server' } });
    const local = await client.create({ title: 'unsent' });
    server.gone = true;
    const result = await client.sync();
    expect(result.resynced).toBe(true);
    expect(await outbox()).toEqual([]);
    expect(await client.get(synced.id)).toMatchObject({ data: { title: 'changed on the server' }, version: 2 });
    expect(server.records.get(local.id)).toMatchObject({ version: 1 });
  });

  it('drops the local copies and the cursor when a pull answers 403 — access lost for good', async () => {
    const { client, network, outbox, server, store } = setup();
    const note = await client.create({ title: 'seen before' });
    await client.sync();
    network.online = false;
    const unsent = await client.create({ title: 'unsent' });
    network.online = true;
    server.forbidden = true;
    const before = server.pushes.length;
    const result = await client.sync();
    expect(result).toMatchObject({ forbidden: true });
    // The push went out before the pull was refused; every copy goes, the pushed record's too
    expect(server.pushes.length).toBe(before + 1);
    expect(await client.get(note.id)).toBeUndefined();
    expect(await store.run((tx) => tx.getMeta('cursor:Note'))).toBeUndefined();
    expect((await outbox()).map((item) => item.id)).not.toContain(note.id);
    expect(await client.get(unsent.id)).toBeUndefined();
  });

  it('pulls page by page and continues from the stored cursor', async () => {
    const { client, server, store } = setup();
    for (let index = 0; index < 250; index++) {
      server.write(`id-${String(index).padStart(3, '0')}`, { data: { index } });
    }
    await client.sync();
    expect(await client.list()).toHaveLength(250);
    expect(await store.run((tx) => tx.getMeta('cursor:Note'))).toBe('250');
    server.write('id-000', { data: { index: -1 } });
    await client.sync();
    expect(await client.get('id-000')).toMatchObject({ data: { index: -1 }, version: 2 });
  });

  it('serves two tabs on one file without losing or doubling a change', async () => {
    const server = new FakeSyncServer();
    const first = setup(server);
    const second = setup(server, first.path);
    const note = await first.client.create({ title: 'one' });
    await first.client.sync();
    await first.client.update(note.id, { title: 'both push this' });
    await Promise.all([first.client.sync(), second.client.sync()]);
    expect(await first.outbox()).toEqual([]);
    expect(server.records.get(note.id)).toMatchObject({ data: { title: 'both push this' }, version: 2 });
    expect(await second.client.get(note.id)).toMatchObject({ version: 2 });
  });
});
