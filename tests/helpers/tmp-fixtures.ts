import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * Per-run scratch directory for file-upload fixtures.
 *
 * Specs that upload a file have to put bytes on disk first. Writing them into
 * `tests/` and unlinking after the assertion looks tidy and is not: the unlink
 * sits AFTER the assertion, so the one case that leaves the file behind is the
 * one the spec exists to catch — a failing upload. Five 16-byte `avatar-*.png`
 * leftovers were committed that way, produced by the very commits that were
 * fixing broken uploads.
 *
 * Staging in an `mkdtemp` directory under `os.tmpdir()` removes the whole class
 * of problem rather than patching it: the repository is never written to, so a
 * missed cleanup cannot become a tracked artifact, and the OS collects the
 * directory even if the process is SIGKILLed. `mkdtemp` also gives per-run
 * isolation for free, so concurrent runs cannot collide on a fixture name.
 *
 * Directory removal still belongs in `afterAll` (see {@link removeFixtureDir}) —
 * not because a leak would be dangerous, but because a long-lived dev machine
 * should not accumulate one directory per run.
 */
export function createFixtureDir(prefix = 'nest-server-test-'): Promise<string> {
  return mkdtemp(join(tmpdir(), prefix));
}

/**
 * Remove a fixture directory and everything in it.
 *
 * Best-effort by design: teardown must never fail a suite whose assertions all
 * passed, and `os.tmpdir()` is collected by the OS regardless.
 */
export async function removeFixtureDir(dir: string | undefined): Promise<void> {
  if (!dir) {
    return;
  }
  try {
    await rm(dir, { force: true, recursive: true });
  } catch {
    /* best-effort */
  }
}
