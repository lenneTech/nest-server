/**
 * A minimal offline-sync client of `docs/offline-sync-protocol.md` — the test client the browser (PWA) and the Node
 * suite share, so both prove the same protocol code against the same API. Test code: it lives in `tests/`, which the
 * npm package does not ship. A project's client is the Nuxt composable (follow-up ticket) or its own.
 *
 * Plain JavaScript without imports, because the browser loads this very file. Storage is an adapter (`idb-store.mjs`
 * in the browser, `sqlite-store.mjs` in Node) with one method, `run(fn)`, that hands `fn` a transaction:
 *
 *   getRecord(id) · putRecord(record) · deleteRecord(id) · listRecords() · clearRecords(keepIds)
 *   getMeta(key) · setMeta(key, value) · deleteMeta(key)
 *   listOutbox() · addOutbox(item) · putOutbox(item) · removeOutbox(mutationId)
 *
 * A local record is `{ id, version, updatedAt, deletedAt, data }`; `version` 0 means "created here, not on the server
 * yet". The outbox holds the unsent changes in the order they were made (`seq`), each a protocol push item plus
 * `sentAt` while a push carries it.
 */

/** The request could not reach the server — the client is offline */
export class SyncOfflineError extends Error {
  constructor(cause) {
    super(`offline: ${cause?.message ?? cause}`);
    this.name = 'SyncOfflineError';
  }
}

/** The server answered 401: the session ended. Nothing was applied, nothing is discarded (protocol §4) */
export class SyncUnauthorizedError extends Error {
  constructor() {
    super('unauthorized');
    this.name = 'SyncUnauthorizedError';
  }
}

const hex = (bytes) => Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');

/** An ObjectId-hex id with the random tail protocol §3 asks for: 4 timestamp bytes plus 8 bytes from a secure source */
export function newObjectId() {
  const random = new Uint8Array(8);
  globalThis.crypto.getRandomValues(random);
  return Math.floor(Date.now() / 1000).toString(16).padStart(8, '0') + hex(random);
}

/** A uuidv7 for a mutation id: 48 bits of milliseconds, version 7, the variant, the rest random */
export function newUuidV7() {
  const bytes = new Uint8Array(16);
  globalThis.crypto.getRandomValues(bytes);
  let time = Date.now();
  for (let index = 5; index >= 0; index--) {
    bytes[index] = time % 256;
    time = Math.floor(time / 256);
  }
  bytes[6] = 0x70 | (bytes[6] & 0x0f);
  bytes[8] = 0x80 | (bytes[8] & 0x3f);
  const value = hex(bytes);
  return `${value.slice(0, 8)}-${value.slice(8, 12)}-${value.slice(12, 16)}-${value.slice(16, 20)}-${value.slice(20)}`;
}

/** A pulled item or a conflict's record as a local record */
function localOf(item) {
  return {
    data: item.deletedAt ? undefined : item.data,
    deletedAt: item.deletedAt ?? null,
    id: item.id,
    updatedAt: item.updatedAt ?? null,
    version: item.version,
  };
}

export class SyncClient {
  /**
   * @param {object} options
   * @param {string} options.model         the model's name under `/sync`
   * @param {object} options.store         the storage adapter
   * @param {string} [options.baseUrl]     the API origin; empty in the browser, where the page shares it
   * @param {Function} [options.fetch]     `fetch`; the Node suite passes one that fails while "offline"
   * @param {Function} [options.headers]   extra headers per request, e.g. `() => ({ authorization: 'Bearer …' })`
   * @param {number} [options.pageLimit]   records per pull page
   */
  constructor({ baseUrl = '', fetch = globalThis.fetch.bind(globalThis), headers = () => ({}), model, pageLimit = 100, store }) {
    this.baseUrl = baseUrl;
    this.fetch = fetch;
    this.headers = headers;
    this.model = model;
    this.pageLimit = pageLimit;
    this.store = store;
  }

  // --- local operations: the client works offline, every change waits in the outbox -------------------------------

  /** The live local records, by id */
  async list() {
    const records = await this.store.run((tx) => tx.listRecords());
    return records.filter((record) => !record.deletedAt).sort((a, b) => (a.id < b.id ? -1 : 1));
  }

  async get(id) {
    return this.store.run((tx) => tx.getRecord(id));
  }

