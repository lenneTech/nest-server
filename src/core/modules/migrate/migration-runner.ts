import * as fs from 'fs';
import * as path from 'path';

import { MongoStateStore } from './mongo-state-store';

/**
 * Migration file interface
 */
export interface MigrationFile {
  /** Down function */
  down?: () => Promise<void>;
  /** File path */
  filePath: string;
  /** Timestamp when migration was created */
  timestamp: number;
  /** Migration name/title */
  title: string;
  /** Up function */
  up: () => Promise<void>;
}

/**
 * Default file pattern for migration files: `*.ts` and `*.js`, but never `*.d.ts`.
 *
 * A compiled migration ships `foo.js` next to `foo.d.ts` (whenever the project
 * builds with `declaration: true`). A plain `/\.(ts|js)$/` matches the
 * declaration file too, so the runner would load it as a *second* migration and
 * throw — `export declare …` is not valid CommonJS.
 *
 * The lookbehind guards the `.ts` branch only. Writing it as `(?<!\.d)\.(ts|js)$`
 * would also reject a perfectly valid `foo.d.js`, since `.d` precedes `.js` there
 * as well.
 */
export const DEFAULT_MIGRATION_FILE_PATTERN = /(?:(?<!\.d)\.ts|\.js)$/;

/**
 * Migration identity = the timestamped file stem WITHOUT its `.ts`/`.js` extension.
 *
 * A migration keeps its identity when a project switches its production image from
 * ts-node (`1699-foo.ts`) to compiled JavaScript (`1699-foo.js`) — the recommended
 * prod setup, since the image prunes ts-node. Comparing raw filenames would make
 * every compiled `.js` migration look "pending" against a state recorded under `.ts`
 * names and re-run already-applied migrations (data corruption on existing DBs).
 * Normalising both sides makes the transition safe with no state rewrite.
 */
export function migrationId(title: string): string {
  return title.replace(/\.(ts|js)$/, '');
}

/**
 * Migration runner configuration
 */
export interface MigrationRunnerOptions {
  /** Directory containing migration files */
  migrationsDirectory: string;
  /** Pattern to match migration files (default: {@link DEFAULT_MIGRATION_FILE_PATTERN}) */
  pattern?: RegExp;
  /** State store for tracking migrations */
  stateStore: MongoStateStore;
  /**
   * Fail hard when a migration recorded in the state has no file on disk.
   *
   * Default `false` (tolerate): recorded migrations whose files were deleted are
   * ignored — `up` skips them (with a warning) and the server still starts. Migrations
   * are tracked in git and can be restored if a rollback is ever needed, so old
   * migration files can be pruned without blocking boot. Set `true` to enforce
   * state/disk integrity (missing file → error).
   */
  strict?: boolean;
}

/**
 * Simple migration runner for NestJS applications
 *
 * This provides a programmatic way to run migrations without requiring the `migrate` CLI.
 * It's a lightweight alternative for projects that want to run migrations from code.
 *
 * @example
 * ```typescript
 * import { MigrationRunner, MongoStateStore } from '@lenne.tech/nest-server';
 *
 * const runner = new MigrationRunner({
 *   stateStore: new MongoStateStore('mongodb://localhost/mydb'),
 *   migrationsDirectory: './migrations'
 * });
 *
 * // Run all pending migrations
 * await runner.up();
 *
 * // Rollback last migration
 * await runner.down();
 * ```
 */
export class MigrationRunner {
  private options: MigrationRunnerOptions;
  private pattern: RegExp;

  constructor(options: MigrationRunnerOptions) {
    this.options = options;
    this.pattern = options.pattern || DEFAULT_MIGRATION_FILE_PATTERN;
  }

  /**
   * Load all migration files from the migrations directory
   */
  private async loadMigrationFiles(): Promise<MigrationFile[]> {
    const files = fs
      .readdirSync(this.options.migrationsDirectory)
      .filter((file) => this.pattern.test(file))
      .sort(); // Sort alphabetically (timestamp-based filenames will be in order)

    const migrations: MigrationFile[] = [];

    for (const file of files) {
      const filePath = path.join(this.options.migrationsDirectory, file);

      const module = require(filePath);

      if (!module.up) {
        console.warn(`Migration ${file} has no 'up' function, skipping...`);
        continue;
      }

      // Extract timestamp from filename (format: TIMESTAMP-name.js)
      const timestampMatch = file.match(/^(\d+)-/);
      const timestamp = timestampMatch ? parseInt(timestampMatch[1], 10) : Date.now();

      migrations.push({
        down: module.down,
        filePath,
        timestamp,
        title: file,
        up: module.up,
      });
    }

    return migrations;
  }

