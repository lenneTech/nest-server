import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { InjectConnection } from '../../../common/persistence/mongo/mongoose-compat.js';
import { readdir } from 'fs/promises';
import type { Connection } from 'mongoose';
import { resolve } from 'path';

import { ConfigService } from '../../../common/services/config.service.js';
import { DEFAULT_MIGRATION_FILE_PATTERN, MigrationRunner } from '../../migrate/migration-runner.js';
import type { DatabaseSqlEngine } from '../../../common/interfaces/server-options.interface.js';
import { getPersistenceRuntime } from '../../../common/persistence/persistence-runtime.registry.js';
import { MongoStateStore } from '../../migrate/mongo-state-store.js';
import { SqlStateStore } from '../../migrate/sql-state-store.js';
import { HubActionMessage } from '../hub-action-messages.js';
import { HUB_CONFIG } from '../hub.constants.js';
import { HubMigrationsData, HubUnavailable } from '../interfaces/hub-panels.interface.js';
import type { ResolvedHubConfig } from '../interfaces/hub-config.interface.js';

/**
 * Reads migration status for the Migrations panel.
 *
 * Status is read from the migration-state collection directly (works without a configured runner);
 * pending migrations are detected by diffing the completed set against the migrations directory
 * listing. The `up()`/`down()` actions (Phase 7) instantiate a `MigrationRunner` on demand.
 */
@Injectable()
export class CoreHubMigrationsService {
  protected readonly logger = new Logger(CoreHubMigrationsService.name);

  constructor(
    @Inject(HUB_CONFIG) protected readonly config: ResolvedHubConfig,
    protected readonly configService: ConfigService,
    @Optional() @InjectConnection() protected readonly connection?: Connection,
  ) {}

  /** Run all pending migrations. Returns the titles that were applied. */
  async runPending(): Promise<{ ran: string[] }> {
    await this.assertSingleMigrationState();
    const runner = this.buildRunner();
    const before = new Set(((await this.getStatus()) as HubMigrationsData).completed ?? []);
    await runner.up();
    const after = ((await this.getStatus()) as HubMigrationsData).completed ?? [];
    return { ran: after.filter((title) => !before.has(title)) };
  }

  /** Roll back the most recently applied migration. Returns the title that was reverted. */
  async rollbackLast(): Promise<{ rolledBack?: string }> {
    await this.assertSingleMigrationState();
    const before = ((await this.getStatus()) as HubMigrationsData).completed ?? [];
    const runner = this.buildRunner();
    await runner.down();
    const after = new Set(((await this.getStatus()) as HubMigrationsData).completed ?? []);
    return { rolledBack: before.find((title) => !after.has(title)) };
  }

  /** Build a MigrationRunner from the hub config + the configured Mongo URI (or the SQL default source's owner). */
  protected buildRunner(): MigrationRunner {
    if (this.config.migrations === false) {
      throw new Error(HubActionMessage.migrationsDisabled);
    }
    const sqlStore = this.sqlStateStore();
    if (sqlStore) {
      return new MigrationRunner({
        migrationsDirectory: resolve(process.cwd(), this.config.migrations.dir),
        stateStore: sqlStore,
      });
    }
    const uri = this.configService.getFastButReadOnly<string>('mongoose.uri');
    if (!uri) {
      throw new Error(HubActionMessage.mongoUriMissing);
    }
    return new MigrationRunner({
      migrationsDirectory: resolve(process.cwd(), this.config.migrations.dir),
      stateStore: new MongoStateStore({
        collectionName: this.config.migrations.collectionName,
        lockCollectionName: this.config.migrations.lockCollectionName,
        uri,
      }),
    });
  }

  /**
   * The migration state store when the default source is a SQL database: the framework keeps the state there
   * (`lt_migrations`), readable and writable by the table owner only. Throws without `database.ownerUrl`.
   */
  protected sqlStateStore(): SqlStateStore | undefined {
    const source = getPersistenceRuntime()?.defaultSqlSource();
    if (!source) {
      return undefined;
    }
    if (!source.ownerUrl) {
      throw new Error(HubActionMessage.sqlOwnerMissing);
    }
    return new SqlStateStore({ engine: source.engine as DatabaseSqlEngine, url: source.ownerUrl });
  }

