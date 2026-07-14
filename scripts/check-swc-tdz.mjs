#!/usr/bin/env node
/**
 * SWC temporal-dead-zone guard.
 *
 * Loads the SWC-compiled output under Node's CommonJS loader — the one execution path where an
 * import cycle actually explodes, and the only one nothing else in this repo exercises:
 *
 *   - `nest build` / `pnpm run build` use **tsc**, whose emit tolerates these cycles.
 *   - vitest runs SWC through **Vite's module runner**, whose getter-based live bindings resolve a
 *     cycle lazily, so the temporal dead zone never opens. 2000+ green tests prove nothing here.
 *   - oxlint has no `import/no-cycle` rule.
 *
 * Consumers running `nest start -b swc` DO hit this path. A cycle that carries a class/const
 * dereferenced at module-evaluation time (a decorator argument, `design:type` metadata, a static
 * field initializer) throws:
 *
 *   ReferenceError: Cannot access 'X' before initialization
 *
 * WHY EVERY FILE IS LOADED SEPARATELY, NOT JUST THE BARREL
 * -------------------------------------------------------
 * Whether such a cycle throws depends on WHICH module the graph is entered through. Requiring only
 * the barrel is not enough — and this is not theoretical: `filter.input` ↔ `combined-filter.input`
 * crashed on a direct `require('.../combined-filter.input.js')` while the barrel loaded fine,
 * because the barrel happened to pull `filter.input` in first. A vendor-mode deep import, or a unit
 * test importing the input directly, would have hit the crash that a barrel-only check called green.
 *
 * So each compiled file is required as its OWN entry point, with our modules evicted from the
 * require cache in between. `node_modules` stays cached — the cycles we care about are inside this
 * repo, and re-evaluating the whole dependency tree per file would make the check unusably slow.
 *
 * WHY IT IS SHARDED, AND WHY IT IS NOT "SMART"
 * --------------------------------------------
 * Re-evaluating our module graph once per entry point is inherently O(files × closure). The work is
 * embarrassingly parallel and each shard is independent, so the file list is split across a few
 * forked children — a pure speedup, since every file is still loaded as its own entry point in a
 * pristine registry. The SEMANTICS are identical to a single-threaded sweep (verified: the sharded
 * run still catches the `combined-filter.input` crash).
 *
 * The obvious "real" optimisation would be to only use files that PARTICIPATE IN A CYCLE as entry
 * points — statically compute the strongly-connected components and test ~15 files instead of ~320.
 * That is deliberately NOT done. It would make this guard's correctness depend on a static cycle
 * analysis, and a blind spot in that analysis would not produce a wrong answer — it would produce a
 * GREEN one, on the single check that exists precisely because everything else in the pipeline is
 * already blind to this bug class. A guard whose job is to be unfoolable must not be clever.
 * Brute force is the feature.
 */
import { fork } from 'node:child_process';
import { existsSync, readdirSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { availableParallelism } from 'node:os';
import { dirname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const SELF = fileURLToPath(import.meta.url);
const ROOT = join(dirname(SELF), '..');
const DIST = join(ROOT, 'dist');

/**
 * Two kinds of file are deliberately not loaded. Both are excluded because requiring them proves
 * nothing about import cycles — NOT because they are inconvenient. Everything else that fails to
 * load is a real finding, and the skips are printed so "all green" can never quietly mean
 * "we didn't look".
 *
 *  - `/templates/` — code templates copied verbatim into consumer projects (`build:copy-templates`).
 *    They import `@lenne.tech/nest-server` by package name, which cannot resolve inside this repo,
 *    and they are never `require()`d here.
 *  - `main.js` — the server bootstrap. Its last line calls `bootstrap()`, so requiring it does not
 *    load a module graph, it STARTS A NEST SERVER (opens a Mongo connection, binds a port). Its
 *    entire import graph is covered anyway: every module it pulls in is checked individually.
 */
const EXCLUDED_DIR_SEGMENTS = ['/templates/'];
const EXCLUDED_FILES = [join(DIST, 'main.js')];

function isExcluded(file) {
  if (EXCLUDED_FILES.includes(file)) {
    return true;
  }
  const posix = file.split(sep).join('/');
  return EXCLUDED_DIR_SEGMENTS.some((segment) => posix.includes(segment));
}

function collectJsFiles(dir) {
  const found = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      found.push(...collectJsFiles(full));
    } else if (entry.endsWith('.js')) {
      found.push(full);
    }
  }
  return found;
}

