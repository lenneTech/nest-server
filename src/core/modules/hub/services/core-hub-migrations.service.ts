import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { InjectConnection } from '@nestjs/mongoose';
import { readdir } from 'fs/promises';
import { Connection } from 'mongoose';
import { resolve } from 'path';

import { ConfigService } from '../../../common/services/config.service';
import { DEFAULT_MIGRATION_FILE_PATTERN, MigrationRunner } from '../../migrate/migration-runner';
import { MongoStateStore } from '../../migrate/mongo-state-store';
import { HubActionMessage } from '../hub-action-messages';
import { HUB_CONFIG } from '../hub.constants';
import { HubMigrationsData, HubUnavailable } from '../interfaces/hub-panels.interface';
import { ResolvedHubConfig } from '../interfaces/hub-config.interface';

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
    const runner = this.buildRunner();
    const before = new Set(((await this.getStatus()) as HubMigrationsData).completed ?? []);
    await runner.up();
    const after = ((await this.getStatus()) as HubMigrationsData).completed ?? [];
    return { ran: after.filter((title) => !before.has(title)) };
  }

  /** Roll back the most recently applied migration. Returns the title that was reverted. */
  async rollbackLast(): Promise<{ rolledBack?: string }> {
    const before = ((await this.getStatus()) as HubMigrationsData).completed ?? [];
    const runner = this.buildRunner();
    await runner.down();
    const after = new Set(((await this.getStatus()) as HubMigrationsData).completed ?? []);
    return { rolledBack: before.find((title) => !after.has(title)) };
  }

  /** Build a MigrationRunner from the hub config + the configured Mongo URI. */
  protected buildRunner(): MigrationRunner {
    if (this.config.migrations === false) {
      throw new Error(HubActionMessage.migrationsDisabled);
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

  /** Completed + pending migrations. */
  async getStatus(): Promise<HubMigrationsData | HubUnavailable> {
    if (this.config.migrations === false) {
      return { available: false, hint: 'The migrations panel is disabled.' };
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
