
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
 * Migration runner configuration
 */
export interface MigrationRunnerOptions {
  /** Directory containing migration files */
  migrationsDirectory: string;
  /** Pattern to match migration files (default: *.ts, *.js) */
  pattern?: RegExp;
  /** State store for tracking migrations */
  stateStore: MongoStateStore;
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
    this.pattern = options.pattern || /\.(ts|js)$/;
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
    const completedMigrations = (state.migrations || []).map((m) => m.title);

    const pendingMigrations = allMigrations.filter((m) => !completedMigrations.includes(m.title));

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
    const migrationToRollback = allMigrations.find((m) => m.title === lastMigration.title);

    if (!migrationToRollback) {
      throw new Error(`Migration file not found: ${lastMigration.title}`);
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

    return {
      completed: completedMigrations,
      pending: allMigrations.filter((m) => !completedMigrations.includes(m.title)).map((m) => m.title),
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
