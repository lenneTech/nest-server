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
 *
 * On Windows the stub cannot be a shell script: test-infra.mjs spawns `docker`
 * WITHOUT a shell, and that lookup only resolves `.com`/`.exe` — a `docker.cmd`
 * would be skipped and the runner's real Docker found instead (which is what the
 * Windows CI job did until this was fixed). So there the stub is a copy of
 * node.exe named `docker.exe`, and the stub logic reaches it via
 * `NODE_OPTIONS=--require`. Every case that expects the stub asserts it was
 * called, so a stub that stops taking effect turns the suite red instead of
 * silently testing the machine's Docker.
 */
import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

// `__dirname`, not `import.meta.url`: tsconfig.tests.json compiles these specs as
// CommonJS, so import.meta is a type error here. Same resolution the sibling
// pnpm-pin-contract.spec.ts uses.
const ROOT = join(__dirname, '..', '..');
const SCRIPT = join(ROOT, 'scripts', 'test-infra.mjs');

let sandbox: string;
let dockerLog: string;
let harness: string;
let stubPreload: string;

const IS_WINDOWS = process.platform === 'win32';

/**
 * Environment with a `docker` that always fails and records every invocation.
 *
 * LT_TEST_INFRA is deliberately removed: CI sets it to `0`, which makes `up()`
 * return before it ever touches Docker — under that value the regression cannot
 * reproduce and the test would pass vacuously.
 */
function envWithFakeDocker(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  // Windows spells it `Path`, and a plain object copy of process.env is case-sensitive: setting
  // `PATH` next to it would hand the child two entries. Reuse whichever key is there.
  const pathKey = Object.keys(env).find((key) => key.toUpperCase() === 'PATH') ?? 'PATH';
  env[pathKey] = `${join(sandbox, 'bin')}${delimiter}${env[pathKey] ?? ''}`;
  if (IS_WINDOWS) {
    // Forward slashes: NODE_OPTIONS treats `\` inside double quotes as an escape, so a native
    // `C:\Users\…` arrives as `C:Users…` and EVERY node process of the test dies on the preload
    // (measured on the Windows runner). Windows accepts `/` in paths.
    env.NODE_OPTIONS = `${env.NODE_OPTIONS ?? ''} --require "${stubPreload.replaceAll('\\', '/')}"`.trim();
  }
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
  if (IS_WINDOWS) {
    // A node.exe named docker.exe runs this preload first. The preload is loaded into EVERY node
    // process of the test (NODE_OPTIONS is inherited), so it acts only in the one named docker.
    // Node has already resolved the subcommand (`info`) to an absolute script path by then, so the
    // log keeps its basename.
    copyFileSync(process.execPath, join(bin, 'docker.exe'));
    stubPreload = join(sandbox, 'docker-stub.cjs');
    writeFileSync(
      stubPreload,
      `if (require('node:path').basename(process.execPath).toLowerCase() === 'docker.exe') {\n` +
        `  require('node:fs').appendFileSync(${JSON.stringify(dockerLog)}, [require('node:path').basename(process.argv[1] ?? ''), ...process.argv.slice(2)].join(' ') + '\\n');\n` +
        `  process.stderr.write('docker stub: daemon not running\\n');\n` +
        `  process.exit(1);\n` +
        `}\n`,
    );
  } else {
    const stub = join(bin, 'docker');
    writeFileSync(stub, `#!/bin/sh\necho "$@" >> "${dockerLog}"\necho "docker stub: daemon not running" >&2\nexit 1\n`);
    chmodSync(stub, 0o755);
  }

  // Imports the script exactly the way tests/global-setup.ts does, then reports
  // whether the import mutated process.exitCode.
  harness = join(sandbox, 'harness.mjs');
  writeFileSync(
    harness,
    // A file URL, not the path: ESM `import()` rejects a bare `C:\…` path as an unknown scheme.
    `const mod = await import(${JSON.stringify(pathToFileURL(SCRIPT).href)});\n` +
      `console.log('exitCode=' + String(process.exitCode) + ' up=' + typeof mod.up + ' down=' + typeof mod.down);\n`,
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
    // Proves the stub answered, not a real Docker that happened to fail.
    expect(dockerInvocations()).toContain('info');
  });
});
