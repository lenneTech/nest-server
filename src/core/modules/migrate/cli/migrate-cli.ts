#!/usr/bin/env node

/**
 * Migration CLI - Compatible with `migrate` package CLI
 *
 * This provides a drop-in replacement for the `migrate` CLI without requiring
 * the external `migrate` package as a dependency.
 *
 * Usage (same as migrate package):
 *   migrate create <name> [options]
 *   migrate up [name] [options]
 *   migrate down [name] [options]
 *   migrate list [options]
 *
 * Options:
 *   --migrations-dir, -d    Directory containing migrations (default: ./migrations)
 *   --store, -s            Path to state store module
 *   --compiler, -c         Compiler to use (e.g., ts:./path/to/ts-compiler.js)
 *   --template-file, -t    Template file for creating migrations
 *   --sql                  Create a SQL migration (statements run as the table owner, see runSqlMigration)
 *   --strict               Fail if a recorded migration's file is missing (default: off / tolerate).
 *                          Applies to up/list; down always fails hard on a missing rollback file.
 */

import * as fs from 'fs';
import * as path from 'path';

import { MigrationRunner, parseStrictEnv } from '../migration-runner.js';
import type { MigrationStateStore } from '../migration-state-store.interface.js';
import { createRequire } from 'node:module';
import { callerDirectory } from '../../../common/helpers/module-location.helper.js';

/**
 * Loads a file the CLI was pointed at (store, `--compiler`) by absolute path. `createRequire` instead of `require`:
 * the core's source is valid as CommonJS and as ESM, and only the former has a `require` in scope.
 */
function requireFromProject(absolutePath: string): any {
  return createRequire(path.join(process.cwd(), 'package.json'))(absolutePath);
}

interface CliOptions {
  compiler?: string;
  migrationsDir: string;
  store?: string;
  strict?: boolean;
  /** `create`: a SQL migration instead of the default template */
  sql?: boolean;
  templateFile?: string;
}

const FRAMEWORK_PACKAGE = '@lenne.tech/nest-server';

/**
 * The import specifier a migration created in `migrationsDir` must use for the framework's helpers.
 *
 * The shipped template imports `getDb` / `uploadFileToGridFS` from `@lenne.tech/nest-server`. A
 * vendor-mode project has no such package — its core lives in `src/core/` — so a migration created
 * from the unchanged template fails with TS2307 in the IDE and `tsc`, and with MODULE_NOT_FOUND at run time.
 * Returns the relative path from the migrations directory to the vendored core when the package does
 * not resolve from `cwd` AND this CLI runs from a vendored core (one with its own `index` next to
 * `modules/`, as the vendor flatten-fix leaves it); otherwise `undefined`, i.e. keep the package name.
 * In npm mode the package resolves, and in this framework repo `src/core/` has no `index`, so neither
 * is rewritten.
 *
 * @param migrationsDir - Directory the migration is written to, absolute or relative to `cwd`
 * @param cwd - Project directory the package is resolved from
 * @param coreRoot - Root of the core this CLI belongs to
 */
export function vendoredFrameworkSpecifier(
  migrationsDir: string,
  cwd: string = process.cwd(),
  coreRoot: string = path.resolve(callerDirectory(), '..', '..', '..'),
): string | undefined {
  try {
    createRequire(path.join(cwd, 'package.json')).resolve(FRAMEWORK_PACKAGE);
    return undefined;
  } catch {
    // Not installed — the vendor-mode case, if the core below has an entry point of its own.
  }
  if (!['index.ts', 'index.js'].some((entry) => fs.existsSync(path.join(coreRoot, entry)))) {
    return undefined;
  }
  const relativePath = path.relative(path.resolve(cwd, migrationsDir), coreRoot).split(path.sep).join('/');
  return relativePath.startsWith('.') ? relativePath : `./${relativePath}`;
}

/**
 * Replaces the exact `@lenne.tech/nest-server` specifier (`from '…'`, `require('…')`, single or double
 * quotes) in a migration template. Subpaths of the package are left alone.
 */
