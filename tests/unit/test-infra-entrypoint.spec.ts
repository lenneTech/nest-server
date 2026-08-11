/**
 * Unit Tests: scripts/test-infra.mjs must be import-safe.
 *
 * tests/global-setup.ts imports `up` from that script. The script used to run its
 * CLI dispatch at module scope, so the IMPORT itself dispatched: under
 * `vitest run …` `process.argv[2]` is `run`, which fell into the `up()` branch.
 * Two consequences, both silent:
 *
 *  1. On a machine with no Docker daemon it set `process.exitCode = 1`, so
 *     `pnpm test` printed a fully green test summary and then exited non-zero —
 *     the exact opposite of the "Never fatal: a machine without Docker still runs
 *     every suite that needs no infrastructure" contract global-setup documents.
 *  2. `up()` ran twice per test run (once at import, once from `setup()`).
 *
 * Invisible in CI (which sets LT_TEST_INFRA=0, short-circuiting `up()`) and on a
 * maintainer machine (Docker running), which is precisely why it needs a test.
 *
 * Rule under test: an imported module must never touch `process.exitCode` and must
 * not shell out at import time — while `node scripts/test-infra.mjs …` still works.
 *
 * Needs no Docker: a stub `docker` that always fails is put on PATH, which also
 * lets the test assert that the import never invoked it at all.
 */
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

// `__dirname`, not `import.meta.url`: tsconfig.tests.json compiles these specs as
// CommonJS, so import.meta is a type error here. Same resolution the sibling
// pnpm-pin-contract.spec.ts uses.
const ROOT = join(__dirname, '..', '..');
const SCRIPT = join(ROOT, 'scripts', 'test-infra.mjs');

let sandbox: string;
let dockerLog: string;
let harness: string;

/**
 * Environment with a `docker` that always fails and records every invocation.
 *
 * LT_TEST_INFRA is deliberately removed: CI sets it to `0`, which makes `up()`
 * return before it ever touches Docker — under that value the regression cannot
 * reproduce and the test would pass vacuously.
 */
function envWithFakeDocker(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, PATH: `${join(sandbox, 'bin')}:${process.env.PATH}` };
  delete env.LT_TEST_INFRA;
  return env;
}

function dockerInvocations(): string {
  return existsSync(dockerLog) ? readFileSync(dockerLog, 'utf8').trim() : '';
}

beforeAll(() => {
  sandbox = mkdtempSync(join(tmpdir(), 'test-infra-entrypoint-'));
  const bin = join(sandbox, 'bin');
  dockerLog = join(sandbox, 'docker-calls.log');
  mkdirSync(bin, { recursive: true });
  const stub = join(bin, 'docker');
  writeFileSync(stub, `#!/bin/sh\necho "$@" >> "${dockerLog}"\necho "docker stub: daemon not running" >&2\nexit 1\n`);
  chmodSync(stub, 0o755);

  // Imports the script exactly the way tests/global-setup.ts does, then reports
  // whether the import mutated process.exitCode.
  harness = join(sandbox, 'harness.mjs');
  writeFileSync(
    harness,
    `const mod = await import(${JSON.stringify(SCRIPT)});\n`
      + `console.log('exitCode=' + String(process.exitCode) + ' up=' + typeof mod.up + ' down=' + typeof mod.down);\n`,
  );
});

afterAll(() => {
  rmSync(sandbox, { force: true, recursive: true });
});

describe('scripts/test-infra.mjs: import safety', () => {
  it("importing it does not dispatch, even with vitest's own `run` in argv[2]", () => {
    // argv: [node, harness.mjs, 'run'] — the shape `vitest run …` produces.
    const result = spawnSync(process.execPath, [harness, 'run'], {
      encoding: 'utf8',
      env: envWithFakeDocker(),
    });

    // The regression: a green suite that exits 1 because the import set exitCode.
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('exitCode=undefined');
    // ...and it must not have shelled out to docker at all (the import used to
    // run `docker info`, and on a working machine `docker run` on top of that).
    expect(dockerInvocations()).toBe('');
    expect(result.stdout + result.stderr).not.toContain('Docker is not available');
  });

  it('exports up/down as functions for tests/global-setup.ts', () => {
    const result = spawnSync(process.execPath, [harness, 'run'], {
      encoding: 'utf8',
      env: envWithFakeDocker(),
    });
    expect(result.stdout).toContain('up=function');
    expect(result.stdout).toContain('down=function');
  });
});

describe('scripts/test-infra.mjs: CLI entry point still dispatches', () => {
  it('`status` runs and exits 0 when Docker is unavailable', () => {
    const result = spawnSync(process.execPath, [SCRIPT, 'status'], {
      encoding: 'utf8',
      env: envWithFakeDocker(),
    });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('Docker not available');
    expect(dockerInvocations()).toContain('info');
  });

  it('`up` surfaces failure as a non-zero exit code (this is where exitCode belongs)', () => {
    const result = spawnSync(process.execPath, [SCRIPT, 'up'], {
      encoding: 'utf8',
      env: envWithFakeDocker(),
    });
    expect(result.status).toBe(1);
    expect(result.stderr + result.stdout).toContain('Docker is not available');
  });
});