// ---------------------------------------------------------------------------------------------
// Child: load an assigned slice, each file as its own entry point, and report failures over IPC.
// ---------------------------------------------------------------------------------------------
if (process.send && process.env.SWC_TDZ_SHARD) {
  const require = createRequire(SELF);
  const files = JSON.parse(process.env.SWC_TDZ_SHARD);
  const failures = [];

  /** Evict only OUR modules, so the next require re-evaluates them from a pristine registry. */
  const evictOwnModules = () => {
    for (const key of Object.keys(require.cache)) {
      if (key.startsWith(DIST)) {
        delete require.cache[key];
      }
    }
  };

  for (const file of files) {
    evictOwnModules();
    try {
      require(file);
    } catch (error) {
      failures.push({ file: relative(ROOT, file), message: error?.message ?? String(error) });
    }
  }

  process.send({ failures });
  process.exit(0);
}

// ---------------------------------------------------------------------------------------------
// Parent: shard the file list, fan out, aggregate.
// ---------------------------------------------------------------------------------------------
if (!existsSync(DIST)) {
  process.stderr.write('[swc-tdz] dist/ not found — run the SWC build first.\n');
  process.exit(1);
}

const allFiles = collectJsFiles(DIST).sort();
const excluded = allFiles.filter(isExcluded);
const files = allFiles.filter((file) => !isExcluded(file));

// Never let an exclusion pass silently — a skipped file must be visible, or "all green" is a lie.
for (const file of excluded) {
  process.stdout.write(`[swc-tdz] skipped (not a loadable library module): ${relative(ROOT, file)}\n`);
}

/**
 * Capped at 4 on purpose, not set to the core count.
 *
 * Each child pays a full cold load of `node_modules` (Nest, Mongoose, GraphQL) before it can start
 * its slice — a fixed, CPU- and IO-heavy cost that every extra shard pays AGAIN. Past ~4 children
 * that duplicated warm-up dominates and they start fighting for cores: measured on a 12-core box,
 * 12 shards (17s) was slower than running single-threaded (6s). Median wall-clock:
 *
 *   1 shard: 6.3s (unstable, 4.5–12s)   4 shards: 3.7s (stable, 3.5–4.5s)   12 shards: 17s
 *
 * Four is also the point where the sweep stops being the check's variance hot-spot, which matters
 * more than the raw seconds. Override with SWC_TDZ_SHARDS to re-measure on other hardware.
 */
const shardCount = Math.max(
  1,
  Math.min(Number(process.env.SWC_TDZ_SHARDS) || 4, availableParallelism(), files.length),
);
const shards = Array.from({ length: shardCount }, () => []);
files.forEach((file, index) => shards[index % shardCount].push(file));

const results = await Promise.all(
  shards.map(
    (shard) =>
      new Promise((resolve, reject) => {
        // stdio: discard the children's own output, keep only the IPC channel.
        //
        // Do NOT use `silent: true` here. That pipes child stdout/stderr to the parent, and loading
        // ~320 modules makes each child emit a torrent of Nest logger output ("Configured for: …",
        // guard registrations, config banners). Nothing in the parent drains those pipes, so once a
        // child fills the ~64 KB pipe buffer it BLOCKS on write, forever — the whole check hangs
        // with no error and no output. Discarding the streams outright removes the buffer, and the
        // results come back over IPC where they cannot be confused with log noise anyway.
        const child = fork(SELF, [], {
          env: { ...process.env, SWC_TDZ_SHARD: JSON.stringify(shard) },
          stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
        });

        let reported = null;
        child.on('message', (message) => {
          reported = message;
        });
        child.on('error', reject);
        child.on('exit', (code) => {
          if (reported) {
            resolve(reported.failures);
          } else {
            // A child that dies without reporting is itself a finding: some module in its slice took
            // the process down (a top-level crash, an `process.exit`, an OOM). Never swallow it.
            reject(new Error(`shard died without reporting (exit code ${code})`));
          }
        });
      }),
  ),
);

const failures = results.flat();

if (failures.length) {
  process.stderr.write(
    `\n[swc-tdz] ${failures.length} of ${files.length} modules failed to load under SWC/CommonJS:\n\n`,
  );
  for (const { file, message } of failures) {
    process.stderr.write(`  ✗ ${file}\n      ${message}\n`);
  }
  process.stderr.write(
    '\n  A "Cannot access \'X\' before initialization" means an import cycle is dereferenced at\n' +
      '  module-evaluation time (decorator argument, design:type metadata, static field initializer).\n' +
      '  Break the cycle — a lazy thunk is usually NOT enough, because emitDecoratorMetadata still\n' +
      '  emits an eager design:type. See .claude/rules/architecture.md.\n\n',
  );
  process.exit(1);
}

process.stdout.write(
  `[swc-tdz] ${files.length} modules load clean as standalone entry points (${shardCount} shards)\n`,
);
