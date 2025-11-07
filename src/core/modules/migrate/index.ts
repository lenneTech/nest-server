/**
 * Migration module exports
 *
 * This module provides MongoDB-based state storage for migration frameworks.
 * It is compatible with the @nodepit/migrate-state-store-mongodb package
 * and supports MongoDB 6+.
 *
 * @example
 * ```typescript
 * import { MongoStateStore, synchronizedUp, createMigrationStore } from '@lenne.tech/nest-server';
 *
 * // Basic usage
 * const stateStore = new MongoStateStore('mongodb://localhost/mydb');
 *
 * // With custom collection names
 * const stateStore = new MongoStateStore({
 *   uri: 'mongodb://localhost/mydb',
 *   collectionName: 'my_migrations',
 *   lockCollectionName: 'migration_lock'
 * });
 *
 * // Using synchronized migration for clustered environments
 * await synchronizedUp({
 *   stateStore: new MongoStateStore({
 *     uri: 'mongodb://localhost/mydb',
 *     lockCollectionName: 'migration_lock'
 *   })
 * });
 *
 * // Create a migration store for use with migrate CLI
 * // In your project's migrations-utils/migrate.js:
 * const { createMigrationStore } = require('@lenne.tech/nest-server');
 * const config = require('../src/config.env');
 * module.exports = createMigrationStore(config.default.mongoose.uri);
 * ```
 */

export * from './cli/migrate-cli';
export * from './helpers/migration.helper';
export * from './migration-runner';
export * from './mongo-state-store';
