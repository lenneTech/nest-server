/**
 * Unit Tests: MigrationRunner identity + missing-file tolerance
 *
 * Safety properties for the ts-node → compiled-JS production transition:
 *
 *  1. Extension-agnostic identity — a migration recorded under its `.ts` name (how it
 *     ran via ts-node) must NOT be re-run once the prod image ships the compiled `.js`.
 *     Keying state by raw filename would treat `foo.js` as a new migration against a
 *     `foo.ts` state and re-run already-applied, non-idempotent migrations (data loss).
 *     Co-present `foo.ts` + `foo.js` are ONE migration — only one file is loaded and
 *     executed per `up()` run (deduplicated by identity, `.js` wins).
 *
 *  2. Missing files are tolerated by default in `up()` — deleting an old, already-applied
 *     migration file (they live in git and can be restored) must not crash the boot.
 *     `strict` (option or NSC__MIGRATE__STRICT) opts back into hard integrity
 *     enforcement. `down()` ALWAYS fails hard on a missing rollback file — rollback is
 *     an explicit operator action, never a boot path, and an exit 0 with no rollback
 *     performed would mislead scripted rollbacks.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import type { MigrationSet, MongoStateStore } from '../../src/core/modules/migrate/mongo-state-store';

import { MigrationRunner, migrationId, parseStrictEnv } from '../../src/core/modules/migrate/migration-runner';

/**
 * State store stub: serves a FRESH copy of the recorded set per load (like a real DB
 * read) and captures every save, so tests can assert state changes — or their absence.
 */
function fakeStore(recorded: { timestamp?: number; title: string }[]): {
  saves: MigrationSet[];
  store: MongoStateStore;
} {
  const saves: MigrationSet[] = [];
  const store = {
    loadAsync: async () => ({ migrations: recorded.map((m) => ({ ...m })), up: () => {} }),
    saveAsync: async (set) => {
      saves.push(set);
    },
  } satisfies Pick<MongoStateStore, 'loadAsync' | 'saveAsync'> as unknown as MongoStateStore;
  return { saves, store };
}

/** Write a CJS migration fixture whose up/down append a marker line when executed. */
function writeMigration(dir: string, fileName: string, options?: { downMarker?: string; upMarker?: string }): void {
  const up = options?.upMarker
    ? `require('fs').appendFileSync(${JSON.stringify(options.upMarker)}, 'up\\n');`
    : '';
  const down = options?.downMarker
    ? `module.exports.down = async () => { require('fs').appendFileSync(${JSON.stringify(options.downMarker)}, 'down\\n'); };\n`
    : '';
  fs.writeFileSync(path.join(dir, fileName), `module.exports.up = async () => { ${up} };\n${down}`);
}

// The MigrationRunner constructor resolves its strict default from NSC__MIGRATE__STRICT —
// isolate the suite from whatever the invoking shell has set.
const savedStrictEnv = process.env.NSC__MIGRATE__STRICT;
beforeAll(() => {
  delete process.env.NSC__MIGRATE__STRICT;
});
afterAll(() => {
  if (savedStrictEnv === undefined) {
    delete process.env.NSC__MIGRATE__STRICT;
  } else {
    process.env.NSC__MIGRATE__STRICT = savedStrictEnv;
  }
});

// A failing assertion between spyOn and mockRestore must not leak a silenced console
// into the remaining tests of this fork (vitest.config.ts sets no restoreMocks).
afterEach(() => {
  vi.restoreAllMocks();
});

describe('migrationId', () => {
  it('strips the .ts / .js extension so identity survives the transpile → compile switch', () => {
    expect(migrationId('1699000000000-foo.ts')).toBe('1699000000000-foo');
    expect(migrationId('1699000000000-foo.js')).toBe('1699000000000-foo');
    expect(migrationId('1699000000000-foo')).toBe('1699000000000-foo');
  });
});

describe('parseStrictEnv', () => {
  it('accepts 1/true/yes case-insensitively and ignores surrounding whitespace', () => {
    expect(parseStrictEnv('1')).toBe(true);
    expect(parseStrictEnv('true')).toBe(true);
    expect(parseStrictEnv('TRUE')).toBe(true);
    expect(parseStrictEnv('yes')).toBe(true);
    expect(parseStrictEnv(' true ')).toBe(true);
  });

  it('treats unset, empty, and recognized falsy values as false without warning', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    expect(parseStrictEnv(undefined)).toBe(false);
    expect(parseStrictEnv('')).toBe(false);
    expect(parseStrictEnv('0')).toBe(false);
    expect(parseStrictEnv('false')).toBe(false);
    expect(parseStrictEnv('no')).toBe(false);
    expect(warn).not.toHaveBeenCalled();
  });

  it('warns on non-empty unrecognized values and falls back to false (tolerate)', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    expect(parseStrictEnv('on')).toBe(false);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('Unrecognized NSC__MIGRATE__STRICT value "on"'));
  });
});

