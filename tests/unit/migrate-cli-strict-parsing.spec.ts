/**
 * Unit Tests: migrate CLI argument parsing — the --strict flag and its
 * NSC__MIGRATE__STRICT environment default.
 *
 * parseArgs is exported for testing only (same pattern as resolveCliPath in
 * bin/migrate.js): the CLI runs main() solely behind a require.main guard, so
 * importing the module here is side-effect-free.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { parseArgs } from '../../src/core/modules/migrate/cli/migrate-cli';

const savedArgv = process.argv;
const savedStrictEnv = process.env.NSC__MIGRATE__STRICT;

function withArgs(...args: string[]): void {
  process.argv = ['node', 'migrate', ...args];
}

beforeEach(() => {
  delete process.env.NSC__MIGRATE__STRICT;
});

afterEach(() => {
  process.argv = savedArgv;
  if (savedStrictEnv === undefined) {
    delete process.env.NSC__MIGRATE__STRICT;
  } else {
    process.env.NSC__MIGRATE__STRICT = savedStrictEnv;
  }
});

describe('parseArgs — strict resolution', () => {
  it('defaults to strict=false when neither --strict nor NSC__MIGRATE__STRICT is set', () => {
    withArgs('up', '--store', './migrate.js');

    const { command, options } = parseArgs();

    expect(command).toBe('up');
    expect(options.strict).toBe(false);
    expect(options.migrationsDir).toBe('./migrations');
  });

  it('enables strict via the --strict flag', () => {
    withArgs('up', '--strict');

    expect(parseArgs().options.strict).toBe(true);
  });

  it.each(['1', 'true', 'yes', 'TRUE'])('enables strict via NSC__MIGRATE__STRICT=%s', (value) => {
    process.env.NSC__MIGRATE__STRICT = value;
    withArgs('up');

    expect(parseArgs().options.strict).toBe(true);
  });

  it.each(['', '0', 'false', 'no'])('stays tolerant for NSC__MIGRATE__STRICT=%j', (value) => {
    process.env.NSC__MIGRATE__STRICT = value;
    withArgs('up');

    expect(parseArgs().options.strict).toBe(false);
  });

  it('lets --strict win over a falsy environment value', () => {
    process.env.NSC__MIGRATE__STRICT = '0';
    withArgs('down', '--strict');

    const { command, options } = parseArgs();

    expect(command).toBe('down');
    expect(options.strict).toBe(true);
  });

  it('keeps parsing the surrounding options untouched', () => {
    withArgs('list', '--strict', '--migrations-dir', './db/migrations', '--store', './store.js');

    const { command, name, options } = parseArgs();

    expect(command).toBe('list');
    expect(name).toBeUndefined();
    expect(options).toEqual({
      migrationsDir: './db/migrations',
      store: './store.js',
      strict: true,
    });
  });
});
