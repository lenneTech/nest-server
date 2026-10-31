/**
 * The SQLite storage of the Node test client (`sync-client.mjs`), on Node's built-in `node:sqlite` — a client without a
 * browser, as a desktop or React Native app would keep its data. Test code, not shipped.
 *
 * Two clients on one file are two "tabs" of one device. `node:sqlite` is synchronous, so a second connection waiting
 * for the first one's lock would block the event loop the first one needs to finish; the transactions of every client
 * on a file are therefore queued in this process, and SQLite's own lock covers other processes.
 */
import { DatabaseSync } from 'node:sqlite';

const queues = new Map();

export class SqliteStore {
  constructor(path) {
    this.path = path;
    this.db = new DatabaseSync(path);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA busy_timeout = 5000;
      CREATE TABLE IF NOT EXISTS records (id TEXT PRIMARY KEY, json TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS outbox (seq INTEGER PRIMARY KEY AUTOINCREMENT, mutation_id TEXT NOT NULL UNIQUE, json TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    `);
  }

  close() {
    this.db.close();
  }

  /** Run `fn` in one transaction (`BEGIN IMMEDIATE`), after every earlier transaction of this file in this process */
  async run(fn) {
    const previous = queues.get(this.path) ?? Promise.resolve();
    let release;
    const current = new Promise((resolve) => {
      release = resolve;
    });
    queues.set(
      this.path,
      previous.then(() => current),
    );
    await previous;
    try {
      this.db.exec('BEGIN IMMEDIATE');
      try {
        const result = await fn(this.transaction());
        this.db.exec('COMMIT');
        return result;
      } catch (error) {
        this.db.exec('ROLLBACK');
        throw error;
      }
    } finally {
      release();
    }
  }

  transaction() {
    const db = this.db;
    const json = (value) => (value === undefined || value === null ? undefined : JSON.parse(value));
    return {
      addOutbox: (item) => {
        const { seq, ...rest } = item;
        db.prepare('INSERT INTO outbox (mutation_id, json) VALUES (?, ?)').run(rest.mutationId, JSON.stringify(rest));
      },
      clearRecords: (keepIds) => {
        for (const { id } of db.prepare('SELECT id FROM records').all()) {
          if (!keepIds.has(id)) {
            db.prepare('DELETE FROM records WHERE id = ?').run(id);
          }
        }
      },
      deleteMeta: (key) => {
        db.prepare('DELETE FROM meta WHERE key = ?').run(key);
      },
      deleteRecord: (id) => {
        db.prepare('DELETE FROM records WHERE id = ?').run(id);
      },
      getMeta: (key) => db.prepare('SELECT value FROM meta WHERE key = ?').get(key)?.value,
      getRecord: (id) => json(db.prepare('SELECT json FROM records WHERE id = ?').get(id)?.json),
      listOutbox: () =>
        db
          .prepare('SELECT seq, json FROM outbox ORDER BY seq')
          .all()
          .map((row) => ({ ...JSON.parse(row.json), seq: row.seq })),
      listRecords: () =>
        db
          .prepare('SELECT json FROM records')
          .all()
          .map((row) => JSON.parse(row.json)),
      putOutbox: (item) => {
        const { seq, ...rest } = item;
        db.prepare('UPDATE outbox SET json = ? WHERE mutation_id = ?').run(JSON.stringify(rest), rest.mutationId);
      },
      putRecord: (record) => {
        db.prepare('INSERT INTO records (id, json) VALUES (?, ?) ON CONFLICT (id) DO UPDATE SET json = excluded.json').run(
          record.id,
          JSON.stringify(record),
        );
      },
      removeOutbox: (mutationId) => {
        db.prepare('DELETE FROM outbox WHERE mutation_id = ?').run(mutationId);
      },
      setMeta: (key, value) => {
        db.prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value').run(
          key,
          String(value),
        );
      },
    };
  }
}
