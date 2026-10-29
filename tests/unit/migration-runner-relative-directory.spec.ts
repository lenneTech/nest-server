/**
 * Unit Tests: MigrationRunner and synchronizedUp() accept a migrations directory relative to the working directory
 * (DEV-3897)
 *
 * The runner loads every file with `require(path.join(dir, file))`, and `path.join('./migrations', file)` normalises
 * to `migrations/<file>` — which `require()` reads as the name of a package in `node_modules`. The CLI and the Hub
 * resolve the directory before they build a runner; a programmatic caller using the documented `'./migrations'` got
 * `MODULE_NOT_FOUND` as soon as one migration existed.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { MigrationSet, MigrationStateStore } from '../../src/core/modules/migrate/migration-state-store.interface';

import { MigrationRunner, synchronizedUp } from '../../src/core/modules/migrate/migration-runner';

/** State store stub with its own lock, capturing every save */
function fakeStore(): { saves: MigrationSet[]; store: MigrationStateStore } {
  const saves: MigrationSet[] = [];
  const store = {
    load: () => undefined,
    loadAsync: async () => ({ migrations: [], up: () => {} }),
    save: () => undefined,
    saveAsync: async (set: MigrationSet) => {
      saves.push(set);
    },
    withLock: <T>(fn: () => Promise<T>) => fn(),
  } as unknown as MigrationStateStore;
  return { saves, store };
}

describe('MigrationRunner with a directory relative to the working directory', () => {
  let workDir: string;

  beforeEach(() => {
    // See migration-runner-identity.spec.ts: console output crosses the worker RPC channel. Spied, not silenced globally.
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'migrate-relative-'));
    fs.mkdirSync(path.join(workDir, 'migrations'));
    fs.writeFileSync(
      path.join(workDir, 'migrations', '1699000000001-relative.js'),
      'module.exports.up = async () => undefined;\n',
    );
    vi.spyOn(process, 'cwd').mockReturnValue(workDir);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    fs.rmSync(workDir, { force: true, recursive: true });
  });

  /**
   * @regression   DEV-3897 review — the runner handed a relative directory to `require()` unresolved, so
   *   `migrationsDirectory: './migrations'` (the spelling the README, the JSDoc and synchronizedUp() show) threw
   *   MODULE_NOT_FOUND for every migration file.
   * @seen-failing Drop the path.resolve() of migrationsDirectory in the MigrationRunner constructor in
   *   src/core/modules/migrate/migration-runner.ts — registered as mutation `migration-runner-relative-directory` in
   *   tests/regression-mutations.json.
   */
  it('runs the migrations of `./migrations`', async () => {
    const { saves, store } = fakeStore();

    await new MigrationRunner({ migrationsDirectory: './migrations', stateStore: store }).up();

    expect(saves.map((set) => set.lastRun)).toEqual(['1699000000001-relative.js']);
  });

  it('synchronizedUp() runs them from an explicit relative directory and from its default', async () => {
    const explicit = fakeStore();
    await synchronizedUp({ migrationsDirectory: './migrations', stateStore: explicit.store });
    expect(explicit.saves.map((set) => set.lastRun)).toEqual(['1699000000001-relative.js']);

    const byDefault = fakeStore();
    await synchronizedUp({ stateStore: byDefault.store });
    expect(byDefault.saves.map((set) => set.lastRun)).toEqual(['1699000000001-relative.js']);
  });
});
