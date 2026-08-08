import * as fs from 'fs';
import { Db, GridFSBucket, MongoClient, ObjectId } from 'mongodb';
import * as path from 'path';

import { MongoStateStore } from '../mongo-state-store';

/**
 * Migration helper functions for database operations
 */

// Store active connections for auto-cleanup
const activeConnections = new Set<MongoClient>();

// Track if we're in a migration context
let inMigrationContext = false;

/**
 * Mark the start of a migration
 * @internal Used by migration runner
 */
export const _startMigration = () => {
  inMigrationContext = true;
};

/**
 * Mark the end of a migration and close all connections
 * @internal Used by migration runner
 */
export const _endMigration = async () => {
  inMigrationContext = false;
  // Close all active connections
  const promises = Array.from(activeConnections).map((client) => client.close());
  activeConnections.clear();
  await Promise.all(promises);
};

/**
 * Get database connection
 *
 * When used in migrations, connections are automatically closed after the migration completes.
 * For manual usage outside migrations, you must close the connection manually.
 *
 * @param mongoUrl - MongoDB connection URI
 * @returns Promise with database instance
 *
 * @example
 * ```typescript
 * // In migrations - connection auto-closes after migration
 * const db = await getDb('mongodb://localhost/mydb');
 * await db.collection('users').updateMany(...);
 *
 * // Outside migrations - must close manually
 * const db = await getDb('mongodb://localhost/mydb');
 * try {
 *   await db.collection('users').updateMany(...);
 * } finally {
 *   await db.client.close();
 * }
 * ```
 */
export const getDb = async (mongoUrl: string): Promise<Db> => {
  const client: MongoClient = await MongoClient.connect(mongoUrl);

  // Track connection for auto-cleanup in migrations
  if (inMigrationContext) {
    activeConnections.add(client);
  }

  return client.db();
};

/**
 * Throw unless every chunk of a stored GridFS file is present.
 *
 * A GridFS upload is not one write but many: N chunk documents plus the files
 * document that describes them. The write stream's `'finish'` event says the
 * stream ended — it does not prove every chunk is durably there, and a
 * connection that goes away at the wrong moment can leave a files document
 * behind that promises more bytes than exist. The upload then "succeeds", the
 * caller stores the id, and the defect only surfaces much later as a broken
 * download from a record that looks perfectly healthy.
 *
 * Counts documents rather than reading bytes, so a chunk that was written but
 * truncated still passes. Catching that would mean streaming the whole file
 * back on every upload; the cheap count catches the failure that actually
 * occurs (a missing chunk) and is index-only via the GridFS default index.
 *
 * @param db - Database holding the bucket
 * @param bucketName - GridFS bucket name, i.e. the prefix of `<bucket>.files` / `<bucket>.chunks`
 * @param id - `_id` of the files document
 * @param label - Optional human-readable name for the error message; defaults to the id
 * @throws Error if the files document is missing or fewer chunks are stored than its length implies
 *
 * @example
 * ```typescript
 * await assertGridFsFileComplete(db, 'images', fileId, 'logo.png');
 * ```
 */
export const assertGridFsFileComplete = async (
  db: Db,
  bucketName: string,
  id: ObjectId,
  label?: string,
): Promise<void> => {
  const name = label || String(id);
  const fileDoc = await db.collection(`${bucketName}.files`).findOne({ _id: id });
  if (!fileDoc) {
    throw new Error(`GridFS file '${name}' has no file document (id ${String(id)})`);
  }

  const chunkSize: number = fileDoc.chunkSize || 255 * 1024;
  // NO `Math.max(1, …)` floor here: GridFS stores ZERO chunk documents for a
  // zero-byte file — the driver's `writeRemnant()` returns early on `pos === 0`
  // rather than inserting an empty chunk. A floor of 1 would reject every
  // legitimately empty asset, and because the container entrypoint defaults to
  // `MIGRATE_FAILURE_POLICY=abort`, that failure would keep the server from
  // starting at all.
  const expected = Math.ceil((fileDoc.length || 0) / chunkSize);
  const actual = await db
    .collection(`${bucketName}.chunks`)
    // Read from the primary: this is a read-your-own-write, and a URI carrying
    // `readPreference=secondaryPreferred` would otherwise fail a healthy upload
    // against a secondary that has not caught up yet.
    .countDocuments({ files_id: id }, { readPreference: 'primary' });
  if (actual < expected) {
    throw new Error(`GridFS file '${name}' is incomplete: ${actual} of ${expected} chunks stored (id ${String(id)})`);
  }
};

/**
 * Upload file to GridFS
 *
 * Resolves only once the upload is verified complete (see
 * {@link assertGridFsFileComplete}); rejects — rather than hanging — when the
 * source file cannot be read. Closes its own connection either way.
 *
 * @param mongoUrl - MongoDB connection URI
 * @param relativePath - Path to the file, resolved against this module's directory
 * @param options - Optional bucket name and filename
 * @returns Promise with ObjectId of uploaded file
 * @throws Error if the source cannot be read, or if the stored file is incomplete
 *
 * @example
 * ```typescript
 * const fileId = await uploadFileToGridFS(
 *   'mongodb://localhost/mydb',
 *   '../assets/image.png',
 *   { bucketName: 'images', filename: 'logo.png' }
 * );
 * ```
 */
