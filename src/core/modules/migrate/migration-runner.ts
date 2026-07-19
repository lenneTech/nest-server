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
 * Matches the trailing `.ts`/`.js` extension stripped by {@link migrationId}.
 * Hoisted to module level so `migrationId` allocates no per-call RegExp wrapper.
 */
const MIGRATION_EXTENSION_PATTERN = /\.(ts|js)$/;

/**
 * Migration identity = the timestamped file stem WITHOUT its `.ts`/`.js` extension.
 *
 * A migration keeps its identity when a project switches its production image from
 * ts-node (`1699-foo.ts`) to compiled JavaScript (`1699-foo.js`) — the recommended
 * prod setup, since the image prunes ts-node. Comparing raw filenames would make
 * every compiled `.js` migration look "pending" against a state recorded under `.ts`
 * names and re-run already-applied migrations (data corruption on existing DBs).
 * Normalising both sides makes the transition safe with no state rewrite.
 *
 * @param title Migration title, usually the filename (e.g. `1699000000000-foo.ts`)
 * @returns The extension-agnostic identity (e.g. `1699000000000-foo`)
 * @example
 * migrationId('1699000000000-foo.ts'); // '1699000000000-foo'
 * migrationId('1699000000000-foo.js'); // '1699000000000-foo'
 * migrationId('1699000000000-foo');    // '1699000000000-foo' (already extensionless)
 */
export function migrationId(title: string): string {
  return title.replace(MIGRATION_EXTENSION_PATTERN, '');
}

/**
 * Parse the `NSC__MIGRATE__STRICT` environment variable into a boolean.
 *
 * Truthy values: `1`, `true`, `yes` (case-insensitive, surrounding whitespace ignored —
 * a real risk with Docker/compose env files). Every other value means `false` (tolerate,
 * the safe default); non-empty unrecognized values additionally emit a warning so a typo
 * like `NSC__MIGRATE__STRICT=on` does not silently disable the control the operator
 * intended to enable.
 *
 * Shared by the CLI (`migrate-cli.ts`) and the {@link MigrationRunner} constructor, so
 * the env var behaves identically for CLI and programmatic runners.
 */
export function parseStrictEnv(value: string | undefined = process.env.NSC__MIGRATE__STRICT): boolean {
  if (value === undefined) {
    return false;
  }
  const normalized = value.trim().toLowerCase();
  if (['1', 'true', 'yes'].includes(normalized)) {
    return true;
  }
  if (normalized !== '' && !['0', 'false', 'no'].includes(normalized)) {
    console.warn(`[migrate] Unrecognized NSC__MIGRATE__STRICT value "${value}" — treating as false (tolerate).`);
  }
  return false;
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
   * Default: resolved from the `NSC__MIGRATE__STRICT` environment variable (see
   * {@link parseStrictEnv}), falling back to `false` (tolerate) — recorded migrations
   * whose files were deleted are ignored: `up()` skips them (with a warning) and the
   * server still starts. Migrations are tracked in git and can be restored, so old
   * migration files can be pruned without blocking boot. Set `true` to enforce
   * state/disk integrity (missing file → error in `up()` and `migrate list`).
   *
   * Applies to `up()` and `status()`/`migrate list` only — `down()` ALWAYS fails hard
   * on a missing rollback file, because rollback is an explicit operator action and
   * never a boot path (an exit 0 with no rollback performed would mislead scripts).
   *
   * @see `--strict` CLI flag and `NSC__MIGRATE__STRICT` env var in `cli/migrate-cli.ts`
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
    // Resolve the strict default from the environment so NSC__MIGRATE__STRICT works
    // identically for programmatic runners and the CLI (which parses it itself).
    this.options = { ...options, strict: options.strict ?? parseStrictEnv() };
    this.pattern = options.pattern || DEFAULT_MIGRATION_FILE_PATTERN;
  }

  /**
   * Load all migration files from the migrations directory
   *
   * Files are deduplicated by {@link migrationId}: when both `foo.ts` and `foo.js`
   * are present (overlapping `outDir`, source + build output copied into one image),
   * they are ONE migration — loading both would execute it twice in a single `up()`
   * run (the exact double-execution the identity concept exists to prevent). The
   * `.js` file wins deterministically (`.js` sorts before `.ts`), matching the
   * compiled-production intent; the duplicate is skipped with a warning.
   */
  private async loadMigrationFiles(): Promise<MigrationFile[]> {
    const files = fs
      .readdirSync(this.options.migrationsDirectory)
      .filter((file) => this.pattern.test(file))
      .sort(); // Sort alphabetically (timestamp-based filenames will be in order)

    const migrations: MigrationFile[] = [];
    const seenIds = new Set<string>();

    for (const file of files) {
      const id = migrationId(file);
      if (seenIds.has(id)) {
        console.warn(
          `[migrate] duplicate files for migration "${id}" — skipping ${file} (a same-named file was already loaded)`,
        );
        continue;
      }

      const filePath = path.join(this.options.migrationsDirectory, file);

      const module = require(filePath);

      if (!module.up) {
        console.warn(`Migration ${file} has no 'up' function, skipping...`);
        continue;
      }

      // Extract timestamp from filename (format: TIMESTAMP-name.js)
      const timestampMatch = file.match(/^(\d+)-/);
      const timestamp = timestampMatch ? parseInt(timestampMatch[1], 10) : Date.now();

      seenIds.add(id);
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
    const rollbackId = migrationId(lastMigration.title);
    const migrationToRollback = allMigrations.find((m) => migrationId(m.title) === rollbackId);

    if (!migrationToRollback) {
      // Always a hard error, independent of `strict`: down() is an explicit operator
      // action and never a boot path — the boot-tolerance rationale does not apply,
      // and an exit 0 with no rollback performed would mislead scripted rollbacks.
      throw new Error(`Migration file not found: ${lastMigration.title} — restore the file from git to roll back.`);
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
   *
   * `missing` lists recorded migrations whose file is gone from disk (identity-based,
   * so a `.ts`-recorded migration with a compiled `.js` on disk is NOT missing) — the
   * same integrity drift `up()` warns about, surfaced here so `migrate list` can show
   * it before a deploy or file pruning.
   */
  async status(): Promise<{
    completed: string[];
    missing: string[];
    pending: string[];
  }> {
    const allMigrations = await this.loadMigrationFiles();
    const state = await this.options.stateStore.loadAsync();
    const completedMigrations = (state.migrations || []).map((m) => m.title);
    const completedIds = new Set(completedMigrations.map(migrationId));
    const presentIds = new Set(allMigrations.map((m) => migrationId(m.title)));

    return {
      completed: completedMigrations,
      missing: completedMigrations.filter((title) => !presentIds.has(migrationId(title))),
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
