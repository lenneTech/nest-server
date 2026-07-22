/**
 * Unit Tests: MigrationRunner tolerates a MISSING migrations directory (DEV-2634)
 *
 * A missing directory means the same thing as an empty one — there are no migrations — and
 * must behave identically instead of throwing ENOENT.
 *
 * Why this is a boot blocker and not a cosmetic error: the starter's `start` script is
 * `migrate:up && start:local`, so the `&&` turns a `readdirSync` ENOENT into a server that
 * never starts, with an error that does not point at the cause. And it is a state people
 * produce routinely — "delete all migrations" reads to most as "throw the folder away".
 *
 * The runner already tolerates the RELATED case (a migration recorded in the database whose
 * file is gone is non-fatal unless `NSC__MIGRATE__STRICT` is set). Only the wholly absent
 * directory fell outside that tolerance, which made the behaviour inconsistent.
 *
 * `down()` stays hard on purpose: rollback is an explicit operator action, never a boot path,
 * and an exit 0 with no rollback performed would mislead scripted rollbacks.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import type { MigrationSet, MongoStateStore } from '../../src/core/modules/migrate/mongo-state-store';

import { MigrationRunner } from '../../src/core/modules/migrate/migration-runner';

/** State store stub serving a fresh copy per load, capturing every save. */
function fakeStore(recorded: { timestamp?: number; title: string }[] = []): {
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

/** A path that is guaranteed not to exist. */
function missingDir(): string {
  return path.join(os.tmpdir(), `nest-server-migrations-absent-${process.pid}-${Math.trunc(performance.now())}`);
}

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

afterEach(() => {
  vi.restoreAllMocks();
});

describe('MigrationRunner with a missing migrations directory', () => {
  beforeEach(() => {
    // See migration-runner-identity.spec.ts: `console.log` output crosses the worker
    // RPC channel and can abort the run on teardown. Spied, not silenced globally.
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
  });

  it('up() resolves instead of throwing ENOENT', async () => {
    const dir = missingDir();
    expect(fs.existsSync(dir)).toBe(false);
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const { saves, store } = fakeStore();

    const runner = new MigrationRunner({ migrationsDirectory: dir, stateStore: store });

    await expect(runner.up()).resolves.not.toThrow();
    // Nothing ran, so nothing may be recorded — a phantom state entry would make a later,
    // restored migration silently "already applied".
    expect(saves).toEqual([]);
  });

  it('up() warns so the operator sees WHY nothing ran', async () => {
    const dir = missingDir();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const { store } = fakeStore();

    await new MigrationRunner({ migrationsDirectory: dir, stateStore: store }).up();

    expect(warn.mock.calls.flat().join(' ')).toContain('migrations directory not found');
  });

  it('status() reports an empty set rather than throwing', async () => {
    const dir = missingDir();
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const { store } = fakeStore();

    const status = await new MigrationRunner({ migrationsDirectory: dir, stateStore: store }).status();

    expect(status.pending).toEqual([]);
    expect(status.completed).toEqual([]);
  });

  it('behaves identically to an EMPTY directory — that is the whole point', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const emptyDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nest-server-migrations-empty-'));
    try {
      const fromEmpty = await new MigrationRunner({
        migrationsDirectory: emptyDir,
        stateStore: fakeStore().store,
      }).status();
      const fromMissing = await new MigrationRunner({
        migrationsDirectory: missingDir(),
        stateStore: fakeStore().store,
      }).status();

      expect(fromMissing.pending).toEqual(fromEmpty.pending);
      expect(fromMissing.completed).toEqual(fromEmpty.completed);
    } finally {
      fs.rmSync(emptyDir, { force: true, recursive: true });
    }
  });

  it('still reports a recorded-but-missing migration as missing, not as an error', async () => {
    // The pre-existing tolerance must keep working when the whole directory is gone, not just
    // when a single file is.
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const { store } = fakeStore([{ timestamp: 1_699_000_000_000, title: '1699000000000-foo.ts' }]);

    const status = await new MigrationRunner({ migrationsDirectory: missingDir(), stateStore: store }).status();

    expect(status.missing).toEqual(['1699000000000-foo.ts']);
  });

  it('strict mode still fails hard — tolerance is a default, not a removal of the guard', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const { store } = fakeStore([{ timestamp: 1_699_000_000_000, title: '1699000000000-foo.ts' }]);

    const runner = new MigrationRunner({ migrationsDirectory: missingDir(), stateStore: store, strict: true });

    await expect(runner.up()).rejects.toThrow();
  });
});