  /** Create a record with a client id (protocol §3); pushed as an upsert without `baseVersion` */
  async create(data) {
    const record = { data, deletedAt: null, id: newObjectId(), updatedAt: null, version: 0 };
    await this.store.run(async (tx) => {
      await tx.putRecord(record);
      await tx.addOutbox({ data, id: record.id, mutationId: newUuidV7(), op: 'upsert' });
    });
    return record;
  }

  /** Change fields of a record; folded into an unsent change of the same record where there is one */
  async update(id, data) {
    return this.store.run(async (tx) => {
      const record = await tx.getRecord(id);
      if (!record || record.deletedAt) {
        throw new Error(`no live local record ${id}`);
      }
      const pending = this.lastPending(await tx.listOutbox(), id);
      if (pending && pending.op === 'upsert' && !pending.sentAt) {
        await tx.putOutbox({ ...pending, data: { ...pending.data, ...data } });
      } else {
        await tx.addOutbox({ baseVersion: this.nextBase(record, pending), data, id, mutationId: newUuidV7(), op: 'upsert' });
      }
      const changed = { ...record, data: { ...record.data, ...data } };
      await tx.putRecord(changed);
      return changed;
    });
  }

  /** Delete a record: a tombstone on the server (a hard delete is not reachable through sync) */
  async remove(id) {
    await this.store.run(async (tx) => {
      const record = await tx.getRecord(id);
      if (!record || record.deletedAt) {
        return;
      }
      const pending = this.lastPending(await tx.listOutbox(), id);
      if (pending && !pending.sentAt) {
        await tx.removeOutbox(pending.mutationId);
        if (pending.baseVersion === undefined) {
          // Created and deleted before it ever reached the server: nothing to tell the server
          await tx.deleteRecord(id);
          return;
        }
      }
      const baseVersion = pending && !pending.sentAt ? pending.baseVersion : this.nextBase(record, pending);
      await tx.addOutbox({ baseVersion, id, mutationId: newUuidV7(), op: 'delete' });
      await tx.putRecord({ ...record, data: undefined, deletedAt: new Date().toISOString() });
    });
  }

  /** The last unsent change of a record */
  lastPending(outbox, id) {
    return outbox.filter((item) => item.id === id).at(-1);
  }

  /**
   * The `baseVersion` of a new change: the version the change before it produces (protocol §6.2) — the stored version,
   * or one more than a change already on its way.
   */
  nextBase(record, pending) {
    return pending ? (pending.baseVersion ?? 0) + 1 : record.version;
  }

  // --- sync ---------------------------------------------------------------------------------------------------------

  /**
   * Push the outbox, then pull until `hasMore` is false — at start, on `online`, on focus (protocol §2). Never throws
   * for an offline client or an ended session: the result says so, and the outbox keeps every change.
   */
  async sync() {
    const result = { applied: 0, conflicts: [], needsLogin: false, offline: false, rejected: [], resynced: false, retried: 0 };
    try {
      await this.push(result);
      if (await this.pull(result)) {
        // A resync drops the local records but keeps the unsent changes; they meet the new state now (protocol §8)
        await this.push(result);
      }
    } catch (error) {
      if (error instanceof SyncUnauthorizedError) {
        result.needsLogin = true;
      } else if (error instanceof SyncOfflineError) {
        result.offline = true;
      } else {
        throw error;
      }
    }
    return result;
  }

  async push(result) {
    const outbox = await this.store.run((tx) => tx.listOutbox());
    for (let start = 0; start < outbox.length; start += 100) {
      const chunk = outbox.slice(start, start + 100);
      await this.store.run(async (tx) => {
        for (const item of chunk) {
          await tx.putOutbox({ ...item, sentAt: Date.now() });
        }
      });
      let response;
      try {
        response = await this.request('POST', `/sync/${this.model}`, { items: chunk.map((item) => this.pushItem(item)) });
      } catch (error) {
        await this.store.run(async (tx) => {
          for (const item of chunk) {
            const current = (await tx.listOutbox()).find((entry) => entry.mutationId === item.mutationId);
            if (current) {
              await tx.putOutbox({ ...current, sentAt: undefined });
            }
          }
        });
        throw error;
      }
      const results = response.body.results ?? [];
      for (let index = 0; index < chunk.length; index++) {
        await this.store.run((tx) => this.settle(tx, chunk[index], results[index], result));
      }
    }
  }

  /** The item as the protocol takes it — without the local bookkeeping */
  pushItem(item) {
    const { baseVersion, data, id, mutationId, op } = item;
    return { ...(baseVersion === undefined ? {} : { baseVersion }), ...(data === undefined ? {} : { data }), id, mutationId, op };
  }