describe('MigrationRunner', () => {
  let dir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'migrate-runner-'));
    // The runner logs its progress via `console.log`. That output crosses the worker
    // RPC channel (`onUserConsoleLog`), and a call still pending when the worker is
    // torn down aborts the whole run with `EnvironmentTeardownError` — a red exit code
    // with zero failed tests. `Logger.overrideLogger` does not cover raw `console.*`.
    // (`restoreMocks: true` in vitest.config.ts restores this before the next test.)
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
  });

  afterEach(() => {
    fs.rmSync(dir, { force: true, recursive: true });
  });

  describe('status', () => {
    it('does not mark a compiled .js migration pending (or missing) when it is recorded under its .ts name', async () => {
      writeMigration(dir, '1699000000000-foo.js');
      const { store } = fakeStore([{ title: '1699000000000-foo.ts' }]);
      const runner = new MigrationRunner({ migrationsDirectory: dir, stateStore: store });

      const status = await runner.status();

      expect(status.pending).toEqual([]);
      expect(status.completed).toEqual(['1699000000000-foo.ts']);
      expect(status.missing).toEqual([]);
    });

    it('lists a recorded migration whose file was deleted in missing (completed keeps it, pending stays empty)', async () => {
      const { store } = fakeStore([{ title: '1699000000000-deleted.ts' }]);
      const runner = new MigrationRunner({ migrationsDirectory: dir, stateStore: store });

      const status = await runner.status();

      expect(status.completed).toEqual(['1699000000000-deleted.ts']);
      expect(status.missing).toEqual(['1699000000000-deleted.ts']);
      expect(status.pending).toEqual([]);
    });
  });

  describe('up', () => {
    it('does not re-run a compiled .js migration recorded under its .ts name', async () => {
      const marker = path.join(dir, 'up-executed.marker');
      writeMigration(dir, '1699000000000-foo.js', { upMarker: marker });
      const { saves, store } = fakeStore([{ title: '1699000000000-foo.ts' }]);
      const runner = new MigrationRunner({ migrationsDirectory: dir, stateStore: store });

      await expect(runner.up()).resolves.toBeUndefined();

      expect(fs.existsSync(marker)).toBe(false); // the migration body never ran
      expect(saves).toEqual([]); // no state written — nothing was pending
    });

    it('runs co-present .ts and .js files of one migration exactly once (dedupe by identity, .js wins)', async () => {
      const marker = path.join(dir, 'run-count.marker');
      writeMigration(dir, '1699000000000-foo.js', { upMarker: marker });
      writeMigration(dir, '1699000000000-foo.ts', { upMarker: marker });
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
      const { saves, store } = fakeStore([]);
      const runner = new MigrationRunner({ migrationsDirectory: dir, stateStore: store });

      await expect(runner.up()).resolves.toBeUndefined();

      expect(fs.readFileSync(marker, 'utf-8')).toBe('up\n'); // exactly one execution
      expect(saves).toHaveLength(1);
      expect(saves[0].migrations.map((m) => m.title)).toEqual(['1699000000000-foo.js']);
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('duplicate files for migration "1699000000000-foo"'));
    });

    it('tolerates a recorded migration whose file was deleted (default, strict=false) and leaves state untouched', async () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
      // Empty migrations dir → the recorded migration's file is gone.
      const { saves, store } = fakeStore([{ title: '1699000000000-deleted.ts' }]);
      const runner = new MigrationRunner({ migrationsDirectory: dir, stateStore: store });

      await expect(runner.up()).resolves.toBeUndefined();
      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining(
          '1 recorded migration file(s) missing — tolerated (strict=false): 1699000000000-deleted.ts',
        ),
      );
      expect(saves).toEqual([]); // state untouched
    });

    it('fails on a missing migration file when strict=true, naming count and file', async () => {
      const { store } = fakeStore([{ title: '1699000000000-deleted.ts' }]);
      const runner = new MigrationRunner({ migrationsDirectory: dir, stateStore: store, strict: true });

      await expect(runner.up()).rejects.toThrow(
        /Strict mode: 1 recorded migration file\(s\) missing: 1699000000000-deleted\.ts/,
      );
    });
  });

  describe('down', () => {
    it('rolls back a migration recorded under its .ts name via the compiled .js file', async () => {
      const marker = path.join(dir, 'down-executed.marker');
      writeMigration(dir, '1699000000000-foo.js', { downMarker: marker });
      const { saves, store } = fakeStore([{ title: '1699000000000-foo.ts' }]);
      const runner = new MigrationRunner({ migrationsDirectory: dir, stateStore: store });

      await expect(runner.down()).resolves.toBeUndefined();

      expect(fs.readFileSync(marker, 'utf-8')).toBe('down\n'); // rollback body ran
      expect(saves).toHaveLength(1);
      expect(saves[0].migrations).toEqual([]); // popped from state
    });

    it('always fails hard when the last recorded migration has no file — regardless of strict', async () => {
      const recorded = [{ title: '1699000000000-deleted.ts' }];
      const expected = /Migration file not found: 1699000000000-deleted\.ts — restore the file from git/;

      const tolerant = new MigrationRunner({ migrationsDirectory: dir, stateStore: fakeStore(recorded).store });
      await expect(tolerant.down()).rejects.toThrow(expected);

      const explicitlyTolerant = new MigrationRunner({
        migrationsDirectory: dir,
        stateStore: fakeStore(recorded).store,
        strict: false,
      });
      await expect(explicitlyTolerant.down()).rejects.toThrow(expected);
    });
  });
});
