/**
 * Unit test for docker-entrypoint.sh — the failure policy for migrations that run before the server.
 *
 * A migration that RAN AND FAILED refuses the start by default: a failed schema migration is
 * otherwise indistinguishable from a good deploy. MIGRATIONS_ALLOW_FAILURE=true (or the long form
 * MIGRATE_FAILURE_POLICY=warn, which wins when both are set) opts out per deploy (DEV-2728, in
 * lockstep with nest-server-starter's entrypoint). A recorded migration whose file was pruned stays a
 * warning: that is the migrate CLI's own tolerance, which the entrypoint keeps by never passing
 * --strict.
 *
 * Skipped on win32: the script runs in Linux containers only, and there is no `sh` to run it with.
 */
import { execFileSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const ENTRYPOINT = join(process.cwd(), 'docker-entrypoint.sh');
const SERVER_MARKER = '__SERVER_STARTED__';

/** Runs the entrypoint; throws (via execFileSync) on a non-zero exit. */
function runEntrypoint(env: Record<string, string>): string {
  return execFileSync('sh', [ENTRYPOINT], {
    encoding: 'utf-8',
    // Both policy variables are PINNED empty, so a value in the invoking shell can never turn a
    // "default" case into a test of something else.
    env: {
      ...process.env,
      MIGRATE_FAILURE_POLICY: '',
      MIGRATIONS_ALLOW_FAILURE: '',
      SERVER_CMD: `echo ${SERVER_MARKER}`,
      ...env,
    },
  });
}

/** Runs the entrypoint where it must exit non-zero; returns status and what it printed. */
function runEntrypointExpectingFailure(env: Record<string, string>): { status?: number; stdout: string } {
  try {
    runEntrypoint(env);
  } catch (e) {
    const error = e as { status?: number; stdout?: string };
    return { status: error.status, stdout: error.stdout ?? '' };
  }
  throw new Error('expected the entrypoint to exit non-zero, but it succeeded');
}

describe.skipIf(process.platform === 'win32')(
  'docker-entrypoint.sh — migration failure policy (skipped on win32: a Linux-container script)',
  () => {
    let dir: string;
    let dist: string;
    let failingCli: string;

    beforeEach(() => {
      dir = mkdtempSync(join(tmpdir(), 'entrypoint-'));
      dist = join(dir, 'dist');
      mkdirSync(join(dist, 'migrations'), { recursive: true });
      writeFileSync(join(dist, 'migrations', '1750000000000-noop.js'), 'exports.up = async () => {};\n');
      failingCli = join(dir, 'migrate-fails');
      writeFileSync(failingCli, '#!/bin/sh\nexit 1\n');
      chmodSync(failingCli, 0o755);
    });

    afterEach(() => {
      rmSync(dir, { force: true, recursive: true });
    });

    it('refuses to start by default when a migration ran and failed', () => {
      const error = runEntrypointExpectingFailure({ APP_DIST: dist, MIGRATE_BIN: failingCli });
      expect(error.status).toBe(1);
      expect(error.stdout).toContain('refusing to start against a possibly half-applied schema');
      expect(error.stdout).toContain('MIGRATIONS_ALLOW_FAILURE=true');
      expect(error.stdout).not.toContain(SERVER_MARKER);
    });

    it('starts anyway when MIGRATIONS_ALLOW_FAILURE=true', () => {
      const stdout = runEntrypoint({ APP_DIST: dist, MIGRATE_BIN: failingCli, MIGRATIONS_ALLOW_FAILURE: 'true' });
      expect(stdout).toContain('WARNING: migration step failed');
      expect(stdout).toContain(SERVER_MARKER);
    });

    it('lets the long form MIGRATE_FAILURE_POLICY win over MIGRATIONS_ALLOW_FAILURE', () => {
      const error = runEntrypointExpectingFailure({
        APP_DIST: dist,
        MIGRATE_BIN: failingCli,
        MIGRATE_FAILURE_POLICY: 'abort',
        MIGRATIONS_ALLOW_FAILURE: 'true',
      });
      expect(error.status).toBe(1);
      expect(error.stdout).not.toContain(SERVER_MARKER);
    });

    it('treats an unknown MIGRATIONS_ALLOW_FAILURE value as abort, and says so', () => {
      const error = runEntrypointExpectingFailure({
        APP_DIST: dist,
        MIGRATE_BIN: failingCli,
        MIGRATIONS_ALLOW_FAILURE: 'yes',
      });
      expect(error.stdout).toContain("unknown MIGRATIONS_ALLOW_FAILURE 'yes' (expected 'true') — using 'abort'");
      expect(error.stdout).not.toContain(SERVER_MARKER);
    });

    it('runs `migrate up` WITHOUT --strict, so a pruned migration file stays a warning', () => {
      const echoingCli = join(dir, 'migrate-echo');
      writeFileSync(echoingCli, '#!/bin/sh\necho "__MIGRATE_RAN__ $*"\nexit 0\n');
      chmodSync(echoingCli, 0o755);

      const stdout = runEntrypoint({ APP_DIST: dist, MIGRATE_BIN: echoingCli });
      expect(stdout).toContain('__MIGRATE_RAN__ up');
      expect(stdout).not.toContain('--strict');
      expect(stdout).toContain('[entrypoint] Migrations applied.');
      expect(stdout).toContain(SERVER_MARKER);
    });
  },
);
