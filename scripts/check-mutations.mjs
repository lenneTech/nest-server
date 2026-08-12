#!/usr/bin/env node
/**
 * Re-run the evidence behind every `@regression` test: break the code on purpose, and require the
 * tests that claim to catch it to go RED.
 *
 * WHY THIS EXISTS
 * ---------------
 * Two regression tests written while fixing 11.33.1 passed with the bug fully restored. Nothing in
 * the suite could tell — a green test looks identical whether it is checking something or nothing.
 * The only thing that separates the two is having SEEN it fail, and that observation was, until
 * now, a memory in someone's terminal scrollback.
 *
 * So it is written down (`tests/regression-mutations.json`) and re-runnable. A mutation that no
 * longer turns its specs red means one of two things, and both matter: the test went vacuous, or
 * the defect is no longer reachable and the mutation needs re-pointing. Either way somebody should
 * look.
 *
 * NOT part of `pnpm run check`: it edits source files and re-runs whole e2e suites. It belongs in
 * review and on the publish path. The registry is kept from rotting between runs by
 * `tests/unit/regression-evidence.spec.ts`, which asserts every `find` still matches exactly once —
 * a stale mutation would otherwise silently become a no-op, and a no-op mutation "proves" every
 * test vacuous-free by accident.
 *
 * SAFETY
 * ------
 * Every touched file is restored from an in-memory copy of the content as it was READ (never from
 * git HEAD), in a `finally` and again from an `exit`/signal handler, so an interrupted run cannot
 * leave a deliberately broken source behind.
 *
 * The one thing a snapshot cannot survive is somebody else writing the same file WHILE the mutation
 * is applied — the restore would then overwrite their edit. So by default the run refuses to touch
 * a target with uncommitted changes. `--allow-dirty` lifts that (needed when the fix and its
 * evidence are being developed in the same working tree) and instead verifies, immediately before
 * writing, that the file still matches the snapshot.
 *
 * Usage:
 *   pnpm run check:mutations                    all registered mutations
 *   pnpm run check:mutations -- --id=<id>       one mutation
 *   pnpm run check:mutations -- --list          show the registry without running anything
 *   pnpm run check:mutations -- --allow-dirty   run against an uncommitted working tree
 */
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const REGISTRY = join(ROOT, 'tests', 'regression-mutations.json');

const args = process.argv.slice(2);
const only = args.find((arg) => arg.startsWith('--id='))?.slice('--id='.length);
const listOnly = args.includes('--list');
const allowDirty = args.includes('--allow-dirty');

/** Files restored on any exit path, keyed by absolute path. */
const originals = new Map();

function restoreAll() {
  for (const [file, content] of originals) {
    try {
      writeFileSync(file, content);
    } catch {
      // Nothing useful left to do while unwinding; the message below is the actionable part.
      process.stderr.write(`\n!! Could not restore ${file} — run \`git checkout -- ${file}\`\n`);
    }
  }
  originals.clear();
}

process.on('exit', restoreAll);
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    restoreAll();
    process.exit(130);
  });
}

/**
 * Apply one mutation to a file's text.
 *
 * Throws rather than silently doing nothing when the anchor or the target is missing or ambiguous.
 * A no-op mutation is the worst outcome this script can produce: every spec stays green and the
 * run reports "evidence confirmed" for a check that never happened.
 */
export function applyMutation(source, mutation) {
  let offset = 0;
  if (mutation.after) {
    const occurrences = source.split(mutation.after).length - 1;
    if (occurrences !== 1) {
      throw new Error(`anchor \`after\` matched ${occurrences} times (expected exactly 1)`);
    }
    offset = source.indexOf(mutation.after);
  }
  const window = source.slice(offset);
  const occurrences = window.split(mutation.find).length - 1;
  if (occurrences !== 1) {
    throw new Error(`\`find\` matched ${occurrences} times in the search window (expected exactly 1)`);
  }
  return source.slice(0, offset) + window.replace(mutation.find, mutation.replace);
}

function gitIsClean(file) {
  const result = spawnSync('git', ['status', '--porcelain', '--', file], { cwd: ROOT, encoding: 'utf8' });
  return result.status === 0 && result.stdout.trim() === '';
}

