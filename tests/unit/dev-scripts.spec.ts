/**
 * The Node replacements for the POSIX-only developer scripts (`test:cleanup`, `docs`).
 *
 * Ported from nest-server-starter (`tests/unit/dev-scripts.spec.ts`). Nothing here opens a browser:
 * the platform decision is a pure function and is asked for all three platforms. The only real side
 * effect is `cleanTestArtifacts`, and that runs on a temporary directory this test creates itself.
 */
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { ARTIFACT_EXTENSIONS, cleanTestArtifacts, isTestArtifact } from '../../scripts/clean-test-artifacts.mjs';
import { openPlan, resolveTarget } from '../../scripts/open.mjs';

describe('isTestArtifact — same semantics as the find command it replaces', () => {
  it('matches .txt, .bin and .png, dotfiles included', () => {
    for (const name of ['x.txt', 'y.bin', 'avatar-1.png', '.dot.txt', '.gitkeep.txt']) {
      expect(isTestArtifact(name), name).toBe(true);
    }
  });

  it('is case-sensitive like find -name, unlike rimraf --glob on macOS and Windows', () => {
    expect(isTestArtifact('UP.TXT')).toBe(false);
    expect(isTestArtifact('y.BIN')).toBe(false);
    expect(isTestArtifact('a.PNG')).toBe(false);
  });

  it('keeps .gitkeep and everything else', () => {
    for (const name of ['.gitkeep', 'keep.ts', 'x.txt.bak', 'txt']) {
      expect(isTestArtifact(name), name).toBe(false);
    }
  });

  it('removes the same extensions as the startup sweep in tests/global-setup.ts', () => {
    // Two lists of one fact: the sweep runs automatically, this script on demand. They must agree,
    // or `pnpm run test:cleanup` leaves behind what the next run's sweep then deletes (or the
    // reverse). Read from the source, because global-setup.ts cannot be imported without starting
    // the test infrastructure.
    const source = readFileSync(resolve(__dirname, '../global-setup.ts'), 'utf8');
    const declared = /const ARTIFACT_EXTENSIONS = \[([^\]]*)\]/.exec(source)?.[1];

    expect(declared, 'ARTIFACT_EXTENSIONS not found in tests/global-setup.ts').toBeDefined();
    const sweep = [...(declared ?? '').matchAll(/'([^']+)'/g)].map((match) => match[1]).sort();
    expect([...ARTIFACT_EXTENSIONS].sort()).toEqual(sweep);
  });
});

describe('cleanTestArtifacts', () => {
  let dir = '';
  afterEach(() => rmSync(dir, { force: true, recursive: true }));

  const tree = (root: string): string[] =>
    readdirSync(root, { recursive: true, withFileTypes: true })
      .map((entry) => relative(root, join(entry.parentPath, entry.name)).split('\\').join('/'))
      .sort();

  it('deletes artifacts in nested and hidden directories, and nothing else', () => {
    dir = mkdtempSync(join(tmpdir(), 'clean-test-artifacts-'));
    for (const sub of ['a/b', '.hidden', 'c.txt.d']) mkdirSync(join(dir, sub), { recursive: true });
    for (const file of ['x.txt', 'a/y.bin', 'a/b/z.png', '.hidden/h.txt', '.gitkeep', 'keep.ts', 'c.txt.d/inner.ts']) {
      writeFileSync(join(dir, file), '');
    }

    const deleted = cleanTestArtifacts(dir).map((path) => relative(dir, path).split('\\').join('/'));

    expect(deleted.sort()).toEqual(['.hidden/h.txt', 'a/b/z.png', 'a/y.bin', 'x.txt']);
    expect(tree(dir)).toEqual(['.gitkeep', '.hidden', 'a', 'a/b', 'c.txt.d', 'c.txt.d/inner.ts', 'keep.ts']);
  });

  it.skipIf(process.platform === 'win32')('leaves symlinks alone, like find -type f', () => {
    dir = mkdtempSync(join(tmpdir(), 'clean-test-artifacts-'));
    writeFileSync(join(dir, 'keep.ts'), '');
    symlinkSync('keep.ts', join(dir, 'link.txt'));

    expect(cleanTestArtifacts(dir)).toEqual([]);
    expect(tree(dir)).toEqual(['keep.ts', 'link.txt']);
  });
});

describe('openPlan', () => {
  it('uses open on macOS', () => {
    expect(openPlan('http://x/', 'darwin')).toEqual({ args: ['http://x/'], command: 'open' });
  });

  it('uses the URL protocol handler on Windows, never the cmd.exe builtin start', () => {
    expect(openPlan('http://x/', 'win32')).toEqual({
      args: ['url.dll,FileProtocolHandler', 'http://x/'],
      command: 'rundll32',
    });
  });

  it('uses xdg-open everywhere else', () => {
    expect(openPlan('http://x/', 'linux')).toEqual({ args: ['http://x/'], command: 'xdg-open' });
  });
});

describe('resolveTarget', () => {
  it('passes URLs through untouched', () => {
    expect(resolveTarget('http://127.0.0.1:8080/', '/proj')).toBe('http://127.0.0.1:8080/');
  });

  it('makes a file path absolute, because the Windows handler does not resolve it', () => {
    expect(resolveTarget('./public/index.html', '/proj')).toBe(resolve('/proj', 'public/index.html'));
  });
});
