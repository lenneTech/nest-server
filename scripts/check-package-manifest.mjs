#!/usr/bin/env node
/**
 * Verifies that what package.json PROMISES actually ships in the tarball.
 *
 * Two silent failure modes this catches — both produce a green `check` and a
 * broken release:
 *
 *   1. A `files` pattern that matches nothing. Rename `.claude/rules/` or move
 *      `src/`, and npm packs zero files for that entry without any warning. The
 *      published package is simply missing them — vendor mode (which consumes
 *      `src/**`) or the lt-dev agent rules then break in consuming projects,
 *      not here.
 *   2. `main` / `types` / `bin` pointing at a path that is not packed, e.g.
 *      after a build-output move. `check` builds into dist/ and is happy; the
 *      installed package cannot be required at all.
 *   3. A nested `package.json` that keeps a directory CommonJS inside this ESM
 *      package (`bin/`, `migrate/helpers/`) missing from the tarball or from
 *      dist/. Every file there then loads as ESM and dies on `require` — the
 *      migrate CLI and the `--compiler ts:` loader of every project.
 *   4. The built package not LOADING the way consumers load it: `require()` of
 *      the barrel from a CommonJS project (which can return a different export
 *      list than `import()` once a CommonJS module sits inside the ES module
 *      graph), the loader, the old helper path and the CLI. The suites import
 *      sources through vitest and never see any of that.
 *
 * Runs on the ALREADY BUILT tree (--ignore-scripts, no prepack) — so put it
 * after the build step in the `check` chain, where dist/ is fresh.
 *
 * Exit code: 0 when every promise holds, 1 otherwise.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));

let raw;
try {
  // One command STRING, not an args array: pnpm is a .cmd/.ps1/.exe shim on Windows,
  // which Node has refused to spawn directly since 20.12 (CVE-2024-27980) — hence the
  // shell. Node then deprecates passing args ALONGSIDE it (DEP0190), because it just
  // concatenates them unescaped. Every token here is a literal, so we write the line
  // out and there is nothing to escape.
  raw = execFileSync('npm pack --dry-run --ignore-scripts --json', {
    cwd: ROOT,
    encoding: 'utf8',
    shell: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
} catch (error) {
  console.error('[package-manifest] `npm pack --dry-run` failed:');
  console.error(`${error.stdout ?? ''}${error.stderr ?? ''}`.trim().split('\n').slice(-10).join('\n'));
  process.exit(1);
}

const packed = JSON.parse(raw)[0].files.map((f) => f.path);
const problems = [];

// 1. Every `files` entry must contribute at least one file.
for (const pattern of pkg.files ?? []) {
  const base = pattern.replace(/\/\*\*\/\*$/, '').replace(/\/\*$/, '');
  const hits = packed.filter((f) => f === base || f.startsWith(`${base}/`)).length;
  if (hits === 0) {
    problems.push(`files entry "${pattern}" matches nothing — it will ship empty`);
  }
}

// 2. Every advertised entry point must actually be in the tarball. This covers
// the `exports` map too — a subpath like "./testing" pointing at an unpacked
// file fails only in the consumer, on import.
function exportTargets(node, path = 'exports', out = []) {
  if (typeof node === 'string') {
    if (node.startsWith('./')) out.push([path, node]);
  } else if (node && typeof node === 'object') {
    for (const [key, value] of Object.entries(node)) exportTargets(value, `${path}.${key}`, out);
  }
  return out;
}

const entries = [
  ['main', pkg.main],
  ['types', pkg.types],
  ['module', pkg.module],
  ...Object.entries(pkg.bin ?? {}).map(([k, v]) => [`bin.${k}`, v]),
  ...exportTargets(pkg.exports),
];
for (const [label, target] of entries) {
  if (!target) continue;
  const path = String(target).replace(/^\.\//, '');
  if (!packed.includes(path)) {
    problems.push(`${label} -> "${target}" is not in the tarball`);
  }
}

// 3. Nested manifests: every package.json below bin/ and src/core/ ships, and the src/core ones also exist in dist/
// (nest-cli copies them as assets — without that, dist/ holds the files but not their module format).
function nestedManifests(dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).flatMap((entry) => {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) return entry === 'node_modules' ? [] : nestedManifests(path);
    return entry === 'package.json' ? [relative(ROOT, path).split(sep).join('/')] : [];
  });
}
for (const manifest of [...nestedManifests(join(ROOT, 'bin')), ...nestedManifests(join(ROOT, 'src', 'core'))]) {
  const required = manifest.startsWith('src/') ? [manifest, manifest.replace(/^src\//, 'dist/')] : [manifest];
  for (const path of required) {
    if (!packed.includes(path)) {
      problems.push(`${path} is not in the tarball — its directory would lose its module format`);
    }
  }
}

// 4. Load the built package the way consumers do, each in a fresh process (one module cache would hide a difference).
function run(args, label) {
  try {
    return execFileSync(process.execPath, args, { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (error) {
    const lines = `${error.stderr ?? ''}`.split('\n').map((line) => line.trim());
    problems.push(
      `${label} failed: ${lines.find((line) => /^\w*Error\b|^Error:/.test(line)) ?? lines.filter(Boolean).at(-1)}`,
    );
    return undefined;
  }
}
const KEYS =
  "JSON.stringify(Object.keys(m).filter((k) => !['__esModule', 'default', 'module.exports'].includes(k)).sort())";
const viaRequire = run(
  ['--input-type=commonjs', '-e', `const m = require('./dist/index.js'); console.log(${KEYS});`],
  'require() of dist/index.js',
);
const viaImport = run(
  ['--input-type=module', '-e', `const m = await import('./dist/index.js'); console.log(${KEYS});`],
  'import() of dist/index.js',
);
if (viaRequire && viaImport) {
  const required = JSON.parse(viaRequire);
  const imported = JSON.parse(viaImport);
  const missing = imported.filter((k) => !required.includes(k));
  const extra = required.filter((k) => !imported.includes(k));
  if (missing.length || extra.length || !required.includes('CoreModule')) {
    problems.push(
      `require() of dist/index.js exports ${required.length} names, import() ${imported.length}` +
        ` (missing: ${missing.slice(0, 5).join(', ') || '-'}; extra: ${extra.slice(0, 5).join(', ') || '-'})` +
        ' — a CommonJS module inside the ES module graph? See .claude/rules/architecture.md → Module Format',
    );
  }
}
const loader = run(
  ['--input-type=commonjs', '-e', "console.log(typeof require('./dist/core/modules/migrate/helpers/ts-compiler.js'))"],
  'require() of the TypeScript loader',
);
if (loader !== undefined && loader.trim() !== 'function') {
  problems.push(`dist/core/modules/migrate/helpers/ts-compiler.js exports a ${loader.trim()}, not the loader function`);
}
const forwarder = run(
  [
    '--input-type=commonjs',
    '-e',
    "const f = Object.keys(require('./dist/core/modules/migrate/helpers/migration.helper.js')).sort().join();" +
      "const h = Object.keys(require('./dist/core/modules/migrate/migration.helper.js')).filter((k) => k !== '__esModule').sort().join();" +
      'console.log(f === h && f.includes("createMigrationStore"));',
  ],
  'require() of the old migration.helper path',
);
if (forwarder !== undefined && forwarder.trim() !== 'true') {
  problems.push('dist/core/modules/migrate/helpers/migration.helper.js no longer forwards the migration helper API');
}
const cli = run(['bin/migrate.js', '--help'], 'bin/migrate.js --help');
if (cli !== undefined && !cli.includes('Usage:')) {
  problems.push('bin/migrate.js --help printed no usage');
}

if (problems.length > 0) {
  console.error('[package-manifest] the published package would be broken:\n');
  for (const p of problems) console.error(`  ✗ ${p}`);
  console.error(`\n  Inspect with: npm pack --dry-run --ignore-scripts`);
  process.exit(1);
}

console.log(
  `[package-manifest] ok — ${packed.length} files, every files entry and entry point resolves, the build loads via require() and import()`,
);
