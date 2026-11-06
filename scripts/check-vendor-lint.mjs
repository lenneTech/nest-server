#!/usr/bin/env node
/**
 * VENDOR LINT GATE — `pnpm run check:vendor-lint`, part of `check`.
 *
 * A vendor-mode project lints the core it copied with ITS OWN configuration: nest-server-starter's `.oxlintrc.json`
 * and `.oxlintignore`. This repository lints the same files with its own `.oxlintrc.json`. An exception that exists
 * here and not in the starter, or a rule the starter enables and this repository does not, is therefore green here
 * and a warning in every vendor project. The smoke test of 2026-11-05 found exactly that: four warnings in
 * `common/persistence/mongo/declared-schema.view.ts` and `common/persistence/sql/sql-session.ts`, repaired in the
 * starter after the fact. Nothing in this repository would have said so.
 *
 * So this script does what a vendor project's `pnpm run lint` does:
 *
 *   1. lays out what vendor mode copies the way the CLI's `convertCloneToVendored()` places it: everything under
 *      `src/core/` (`src/index.ts` -> `src/core/index.ts`, `src/test/` -> `src/core/test/`, ...), with the CLI's
 *      flatten-fix applied to the relative specifiers. The layout is not cosmetic: the starter scopes its exceptions
 *      for the core to `src/core/**`, and linted in place, `src/index.ts` would sit outside that glob;
 *   2. runs oxlint with the starter's configuration, `--type-aware` as the starter's `lint` script does, and
 *      `--deny-warnings`: the starter's own lint only reports warnings, so a warning is precisely what reaches every
 *      vendor project unnoticed.
 *
 * Where the starter's configuration comes from: the checkout named by `--starter=<path>` or NEST_SERVER_STARTER_PATH,
 * otherwise the starter's `main` on GitHub, which is what `lt fullstack init` gives a new project. An implicit sibling
 * checkout is deliberately NOT used: a stale one answers about a configuration nobody gets any more. When the
 * configuration cannot be read, the gate warns and passes locally (offline work stays possible) and FAILS under `CI`,
 * where a skip nobody reads would be indistinguishable from a check that ran (the rule `check-overrides.mjs` follows).
 *
 * Usage:
 *   pnpm run check:vendor-lint
 *   pnpm run check:vendor-lint -- --starter=/path/to/nest-server-starter
 */
