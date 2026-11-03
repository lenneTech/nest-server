import { execFileSync, spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * This repository is public, and so is everything it ships (npm tarball, vendor-mode copies). The team's internal
 * working notes — the review agents' memory and the design plans of larger epics — live in a private repository and are
 * linked into `.claude/agent-memory` and `.claude/plans` as symlinks. Three properties keep them out of here:
 *
 * 1. Nothing below either directory is tracked.
 * 2. `.gitignore` ignores both paths AS A FILE, at the root and in any sub-directory. A symlink is a file to git, so
 *    the directory-only form (`.claude/agent-memory/`, the form this file had until 2026-11-01) does not match it, and
 *    `git add -A` would commit the link. The linking tool refuses to link without the right rule; this keeps the rule.
 * 3. No shipped text names a path into the notes, or a developer's home directory. A path into a directory the
 *    repository does not contain is a dead reference for every consumer.
 */
const ROOT = join(__dirname, '..', '..');

function tracked(...pathspecs: string[]): string[] {
  return execFileSync('git', ['ls-files', '-z', '--', ...pathspecs], { cwd: ROOT, encoding: 'utf8' })
    .split('\0')
    .filter(Boolean);
}

describe('public repository hygiene', () => {
  it('tracks no file of the internal notes', () => {
    expect(
      tracked(
        '.claude/agent-memory',
        '.claude/plans',
        ':(glob)**/.claude/agent-memory/**',
        ':(glob)**/.claude/plans/**',
      ),
    ).toEqual([]);
  });

  it.each(['.claude/agent-memory', '.claude/plans', 'projects/api/.claude/agent-memory'])(
    'ignores %s as a symlink (no trailing slash in the rule)',
    (path) => {
      const result = spawnSync('git', ['check-ignore', '-q', '--no-index', '--', path], { cwd: ROOT });
      expect(result.status, `${path} is not ignored as a file — use "**/${path.split('/').slice(-2).join('/')}"`).toBe(
        0,
      );
    },
  );

  it('names no path into the notes and no developer home directory in shipped text', () => {
    const shipped = tracked('CLAUDE.md', '.claude/rules', 'docs', 'migration-guides', 'src').filter((file) =>
      /\.(md|ts|mjs|cjs|js|json|ejs)$/.test(file),
    );
    expect(shipped.length).toBeGreaterThan(100);
    const offenders = shipped.flatMap((file) => {
      const text = readFileSync(join(ROOT, file), 'utf8');
      return [/\.claude\/plans\//, /\.claude\/agent-memory\/[\w-]/, /\/Users\/[a-z][\w.-]*\//]
        .filter((pattern) => pattern.test(text))
        .map((pattern) => `${file}: ${pattern}`);
    });
    expect(offenders).toEqual([]);
  });
});