  /** Act on one item's result (protocol §7) */
  async settle(tx, item, outcome, result) {
    const status = outcome?.status;
    if (status === 'retry' || !status) {
      // The same change is still in progress elsewhere (a second tab), or the server had a transient problem
      result.retried++;
      const current = (await tx.listOutbox()).find((entry) => entry.mutationId === item.mutationId);
      if (current) {
        await tx.putOutbox({ ...current, sentAt: undefined });
      }
      return;
    }
    await tx.removeOutbox(item.mutationId);
    const record = await tx.getRecord(item.id);
    if (status === 'applied') {
      result.applied++;
      if (item.op === 'delete') {
        await tx.deleteRecord(item.id);
      } else if (record && (record.version ?? 0) < outcome.version) {
        await tx.putRecord({ ...record, version: outcome.version });
      }
      return;
    }
    if (status === 'merged') {
      result.applied++;
      await tx.putRecord(localOf(outcome.record));
      return;
    }
    if (status === 'conflict') {
      // This client's policy: the server wins. Later changes of the record were based on the lost one, so they go too
      result.conflicts.push(outcome);
      for (const later of (await tx.listOutbox()).filter((entry) => entry.id === item.id)) {
        await tx.removeOutbox(later.mutationId);
      }
      if (outcome.record?.deletedAt) {
        await tx.deleteRecord(item.id);
      } else if (outcome.record) {
        await tx.putRecord(localOf(outcome.record));
      }
      return;
    }
    if (status === 'not_found') {
      await tx.deleteRecord(item.id);
      return;
    }
    // rejected: retrying the same change will not help; a record the server never had goes with it
    result.rejected.push(outcome);
    if (record && !record.version) {
      await tx.deleteRecord(item.id);
    }
  }

  /** Pull every page after the stored cursor; answers whether a resync dropped the local records */
  async pull(result) {
    const cursorKey = `cursor:${this.model}`;
    let cursor = await this.store.run((tx) => tx.getMeta(cursorKey));
    for (let page = 0; page < 10_000; page++) {
      const query = new URLSearchParams({ limit: String(this.pageLimit) });
      if (cursor) {
        query.set('cursor', cursor);
      }
      const response = await this.request('GET', `/sync/${this.model}?${query}`);
      if (response.status === 410) {
        if (result.resynced) {
          throw new Error(`resync loop: ${JSON.stringify(response.body)}`);
        }
        result.resynced = true;
        await this.store.run(async (tx) => {
          const keep = new Set((await tx.listOutbox()).map((item) => item.id));
          await tx.clearRecords(keep);
          await tx.deleteMeta(cursorKey);
        });
        cursor = undefined;
        continue;
      }
      const body = response.body;
      // A page's items and its cursor in one local transaction: a crash after it resumes with the next page (§5.2)
      await this.store.run(async (tx) => {
        const pending = new Set((await tx.listOutbox()).map((item) => item.id));
        for (const item of body.items) {
          if (pending.has(item.id)) {
            // An unsent local change wins locally until its push settles; the push meets the newer version then
            continue;
          }
          const local = await tx.getRecord(item.id);
          if (local && local.version > item.version) {
            continue;
          }
          if (item.deletedAt) {
            await tx.deleteRecord(item.id);
          } else {
            await tx.putRecord(localOf(item));
          }
        }
        await tx.setMeta(cursorKey, body.cursor);
      });
      cursor = body.cursor;
      if (!body.hasMore) {
        return result.resynced;
      }
    }
    throw new Error('pull did not end');
  }

  /** One request; answers `{ status, body }`, throws for an offline client and for 401 */
  async request(method, path, payload) {
    let response;
    try {
      response = await this.fetch(`${this.baseUrl}${path}`, {
        body: payload === undefined ? undefined : JSON.stringify(payload),
        credentials: 'same-origin',
        headers: { ...(payload === undefined ? {} : { 'content-type': 'application/json' }), ...this.headers() },
        method,
      });
    } catch (error) {
      throw new SyncOfflineError(error);
    }
    if (response.status === 401) {
      throw new SyncUnauthorizedError();
    }
    const text = await response.text();
    const body = text ? JSON.parse(text) : undefined;
    if (response.status === 410) {
      return { body, status: 410 };
    }
    if (!response.ok) {
      throw new Error(`${method} ${path} answered ${response.status}: ${text.slice(0, 300)}`);
    }
    return { body, status: response.status };
  }
}