  /**
   * Refuse to run or roll back while {@link migrationStateLeftInMongo} — the Hub would apply, against live data, every
   * migration the project's own runs recorded in MongoDB.
   */
  protected async assertSingleMigrationState(): Promise<void> {
    const sqlStore = this.sqlStateStore();
    if (!sqlStore) {
      return;
    }
    const completed = ((await sqlStore.loadAsync()).migrations ?? []).map((migration) => migration.title);
    if (await this.migrationStateLeftInMongo(completed)) {
      throw new Error(this.migrationStateInMongoMessage());
    }
  }

  /**
   * Whether the project still records its migrations in MongoDB although the default source is a SQL database.
   *
   * The state of a SQL default source belongs in `lt_migrations`, but only `migrations-utils/migrate.js` decides where
   * it actually goes: one that still passes the MongoDB URI to `createMigrationStore()` writes the MongoDB collection,
   * and the empty table would show every applied migration as pending. Answered from the data, never guessed: an empty
   * table next to a MongoDB collection that lists applied migrations. A MongoDB read that fails throws, so the panel
   * never offers a run it could not rule out.
   */
  protected async migrationStateLeftInMongo(sqlCompleted: string[]): Promise<boolean> {
    if (sqlCompleted.length || this.config.migrations === false) {
      return false;
    }
    const db = this.connection?.db;
    if (!db) {
      return false;
    }
    const [stateDoc] = await db.collection(this.config.migrations.collectionName).find({}).limit(1).toArray();
    return (stateDoc?.migrations ?? []).length > 0;
  }

  protected migrationStateInMongoMessage(): string {
    return HubActionMessage.migrationStateInMongo(
      this.config.migrations === false ? 'migrations' : this.config.migrations.collectionName,
    );
  }

  /** Completed + pending migrations. */
  async getStatus(): Promise<HubMigrationsData | HubUnavailable> {
    if (this.config.migrations === false) {
      return { available: false, hint: 'The migrations panel is disabled.' };
    }
    let sqlStore: SqlStateStore | undefined;
    try {
      sqlStore = this.sqlStateStore();
    } catch (error) {
      return { available: false, hint: error instanceof Error ? error.message : String(error) };
    }
    if (sqlStore) {
      let state: { lastRun?: string; migrations?: { title: string }[] } = {};
      try {
        state = await sqlStore.loadAsync();
      } catch (error) {
        this.logger.warn(`Failed to read migration state: ${error instanceof Error ? error.message : String(error)}`);
      }
      const completed = (state.migrations ?? []).map((migration) => migration.title);
      try {
        if (await this.migrationStateLeftInMongo(completed)) {
          return { available: false, hint: this.migrationStateInMongoMessage() };
        }
      } catch (error) {
        return { available: false, hint: error instanceof Error ? error.message : String(error) };
      }
      const { dirAvailable, files } = await this.listMigrationFiles();
      const pending = dirAvailable ? files.filter((file) => !completed.includes(file)) : [];
      return { completed, dirAvailable, lastRun: state.lastRun, pending, source: 'table' };
    }
    const db = this.connection?.db;
    if (!db) {
      return { available: false, hint: 'No MongoDB connection is available.' };
    }

    const collectionName = this.config.migrations.collectionName;
    let completed: string[] = [];
    let lastRun: string | undefined;

    try {
      const [stateDoc] = await db.collection(collectionName).find({}).limit(1).toArray();
      completed = (stateDoc?.migrations ?? []).map((m: { title: string }) => m.title);
      lastRun = stateDoc?.lastRun;
    } catch (error) {
      this.logger.warn(`Failed to read migration state: ${error instanceof Error ? error.message : String(error)}`);
    }

    const { dirAvailable, files } = await this.listMigrationFiles();
    const pending = dirAvailable ? files.filter((f) => !completed.includes(f)) : [];

    return { completed, dirAvailable, lastRun, pending, source: 'collection' };
  }

  /** List migration file titles from the configured directory (empty when the dir is missing). */
  protected async listMigrationFiles(): Promise<{ dirAvailable: boolean; files: string[] }> {
    if (this.config.migrations === false) {
      return { dirAvailable: false, files: [] };
    }
    const dir = resolve(process.cwd(), this.config.migrations.dir);
    try {
      // A missing or unreadable directory rejects here (ENOENT) → treated as "no dir available".
      const entries = await readdir(dir);
      const files = entries.filter((file) => DEFAULT_MIGRATION_FILE_PATTERN.test(file)).sort();
      return { dirAvailable: true, files };
    } catch {
      return { dirAvailable: false, files: [] };
    }
  }
}
