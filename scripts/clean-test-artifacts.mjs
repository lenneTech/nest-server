#!/usr/bin/env node
/**
 * Deletes the files the test suite leaves behind (`*.txt`, `*.bin`, `*.png`) anywhere under `tests/`.
 *
 * Replaces `find tests -type f \( -name '*.txt' -o -name '*.bin' -o -name '*.png' \) -not -name
 * '.gitkeep' -delete`, which does not run on Windows: `find.exe` there is a text search, not a file
 * walker. Ported from nest-server-starter. The semantics are kept on purpose rather than
 * approximated with `rimraf --glob`, which was measured to differ in two ways: it skips dotfiles
 * (`find` deletes `.x.txt`) and matches case-insensitively on macOS and Windows (`find` keeps
 * `UP.TXT`).
 *
 * The extension list is the one the startup sweep in `tests/global-setup.ts` uses, so an on-demand
 * cleanup and the automatic one remove the same files; tests/unit/dev-scripts.spec.ts keeps the two
 * lists equal.
 *
 * Usage: node scripts/clean-test-artifacts.mjs
 */
import { readdirSync, realpathSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const ARTIFACT_EXTENSIONS = ['.bin', '.png', '.txt'];

/**
 * Whether a file name counts as a test artifact. Case-sensitive, dotfiles included, like
 * `find -name`. (The original's `-not -name '.gitkeep'` never fired: `.gitkeep` ends in none of them.)
 */
export function isTestArtifact(name) {
  return ARTIFACT_EXTENSIONS.some((extension) => name.endsWith(extension));
}

/** Deletes every test artifact below `dir` and returns the deleted paths. */
export function cleanTestArtifacts(dir) {
  const deleted = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      deleted.push(...cleanTestArtifacts(path));
    } else if (entry.isFile() && isTestArtifact(entry.name)) {
      rmSync(path);
      deleted.push(path);
    }
  }
  return deleted;
}

const entry = process.argv[1];
if (entry && realpathSync(entry) === realpathSync(fileURLToPath(import.meta.url))) {
  cleanTestArtifacts('tests');
  console.log('Test artifacts cleaned up');
}
