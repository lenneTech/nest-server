/**
 * Unit Tests: MigrationRunner reads and writes the migration state INSIDE the lock — for
 * `up()` AND `down()`.
 *
 * The lock itself (acquire, heartbeat, stale-lock breaking) is exercised against a real
 * MongoDB in tests/migrate/mongo-state-store.e2e-spec.ts. What this file pins is the runner's
 * side of the contract: every run that CHANGES the state holds the lock for the whole of it,
 * including the read at its start. A read taken before the lock is what lets a waiting replica
 * act on a state the holder has since changed.
 *
 * `withMigrationLock` is replaced by a double that records whether the store is touched while it
 * is "held". The read-only `status()` is the paired control: it is deliberately not locked, so the
 * double demonstrably reports reads OUTSIDE the lock too — a green run is not an artefact of a
 * double that always says "inside".
 *
 * @regression   DEV-2728 — `down()` ran outside the migration lock while `up()` held it. A rollback
 *   is typically run while a deploy is failing, i.e. while replicas restart and each boots into
 *   `migrate up`; the two read and rewrote the migration state concurrently.
 * @seen-failing Call `this.runDown()` directly instead of through `withMigrationLock()` in
 *   src/core/modules/migrate/migration-runner.ts — registered as mutation
 *   `migration-down-outside-lock` in tests/regression-mutations.json.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import type { MigrationSet, MongoStateStore } from '../../src/core/modules/migrate/mongo-state-store';

import { MigrationRunner } from '../../src/core/modules/migrate/migration-runner';

const lock = vi.hoisted(() => ({ acquisitions: 0, held: false }));

vi.mock('../../src/core/modules/migrate/mongo-state-store', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/core/modules/migrate/mongo-state-store')>();
  return {
    ...actual,
    withMigrationLock: async <T>(_store: unknown, fn: () => Promise<T>): Promise<T> => {
      lock.acquisitions++;
      lock.held = true;
      try {
        return await fn();
      } finally {
        lock.held = false;
      }
    },
  };
});

/** Records, for every load and save, whether the lock was held at that moment. */
function recordingStore(recorded: { title: string }[]) {
  const touches: { held: boolean; op: 'load' | 'save' }[] = [];
  const store = {
    loadAsync: async () => {
      touches.push({ held: lock.held, op: 'load' });
      return { migrations: recorded.map((m) => ({ ...m })), up: () => {} };
    },
    saveAsync: async (_set: MigrationSet) => {
      touches.push({ held: lock.held, op: 'save' });
    },
  } as unknown as MongoStateStore;
  return { store, touches };
}

let dir: string;
const savedStrictEnv = process.env.NSC__MIGRATE__STRICT;

beforeAll(() => {
  delete process.env.NSC__MIGRATE__STRICT;
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'migration-lock-'));
  fs.writeFileSync(
    path.join(dir, '1700000000000-demo.js'),
    'module.exports.up = async () => {};\nmodule.exports.down = async () => {};\n',
  );
});

afterAll(() => {
  fs.rmSync(dir, { force: true, recursive: true });
  if (savedStrictEnv === undefined) {
    delete process.env.NSC__MIGRATE__STRICT;
  } else {
    process.env.NSC__MIGRATE__STRICT = savedStrictEnv;
  }
});

beforeEach(() => {
  lock.acquisitions = 0;
  lock.held = false;
});

describe('MigrationRunner — the migration lock covers every state-changing run', () => {
  it('up(): loads and saves the state only while holding the lock', async () => {
    const { store, touches } = recordingStore([]);
    await new MigrationRunner({ migrationsDirectory: dir, stateStore: store }).up();

    expect(lock.acquisitions).toBe(1);
    expect(
      touches.some((t) => t.op === 'save'),
      'the pending migration must have been recorded',
    ).toBe(true);
    expect(
      touches.every((t) => t.held),
      `touched outside the lock: ${JSON.stringify(touches)}`,
    ).toBe(true);
  });

  it('down(): loads and saves the state only while holding the lock', async () => {
    const { store, touches } = recordingStore([{ title: '1700000000000-demo.js' }]);
    await new MigrationRunner({ migrationsDirectory: dir, stateStore: store }).down();

    expect(lock.acquisitions).toBe(1);
    expect(
      touches.some((t) => t.op === 'save'),
      'the rollback must have been recorded',
    ).toBe(true);
    expect(
      touches.every((t) => t.held),
      `touched outside the lock: ${JSON.stringify(touches)}`,
    ).toBe(true);
  });

  it('status() is read-only and stays unlocked (the paired control: the double can report "outside")', async () => {
    const { store, touches } = recordingStore([{ title: '1700000000000-demo.js' }]);
    await new MigrationRunner({ migrationsDirectory: dir, stateStore: store }).status();

    expect(lock.acquisitions).toBe(0);
    expect(touches.length).toBeGreaterThan(0);
    expect(touches.every((t) => !t.held)).toBe(true);
  });
});
