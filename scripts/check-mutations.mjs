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
 *   pnpm run check:mutations -- --no-infra      only the mutations that need no MongoDB
 *   pnpm run check:mutations -- --since=<ref>   only mutations touching files changed since <ref>
 *
 * `--no-infra` selects the 21 mutations whose specs are all unit specs — the unit runner has no
 * `globalSetup`, so those need no MongoDB and no test containers. It is a CAPABILITY filter, for a
 * machine that cannot start the infrastructure; it is not a "quick mode". When you are iterating on
 * one mutation, `--id=<id>` is both faster and more relevant.
 *
 * `--no-infra` and `--since` are for LOCAL work and are deliberately not wired into the publish
 * path. `--since` in particular is a HEURISTIC: it matches a mutation's own target file and
 * spec files, and does NOT follow what those specs transitively import or read at runtime. A
 * refactor three modules away can hollow out a test it will happily skip — which is exactly the
 * failure this tool exists to catch. Fast feedback while you work; never the evidence.
 *
 * Why the release gate still runs all 51 rather than caching per-mutation verdicts: the gate runs
 * ONCE PER RELEASE, not per commit, so the saving is ~10 minutes a release. The price would be a
 * cache that has to model each spec's full dependency closure correctly, and the failure mode of
 * getting that wrong is a stale PASS for a test that has since gone vacuous — the precise thing the
 * gate is there to prevent. Bad trade at 51 mutations. Revisit around 100, where the full run
 * approaches half an hour.
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
const noInfra = args.includes('--no-infra');
const since = args.find((arg) => arg.startsWith('--since='))?.slice('--since='.length);

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
  // Index arithmetic, NOT `window.replace(find, replace)`: String.replace interprets `$&`, `$1`
  // and `` $` `` in the REPLACEMENT even when the pattern is a plain string. A registry entry
  // containing one would write code the registry does not describe — and the run would then report
  // a verdict about a defect nobody introduced.
  const index = window.indexOf(mutation.find);
  return (
    source.slice(0, offset) + window.slice(0, index) + mutation.replace + window.slice(index + mutation.find.length)
  );
}

function gitIsClean(file) {
  const result = spawnSync('git', ['status', '--porcelain', '--', file], { cwd: ROOT, encoding: 'utf8' });
  return result.status === 0 && result.stdout.trim() === '';
}

function specEnv(specs, jobs) {
  const unit = specs.every((spec) => spec.startsWith('tests/unit/'));
  return {
    ...process.env,
    // Low-resource mode raises the e2e timeouts and caps `maxForks`. The parallel path deliberately
    // creates the very multi-run state `vitest-e2e.config.ts` auto-detects, so it must be ON there:
    // its own comment describes what starvation costs — requests queue past the 30s testTimeout,
    // auth comes back as spurious 401s, sockets hang up — symptoms that read like product bugs and,
    // before the INCONCLUSIVE verdict, would have been reported as confirmed evidence.
    //
    // The SEQUENTIAL path leaves the variable UNSET rather than forcing '0'. Forcing it off does not
    // merely decline low-resource mode, it DISABLES the auto-detection (`vitest-e2e.config.ts` only
    // computes `LOW_RESOURCE_AUTO` when the variable is undefined). "Nothing else is competing" is
    // true of this run, not of the machine: `countOtherActiveRuns()` exists precisely because
    // another lt project's e2e suite may be live, and forcing full speed against it reproduces the
    // spurious reds this tool exists to refuse.
    ...(jobs > 1 ? { CHECK_LOW_RESOURCE: process.env.CHECK_LOW_RESOURCE ?? '1' } : {}),
    // Each lane starts its own e2e vitest, and that config sizes `maxForks` from the TOTAL machine
    // cores — so without this every lane believes it owns the machine (12 cores, 4 lanes => 4 forks
    // each = 16 forks on 12 cores). Divide the machine between the lanes instead.
    ...(jobs > 1
      ? { CHECK_LOW_RESOURCE_FORKS: String(Math.max(1, Math.floor(availableParallelism() / (3 * jobs)))) }
      : {}),
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
    // `node_modules/.bin/vitest`, not `npx`: measured 0.04s vs 0.24s per spawn, and this runs once
    // per mutation.
    const child = spawn(
      join(ROOT, 'node_modules', '.bin', 'vitest'),
      ['run', '--config', specConfig(specs), ...specs],
      {
        cwd,
        env: specEnv(specs, jobs),
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );
    let output = '';
    child.stdout.on('data', (chunk) => (output += chunk));
    child.stderr.on('data', (chunk) => (output += chunk));
    child.on('error', (error) => resolveRun({ code: 1, output: `${output}\n${error.message}` }));
    child.on('close', (code) => resolveRun({ code: code ?? 1, output }));
  });
}

