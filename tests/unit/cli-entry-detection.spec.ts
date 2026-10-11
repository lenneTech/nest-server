import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, symlinkSync } from 'node:fs';
import os from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { isSameCliEntry as checkConsumerEntry } from '../../scripts/check-consumer.mjs';
import { isSameCliEntry as checkMutationsEntry } from '../../scripts/check-mutations.mjs';
import { isSameCliEntry as checkEntry } from '../../scripts/check.mjs';

/**
 * Unit Tests: how the three check scripts decide that they were started as the CLI.
 *
 * Each script runs its pipeline only when `process.argv[1]` names the module itself, so that a unit
 * test can import its helpers without starting a run. Node resolves the main module's symlinks for
 * `import.meta.url` but keeps `argv[1]` as typed, so a comparison of the two plain paths answered
 * "not the CLI" for every start through a symlink — and the script exited 0 having checked nothing.
 * On macOS that is any absolute path under `/tmp` (a symlink to `/private/tmp`), or a checkout
 * reached through a symlinked directory.
 *
 * Symlink creation needs a privilege on Windows, which the Windows CI runner of this repo does not
 * hold, so the symlink cases are POSIX-only. The comparison itself is platform-neutral.
 */
const SCRIPTS_DIR = resolve(__dirname, '../../scripts');
const posixOnly = it.skipIf(process.platform === 'win32');

const CASES = [
  { file: 'check.mjs', isSame: checkEntry, mutation: 'cli-entry-no-realpath-check' },
  { file: 'check-mutations.mjs', isSame: checkMutationsEntry, mutation: 'cli-entry-no-realpath-check-mutations' },
  { file: 'check-consumer.mjs', isSame: checkConsumerEntry, mutation: 'cli-entry-no-realpath-check-consumer' },
] as const;

describe('check scripts: CLI entry detection', () => {
  let dir: string;
  let linkedScripts: string;

  beforeEach(() => {
    dir = mkdtempSync(join(os.tmpdir(), 'cli-entry-'));
    linkedScripts = join(dir, 'scripts-link');
    if (process.platform !== 'win32') {
      symlinkSync(SCRIPTS_DIR, linkedScripts);
    }
  });

  afterEach(() => {
    // rmSync removes the link itself, never the repository's scripts/ it points at.
    rmSync(dir, { force: true, recursive: true });
  });

  describe.each(CASES)('$file', ({ file, isSame }) => {
    it('recognises the module by its own path', () => {
      expect(isSame(join(SCRIPTS_DIR, file), join(SCRIPTS_DIR, file))).toBe(true);
    });

    it('does not mistake another module for itself', () => {
      // The refusal case: a comparison that always answered "yes" would start a full check run
      // whenever a unit test imported the module.
      expect(isSame(join(SCRIPTS_DIR, 'check-server-start.mjs'), join(SCRIPTS_DIR, file))).toBe(false);
    });

    /**
     * @regression   11.42.x — the CLI guard compared `resolve(process.argv[1])` with the module's own
     *   path. A start through a symlink compared unequal, so the script skipped its pipeline and
     *   exited 0: a green "check" that checked nothing. Ported from nest-server-starter, whose
     *   check.mjs resolves both sides with realpathSync.
     * @seen-failing Compare the plain resolved paths in isSameCliEntry() of the script under test —
     *   registered as mutations `cli-entry-no-realpath-check`, `cli-entry-no-realpath-check-mutations`
     *   and `cli-entry-no-realpath-check-consumer` in tests/regression-mutations.json.
     */
    posixOnly('recognises itself when started through a symlinked directory', () => {
      expect(isSame(join(linkedScripts, file), join(SCRIPTS_DIR, file))).toBe(true);
    });
  });

  posixOnly('really runs check-mutations when started through a symlink (end to end)', () => {
    // `--list` prints the registry and runs nothing, so this observes the guard without side
    // effects. With the old comparison the process printed nothing and still exited 0.
    const result = spawnSync(process.execPath, [join(linkedScripts, 'check-mutations.mjs'), '--list'], {
      encoding: 'utf8',
    });

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('e2e-slot-no-age-cap');
  });
});
