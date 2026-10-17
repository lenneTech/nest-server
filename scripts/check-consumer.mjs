#!/usr/bin/env node
/**
 * PRE-PUBLISH CONSUMER GATE — build the tarball we are about to publish, install it into a
 * throwaway copy of `nest-server-starter`, and run the starter's own checks against it.
 *
 * WHY
 * ---
 * The starter is the first real consumer of this framework, and until now it only ever saw a
 * release AFTER it was published. Both defects that shipped in 11.33.0 and 11.33.1 were found there
 * — downstream, hours later, by a human. This gate moves that discovery in front of `npm publish`,
 * where it costs a re-run instead of a patch release.
 *
 * It is not a duplicate of `pnpm run check`. This repo's own suite exercises `src/server`, a
 * consumer that (by construction) tracks every framework change in the same commit. The starter is
 * the consumer that does NOT: it holds its own `ServerModule`, its own extended `Core*` classes and
 * its own `config.env.ts`, and it consumes `dist/` through the package's public entry points rather
 * than `src/` through relative paths. A change that compiles here and breaks a subclass there is
 * invisible to everything else in the pipeline — including `pnpm pack` itself, which is happy to
 * ship a tarball nothing has ever installed.
 *
 * WHAT IT ACTUALLY CATCHES, that nothing else does
 * ------------------------------------------------
 *   - a `files`/`exports` mistake that leaves something out of the tarball;
 *   - a widened or narrowed public signature that only a SUBCLASS notices;
 *   - a `devDependency` used at runtime by framework code (it resolves here, not there);
 *   - behaviour that changed under the starter's configuration rather than under this repo's.
 *
 * COST, and where it therefore runs
 * ---------------------------------
 * `pnpm pack` runs a full build, then the copy does a cold `pnpm install` and the starter's whole
 * check (lint, typecheck, unit + e2e, build, server start). That is minutes, not seconds — too slow
 * for every push. So it is wired into `.github/workflows/publish.yml` BEFORE the publish step, and
 * is available locally on demand. `--fast` trims it to the three steps that catch the class of
 * defect above (typecheck, build, tests) for use during development.
 *
 * The starter is COPIED, never used in place: the run rewrites `package.json`, installs, builds and
 * runs migrations. Doing that in a developer's working tree would be destructive.
 *
 * The copy is UPDATED the way a consumer updates, not just re-pointed. A starter-based project
 * moves to a new framework version with `pnpm run update` (the starter's extras/sync-packages.mjs),
 * which raises every pin the project already declares to the framework's version. A package the
 * framework ships (`dependencies`) is raised in whichever section the project keeps it: the starter
 * keeps `mongodb` as a devDependency, and Better-Auth's MongoDB adapter resolves its `mongodb` peer
 * from exactly that pin. Matching sections left it behind when mongoose 9.11 required mongodb ~7.7 —
 * two bson copies, sign-in answered 401, and the gate broke on 2026-10-06. A package the framework
 * only develops with (`devDependencies`, e.g. the better-auth trio) raises only the project's own
 * devDependencies, never a runtime pin the project owns (`RAISE_SOURCES`).
 * Re-pointing only the framework dependency tested a state no documented path produces — and one
 * that fails for EVERY release raising a shared exact pin: the starter kept `@nestjs/common` 11.2.1
 * while the tarball brought 11.2.6, `@nestjs/schedule` was installed twice, and `CronJobs extends
 * CoreCronJobs` stopped type-checking. That blocked 11.41.4 although the tarball was sound. The
 * gate cannot run sync-packages itself (it reads the npm registry, which does not have this version
 * yet), so `alignConsumerPins()` applies the same rule to the tarball's manifest and PRINTS every pin
 * it raised: those are exactly the pins a consumer has to raise too, and the migration guide must
 * say so.
 *
 * Usage:
 *   pnpm run check:consumer
 *   pnpm run check:consumer -- --fast
 *   pnpm run check:consumer -- --starter=/path/to/nest-server-starter
 *   pnpm run check:consumer -- --keep          leave the temp workspace for inspection
 *
 * Environment:
 *   NEST_SERVER_STARTER_PATH   default starter location (else ../nest-server-starter)
 */