/**
 * Run the mutations one at a time in the real working tree.
 *
 * `live: true` — this path mutates the developer's own checkout, so it honours the dirty-file guard
 * and registers each snapshot with the process-wide restore handler.
 */
async function runSequential(mutations) {
  const results = [];
  for (const mutation of mutations) {
    results.push(await runOne(mutation, ROOT, 1, true));
  }
  return results;
}

/** Worktrees created for a parallel run — removed on every exit path. */
const worktrees = [];

/** The `mkdtemp` root holding the lane worktrees; removed with them. */
let worktreeBase;

function removeWorktrees() {
  let removalFailed = false;
  for (const dir of worktrees.splice(0)) {
    try {
      spawnSync('git', ['worktree', 'remove', '--force', dir], { cwd: ROOT });
      if (existsSync(dir)) rmSync(dir, { force: true, recursive: true });
    } catch {
      removalFailed = true;
      process.stderr.write(`\n!! Could not remove worktree ${dir} — run \`git worktree prune\`\n`);
    }
  }
  // The mkdtemp root itself, or every run leaves an empty `lt-mutations-*` behind in tmpdir().
  //
  // Skipped when a worktree removal failed: this is a RECURSIVE delete, so it would tear the
  // directory out from under git's `.git/worktrees/` admin files and turn the `git worktree prune`
  // the message above offers as a contingency into a certainty. A leftover temp directory is the
  // cheaper of the two problems.
  if (!removalFailed && worktreeBase && existsSync(worktreeBase)) {
    try {
      rmSync(worktreeBase, { force: true, recursive: true });
    } catch {
      // Best effort — an empty temp directory is not worth failing a run over.
    }
  }
  worktreeBase = undefined;
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
 * Files whose change can invalidate ANY mutation's verdict, so a `--since` selection cannot reason
 * about them piecemeal. Touch one and the only honest answer is "run everything".
 */
const GLOBAL_INPUTS = [
  'tests/regression-mutations.json',
  'tests/setup.ts',
  'tests/global-setup.ts',
  'tests/db-lifecycle.reporter.ts',
  'tests/e2e-run-slots.ts',
  'vitest.config.ts',
  'vitest-e2e.config.ts',
  'vitest.include-globs.ts',
  'scripts/check-mutations.mjs',
  'src/config.env.ts',
  'tsconfig.json',
  'package.json',
  'pnpm-lock.yaml',
];

/**
 * Directories whose every file is a global input.
 *
 * `tests/helpers/file-storage-matrix.ts` is the reason this exists: it IS the case list for the
 * storage-parity mutations, so editing it decides which `it()` blocks exist at all. A `--since`
 * selection that skipped it would miss "the test went vacuous because somebody edited the case
 * list, not the source" — the exact failure this tool was built to catch. `src/test/` is the same
 * argument for `test.helper.ts`, which every e2e spec's REST/GraphQL surface runs through.
 */
const GLOBAL_INPUT_DIRS = ['tests/helpers/', 'src/test/'];

/**
 * Narrow the registry for a LOCAL iteration run.
 *
 * ⚠️ This is a HEURISTIC, and deliberately not wired into the publish path. It selects on the
 * mutation's own target file and spec files — it does NOT follow what those specs transitively
 * import, nor what they read at runtime (`email-templates.spec.ts` reads `.ejs` files that appear
 * in no import graph). A refactor three modules away can hollow out a test this filter will happily
 * skip, and that is precisely the failure mode the whole tool exists to catch.
 *
 * So: use it while iterating, never as the evidence. The release gate runs the full registry.
 *
 * @param {object} options
 * @param {string[]} [options.changed] paths changed since the ref, repo-relative
 * @param {Array<{id: string, specs: string[], file: string}>} options.mutations
 * @param {boolean} [options.noInfra] keep only mutations that run without MongoDB (all-unit specs).
 *   Destructured under a different name so it cannot silently read the module-level flag if a caller
 *   forgets to pass it — the point of this function is that it is pure.
 * @returns {{ mutations: any[], notes: string[] }}
 */
export function selectMutations({ changed, mutations, noInfra: infraFree = false }) {
  const notes = [];
  let selected = mutations;

  if (infraFree) {
    // The unit runner has no `globalSetup`, so a mutation whose specs are all unit specs runs
    // without MongoDB or the Redis/S3 containers. That is what this filter is for — not speed.
    selected = selected.filter((mutation) => mutation.specs.every((spec) => spec.startsWith('tests/unit/')));
    notes.push(
      `--no-infra: ${selected.length} of ${mutations.length} mutations run without MongoDB; the other ${mutations.length - selected.length} were NOT checked`,
    );
  }

  if (changed) {
    const touchedGlobal = changed.filter(
      (file) => GLOBAL_INPUTS.includes(file) || GLOBAL_INPUT_DIRS.some((dir) => file.startsWith(dir)),
    );
    if (touchedGlobal.length) {
      notes.push(`--since: ${touchedGlobal.join(', ')} changed, which can affect any verdict — running the full set`);
      return { mutations: selected, notes };
    }
    const before = selected.length;
    selected = selected.filter(
      (mutation) => changed.includes(mutation.file) || mutation.specs.some((spec) => changed.includes(spec)),
    );
    notes.push(`--since: ${selected.length} of ${before} mutations touch changed files`);
    notes.push('   HEURISTIC — does not follow transitive imports. Not evidence; the release gate runs everything.');
  }

  return { mutations: selected, notes };
}

/**
 * Remove ANSI colour/style sequences from captured output.
 *
 * Anything that PARSES a spawned run's output must go through this: the same command is colourless
 * on a pipe locally and colourised on a CI runner, so a regex tested locally can be reliably wrong
 * in exactly the place where the answer matters.
 */
export function stripAnsi(text) {
  return String(text ?? '').replace(/\u001b\[[0-9;]*m/g, '');
}

/**
 * Turn one vitest run into a verdict — pure, so the rule can be tested without running vitest.
 *
 * Three outcomes, and the third is the one that matters:
 *
 * - `code === 0` — the specs stayed green with the defect restored. VACUOUS: the test proves nothing.
 * - non-zero WITH a reported failing count — the specs went red. That is the evidence we want.
 * - non-zero WITHOUT one — INCONCLUSIVE, not evidence. vitest also exits non-zero when it crashed,
 *   timed out, could not collect a spec, or was starved of resources, and this tool exists to stop
 *   exactly that from reading as a pass. Parallel runs make it reachable: several e2e suites on one
 *   machine is the documented starvation scenario, whose symptoms (spurious 401s, `socket hang up`)
 *   look like product failures. So require ACTUAL FAILING TESTS; anything else needs a human.
 *
 * @param {{ code: number, output: string }} run
 * @returns {{ evidence?: string, label: string, note: string, ok: boolean }} `evidence` is present
 *   only on a verdict that needs explaining — a passing one has nothing to explain.
 */
export function classifyRun({ code, output }) {
  // Strip ANSI first. vitest COLOURS its summary on a CI runner, so the raw line carries escape
  // sequences between `Tests` and the number — and `\s+` matches whitespace only, never an escape
  // sequence. Not hypothetical: it made every one of 51 mutations INCONCLUSIVE while the specs had
  // gone red exactly as required.
  //
  // Worth knowing WHY this surfaced only now: the previous verdict was `failedCount ?? 'some'` with
  // `ok: true` on any non-zero exit, so it never needed the count. The regex was already blind to
  // colour — the gate simply accepted a crash, a timeout or a collection error as "went red". The
  // strict count is the fix; this is what the fix depends on.
  const text = stripAnsi(String(output ?? ''));
  const failedCount = text.match(/Tests\s+(\d+) failed/)?.[1];
  if (code === 0) {
    return {
      evidence: tailOf(text),
      label: 'VACUOUS: the specs passed with the defect restored',
      note: 'specs stayed GREEN with the defect restored — vacuous',
      ok: false,
    };
  }
  if (!failedCount) {
    return {
      evidence: tailOf(text),
      label: `INCONCLUSIVE: the run exited ${code} but reported no failing tests — crash, timeout or collection error`,
      note: 'run exited non-zero without reporting failing tests — inconclusive, re-run this one alone',
      ok: false,
    };
  }
  return {
    label: `OK: ${failedCount} test(s) went red`,
    note: `${failedCount} test(s) failed, as required`,
    ok: true,
  };
}

/**
 * The last few lines of a captured run, for a verdict that needs explaining.
 *
 * WHY THIS EXISTS: `INCONCLUSIVE` was added so a crashed or starved run could not be counted as
 * evidence — correct, but it left the operator with a verdict and nothing to act on. That cost a
 * release: the gate reported `0/51 mutations confirmed` on a CI runner, every one of them
 * inconclusive, and the vitest output that would have said WHY had been captured into a variable
 * and thrown away. A refusal has to carry its reason, or the next person is where I was.
 *
 * Bounded deliberately: 51 mutations x a full vitest log would bury the summary that matters.
 */
export function tailOf(output, lines = 25) {
  const trimmed = stripAnsi(String(output ?? '')).trimEnd();
  if (!trimmed) return '(no output captured)';
  const all = trimmed.split('\n');
  const tail = all.slice(-lines);
  return (all.length > lines ? [`… ${all.length - lines} earlier line(s) omitted`, ...tail] : tail).join('\n');
}

/**
 * Resolve a `--since` value to a full SHA, refusing anything git would read as an OPTION.
 *
 * Pure apart from the `git rev-parse` it delegates to, which is injectable so the refusal itself can
 * be tested without a repository.
 *
 * WHY: git parses a leading dash as an option, not a ref, so an unvalidated value reaches
 * `--output=<path>` — which TRUNCATES and overwrites that file before git validates anything else
 * (verified: the target's contents are replaced by the diff even when git then errors). `-O<file>`
 * is reachable the same way. Harmless while a developer types the ref by hand; not harmless the
 * moment a hook, a CI job or an agent passes `$GITHUB_BASE_REF` or a branch name through.
 *
 * @param {string} value the raw `--since=` argument
 * @param {(ref: string) => { status: number, stdout?: string }} [revParse] injectable resolver
 * @returns {{ ok: true, sha: string } | { ok: false, reason: string }}
 */
export function resolveSinceRef(value, revParse) {
  if (typeof value !== 'string' || value === '' || value.startsWith('-')) {
    return { ok: false, reason: `\`${value}\` is not a valid ref — a leading dash would be read by git as an option.` };
  }
  const run =
    revParse ?? ((ref) => spawnSync('git', ['rev-parse', '--verify', '--quiet', ref], { cwd: ROOT, encoding: 'utf8' }));
  const verified = run(`${value}^{commit}`);
  const sha = (verified.stdout ?? '').trim();
  if (verified.status !== 0 || !/^[0-9a-f]{40}$/.test(sha)) {
    return { ok: false, reason: `\`${value}\` is not a commit this repository knows.` };
  }
  return { ok: true, sha };
}

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
  // Sizing is core-proportional because each lane is CPU-BOUND, not I/O-bound. That much the data
  // does support: 12 cores / 4 jobs -> 1.87x and 4 vCPU / 2 jobs -> 1.10x, whereas single-threaded
  // cold-start I/O — as an earlier version of this comment claimed — would have returned ~1.8x on
  // the second. What the data does NOT pin is a per-lane core figure: two points on two different
  // machines cannot, and 47% efficiency at 4 lanes argues against the tidy "~2-3 cores each" story.
  // `cores / 3` is therefore an EMPIRICAL setting, not a derived one. Capped at 4 because past that
  // the lanes only fight each other.
  //
  // ⚠ Both speed-ups were measured while `specEnv` forced `CHECK_LOW_RESOURCE='0'`. It no longer
  // does — the parallel path now enables low-resource mode and divides `maxForks` between the lanes,
  // which is a correctness fix (see `specEnv`) that necessarily costs wall clock. Treat 1.87x as a
  // historical upper bound and re-measure before quoting it.
  //
  // The floor of 2 is a deliberate trade and the weakest part of this heuristic: on a 4-vCPU runner
  // the formula says 1, and forcing 2 buys ~10% while over-subscribing the machine. It is kept
  // because that runner is where the wall clock hurts most — but if starvation ever shows up in CI,
  // this floor is the first thing to drop.
  // An explicit --jobs is capped too. `LT_E2E_MAX_RUNS` is raised to the lane count, and that slot
  // directory is MACHINE-WIDE, shared with every other lt project and session — an unbounded
  // `--jobs=50` would evict the concurrency protection other people are relying on.
  const requested =
    Number.isInteger(explicit) && explicit > 0
      ? Math.min(explicit, 8)
      : Math.min(4, Math.max(2, Math.floor(cores / 3)));
  // Worktree setup costs real time; below two mutations per lane the run finishes before the
  // parallelism pays for itself.
  if (requested === 1 || mutationCount < 2) return { jobs: 1 };
  if (mutationCount < requested * 2) {
    return { jobs: Math.max(1, Math.floor(mutationCount / 2)) };
  }

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
  worktreeBase = base;
  process.stdout.write(`\nRunning ${mutations.length} mutations across ${jobs} worktrees\n`);

  const lanes = [];
  for (let i = 0; i < jobs; i++) {
    const dir = join(base, `w${i}`);
    const added = spawnSync('git', ['worktree', 'add', '--detach', dir, 'HEAD'], { cwd: ROOT, encoding: 'utf8' });
    if (added.status !== 0) {
      removeWorktrees();
      process.stderr.write(`\n!! Could not create worktree: ${added.stderr ?? ''}\nFalling back to sequential.\n`);
      // `runSequential`, NOT `mutations.map(runOne)`: `runOne` is async, so a bare `map` returns
      // PENDING PROMISES. `main()` awaits this function, and awaiting a plain array yields that
      // array unchanged — every `result.ok` would read `undefined`, every mutation would print FAIL,
      // and the gate would exit 1 having verified nothing. It would also run all N concurrently
      // against ROOT, the developer's real working tree, which is the very interference the
      // worktrees exist to prevent.
      return runSequential(mutations);
    }
    worktrees.push(dir);
    // pnpm's internal links are relative to node_modules, so one symlink serves every worktree —
    // no second install, no store duplication.
    symlinkSync(join(ROOT, 'node_modules'), join(dir, 'node_modules'));
    lanes.push(dir);
  }

  // A SHARED CURSOR, not a fixed assignment. Mutation cost is bimodal — a unit mutation is ~3s, an
  // e2e one ~20s — so any static split lets the unluckiest lane set the wall clock while the others
  // idle. Round-robin fixes the clustering but not the variance; pulling work on demand fixes both.
  let cursor = 0;
  const settled = Array.from({ length: mutations.length });
  let done = 0;
  const workers = lanes.map((dir) =>
    (async () => {
      for (let index = cursor++; index < mutations.length; index = cursor++) {
        const item = { index, mutation: mutations[index] };
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

  let applied = false;
  try {
    // Last-moment race check. Between reading the snapshot and writing the mutation another process
    // (a parallel agent, a watch-mode formatter, an editor autosave) may have rewritten the file.
    //
    // RETURN, do not throw: an exception here would unwind into the `finally` below, which writes
    // the snapshot back — silently destroying exactly the concurrent edit this check exists to
    // protect. Nothing has been written at this point, so there is nothing to restore. This is not
    // hypothetical in this repo: concurrent sessions edit `src/` while a review runs.
    if (readFileSync(file, 'utf8') !== original) {
      emit('   SKIPPED: the target file changed while this mutation was being prepared\n');
      return { id: mutation.id, log, note: 'target file changed mid-run — re-run this one', ok: false };
    }
    // Registered AFTER the race check and immediately before the write, so the signal handler can
    // never hold a snapshot for a file this process has not modified. Registering it earlier left a
    // one-`readFileSync` window in which a SIGINT would have restored our snapshot over somebody
    // else's edit — the same data loss the check above exists to prevent, by a different route.
    if (live) originals.set(file, original);
    writeFileSync(file, mutated);
    applied = true;
    emit(`   applied, running ${mutation.specs.join(' ')}\n`);
    const { code, output } = await runSpecs(mutation.specs, cwd, jobs);
    const verdict = classifyRun({ code, output });
    emit(`   ${verdict.label}\n`);
    // A failing verdict without its reason is what made the 11.36.3 CI failure undiagnosable.
    if (verdict.evidence) {
      emit(`${verdict.evidence.replace(/^/gm, '   | ')}\n`);
    }
    return { id: mutation.id, log, note: verdict.note, ok: verdict.ok };
  } finally {
    // Only restore what we actually wrote — see the race check above.
    if (applied) {
      writeFileSync(file, original);
    }
    if (live) originals.delete(file);
  }
}

async function main() {
  const registry = JSON.parse(readFileSync(REGISTRY, 'utf8'));
  let changed;
  if (since) {
    // Resolve to a SHA before it reaches `git diff` — see `resolveSinceRef` for why a raw value is
    // dangerous here.
    const resolved = resolveSinceRef(since);
    if (!resolved.ok) {
      process.stderr.write(`${resolved.reason}\n`);
      process.exit(1);
    }
    const { sha } = resolved;
    // Trailing `--` so the SHA cannot be re-read as a pathspec either.
    const diff = spawnSync('git', ['diff', '--name-only', sha, '--'], { cwd: ROOT, encoding: 'utf8' });
    if (diff.status !== 0) {
      process.stderr.write(`Could not diff against \`${since}\`: ${diff.stderr ?? ''}\n`);
      process.exit(1);
    }
    changed = (diff.stdout ?? '').split('\n').filter(Boolean);
  }
  const { mutations, notes } = selectMutations({
    changed,
    mutations: registry.mutations.filter((mutation) => !only || mutation.id === only),
    noInfra,
  });
  for (const note of notes) process.stdout.write(`${note}\n`);

  if (!mutations.length) {
    if (since || noInfra) {
      process.stdout.write(
        '\nNothing selected — no mutation matches the filters. This is NOT a pass.\n' +
          'Exit code 2 (= "no verdict"), so a wrapper or `&&` chain cannot read it as one.\n',
      );
      process.exit(2);
    }
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
  results = jobs > 1 ? await runParallel(mutations, jobs) : await runSequential(mutations);

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