  /**
   * Run all pending migrations (up)
   */
  async up(): Promise<void> {
    const { _endMigration, _startMigration } = await import('./helpers/migration.helper');

    const allMigrations = await this.loadMigrationFiles();
    const state = await this.options.stateStore.loadAsync();
    const recorded = state.migrations || [];
    const presentIds = new Set(allMigrations.map((m) => migrationId(m.title)));

    // Recorded migrations whose file is gone. Tolerated by default (git-tracked and
    // restorable); in strict mode this is a hard error so integrity drift is caught.
    const missing = recorded.filter((m) => !presentIds.has(migrationId(m.title)));
    if (missing.length > 0) {
      const list = missing.map((m) => m.title).join(', ');
      if (this.options.strict) {
        throw new Error(`Strict mode: ${missing.length} recorded migration file(s) missing: ${list}`);
      }
      console.warn(
        `[migrate] ${missing.length} recorded migration file(s) missing — tolerated (strict=false): ${list}`,
      );
    }

    const completedIds = new Set(recorded.map((m) => migrationId(m.title)));
    const pendingMigrations = allMigrations.filter((m) => !completedIds.has(migrationId(m.title)));

    if (pendingMigrations.length === 0) {
      console.log('No pending migrations');
      return;
    }

    console.log(`Running ${pendingMigrations.length} pending migration(s)...`);

    for (const migration of pendingMigrations) {
      console.log(`Running migration: ${migration.title}`);

      // Mark start of migration for auto-cleanup
      _startMigration();

      try {
        await migration.up();

        // Update state
        const newState = await this.options.stateStore.loadAsync();
        const migrations = newState.migrations || [];
        migrations.push({
          timestamp: migration.timestamp,
          title: migration.title,
        });

        await this.options.stateStore.saveAsync({
          lastRun: migration.title,
          migrations,
          up: () => {},
        } as any);

        console.log(`✓ Migration completed: ${migration.title}`);
      } finally {
        // Always close connections, even on error
        await _endMigration();
      }
    }

    console.log('All migrations completed successfully');
  }

  /**
   * Rollback the last migration (down)
   */
  async down(): Promise<void> {
    const { _endMigration, _startMigration } = await import('./helpers/migration.helper');

    const state = await this.options.stateStore.loadAsync();
    const completedMigrations = state.migrations || [];

    if (completedMigrations.length === 0) {
      console.log('No migrations to rollback');
      return;
    }

    const lastMigration = completedMigrations[completedMigrations.length - 1];
    const allMigrations = await this.loadMigrationFiles();
    const migrationToRollback = allMigrations.find((m) => migrationId(m.title) === migrationId(lastMigration.title));

    if (!migrationToRollback) {
      if (this.options.strict) {
        throw new Error(`Migration file not found: ${lastMigration.title}`);
      }
      console.warn(
        `[migrate] last recorded migration "${lastMigration.title}" has no file — cannot roll back (strict=false); leaving state unchanged.`,
      );
      return;
    }

    if (!migrationToRollback.down) {
      throw new Error(`Migration ${lastMigration.title} has no 'down' function`);
    }

    console.log(`Rolling back migration: ${migrationToRollback.title}`);

    // Mark start of migration for auto-cleanup
    _startMigration();

    try {
      await migrationToRollback.down();

      // Update state
      const newMigrations = completedMigrations.slice(0, -1);
      await this.options.stateStore.saveAsync({
        lastRun: newMigrations.length > 0 ? newMigrations[newMigrations.length - 1].title : undefined,
        migrations: newMigrations,
        up: () => {},
      } as any);

      console.log(`✓ Migration rolled back: ${migrationToRollback.title}`);
    } finally {
      // Always close connections, even on error
      await _endMigration();
    }
  }

  /**
   * Get migration status
   */
  async status(): Promise<{
    completed: string[];
    pending: string[];
  }> {
    const allMigrations = await this.loadMigrationFiles();
    const state = await this.options.stateStore.loadAsync();
    const completedMigrations = (state.migrations || []).map((m) => m.title);
    const completedIds = new Set(completedMigrations.map(migrationId));

    return {
      completed: completedMigrations,
      pending: allMigrations.filter((m) => !completedIds.has(migrationId(m.title))).map((m) => m.title),
    };
  }

  /**
   * Create a new migration file
   */
  static async create(migrationsDirectory: string, name: string): Promise<string> {
    const timestamp = Date.now();
    const fileName = `${timestamp}-${name}.ts`;
    const filePath = path.join(migrationsDirectory, fileName);

    const template = `/**
 * Migration: ${name}
 * Created: ${new Date().toISOString()}
 */

export const up = async () => {
  // TODO: Implement migration
  console.log('Running migration: ${name}');
};

export const down = async () => {
  // TODO: Implement rollback
  console.log('Rolling back migration: ${name}');
};
`;

    fs.writeFileSync(filePath, template, 'utf-8');
    console.log(`✓ Created migration: ${fileName}`);

    return filePath;
  }
}