import { spawnSync } from 'node:child_process';
import {
  cpSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const PACKAGE_NAME = '@lenne.tech/nest-server';
const DEPENDENCY_SECTIONS = ['dependencies', 'devDependencies'];

/** `[major, minor, patch]` for an exact `x.y.z`, else undefined — ranges, tags and prereleases never compare. */
function parseExactVersion(value) {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(String(value ?? '').trim());
  return match ? match.slice(1).map(Number) : undefined;
}

/** Positive when `a` is newer than `b`; 0 when equal or when either is not an exact version. */
function compareExactVersions(a, b) {
  const left = parseExactVersion(a);
  const right = parseExactVersion(b);
  if (!left || !right) {
    return 0;
  }
  for (let i = 0; i < 3; i++) {
    if (left[i] !== right[i]) {
      return left[i] - right[i];
    }
  }
  return 0;
}

/**
 * Which framework sections may raise a pin in each consumer section. What the framework SHIPS
 * (`dependencies`) must match wherever the consumer keeps it, or two copies end up in one tree. What
 * the framework only develops and tests with (`devDependencies` — e.g. the better-auth trio, whose
 * contract is the peer range) never sets a consumer's RUNTIME pin: the project owns those versions.
 */
const RAISE_SOURCES = {
  dependencies: ['dependencies'],
  devDependencies: ['dependencies', 'devDependencies'],
};

/** The newest exact version `framework` declares for `name` across `sections`, else undefined. */
function newestFrameworkVersion(framework, name, sections) {
  let newest;
  for (const section of sections) {
    const version = framework?.[section]?.[name];
    if (version !== undefined && (newest === undefined || compareExactVersions(version, newest) > 0)) {
      newest = version;
    }
  }
  return newest;
}

/**
 * Raise the consumer's pins the way its own `pnpm run update` does (the starter's
 * extras/sync-packages.mjs, rule in extras/align-package-versions.mjs): a package the consumer ALREADY
 * declares is raised to the framework's version when that is newer, in the section the consumer keeps
 * it. The framework's version comes from the sections `RAISE_SOURCES` allows for that consumer
 * section. Never lowered, never added, never moved to another section, never touched when either side
 * is not an exact version. Mutates `consumer` and returns what it raised.
 */
function alignConsumerPins(consumer, framework) {
  const raised = [];
  for (const section of DEPENDENCY_SECTIONS) {
    for (const [name, current] of Object.entries(consumer?.[section] ?? {})) {
      const version = newestFrameworkVersion(framework, name, RAISE_SOURCES[section]);
      if (name === PACKAGE_NAME || version === undefined) {
        continue;
      }
      if (compareExactVersions(version, current) > 0) {
        consumer[section][name] = version;
        raised.push({ from: current, name, section, to: version });
      }
    }
  }
  return raised;
}

/** Never copied into the throwaway workspace: rebuilt, irrelevant, or enormous. */
const SKIP_ENTRIES = new Set(['.git', '.idea', 'coverage', 'dist', 'node_modules', 'public', 'tmp']);

const args = process.argv.slice(2);
const fast = args.includes('--fast');
const keep = args.includes('--keep');
const starterArg = args.find((arg) => arg.startsWith('--starter='))?.slice('--starter='.length);

const STARTER = resolve(starterArg ?? process.env.NEST_SERVER_STARTER_PATH ?? join(ROOT, '..', 'nest-server-starter'));

/**
 * Set once the throwaway workspace exists.
 *
 * `fail()` terminates the process, which skips `finally` — so the "where to look" line has to be
 * emitted here rather than in a cleanup block that will not run. A failed gate deliberately KEEPS
 * the workspace: the interesting artefact is the consumer project in the state that broke.
 */
let workspacePath;

function fail(message) {
  process.stderr.write(`\n✗ ${message}\n`);
  if (workspacePath) {
    process.stderr.write(`  Workspace kept for inspection: ${workspacePath}\n`);
  }
  process.exit(1);
}

function step(label) {
  process.stdout.write(`\n── ${label} ──\n`);
}

function run(command, commandArgs, cwd, env = {}) {
  const result = spawnSync(command, commandArgs, {
    cwd,
    env: { ...process.env, ...env },
    stdio: 'inherit',
  });
  return result.status ?? 1;
}

function main() {
  if (!existsSync(join(STARTER, 'package.json'))) {
    fail(
      `No consumer project at ${STARTER}.\n` +
        '  Pass --starter=<path>, or set NEST_SERVER_STARTER_PATH.\n' +
        '  In CI, check the starter out first (see .github/workflows/publish.yml).',
    );
  }

  const version = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).version;
  const workspace = mkdtempSync(join(tmpdir(), 'nest-server-consumer-'));
  workspacePath = workspace;
  process.stdout.write(
    `Consumer gate for ${PACKAGE_NAME}@${version}\n  starter:   ${STARTER}\n  workspace: ${workspace}\n`,
  );

  try {
    // 1. Pack. `prepack` builds, so this is the artifact a publish would upload — not a
    //    stale dist/ left over from an earlier run.
    step('pnpm pack');
    if (run('pnpm', ['pack', '--pack-destination', workspace], ROOT) !== 0) {
      fail('pnpm pack failed');
    }
    const tarball = readdirSync(workspace).find((entry) => entry.endsWith('.tgz'));
    if (!tarball) {
      fail(`pnpm pack produced no tarball in ${workspace}`);
    }
    const tarballPath = join(workspace, tarball);
    process.stdout.write(`  packed ${tarball}\n`);

    // 2. Copy the consumer. Never in place — the run rewrites package.json and installs.
    step('copy consumer project');
    const consumer = join(workspace, basename(STARTER));
    cpSync(STARTER, consumer, {
      dereference: false,
      filter: (source) => {
        const relative = source.slice(STARTER.length + 1);
        return !relative.split('/').some((segment) => SKIP_ENTRIES.has(segment));
      },
      recursive: true,
    });
    process.stdout.write(`  copied to ${consumer}\n`);

    // 3. Point the dependency at the tarball.
    step(`install ${PACKAGE_NAME} from the tarball`);
    const manifestPath = join(consumer, 'package.json');
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
    const previous = manifest.dependencies?.[PACKAGE_NAME];
    if (!previous) {
      fail(`${basename(STARTER)} does not depend on ${PACKAGE_NAME} — is this really a consumer project?`);
    }
    manifest.dependencies[PACKAGE_NAME] = `file:${tarballPath}`;
    process.stdout.write(`  ${previous} -> file:${tarball}\n`);

    // 3b. Update the rest of the consumer the way `pnpm run update` would (see the header). The
    //     packed manifest IS this repo's package.json — `pnpm pack` does not rewrite versions.
    const raised = alignConsumerPins(manifest, JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')));
    if (raised.length) {
      process.stdout.write(
        `  raised ${raised.length} consumer pin(s) the way \`pnpm run update\` does — every consumer has to raise them too:\n`,
      );
      for (const { from, name, section, to } of raised) {
        process.stdout.write(`    ${section} ${name} ${from} -> ${to}\n`);
      }
    }
    writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

    // `--no-frozen-lockfile` because the manifest was just rewritten; the copy's lockfile is
    // regenerated here so the consumer's own `check` (which installs frozen) still passes.
    if (run('pnpm', ['install', '--no-frozen-lockfile'], consumer) !== 0) {
      fail('pnpm install failed in the consumer copy');
    }

    // 4. Prove the tarball is what got installed. Without this the whole gate can silently
    //    validate the previously published version from the pnpm store.
    step('verify the installed artifact');
    const installed = JSON.parse(readFileSync(join(consumer, 'node_modules', PACKAGE_NAME, 'package.json'), 'utf8'));
    if (installed.version !== version) {
      fail(`installed ${PACKAGE_NAME}@${installed.version}, expected ${version} — the tarball was not used`);
    }
    process.stdout.write(`  ${PACKAGE_NAME}@${installed.version} installed from the tarball\n`);

    // 5. Run the consumer's own checks.
    const chain = fast ? [['run', 'typecheck:tests'], ['run', 'build'], ['test']] : [['run', 'check']];
    for (const command of chain) {
      step(`consumer: pnpm ${command.join(' ')}`);
      if (run('pnpm', command, consumer) !== 0) {
        fail(
          `The consumer project failed \`pnpm ${command.join(' ')}\` against ${PACKAGE_NAME}@${version}.\n` +
            '  This is the gate doing its job — do not publish this build.',
        );
      }
    }

    process.stdout.write(`\n✓ ${basename(STARTER)} passes against ${PACKAGE_NAME}@${version}\n`);
  } finally {
    if (keep) {
      process.stdout.write(`\nWorkspace kept: ${workspace}\n`);
    } else {
      rmSync(workspace, { force: true, recursive: true });
    }
  }
}

/**
 * Whether `entry` (the CLI's `process.argv[1]`) names `moduleFile`. realpathSync on both sides,
 * because `import.meta.url` has its symlinks resolved and `argv[1]` does not — see
 * isSameCliEntry() in scripts/check.mjs for what a plain comparison cost.
 */
function isSameCliEntry(entry, moduleFile) {
  return realpathSync(entry) === realpathSync(moduleFile);
}

// Importable without launching a consumer run, same argv guard as the other scripts.
function isCliEntry() {
  const entry = process.argv[1];
  if (!entry) {
    return false;
  }
  try {
    return isSameCliEntry(entry, fileURLToPath(import.meta.url));
  } catch (err) {
    // "Cannot tell" must never read as "the consumer gate passed".
    process.stderr.write(
      `[check-consumer] cannot resolve the CLI entry (${err?.code || err}) — refusing to report success\n`,
    );
    process.exit(1);
  }
}

if (isCliEntry()) {
  main();
}

export { alignConsumerPins, isSameCliEntry, SKIP_ENTRIES, STARTER };