import { spawnSync } from 'node:child_process';
import {
  cpSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const TAG = '[vendor-lint]';
const STARTER_RAW_URL = 'https://raw.githubusercontent.com/lenneTech/nest-server-starter/main';
const CONFIG_FILES = ['.oxlintrc.json', '.oxlintignore'];

/**
 * Where vendor mode puts each part of `src/` (the CLI's convertCloneToVendored, step 2). `src/templates/` is left out:
 * it holds EJS mail templates, which the CLI places outside `src/core/` and oxlint does not lint.
 */
const VENDOR_LAYOUT = [
  ['core', 'core'],
  ['index.ts', 'core/index.ts'],
  ['core.module.ts', 'core/core.module.ts'],
  ['test', 'core/test'],
  ['types', 'core/types'],
];

/**
 * The CLI's flatten-fix (convertCloneToVendored, step 3): specifiers that still point at the upstream layout. Lint
 * results of the untyped rules do not depend on them, but the type-aware ones do: an unresolved import types its
 * values as `any`, and `no-floating-promises` then misses every promise behind it.
 */
const FLATTEN_REWRITES = [
  { file: 'core/index.ts', from: /(\b(?:from|import)\s*['"])\.\/core\//g, to: '$1./' },
  { file: 'core/core.module.ts', from: /(\b(?:from|import)\s*['"])\.\/core\//g, to: '$1./' },
  { file: 'core/test/test.helper.ts', from: /(\bfrom\s*['"])\.\.\/core\//g, to: '$1../' },
  {
    file: 'core/common/interfaces/core-persistence-model.interface.ts',
    from: /(\bfrom\s*['"])\.\.\/\.\.\/\.\.(\/index(?:\.js)?)?(['"])/g,
    to: '$1../..$2$3',
  },
];

/**
 * Where a vendor project keeps a file this repository has at `relativeToSrc` (a path below `src/`, `/`-separated).
 * Returns `undefined` for a file vendor mode does not copy.
 */
export function vendorPath(relativeToSrc) {
  for (const [from, to] of VENDOR_LAYOUT) {
    if (relativeToSrc === from) {
      return to;
    }
    if (relativeToSrc.startsWith(`${from}/`)) {
      return `${to}${relativeToSrc.slice(from.length)}`;
    }
  }
  return undefined;
}

/** Copies the vendored part of `<root>/src` into `<work>/src` in the vendor layout and applies the flatten-fix. */
export function layoutVendorCopy(root, work) {
  for (const [from] of VENDOR_LAYOUT) {
    const source = join(root, 'src', from);
    if (existsSync(source)) {
      cpSync(source, join(work, 'src', vendorPath(from)), { recursive: true });
    }
  }
  for (const { file, from, to } of FLATTEN_REWRITES) {
    const path = join(work, 'src', file);
    if (existsSync(path)) {
      writeFileSync(path, readFileSync(path, 'utf8').replace(from, to));
    }
  }
}

/**
 * @typedef {(url: string, init?: { signal?: AbortSignal }) => Promise<{ ok: boolean, status: number, text: () => Promise<string> }>} FetchLike
 */

/**
 * Reads the starter's lint configuration: from a checkout when `starterPath` is given, from GitHub otherwise.
 * Resolves to `{ files, source }`, or to `{ error }` when the configuration cannot be read. Never throws.
 *
 * @param {{ fetchImpl?: FetchLike, starterPath?: string }} [options]
 * @returns {Promise<{ error?: string, files?: Record<string, string>, source?: string }>}
 */
export async function readStarterConfig({ fetchImpl = globalThis.fetch, starterPath } = {}) {
  if (starterPath) {
    const files = {};
    for (const name of CONFIG_FILES) {
      const path = join(starterPath, name);
      if (!existsSync(path)) {
        return { error: `${path} does not exist` };
      }
      files[name] = readFileSync(path, 'utf8');
    }
    return { files, source: starterPath };
  }
  const files = {};
  for (const name of CONFIG_FILES) {
    const url = `${STARTER_RAW_URL}/${name}`;
    try {
      const response = await fetchImpl(url, { signal: AbortSignal.timeout(15_000) });
      if (!response.ok) {
        return { error: `${url} answered ${response.status}` };
      }
      files[name] = await response.text();
    } catch (error) {
      return { error: `${url} is not reachable (${error?.cause?.code || error?.message || error})` };
    }
  }
  return { files, source: `${STARTER_RAW_URL} (nest-server-starter main)` };
}

/**
 * Lints the vendor copy of `root` with the starter configuration in `files`. Returns `{ output, status }`; status 0
 * means no error and no warning.
 *
 * @param {{ files: Record<string, string>, nodeModules?: string, root?: string }} options
 * @returns {{ output: string, status: number }}
 */
export function lintVendorCopy({ files, nodeModules = join(ROOT, 'node_modules'), root = ROOT }) {
  const work = mkdtempSync(join(tmpdir(), 'nest-server-vendor-lint-'));
  try {
    layoutVendorCopy(root, work);
    for (const [name, content] of Object.entries(files)) {
      writeFileSync(join(work, name), content);
    }
    // The starter's configuration names its schema at ./node_modules; the type-aware rules need the packages.
    symlinkSync(nodeModules, join(work, 'node_modules'), 'junction');
    // The starter is an ESM project (`"type": "module"`, module nodenext): its compiler options, as far as they
    // decide what the type-aware rules see.
    writeFileSync(
      join(work, 'package.json'),
      JSON.stringify({ name: 'vendor-lint-check', private: true, type: 'module' }),
    );
    writeFileSync(
      join(work, 'tsconfig.json'),
      JSON.stringify({
        compilerOptions: {
          allowJs: true,
          emitDecoratorMetadata: true,
          experimentalDecorators: true,
          isolatedModules: true,
          module: 'nodenext',
          moduleResolution: 'nodenext',
          noEmit: true,
          noImplicitAny: false,
          resolveJsonModule: true,
          skipLibCheck: true,
          strict: false,
          target: 'es2022',
          types: ['node', 'vitest/globals'],
        },
        include: ['src/**/*'],
      }),
    );
    const oxlint = join(nodeModules, 'oxlint', 'bin', 'oxlint');
    const result = spawnSync(
      process.execPath,
      [
        oxlint,
        '--type-aware',
        '--deny-warnings',
        // Without a terminal oxlint picks a compact format that drops the summary ("Found ... Finished in ... on <n>
        // files"), and both the file count below and the lint metrics in scripts/check.mjs read it.
        '--format=default',
        '--config',
        '.oxlintrc.json',
        '--ignore-path',
        '.oxlintignore',
        'src/',
      ],
      { cwd: work, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 },
    );
    return {
      output: `${result.stdout ?? ''}${result.stderr ?? ''}${result.error ? String(result.error) : ''}`,
      status: result.status ?? 1,
    };
  } finally {
    rmSync(work, { force: true, recursive: true });
  }
}

/**
 * The whole gate. Resolves to the exit code; writes its report through `log`.
 *
 * @param {{ ci?: boolean, fetchImpl?: FetchLike, log?: (line: string) => unknown, nodeModules?: string, root?: string,
 *   starterPath?: string }} [options]
 * @returns {Promise<number>}
 */
export async function runVendorLintGate({
  ci = Boolean(process.env.CI),
  fetchImpl,
  log = (line) => process.stdout.write(`${line}\n`),
  nodeModules,
  root = ROOT,
  starterPath,
} = {}) {
  const config = await readStarterConfig({ fetchImpl, starterPath });
  if (config.error) {
    if (ci) {
      log(`${TAG} FAIL — cannot read the starter's lint configuration: ${config.error}`);
      return 1;
    }
    log(`${TAG} SKIPPED — cannot read the starter's lint configuration: ${config.error}`);
    log(`${TAG}   Pass --starter=<path> to check against a local checkout. Under CI this is a failure.`);
    return 0;
  }
  const { output, status } = lintVendorCopy({ files: config.files, nodeModules, root });
  // oxlint ends with "Finished in <t> on <n> files ...". Zero files is a gate that checked nothing (a broken layout,
  // an ignore file that swallows src/): oxlint 1.90 exits 1 on it, and the report must then say why rather than claim
  // a lint finding.
  const fileCount = Number(/\bon (\d+) files?\b/.exec(output)?.[1] ?? Number.NaN);
  if (fileCount === 0) {
    log(output.trimEnd());
    log(`${TAG} FAIL — oxlint linted no file of the vendor copy, so nothing was checked.`);
    return 1;
  }
  if (status === 0) {
    const files = Number.isNaN(fileCount) ? 'file count not reported' : `${fileCount} files`;
    log(`${TAG} OK — the vendored core lints clean with the starter's configuration (${config.source}, ${files})`);
    return 0;
  }
  log(output.trimEnd());
  log(`${TAG} FAIL — the vendored core does not lint clean with the starter's configuration (${config.source}).`);
  log(`${TAG}   Paths are the vendor layout: src/core/index.ts, src/core/core.module.ts, src/core/test/ and`);
  log(`${TAG}   src/core/types/ are src/index.ts, src/core.module.ts, src/test/ and src/types/ in this repository.`);
  log(`${TAG}   Fix the code, or, when an exception in .oxlintrc.json is right, add it to the starter's`);
  log(`${TAG}   .oxlintrc.json in the same release: vendor projects lint with the starter's file, not with this one.`);
  return 1;
}

function isCliEntry() {
  const entry = process.argv[1];
  if (!entry) {
    return false;
  }
  try {
    return realpathSync(entry) === realpathSync(fileURLToPath(import.meta.url));
  } catch (err) {
    // "Cannot tell" must never read as "the gate passed".
    process.stderr.write(`${TAG} cannot resolve the CLI entry (${err?.code || err}) — refusing to report success\n`);
    process.exit(1);
  }
}

if (isCliEntry()) {
  const starterArg = process.argv.find((arg) => arg.startsWith('--starter='))?.slice('--starter='.length);
  const starterPath = starterArg ?? process.env.NEST_SERVER_STARTER_PATH;
  process.exitCode = await runVendorLintGate({ starterPath: starterPath ? resolve(starterPath) : undefined });
}

export { VENDOR_LAYOUT };
