import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Guards the assumption that makes an audit suppression defensible.
 *
 * `auditConfig.ignoreGhsas` in `pnpm-workspace.yaml` takes a bare GHSA id — pnpm
 * offers no path, package or dev/prod scoping. So an entry added for a dev-only
 * finding silently keeps suppressing that advisory if it later appears on a
 * PRODUCTION path, and `pnpm audit` (a blocking gate in `.github/workflows/build.yml`)
 * would stay green. The written justification is the only thing holding it, and a
 * comment cannot fail a build.
 *
 * This spec turns that justification into an assertion: the moment a suppressed
 * advisory's package reaches the production tree, the build fails and the entry
 * has to be re-argued or removed.
 *
 * Reads the lockfile via `pnpm why` — no network, no install.
 */

const ROOT = join(__dirname, '../..');

/** Packages whose advisories are currently suppressed, and must stay dev-only. */
const DEV_ONLY_SUPPRESSIONS = [
  {
    // GHSA-mh99-v99m-4gvg — unbounded expansion (OOM). Patched only in 5.0.8;
    // 1.1.16 has no length guard. The remaining path is
    // @nestjs/cli > fork-ts-checker-webpack-plugin > minimatch@3 > brace-expansion@1,
    // which cannot be lifted (minimatch@10 has no callable default export).
    ghsa: 'GHSA-mh99-v99m-4gvg',
    pkg: 'brace-expansion',
    vulnerableInProd: /^brace-expansion@[12]\./m,
  },
];

describe('audit suppressions stay within their justification', () => {
  const workspace = readFileSync(join(ROOT, 'pnpm-workspace.yaml'), 'utf8');

  it('suppresses only the advisories this spec knows about', () => {
    // A new entry must come with a matching guard here, or it is unguarded by
    // definition — which is the failure mode this file exists to prevent.
    const listed = Array.from(workspace.matchAll(/^\s*-\s*(GHSA-[\w-]+)\s*$/gm)).map((m) => m[1]);
    expect(listed.sort()).toEqual(DEV_ONLY_SUPPRESSIONS.map((s) => s.ghsa).sort());
  });

  for (const { ghsa, pkg, vulnerableInProd } of DEV_ONLY_SUPPRESSIONS) {
    it(`keeps ${pkg} (${ghsa}) out of the production dependency tree`, () => {
      // `--prod` walks `dependencies` only. If the vulnerable major shows up
      // here, the "dev tooling only, no consumer and no runtime reaches it"
      // argument behind the suppression no longer holds.
      const out = execFileSync('pnpm', ['why', pkg, '--prod'], {
        cwd: ROOT,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      });

      expect(out).not.toMatch(vulnerableInProd);
    }, 60_000);
  }
});
