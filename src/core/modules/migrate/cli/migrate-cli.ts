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
 */

/* eslint-disable no-console */
// Console output is required for CLI functionality

import * as fs from 'fs';
import * as path from 'path';

import { MigrationRunner } from '../migration-runner';
import { MongoStateStore } from '../mongo-state-store';

interface CliOptions {
  compiler?: string;
  migrationsDir: string;
  store?: string;
  templateFile?: string;
}

/**
 * Create a new migration file
 */
async function createMigration(name: string, options: CliOptions) {
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
  if (options.templateFile) {
    const templatePath = path.resolve(process.cwd(), options.templateFile);
    template = fs.readFileSync(templatePath, 'utf-8');
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
  });

  const status = await runner.status();

  console.log('\nMigration Status:');
  console.log('=================\n');

  if (status.completed.length > 0) {
    console.log('Completed:');
    status.completed.forEach((name) => {
      console.log(`  ✓ ${name}`);
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
}

/**
 * Load state store from module
 */
function loadStateStore(storePath: string | undefined): MongoStateStore {
  if (!storePath) {
    throw new Error('--store option is required for up/down/list commands');
  }

  const absolutePath = path.resolve(process.cwd(), storePath);

  const StoreClass = require(absolutePath);

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

    const register = require(absolutePath);
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

Examples:
  migrate create add-user-email
  migrate create add-user-email --template-file ./migrations-utils/template.ts
  migrate up --store ./migrations-utils/migrate.js --migrations-dir ./migrations
  migrate down --store ./migrations-utils/migrate.js
  migrate list --store ./migrations-utils/migrate.js

Environment Variables:
  NODE_ENV                           Set environment (e.g., development, production)
`);
}

// Run CLI if executed directly
if (require.main === module) {
  main().catch((error) => {
    console.error('Fatal error:', error);
    process.exit(1);
  });
}

export { main };