export function rewriteFrameworkSpecifier(template: string, specifier: string): string {
  return template.replace(
    /(['"])@lenne\.tech\/nest-server\1/g,
    (_match, quote: string) => `${quote}${specifier}${quote}`,
  );
}

/**
 * Create a new migration file
 *
 * @param coreRoot - Root of the core this CLI belongs to; defaults to the one it runs from (tests only)
 */
/**
 * The template of `migrate create <name> --sql`: the statements a refused boot suggested go into `up` after review,
 * their reverse into `down`. They run as the table owner (`NSC__DATABASE__OWNER_URL`, i.e. `database.ownerUrl`).
 * `specifier`: the import path a vendor-mode project uses instead of the package name.
 */
export function sqlMigrationTemplate(name: string, specifier?: string): string {
  const template = `/**
 * Migration: ${name} (SQL)
 * Created: ${new Date().toISOString()}
 *
 * Paste the statements the boot suggested (SchemaMigrationRequiredError) and REVIEW them: a narrowed type, a new
 * unique index or a rename collision can reject or rewrite stored rows. They run as the table owner, in one
 * transaction, under the lock the boot's schema migration takes.
 */
import { runSqlMigration } from '@lenne.tech/nest-server';

const ownerUrl = process.env.NSC__DATABASE__OWNER_URL ?? '';

export const up = async () => {
  await runSqlMigration(ownerUrl, [
    // 'ALTER TABLE "projects" ALTER COLUMN "budget" TYPE text COLLATE "C" USING "budget"::text',
  ]);
};

export const down = async () => {
  await runSqlMigration(ownerUrl, [
    // the reverse of every statement in up
  ]);
};
`;
  return specifier ? rewriteFrameworkSpecifier(template, specifier) : template;
}

async function createMigration(name: string, options: CliOptions, coreRoot?: string) {
  if (!name) {
    console.error('Error: Migration name is required');
    console.log('Usage: migrate create <name> [options]');
    process.exit(1);
  }

  const timestamp = Date.now();
  const fileName = `${timestamp}-${name}.ts`;
  const filePath = path.join(options.migrationsDir, fileName);

  // Create migrations directory if it doesn't exist
  if (!fs.existsSync(options.migrationsDir)) {
    fs.mkdirSync(options.migrationsDir, { recursive: true });
  }

  let template: string;

  // Use custom template if provided
  if (options.sql) {
    template = sqlMigrationTemplate(name, vendoredFrameworkSpecifier(options.migrationsDir, process.cwd(), coreRoot));
  } else if (options.templateFile) {
    const templatePath = path.resolve(process.cwd(), options.templateFile);
    template = fs.readFileSync(templatePath, 'utf-8');
    const specifier = vendoredFrameworkSpecifier(options.migrationsDir, process.cwd(), coreRoot);
    if (specifier) {
      template = rewriteFrameworkSpecifier(template, specifier);
    }
  } else {
    // Default template
    template = `/**
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
  }

  fs.writeFileSync(filePath, template, 'utf-8');
  console.log(`Created migration: ${fileName}`);
}

/**
 * List migration status
 */
async function listMigrations(options: CliOptions) {
  registerCompiler(options.compiler);
  const stateStore = loadStateStore(options.store);

  const runner = new MigrationRunner({
    migrationsDirectory: path.resolve(process.cwd(), options.migrationsDir),
    stateStore,
    strict: options.strict,
  });

  const status = await runner.status();
  const missing = new Set(status.missing);

  console.log('\nMigration Status:');
  console.log('=================\n');

  if (status.completed.length > 0) {
    console.log('Completed:');
    status.completed.forEach((name) => {
      console.log(`  ✓ ${name}${missing.has(name) ? '  (file missing)' : ''}`);
    });
    console.log('');
  }

  if (status.pending.length > 0) {
    console.log('Pending:');
    status.pending.forEach((name) => {
      console.log(`  ⋯ ${name}`);
    });
    console.log('');
  }

  if (status.completed.length === 0 && status.pending.length === 0) {
    console.log('No migrations found\n');
  }

  // In strict mode, integrity drift is an error also on the inspection surface —
  // exit non-zero (via main's error handler) instead of hiding it in the listing.
  if (options.strict && status.missing.length > 0) {
    throw new Error(
      `Strict mode: ${status.missing.length} recorded migration file(s) missing: ${status.missing.join(', ')}`,
    );
  }
}

/**
 * Load state store from module
 */
function loadStateStore(storePath: string | undefined): MigrationStateStore {
  if (!storePath) {
    throw new Error('--store option is required for up/down/list commands');
  }

  const absolutePath = path.resolve(process.cwd(), storePath);

  const StoreClass = requireFromProject(absolutePath);

  // Handle different export patterns
  if (StoreClass.default) {
    return new StoreClass.default();
  } else if (typeof StoreClass === 'function') {
    return new StoreClass();
  } else {
    throw new Error(`Invalid state store module at ${storePath}`);
  }
}

/**
 * Main CLI entry point
 */
async function main() {
  const { command, name, options } = parseArgs();

  try {
    switch (command) {
      case '--help':

      case '-h':

      case 'help':
        showHelp();
        break;

      case 'create':
        await createMigration(name!, options);
        break;
      case 'down':
        await runDown(options);
        break;

      case 'list':
      case 'status':
        await listMigrations(options);
        break;
      case 'up':
        await runUp(options);
        break;

      default:
        if (!command) {
          showHelp();
        } else {
          console.error(`Unknown command: ${command}`);
          console.log('Run "migrate --help" for usage information');
          process.exit(1);
        }
    }
  } catch (error) {
    console.error('Error:', (error as Error).message);
    if (process.env.DEBUG) {
      console.error((error as Error).stack);
    }
    process.exit(1);
  }
}

/**
 * Parse command line arguments
 */
function parseArgs(): { command: string; name?: string; options: CliOptions } {
  const args = process.argv.slice(2);
  const command = args[0];
  let name: string | undefined;
  const options: CliOptions = {
    migrationsDir: './migrations',
    // Off by default: a recorded migration whose file was deleted is tolerated so the
    // server still starts. Enable per-run via `--strict` or globally via NSC__MIGRATE__STRICT.
    strict: parseStrictEnv(),
  };

  // Check if second arg is a name (not a flag)
  if (args[1] && !args[1].startsWith('-')) {
    name = args[1];
  }

  // Parse flags
  for (let i = 1; i < args.length; i++) {
    const arg = args[i];

    if (arg === '--migrations-dir' || arg === '-d') {
      options.migrationsDir = args[++i];
    } else if (arg === '--store' || arg === '-s') {
      options.store = args[++i];
    } else if (arg === '--compiler' || arg === '-c') {
      options.compiler = args[++i];
    } else if (arg === '--template-file' || arg === '-t') {
      options.templateFile = args[++i];
    } else if (arg === '--strict') {
      options.strict = true;
    } else if (arg === '--sql') {
      options.sql = true;
    }
  }

  return { command, name, options };
}

/**
 * Register TypeScript compiler if specified
 */
function registerCompiler(compiler: string | undefined) {
  if (!compiler) {
    return;
  }

  // Format: "ts:./path/to/compiler.js"
  const [type, compilerPath] = compiler.split(':');

  if (type === 'ts' && compilerPath) {
    const absolutePath = path.resolve(process.cwd(), compilerPath);

    const register = requireFromProject(absolutePath);
    if (typeof register === 'function') {
      register();
    }
  }
}

/**
 * Run migrations down
 */
async function runDown(options: CliOptions) {
  registerCompiler(options.compiler);
  const stateStore = loadStateStore(options.store);

  const runner = new MigrationRunner({
    migrationsDirectory: path.resolve(process.cwd(), options.migrationsDir),
    stateStore,
    strict: options.strict,
  });

  await runner.down();
}

/**
 * Run migrations up
 */
async function runUp(options: CliOptions) {
  registerCompiler(options.compiler);
  const stateStore = loadStateStore(options.store);

  const runner = new MigrationRunner({
    migrationsDirectory: path.resolve(process.cwd(), options.migrationsDir),
    stateStore,
    strict: options.strict,
  });

  await runner.up();
}

/**
 * Show help
 */
function showHelp() {
  console.log(`
Migration CLI - Compatible with migrate package

Usage:
  migrate create <name> [options]    Create a new migration
  migrate up [options]               Run all pending migrations
  migrate down [options]             Rollback the last migration
  migrate list [options]             List migration status

Options:
  --migrations-dir, -d <path>        Directory containing migrations (default: ./migrations)
  --store, -s <path>                 Path to state store module
  --compiler, -c <compiler>          Compiler to use (e.g., ts:./path/to/ts-compiler.js)
  --template-file, -t <path>         Template file for creating migrations
  --strict                           Fail if a recorded migration's file is missing (default: off / tolerate).
                                     Applies to up/list; down always fails hard on a missing rollback file.

Examples:
  migrate create add-user-email
  migrate create add-user-email --template-file ./migrations-utils/template.ts
  migrate up --store ./migrations-utils/migrate.js --migrations-dir ./migrations
  migrate down --store ./migrations-utils/migrate.js
  migrate list --store ./migrations-utils/migrate.js

Environment Variables:
  NODE_ENV                           Set environment (e.g., development, production)
  NSC__MIGRATE__STRICT               1|true|yes → fail on a missing recorded migration file (default: tolerate)
`);
}

/**
 * Exit with `code`, but never before our own output has actually left the process.
 *
 * `process.exit()` does NOT drain stdout, and stdout is asynchronous whenever it
 * is a pipe — which is exactly the Docker / CI / `| tee` case. Exiting straight
 * after the completion log therefore discards the record of what this run did,
 * and the line at risk is the last one ("All migrations completed successfully"),
 * which is precisely what a CI step greps for. Measured: past the 64 KiB pipe
 * buffer everything beyond it is lost.
 *
 * `process.exitCode` is assigned first so that a future `exitCode = 1` elsewhere
 * is honoured rather than overwritten by a hardcoded 0. The timer is the safety
 * net for the opposite failure — a consumer that never reads — and is `unref`'d
 * so it cannot itself keep the process alive.
 */
const flushAndExit = async (code: number): Promise<void> => {
  process.exitCode = code;

  const guard = setTimeout(() => process.exit(code), 5000);
  guard.unref();

  await Promise.all(
    [process.stdout, process.stderr].map(
      (stream) =>
        new Promise<void>((resolve) => {
          if (!stream.writableLength) {
            resolve();
            return;
          }
          stream.write('', () => resolve());
        }),
    ),
  );

  clearTimeout(guard);
  process.exit(code);
};

/**
 * Run the CLI and terminate the process when it is done.
 *
 * This is the entry point the `migrate` / `nest-migrate` bin uses. It exists
 * separately from `main()` because the shell around it matters: migrations touch
 * MongoDB, GridFS and — via the state store — a second connection, and any handle
 * one of them leaves behind keeps Node alive forever. The CLI then prints
 * "All migrations completed successfully" and simply never returns: a CI job
 * blocks until its timeout, and a container entrypoint that runs migrations
 * before `exec`ing the server never reaches the server at all.
 *
 * Note this must NOT be guarded by `require.main === module`: the shipped
 * `bin/migrate.js` loads this module and calls in, so `require.main` is the shim,
 * never this file. A guard here would make the exit unreachable on every path
 * that actually ships.
 */
const runCli = async (): Promise<void> => {
  try {
    await main();
  } catch (error) {
    console.error('Fatal error:', error);
    await flushAndExit(1);
    return;
  }
  await flushAndExit(0);
};

// Run CLI if executed directly (`node migrate-cli.js`). The bin shim calls
// runCli() itself, so this only covers a direct invocation of the compiled file.
// `typeof` first: as ESM neither `require` nor `module` exists, and reading them would throw at load time.
if (typeof require !== 'undefined' && typeof module !== 'undefined' && require.main === module) {
  void runCli();
}

// parseArgs is exported for unit testing only (same pattern as resolveCliPath in bin/migrate.js)
export { createMigration, flushAndExit, main, parseArgs, runCli };
