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
 *   pnpm run check:mutations -- --jobs=4        run 4 mutations at a time (see below)
 *
 * PARALLELISM
 * -----------
 * The work here is not the tests — the whole registry's specs add up to well under a minute. It is
 * paying vitest's cold start (process spawn, transform, module graph, mongod connect, DB create and
 * drop) once per mutation. That is idle-core time, so it parallelises well.
 *
 * A mutation WRITES INTO THE SOURCE TREE, which is why this cannot simply run N at once: two
 * mutations in one tree would see each other's edits, and the specs would be answering about a
 * source state nobody registered. So each worker gets its own `git worktree` (with `node_modules`
 * symlinked from the main checkout — pnpm's internal links are relative, so this works and costs
 * nothing) and mutates only inside it.
 *
 * That isolation has a consequence worth stating: a worktree is checked out at HEAD, so parallel
 * mode tests COMMITTED code. When the working tree is dirty — or `--allow-dirty` is passed, which
 * is exactly the "fix and its evidence share a tree" case — the run falls back to sequential, where
 * the real working tree is what gets mutated. Getting a fast answer about the wrong source is worse
 * than a slow answer about the right one.
 *
 * `--jobs` defaults to a value derived from the core count, capped at 4: each worker starts a vitest
 * that forks again, so oversubscribing costs more than it buys. `--jobs=1` forces the sequential
 * path, byte-for-byte the behaviour that existed before parallelism was added.
 */
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { availableParallelism, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const REGISTRY = join(ROOT, 'tests', 'regression-mutations.json');

const args = process.argv.slice(2);
const only = args.find((arg) => arg.startsWith('--id='))?.slice('--id='.length);
const listOnly = args.includes('--list');
const allowDirty = args.includes('--allow-dirty');
const jobsArg = args.find((arg) => arg.startsWith('--jobs='))?.slice('--jobs='.length);

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

function specEnv(specs, jobs) {
  const unit = specs.every((spec) => spec.startsWith('tests/unit/'));
  return {
    ...process.env,
    CHECK_LOW_RESOURCE: process.env.CHECK_LOW_RESOURCE ?? '0',
    // Every worker runs its own e2e vitest, and the machine-wide run governor would otherwise make
    // them queue behind each other — turning the parallel run back into a sequential one with extra
    // steps. These workers ARE one coordinated run, so raise the cap to fit them.
    ...(jobs > 1 ? { LT_E2E_MAX_RUNS: String(Math.max(jobs, Number(process.env.LT_E2E_MAX_RUNS) || 0)) } : {}),
    NODE_ENV: unit ? 'test' : 'e2e',
  };
}

function specConfig(specs) {
  return specs.every((spec) => spec.startsWith('tests/unit/')) ? 'vitest.config.ts' : 'vitest-e2e.config.ts';
}

/**
 * Run a mutation's specs.
 *
 * Deliberately `spawn` and not `spawnSync`: `spawnSync` blocks the whole event loop, so a
 * `Promise.all` over several of them executes strictly one after another. The parallel path would
 * have looked parallel, taken exactly as long as the sequential one, and nothing would have said so.
 */
function runSpecs(specs, cwd = ROOT, jobs = 1) {
  return new Promise((resolveRun) => {
    const child = spawn('npx', ['vitest', 'run', '--config', specConfig(specs), ...specs], {
      cwd,
      env: specEnv(specs, jobs),
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    child.stdout.on('data', (chunk) => (output += chunk));
    child.stderr.on('data', (chunk) => (output += chunk));
    child.on('error', (error) => resolveRun({ code: 1, output: `${output}\n${error.message}` }));
    child.on('close', (code) => resolveRun({ code: code ?? 1, output }));
  });
}

/** Worktrees created for a parallel run — removed on every exit path. */
const worktrees = [];

function removeWorktrees() {
  for (const dir of worktrees.splice(0)) {
    try {
      spawnSync('git', ['worktree', 'remove', '--force', dir], { cwd: ROOT });
      if (existsSync(dir)) rmSync(dir, { force: true, recursive: true });
    } catch {
      process.stderr.write(`\n!! Could not remove worktree ${dir} — run \`git worktree prune\`\n`);
    }
  }
}

process.on('exit', removeWorktrees);

/**
 * How many mutations to run at once.
 *
 * Capped at 4 because each worker starts a vitest that forks again — past that the workers fight
 * each other for the same cores and the wall clock stops improving. Falls back to sequential
 * whenever the worktree would not be a faithful stand-in for what the caller wants tested.
 */
/**
 * Decide how many mutations to run at once — pure, so the decision can be tested without a repo,
 * worktrees and seven minutes. See `tests/unit/mutation-jobs-planning.spec.ts`.
 *
 * @param {object} options
 * @param {boolean} [options.allowDirty] `--allow-dirty` was passed
 * @param {number} options.cores available parallelism
 * @param {number} [options.explicit] `--jobs=N`, `NaN` when absent or malformed
 * @param {number} options.mutationCount how many mutations this run will apply
 * @param {boolean} [options.sourceDirty] `src/` or `tests/` has uncommitted changes
 * @returns {{ jobs: number, why?: string }} `why` is set only when it fell back to sequential
 */
export function planJobs({
  allowDirty: dirtyAllowed = false,
  cores,
  explicit = Number.NaN,
  mutationCount,
  sourceDirty = false,
}) {
  // Floor of 2, not 1: the dominant cost is vitest's cold start, which is largely single-threaded
  // I/O and does NOT scale with cores — the full registry takes ~744s on a 12-core laptop and ~777s
  // on a 4-vCPU CI runner. A core-proportional formula would therefore hand the smallest runner no
  // parallelism at all, which is exactly where the wall clock is worth reclaiming. Capped at 4
  // because each worker starts a vitest that forks again; measured 744s -> 399s (1.87x) at 4 jobs
  // on 12 cores, so the scaling is real but sub-linear and more workers stop paying.
  const requested =
    Number.isInteger(explicit) && explicit > 0 ? explicit : Math.min(4, Math.max(2, Math.floor(cores / 3)));
  if (requested === 1 || mutationCount < 2) return { jobs: 1 };

  // A worktree is checked out at HEAD. If the caller is testing uncommitted work, that is the wrong
  // source — answer slowly about the right code rather than quickly about the wrong code.
  if (dirtyAllowed) {
    return { jobs: 1, why: '--allow-dirty tests the working tree, which a worktree at HEAD is not' };
  }
  if (sourceDirty) {
    return { jobs: 1, why: 'src/ or tests/ is dirty, so HEAD would not be what you are testing' };
  }
  return { jobs: Math.min(requested, mutationCount) };
}

function resolveJobs(mutations) {
  // Scoped to what can actually change a verdict: the code a mutation edits and the specs that
  // judge it. A dirty README or a package.json bump cannot, and refusing to parallelise over those
  // would mean the fast path is almost never available in a real working session.
  const dirty = spawnSync('git', ['status', '--porcelain', '--', 'src', 'tests'], { cwd: ROOT, encoding: 'utf8' });
  const { jobs, why } = planJobs({
    allowDirty,
    cores: availableParallelism(),
    explicit: Number(jobsArg),
    mutationCount: mutations.length,
    sourceDirty: Boolean((dirty.stdout ?? '').trim()),
  });
  if (why) process.stdout.write(`   (sequential: ${why})\n`);
  return jobs;
}

/**
 * Run the registry across `jobs` worktrees.
 *
 * Output is assembled in REGISTRY order, not completion order — a run whose report reshuffles
 * itself depending on machine timing is a run nobody can diff against the last one.
 */
function runParallel(mutations, jobs) {
  const base = mkdtempSync(join(tmpdir(), 'lt-mutations-'));
  process.stdout.write(`\nRunning ${mutations.length} mutations across ${jobs} worktrees\n`);

  const lanes = [];
  for (let i = 0; i < jobs; i++) {
    const dir = join(base, `w${i}`);
    const added = spawnSync('git', ['worktree', 'add', '--detach', dir, 'HEAD'], { cwd: ROOT, encoding: 'utf8' });
    if (added.status !== 0) {
      removeWorktrees();
      process.stderr.write(`\n!! Could not create worktree: ${added.stderr ?? ''}\nFalling back to sequential.\n`);
      return mutations.map((mutation) => runOne(mutation, ROOT, 1, true));
    }
    worktrees.push(dir);
    // pnpm's internal links are relative to node_modules, so one symlink serves every worktree —
    // no second install, no store duplication.
    symlinkSync(join(ROOT, 'node_modules'), join(dir, 'node_modules'));
    lanes.push(dir);
  }

  // Round-robin rather than contiguous slices: the expensive mutations are the e2e ones and they
  // cluster together in the registry, so a contiguous split would hand one worker all of them.
  const assigned = mutations.map((mutation, index) => ({ index, lane: index % jobs, mutation }));
  const settled = Array.from({ length: mutations.length });
  let done = 0;
  const workers = lanes.map((dir, lane) =>
    (async () => {
      for (const item of assigned.filter((entry) => entry.lane === lane)) {
        // `await` is load-bearing: without it this assigns the PENDING PROMISE, the lane never
        // waits, and all N mutations launch at once instead of N-at-a-time. The progress counter
        // then counts promises and reports a run that has not happened yet.
        settled[item.index] = await runOne(item.mutation, dir, jobs, false);
        done += 1;
        process.stdout.write(`   [${done}/${mutations.length}] ${item.mutation.id}\n`);
      }
    })(),
  );

  return Promise.all(workers).then(() => {
    removeWorktrees();
    for (const result of settled) process.stdout.write(result.log.join(''));
    return settled;
  });
}

/**
 * Run ONE mutation inside `cwd` and report whether its specs went red.
 *
 * Shared by the sequential and the parallel paths so the two cannot drift into answering the
 * question differently — the verdict logic exists once.
 *
 * `live` distinguishes the two callers: the sequential path mutates the developer's real working
 * tree, so it honours the dirty-file guard and registers the snapshot with the process-wide restore
 * handler. A worktree is disposable and checked out at HEAD, so neither applies there.
 */
async function runOne(mutation, cwd, jobs, live) {
  const file = resolve(cwd, mutation.file);
  const log = [`\n── ${mutation.id} ──\n   ${mutation.file}\n`];
  const emit = (line) => {
    log.push(line);
    if (jobs === 1) process.stdout.write(line);
  };

  if (live && !allowDirty && !gitIsClean(mutation.file)) {
    emit('   SKIPPED: uncommitted changes in the target file (--allow-dirty to override)\n');
    return {
      id: mutation.id,
      log,
      note: 'target file has uncommitted changes — re-run with --allow-dirty if that is expected',
      ok: false,
    };
  }

  const original = readFileSync(file, 'utf8');
  let mutated;
  try {
    mutated = applyMutation(original, mutation);
  } catch (error) {
    emit(`   STALE: ${error.message}\n`);
    return { id: mutation.id, log, note: `mutation is stale: ${error.message}`, ok: false };
  }

  if (live) originals.set(file, original);
  try {
    // Last-moment race check. Between reading the snapshot and writing the mutation another
    // process (a parallel agent, a watch-mode formatter) may have rewritten the file; restoring
    // the snapshot afterwards would silently discard that edit.
    if (readFileSync(file, 'utf8') !== original) {
      throw new Error('the target file changed while this mutation was being prepared');
    }
    writeFileSync(file, mutated);
    emit(`   applied, running ${mutation.specs.join(' ')}\n`);
    const { code, output } = await runSpecs(mutation.specs, cwd, jobs);
    const failedCount = output.match(/Tests\s+(\d+) failed/)?.[1];
    if (code === 0) {
      emit('   VACUOUS: the specs passed with the defect restored\n');
      return { id: mutation.id, log, note: 'specs stayed GREEN with the defect restored — vacuous', ok: false };
    }
    emit(`   OK: ${failedCount ?? 'some'} test(s) went red\n`);
    return { id: mutation.id, log, note: `${failedCount ?? 'some'} test(s) failed, as required`, ok: true };
  } finally {
    writeFileSync(file, original);
    if (live) originals.delete(file);
  }
}

async function main() {
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

  const jobs = resolveJobs(mutations);
  let results;
  if (jobs > 1) {
    results = await runParallel(mutations, jobs);
  } else {
    results = [];
    for (const mutation of mutations) {
      results.push(await runOne(mutation, ROOT, 1, true));
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
