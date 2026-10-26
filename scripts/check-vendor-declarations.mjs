#!/usr/bin/env node
/**
 * Vendor-mode compile guard — `pnpm run typecheck:vendor`, part of `check`.
 *
 * Vendor-mode projects copy `src/core/` into their own tree and compile it with THEIR tsconfig, which
 * for a starter-based project is `module: commonjs` with `declaration: true`. This repo builds with
 * `nodenext`. Two things can pass here and break there, and both happened in 12.0.0:
 *
 *   1. Type errors that only exist under `module: commonjs` (bundler resolution, `import()` emitted as
 *      `require()`): a type taken with `resolution-mode: 'import'` (TS2322), a derived SDK class type in
 *      a protected signature that the declaration emit cannot name (TS2883).
 *   2. Declarations that only name a type because THIS repo's `node_modules` is hoisted. In a consumer's
 *      isolated pnpm layout the same reference fails (TS2883 — `loadOAuthErrors()` returned a module type
 *      derived from an `import()`; measured by the lt CLI session in a real vendor project). tsc cannot
 *      see that from here, because here the reference resolves.
 *
 * So this script compiles `src/` with tsconfig.vendor-commonjs.json, EMITS the declarations into a
 * temporary directory and fails on (1) any compiler error and (2) any declaration that names a type
 * through a module rather than through an exported type:
 *
 *   - `typeof import("<package>…")` — a whole package module's type in a signature (the form of the 12.0.0 MCP
 *     defect); a relative `typeof import("./…")` names a file of this package and is portable;
 *   - `import("<package>/…/dist/…")` — a path into a package's build output, which an `exports` map or
 *     an isolated layout breaks.
 *
 * The fix in both cases is a structural interface the signature returns instead (`IBrevoSdkClient`,
 * `IMcpOAuthErrorClasses`), or an explicit public return type. See .claude/rules/architecture.md →
 * "Module Format".
 */
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';

const ROOT = join(import.meta.dirname, '..');
const TAG = '[vendor-declarations]';
const outDir = mkdtempSync(join(tmpdir(), 'nest-server-vendor-dts-'));

/** Declaration references that only resolve in a hoisted layout, or only under one module format. */
const NON_PORTABLE = [
  // A PACKAGE's module type. A relative one (`typeof import("./ts-compiler.cjs")`, what a JavaScript file that
  // re-exports a sibling declares) names a file inside this package and resolves the same in any layout.
  { label: 'module type in a signature', pattern: /typeof import\("(?![./])[^"]+"\)/g },
  { label: 'path into a package build', pattern: /import\("(?![./])[^"]*\/dist\/[^"]*"\)/g },
];

function declarationFiles(dir) {
  return readdirSync(dir).flatMap((entry) => {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) {
      return declarationFiles(path);
    }
    return path.endsWith('.d.ts') ? [path] : [];
  });
}

try {
  const tsc = spawnSync(
    process.execPath,
    [
      join(ROOT, 'node_modules', 'typescript', 'bin', 'tsc'),
      '-p',
      join(ROOT, 'tsconfig.vendor-commonjs.json'),
      '--noEmit',
      'false',
      '--emitDeclarationOnly',
      '--outDir',
      outDir,
      '--rootDir',
      join(ROOT, 'src'),
    ],
    { cwd: ROOT, encoding: 'utf8' },
  );
  const errors = `${tsc.stdout}${tsc.stderr}`.split('\n').filter((line) => line.includes('error TS'));
  if (tsc.status !== 0 || errors.length) {
    console.error(`${TAG} FAIL — src/ does not compile the way a vendor-mode project compiles it:`);
    console.error(errors.length ? errors.join('\n') : `${tsc.stdout}${tsc.stderr}`);
    process.exit(1);
  }

  const findings = [];
  for (const file of declarationFiles(outDir)) {
    const text = readFileSync(file, 'utf8');
    for (const { label, pattern } of NON_PORTABLE) {
      for (const match of text.matchAll(pattern)) {
        findings.push(`  ${relative(outDir, file)}: ${label} — ${match[0]}`);
      }
    }
  }
  if (findings.length) {
    console.error(
      `${TAG} FAIL — declarations that break in a consumer's isolated pnpm layout or under an exports map:`,
    );
    console.error(findings.join('\n'));
    console.error('  Return a structural interface instead (see the header of this script).');
    process.exit(1);
  }
  console.log(`${TAG} ok — src/ compiles under module: commonjs, and every declaration names its types portably`);
} finally {
  rmSync(outDir, { force: true, recursive: true });
}
