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

/**
 * Packages whose advisories are currently suppressed, and must stay dev-only.
 *
 * Empty since 2026-09-03, and the entry that used to be here is worth keeping in
 * view — it shows what this spec does NOT cover.
 *
 * GHSA-mh99-v99m-4gvg (brace-expansion, unbounded expansion → OOM) was suppressed
 * on 2026-07-28 with a justification that was accurate in every detail: the newest
 * 1.x was 1.1.16 and carried no length guard, and the one remaining path
 * (@nestjs/cli > fork-ts-checker-webpack-plugin > minimatch@3 > brace-expansion@1)
 * could not be lifted, because minimatch@10 has no callable default export.
 *
 * 1.1.17 — the backport the entry said did not exist — was published on 2026-07-29.
 * ONE DAY later. The `brace-expansion@<1.1.18 -> 1.1.18` override has been resolving
 * that path to a patched version ever since, and `pnpm audit` is green with the
 * suppression removed. It sat here obsolete for five weeks.
 *
 * THE GAP THIS SPEC LEAVES: it asks "is the justification still in scope?" — is the
 * package still dev-only — and answers that well. It cannot ask "is the
 * justification still TRUE?", because upstream publishing a backport changes
 * nothing in this repo. Nothing here moves, so nothing here fails. A suppressed
 * advisory is also removed from `pnpm audit --json` entirely (`advisories` drops
 * it, `muted` comes back empty), so the audit cannot notice either.
 *
 * Closing that gap needs a check against the advisory upstream — a GHSA that gains
 * a `first_patched_version` or is withdrawn makes its suppression obsolete. That
 * belongs in a guard with network access, not in a unit test.
 *
 * THAT GUARD NOW EXISTS: `scripts/check-overrides.mjs` (`pnpm run check:overrides`)
 * re-checks every listed GHSA against the GitHub Advisory API and fails on FIX
 * AVAILABLE or a withdrawal. It runs inside `check` and in CI. So the two halves are
 * split on purpose and neither should grow the other's job: this spec answers "is the
 * justification still in SCOPE?" offline, the guard answers "is it still TRUE?" online.
 * An entry added below should still carry a date to re-verify by — the guard tells you
 * when upstream moves, not when your own reasoning stopped applying.
 */
const DEV_ONLY_SUPPRESSIONS: { ghsa: string; pkg: string; vulnerableInProd: RegExp }[] = [];

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