export const uploadFileToGridFS = async (
  mongoUrl: string,
  relativePath: string,
  options?: { bucketName?: string; filename?: string },
): Promise<ObjectId> => {
  if (!relativePath) {
    throw new Error('relativePath is required');
  }

  const { bucketName, filename } = {
    bucketName: 'fs',
    filename: relativePath.split('/')[relativePath.split('/').length - 1],
    ...options,
  };

  const client = await MongoClient.connect(mongoUrl);
  // Registered unconditionally — unlike `getDb()`, which only registers inside a
  // migration context. This client is always ours to close, so `_endMigration()`
  // stays a backstop for the case where the upload throws before `settle()` runs.
  activeConnections.add(client);

  const db = client.db();
  const bucket = new GridFSBucket(db, { bucketName });
  const writeStream = bucket.openUploadStream(filename);

  const readStream = fs.createReadStream(path.resolve(__dirname, relativePath));
  const rs = readStream.pipe(writeStream);

  /**
   * Read errors need their own handler — `pipe()` does not forward them.
   *
   * An unreadable source (missing file, wrong path inside a container image)
   * emits on the READ stream, where nothing was listening: the write stream
   * never finished, the promise below never settled, and the migration hung
   * until something else timed out. Destroying the write stream routes it into
   * the rejection path so the caller sees the actual cause.
   */
  readStream.on('error', (err) => {
    writeStream.destroy(err);
  });

  /**
   * Close the connection before settling.
   *
   * This client used to be opened and never closed, and it was not registered
   * either — so `_endMigration()` could not reach it. Every uploaded file left a
   * live connection behind, and a live connection keeps an SDAM monitor timer
   * alive, which keeps the Node event loop busy: `migrate up` finished its work,
   * printed "All migrations completed successfully" and then never exited. That
   * is invisible on a developer machine and blocks a CI job until its timeout.
   *
   * A failing `close()` must never become the error the caller sees: the reason
   * the upload ended is what matters, and the settle path is also reached while
   * rejecting. So the close error is logged and swallowed, and `settled` keeps a
   * second call (success path falling into `.catch`) from closing twice.
   */
  let settled = false;
  const settle = async <T>(action: () => T): Promise<T> => {
    if (!settled) {
      settled = true;
      try {
        await client.close();
      } catch (closeErr) {
        console.warn('Failed to close migration connection:', closeErr);
      } finally {
        activeConnections.delete(client);
      }
    }
    return action();
  };

  return new Promise<ObjectId>((resolve, reject) => {
    rs.on('finish', () => {
      const id = writeStream.id as ObjectId;
      // Verify BEFORE closing: the check needs the same open client, and a
      // failure has to reject rather than hand back an id that points at nothing.
      assertGridFsFileComplete(db, bucketName, id, filename)
        .then(() => settle(() => id))
        .then(resolve)
        .catch((err: unknown) => {
          // Drop the incomplete file, otherwise every re-run of the migration
          // leaves another orphaned files document (plus its partial chunks)
          // behind, since a retry uploads under a fresh ObjectId.
          bucket
            .delete(id)
            .catch(() => undefined)
            .then(() => settle(() => undefined))
            .finally(() => reject(err));
        });
    });

    rs.on('error', (err) => {
      settle(() => undefined).finally(() => reject(err));
    });
  });
};

/**
 * Create a migration state store factory
 *
 * The lock collection is set by DEFAULT, so `migrate up` from N replicas booting at
 * the same time serializes instead of applying the same migration twice (the container
 * entrypoint runs migrations on every boot). Pass an empty string to opt out.
 *
 * @param mongoUrl - MongoDB connection URI
 * @param collectionName - Optional collection name (default: 'migrations')
 * @param lockCollectionName - Lock collection name (default: 'migrations_lock'); `''` disables locking
 * @returns MongoStateStore class that can be used with migrate CLI
 *
 * @example
 * ```typescript
 * // In migrations-utils/migrate.js:
 * const { createMigrationStore } = require('@lenne.tech/nest-server');
 * const config = require('../src/config.env');
 *
 * module.exports = createMigrationStore(config.default.mongoose.uri);
 * ```
 */
export const createMigrationStore = (
  mongoUrl: string,
  collectionName: string = 'migrations',
  lockCollectionName: string = 'migrations_lock',
  // Explicit return type: the returned class is anonymous to the declaration emitter, and
  // MongoStateStore has private members, so an inferred type cannot be written to the .d.ts
  // (TS4094).
): new () => MongoStateStore => {
  return class MigrationStateStore extends MongoStateStore {
    constructor() {
      super({
        collectionName,
        lockCollectionName: lockCollectionName || undefined,
        uri: mongoUrl,
      });
    }
  };
};
