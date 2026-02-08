import * as fs from 'fs';
import { Db, GridFSBucket, MongoClient, ObjectId } from 'mongodb';
import * as path from 'path';

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
 * Upload file to GridFS
 *
 * @param mongoUrl - MongoDB connection URI
 * @param relativePath - Relative path to the file
 * @param options - Optional bucket name and filename
 * @returns Promise with ObjectId of uploaded file
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
  const db = client.db();
  const bucket = new GridFSBucket(db, { bucketName });
  const writeStream = bucket.openUploadStream(filename);

  const rs = fs.createReadStream(path.resolve(__dirname, relativePath)).pipe(writeStream);

  return new Promise<ObjectId>((resolve, reject) => {
    rs.on('finish', () => {
      resolve(writeStream.id as ObjectId);
    });

    rs.on('error', (err) => {
      reject(err);
    });
  });
};

/**
 * Create a migration state store factory
 *
 * @param mongoUrl - MongoDB connection URI
 * @param collectionName - Optional collection name (default: 'migrations')
 * @param lockCollectionName - Optional lock collection name for cluster environments
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
  lockCollectionName?: string,
) => {
  const { MongoStateStore } = require('../mongo-state-store');

  return class MigrationStateStore extends MongoStateStore {
    constructor() {
      super({
        collectionName,
        lockCollectionName,
        uri: mongoUrl,
      });
    }
  };
};
