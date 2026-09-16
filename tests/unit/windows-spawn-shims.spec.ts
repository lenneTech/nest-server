import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Node refuses to spawn a `.cmd` / `.bat` directly since 20.12 (CVE-2024-27980).
 * On Windows every package manager IS such a shim, so `spawn('pnpm', …)` without
 * `shell: true` fails with `spawn pnpm ENOENT` (errno -4058) — on Linux and macOS
 * the same line works, which is why this can only be caught by reading the code.
 *
 * @regression   11.41.2 — `scripts/run-spectaql.mjs` spawned pnpm without a shell and
 *   without an `error` handler. On Windows the unhandled `error` event killed the whole
 *   process, and since `execAfterInit: 'pnpm run docs:bootstrap'` runs it right after a
 *   successful boot, it took the running server with it.
 * @seen-failing Drop `shell: true` from the `spawn('pnpm', …)` call in
 *   scripts/run-spectaql.mjs — registered as mutation `spectaql-spawn-without-shell`
 *   in tests/regression-mutations.json.
 */
const SCRIPTS_DIR = join(__dirname, '..', '..', 'scripts');

/**
 * `spawn('pnpm …', …)` / `execFileSync('npm …', …)` and friends, with their options
 * object. Matches both the args-array and the single-command-string form, so a call
 * that goes back to the array form is checked rather than silently skipped.
 */
const PACKAGE_MANAGER_CALL =
  /\b(spawn|spawnSync|execFile|execFileSync)\(\s*'(pnpm|npm|npx|yarn)( [^']*)?'[\s\S]{0,500}?\n\s*\}\)/g;

function scriptFiles(): string[] {
  return readdirSync(SCRIPTS_DIR).filter((file) => /\.(mjs|js|cjs)$/.test(file));
}

describe('Windows: package managers are spawned through a shell', () => {
  it('finds script files to check', () => {
    expect(scriptFiles().length).toBeGreaterThan(0);
  });

  for (const file of scriptFiles()) {
    const content = readFileSync(join(SCRIPTS_DIR, file), 'utf8');
    const calls = [...content.matchAll(PACKAGE_MANAGER_CALL)];
    if (calls.length === 0) {
      continue;
    }

    it(`${file}: every package-manager call passes shell: true`, () => {
      for (const [call] of calls) {
        expect(
          call,
          `${file} spawns a package manager without \`shell: true\` — that is an ENOENT on Windows:\n${call}`,
        ).toMatch(/shell:\s*true/);
      }
    });
  }

  it('run-spectaql.mjs handles the spawn error event', () => {
    const content = readFileSync(join(SCRIPTS_DIR, 'run-spectaql.mjs'), 'utf8');
    // Without a listener, a failed spawn throws `Unhandled 'error' event` and takes
    // the caller down instead of reporting which tool could not be started.
    expect(content).toMatch(/\.on\(\s*'error'/);
  });
});