function runSpecs(specs) {
  const unit = specs.every((spec) => spec.startsWith('tests/unit/'));
  const config = unit ? 'vitest.config.ts' : 'vitest-e2e.config.ts';
  const result = spawnSync('npx', ['vitest', 'run', '--config', config, ...specs], {
    cwd: ROOT,
    encoding: 'utf8',
    env: { ...process.env, CHECK_LOW_RESOURCE: process.env.CHECK_LOW_RESOURCE ?? '0', NODE_ENV: unit ? 'test' : 'e2e' },
  });
  return { code: result.status ?? 1, output: `${result.stdout ?? ''}${result.stderr ?? ''}` };
}

function main() {
  const registry = JSON.parse(readFileSync(REGISTRY, 'utf8'));
  const mutations = registry.mutations.filter((mutation) => !only || mutation.id === only);

  if (!mutations.length) {
    process.stderr.write(`No mutation matches --id=${only}\n`);
    process.exit(1);
  }

  if (listOnly) {
    for (const mutation of mutations) {
      process.stdout.write(
        `${mutation.id}\n  ${mutation.file}\n  ${mutation.defect}\n  specs: ${mutation.specs.join(', ')}\n\n`,
      );
    }
    return;
  }

  const results = [];

  for (const mutation of mutations) {
    const file = resolve(ROOT, mutation.file);
    process.stdout.write(`\n── ${mutation.id} ──\n   ${mutation.file}\n`);

    if (!allowDirty && !gitIsClean(mutation.file)) {
      results.push({
        id: mutation.id,
        note: 'target file has uncommitted changes — re-run with --allow-dirty if that is expected',
        ok: false,
      });
      process.stdout.write('   SKIPPED: uncommitted changes in the target file (--allow-dirty to override)\n');
      continue;
    }

    const original = readFileSync(file, 'utf8');
    let mutated;
    try {
      mutated = applyMutation(original, mutation);
    } catch (error) {
      results.push({ id: mutation.id, note: `mutation is stale: ${error.message}`, ok: false });
      process.stdout.write(`   STALE: ${error.message}\n`);
      continue;
    }

    originals.set(file, original);
    try {
      // Last-moment race check. Between reading the snapshot and writing the mutation another
      // process (a parallel agent, a watch-mode formatter) may have rewritten the file; restoring
      // the snapshot afterwards would silently discard that edit.
      if (readFileSync(file, 'utf8') !== original) {
        throw new Error('the target file changed while this mutation was being prepared');
      }
      writeFileSync(file, mutated);
      process.stdout.write(`   applied, running ${mutation.specs.join(' ')}\n`);
      const { code, output } = runSpecs(mutation.specs);
      const failedCount = output.match(/Tests\s+(\d+) failed/)?.[1];
      if (code === 0) {
        results.push({ id: mutation.id, note: 'specs stayed GREEN with the defect restored — vacuous', ok: false });
        process.stdout.write('   VACUOUS: the specs passed with the defect restored\n');
      } else {
        results.push({ id: mutation.id, note: `${failedCount ?? 'some'} test(s) failed, as required`, ok: true });
        process.stdout.write(`   OK: ${failedCount ?? 'some'} test(s) went red\n`);
      }
    } finally {
      writeFileSync(file, original);
      originals.delete(file);
    }
  }

  process.stdout.write('\n══ regression evidence ══\n');
  for (const result of results) {
    process.stdout.write(`  ${result.ok ? 'PASS' : 'FAIL'}  ${result.id} — ${result.note}\n`);
  }

  const failed = results.filter((result) => !result.ok);
  process.stdout.write(`\n${results.length - failed.length}/${results.length} mutations confirmed\n`);
  process.exit(failed.length ? 1 : 0);
}

// Importable for unit tests without running the pipeline (same guard as scripts/check.mjs).
const INVOKED_AS_SCRIPT = resolve(process.argv[1] ?? '') === resolve(fileURLToPath(import.meta.url));
if (INVOKED_AS_SCRIPT) {
  main();
}
