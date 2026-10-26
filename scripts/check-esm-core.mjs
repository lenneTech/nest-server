#!/usr/bin/env node
/**
 * ESM guard for the core — `pnpm run check:esm`, part of `check`.
 *
 * The core's source must be valid as CommonJS (this package, CommonJS projects) AND as ESM (an ESM project — what
 * `nest new` creates since NestJS 12 — that vendors it). This repository builds CommonJS only, so nothing else here
 * would notice the source drifting out of the ESM subset: an extensionless relative import, an `import x = require()`,
 * a type re-exported without `export type`, a `require` / `module` / `__dirname` read at load time, a named import
 * that a CommonJS dependency does not provide to ESM.
 *
 * So this script does what an ESM vendor project does:
 *
 *   1. copies what vendor mode copies (`src/core`, `src/index.ts`, `src/core.module.ts`, `src/test`,
 *      `src/templates`, `src/types`) into a temporary package with `"type": "module"`;
 *   2. compiles it with `module: nodenext` — under that package type every file is ESM, so tsc applies the ESM
 *      rules (TS2835 for a missing extension, TS1202 for `import = require`, …);
 *   3. IMPORTS the compiled barrel with Node. Only this step sees what tsc cannot: link errors (`does not provide
 *      an export named …`) and ReferenceErrors at module evaluation.
 *
 * `migrate/helpers/ts-compiler.js` is left out: it is the CommonJS entry of the loader for CommonJS packages, and an
 * ESM project points at `ts-compiler.cjs` instead (a `.cjs` file is CommonJS in any package). The migration template is
 * project code and not compiled here.
 */
import { spawnSync } from 'node:child_process';
import {
  copyFileSync,
  cpSync,
  existsSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const ROOT = join(import.meta.dirname, '..');
const TAG = '[esm-core]';
const VENDORED = ['core', 'index.ts', 'core.module.ts', 'test', 'templates', 'types'];
const work = mkdtempSync(join(tmpdir(), 'nest-server-esm-core-'));

/** Copies every nested package.json from `from` to the same place under `to` (tsc does not). */
function copyNestedManifests(from, to) {
  for (const entry of readdirSync(from)) {
    const source = join(from, entry);
    if (statSync(source).isDirectory()) {
      copyNestedManifests(source, join(to, entry));
    } else if (entry === 'package.json' && existsSync(to)) {
      copyFileSync(source, join(to, entry));
    }
  }
}

function listJs(dir) {
  return readdirSync(dir).flatMap((entry) => {
    const path = join(dir, entry);
    return statSync(path).isDirectory() ? listJs(path) : path.endsWith('.js') ? [path] : [];
  });
}

function fail(message, output = '') {
  console.error(`${TAG} FAIL — ${message}`);
  if (output) {
    console.error(output.trim().split('\n').slice(0, 60).join('\n'));
  }
  process.exitCode = 1;
}

try {
  for (const entry of VENDORED) {
    const source = join(ROOT, 'src', entry);
    if (existsSync(source)) {
      cpSync(source, join(work, 'src', entry), { recursive: true });
    }
  }
  symlinkSync(join(ROOT, 'node_modules'), join(work, 'node_modules'), 'junction');
  writeFileSync(join(work, 'package.json'), JSON.stringify({ name: 'esm-core-check', private: true, type: 'module' }));
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
        outDir: 'out',
        rootDir: 'src',
        skipLibCheck: true,
        strict: false,
        target: 'es2022',
        types: ['node', 'vitest/globals'],
      },
      exclude: [
        'src/core/modules/migrate/helpers/ts-compiler.js',
        'src/core/modules/migrate/templates/migration-project.template.ts',
      ],
      include: ['src/**/*'],
    }),
  );

  const tsc = spawnSync(process.execPath, [join(ROOT, 'node_modules', 'typescript', 'bin', 'tsc'), '-p', work], {
    cwd: work,
    encoding: 'utf8',
  });
  if (tsc.status !== 0) {
    fail('the core does not compile as ESM (module: nodenext, "type": "module")', tsc.stdout + tsc.stderr);
  } else {
    // tsc emits no package.json, but a nested one decides the format of what was compiled next to it
    // (`migrate/helpers/package.json` keeps the TypeScript loader CommonJS). The real build copies it as an asset.
    copyNestedManifests(join(work, 'src'), join(work, 'out'));
    // Every compiled file as its own entry, in one process: a link error (`does not provide an export named …`) is
    // reported per module, so one run lists all of them; the barrel last, as the import a project actually makes.
    const files = listJs(join(work, 'out')).filter((file) => !file.endsWith(join('out', 'index.js')));
    const probe = `
      const files = ${JSON.stringify(files.map((file) => pathToFileURL(file).href))};
      const failures = [];
      for (const file of files) {
        try { await import(file); } catch (error) { failures.push(file.split('/out/')[1] + ': ' + String(error.message).split('\\n')[0]); }
      }
      let exportCount = 0;
      try { exportCount = Object.keys(await import(${JSON.stringify(pathToFileURL(join(work, 'out', 'index.js')).href)})).length; }
      catch (error) { failures.push('index.js: ' + String(error.message).split('\\n')[0]); }
      console.log(JSON.stringify({ exportCount, failures, modules: files.length }));
    `;
    const load = spawnSync(process.execPath, ['--input-type=module', '-e', probe], {
      cwd: work,
      encoding: 'utf8',
      env: { ...process.env, NODE_ENV: process.env.NODE_ENV || 'local' },
      maxBuffer: 32 * 1024 * 1024,
    });
    const result = (() => {
      try {
        return JSON.parse(load.stdout.trim().split('\n').pop());
      } catch {
        return undefined;
      }
    })();
    if (!result) {
      fail('the ESM-compiled core could not be probed', load.stderr || load.stdout);
    } else if (result.failures.length || !result.exportCount) {
      // A module that fails to link drags every importer down with it; the distinct messages name the causes.
      const causes = [...new Set(result.failures.map((line) => line.slice(line.indexOf(': ') + 2)))];
      fail(
        `${result.failures.length} of ${result.modules + 1} modules do not load as ESM — ${causes.length} distinct cause(s)`,
        causes.join('\n'),
      );
    } else {
      console.log(
        `${TAG} ok — the core compiles as ESM and all ${result.modules + 1} modules load (${result.exportCount} exports)`,
      );
    }
  }
} finally {
  rmSync(work, { force: true, recursive: true });
}
