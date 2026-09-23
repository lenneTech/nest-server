#!/usr/bin/env node
/**
 * Copies the files `nest build` does not emit into dist/.
 *
 * Replaces `mkdir -p <dir> && cp <src> <dir>/` in `build:copy-types` / `build:copy-templates`.
 * pnpm runs scripts through cmd.exe on Windows, which has no `cp` and whose `mkdir` rejects `-p`
 * ("The syntax of the command is incorrect."), so `pnpm run build` died there at its first copy
 * step — in every Windows CI run since the job existed.
 *
 * Usage: node scripts/copy-build-assets.mjs <types|templates>
 *
 * Fails when a set matches no file, like `cp src/types/*.d.ts` did: a build that silently ships
 * without its type declarations is worse than one that stops.
 */
import { copyFileSync, mkdirSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/** Each set: the source directory, which of its files to copy, and the target directory. */
const SETS = {
  templates: {
    from: 'src/core/modules/migrate/templates',
    match: (file) => file === 'migration-project.template.ts',
    to: 'dist/core/modules/migrate/templates',
  },
  types: {
    from: 'src/types',
    match: (file) => file.endsWith('.d.ts'),
    to: 'dist/types',
  },
};

const name = process.argv[2];
const set = SETS[name];
if (!set) {
  console.error(`copy-build-assets: unknown set "${name}" — expected one of: ${Object.keys(SETS).join(', ')}`);
  process.exit(1);
}

const files = readdirSync(join(ROOT, set.from)).filter(set.match);
if (files.length === 0) {
  console.error(`copy-build-assets: no file in ${set.from} matches the "${name}" set`);
  process.exit(1);
}

mkdirSync(join(ROOT, set.to), { recursive: true });
for (const file of files) {
  copyFileSync(join(ROOT, set.from, file), join(ROOT, set.to, file));
}
