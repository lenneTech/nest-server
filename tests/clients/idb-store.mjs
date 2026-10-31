/**
 * The IndexedDB storage of the PWA test client (`sync-client.mjs`). Test code, not shipped.
 *
 * Every tab of the origin shares the database; IndexedDB serializes their read-write transactions itself. A
 * transaction stays open while `fn` only awaits the requests of that transaction — the client never awaits anything
 * else inside `run()`.
 */
const STORES = ['meta', 'outbox', 'records'];

const done = (request) =>
  new Promise((resolve, reject) => {
    request.addEventListener('success', () => resolve(request.result));
    request.addEventListener('error', () => reject(request.error));
  });

export class IdbStore {
  constructor(name) {
    this.name = name;
    this.db = undefined;
  }

  async open() {
    if (this.db) {
      return this.db;
    }
    const request = indexedDB.open(this.name, 1);
    request.addEventListener('upgradeneeded', () => {
      const db = request.result;
      db.createObjectStore('records', { keyPath: 'id' });
      db.createObjectStore('outbox', { autoIncrement: true, keyPath: 'seq' }).createIndex('mutationId', 'mutationId', {
        unique: true,
      });
      db.createObjectStore('meta', { keyPath: 'key' });
    });
    this.db = await done(request);
    // Another tab deleting the database (cleared storage) must not wait for this one forever
    this.db.addEventListener('versionchange', () => {
      this.db?.close();
      this.db = undefined;
    });
    return this.db;
  }

  /** Delete every record, change and cursor — what a browser does when it clears the site's storage */
  async destroy() {
    this.db?.close();
    this.db = undefined;
    await done(indexedDB.deleteDatabase(this.name));
  }

  async run(fn) {
    const db = await this.open();
    const transaction = db.transaction(STORES, 'readwrite');
    const finished = new Promise((resolve, reject) => {
      transaction.addEventListener('complete', () => resolve());
      transaction.addEventListener('abort', () => reject(transaction.error ?? new Error('transaction aborted')));
      transaction.addEventListener('error', () => reject(transaction.error));
    });
    const store = (name) => transaction.objectStore(name);
    const api = {
      addOutbox: (item) => {
        const { seq, ...rest } = item;
        return done(store('outbox').add(rest));
      },
      clearRecords: async (keepIds) => {
        for (const id of await done(store('records').getAllKeys())) {
          if (!keepIds.has(id)) {
            await done(store('records').delete(id));
          }
        }
      },
      deleteMeta: (key) => done(store('meta').delete(key)),
      deleteRecord: (id) => done(store('records').delete(id)),
      getMeta: async (key) => (await done(store('meta').get(key)))?.value,
      getRecord: (id) => done(store('records').get(id)),
      listOutbox: () => done(store('outbox').getAll()),
      listRecords: () => done(store('records').getAll()),
      putOutbox: (item) => done(store('outbox').put(item)),
      putRecord: (record) => done(store('records').put(record)),
      removeOutbox: async (mutationId) => {
        const key = await done(store('outbox').index('mutationId').getKey(mutationId));
        if (key !== undefined) {
          await done(store('outbox').delete(key));
        }
      },
      setMeta: (key, value) => done(store('meta').put({ key, value })),
    };
    let result;
    try {
      result = await fn(api);
    } catch (error) {
      transaction.abort();
      await finished.catch(() => undefined);
      throw error;
    }
    await finished;
    return result;
  }
}
