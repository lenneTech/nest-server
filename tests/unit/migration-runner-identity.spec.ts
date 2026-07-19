/**
 * Unit Tests: MigrationRunner identity + missing-file tolerance
 *
 * Two safety properties for the ts-node → compiled-JS production transition:
 *
 *  1. Extension-agnostic identity — a migration recorded under its `.ts` name (how it
 *     ran via ts-node) must NOT be re-run once the prod image ships the compiled `.js`.
 *     Keying state by raw filename would treat `foo.js` as a new migration against a
 *     `foo.ts` state and re-run already-applied, non-idempotent migrations (data loss).
 *
 *  2. Missing files are tolerated by default — deleting an old, already-applied
 *     migration file (they live in git and can be restored) must not crash the boot.
 *     `strict` opts back into hard integrity enforcement.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { MongoStateStore } from '../../src/core/modules/migrate/mongo-state-store';

import { MigrationRunner, migrationId } from '../../src/core/modules/migrate/migration-runner';

/** State store stub: serves a fixed recorded set, swallows saves. */
function fakeStore(recorded: { title: string }[]): MongoStateStore {
  return {
    loadAsync: async () => ({ migrations: recorded }),
    saveAsync: async () => undefined,
  } as unknown as MongoStateStore;
}

describe('migrationId', () => {
  it('strips the .ts / .js extension so identity survives the transpile → compile switch', () => {
    expect(migrationId('1699000000000-foo.ts')).toBe('1699000000000-foo');
    expect(migrationId('1699000000000-foo.js')).toBe('1699000000000-foo');
    expect(migrationId('1699000000000-foo')).toBe('1699000000000-foo');
  });
});

describe('MigrationRunner', () => {
  let dir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'migrate-runner-'));
  });

  afterEach(() => {
    fs.rmSync(dir, { force: true, recursive: true });
  });

  it('does not mark a compiled .js migration pending when it is recorded under its .ts name', async () => {
    fs.writeFileSync(path.join(dir, '1699000000000-foo.js'), 'module.exports.up = async () => {};\n');
    const runner = new MigrationRunner({
      migrationsDirectory: dir,
      stateStore: fakeStore([{ title: '1699000000000-foo.ts' }]),
    });

    const status = await runner.status();

    expect(status.pending).toEqual([]);
    expect(status.completed).toEqual(['1699000000000-foo.ts']);
  });

  it('up() tolerates a recorded migration whose file was deleted (default, strict=false)', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    // Empty migrations dir → the recorded migration's file is gone.
    const runner = new MigrationRunner({
      migrationsDirectory: dir,
      stateStore: fakeStore([{ title: '1699000000000-deleted.ts' }]),
    });

    await expect(runner.up()).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('missing'));
    warn.mockRestore();
  });

  it('up() fails on a missing migration file when strict=true', async () => {
    const runner = new MigrationRunner({
      migrationsDirectory: dir,
      stateStore: fakeStore([{ title: '1699000000000-deleted.ts' }]),
      strict: true,
    });

    await expect(runner.up()).rejects.toThrow(/missing/i);
  });
});
