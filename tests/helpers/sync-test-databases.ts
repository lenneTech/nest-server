import mongoose from 'mongoose';

import envConfig from '../../src/config.env';
import { deriveTestDbUri, isDroppableTestDb } from '../db-lifecycle.reporter';
import { createMysqlTestDatabase } from './mysql-test-db';
import { createPostgresTestDatabase } from './postgres-test-db';
import type { SyncDriver } from './sync-contract-matrix';

/** The test infrastructure's one-node replica set (`pnpm run test:infra`, container nest-server-2985-mongo-rs) */
export const MONGO_RS_URL = `mongodb://${process.env.MONGO_RS_HOST || '127.0.0.1'}:${process.env.MONGO_RS_PORT || '27019'}`;

/** A database of one sync column: the configuration that points the application at it, and its removal */
export interface SyncTestDatabase {
  config: Record<string, unknown>;
  drop(): Promise<void>;
}

/**
 * A database of its own for one column of the offline-sync suites. `label` keeps two suites apart and stays short: a
 * PostgreSQL name is cut at 63 characters after the run prefix, and a longer label would cut the engines' names down
 * to one. MongoDB stays the `mongoose` source on every column, as in the reference server; a SQL column adds
 * `database` as the default source.
 */
export async function syncTestDatabase(driver: SyncDriver, label: string): Promise<SyncTestDatabase> {
  const local = deriveTestDbUri(`${label}-${driver}`);
  if (driver === 'mongodb') {
    return { config: { mongoose: { ...envConfig.mongoose, uri: local } }, drop: async () => undefined };
  }
  if (driver === 'mongodb-rs') {
    const name = new URL(local).pathname.slice(1);
    if (!isDroppableTestDb(name)) {
      throw new Error(`Refusing the replica set database "${name}": its name does not pass the drop guard`);
    }
    const uri = `${MONGO_RS_URL}/${name}?directConnection=true`;
    const probe = await mongoose
      .createConnection(uri, { serverSelectionTimeoutMS: 3000 })
      .asPromise()
      .catch((error) => {
        throw new Error(
          `The MongoDB replica set is not reachable on ${MONGO_RS_URL} (${(error as Error).message}). ` +
            'Start the test infrastructure with `pnpm run test:infra` (container nest-server-2985-mongo-rs).',
        );
      });
    await probe.close();
    return {
      config: { mongoose: { ...envConfig.mongoose, uri } },
      drop: async () => {
        const connection = await mongoose.createConnection(uri).asPromise();
        await connection.dropDatabase();
        await connection.close();
      },
    };
  }
  const mongooseConfig = { mongoose: { ...envConfig.mongoose, uri: local } };
  if (driver.startsWith('postgres-')) {
    const database = await createPostgresTestDatabase(`${label}-${driver}`);
    return {
      config: {
        ...mongooseConfig,
        database: { ownerUrl: database.ownerUrl, sqlEngine: driver.slice('postgres-'.length), url: database.appUrl },
      },
      drop: () => database.drop(),
    };
  }
  const database = await createMysqlTestDatabase(driver as 'mariadb' | 'mysql', label);
  return {
    config: { ...mongooseConfig, database: { ownerUrl: database.ownerUrl, url: database.appUrl } },
    drop: () => database.drop(),
  };
}
