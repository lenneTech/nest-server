/**
 * Structural invariant: the registry-resolution block is byte-identical in both check scripts.
 *
 * `scripts/check.mjs` and `scripts/check-overrides.mjs` both ask "is the advisory service actually
 * answering?" — the question that separates a clean tree from a silent outage. Both must ask the
 * registry pnpm ACTUALLY USES; asking npmjs.org while the project sits behind a private registry
 * produces the exact false-green those probes exist to remove, one layer down.
 *
 * The code is DUPLICATED rather than imported, and that is deliberate:
 * `tests/unit/check-overrides.guard.spec.ts` copies the guard ALONE into a temp directory and runs
 * it there, which is what proves it standalone. An import broke that — 40 cases went red with
 * ERR_MODULE_NOT_FOUND, caught only because that suite refuses to let a crash read as a verdict.
 *
 * So the duplication is a decision, and this file is the price of it. Without a check, two copies
 * of a security-relevant probe drift and nothing says so — one of them keeps asking the wrong host
 * and the run still looks green, which is precisely the defect being fixed.
 *
 * @regression   11.40.0 — both probes hardcoded `registry.npmjs.org` while pnpm audits against the
 *   configured registry. Found by MEASURING three real outage modes (502, dead DNS, connection
 *   refused): all three make `pnpm audit --json` exit 0 with a complete, all-zero, healthy-looking
 *   report and no error envelope, so the probe is the only defence for that class — and it was
 *   pointed at the wrong service.
 * @seen-failing Change the fallback URL in ONE of the two marked blocks — registered as mutation
 *   `shared-registry-block-drift` in tests/regression-mutations.json.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

const ROOT = join(__dirname, '..', '..');
const MARKER = /\/\/ >>> SHARED-WITH-CHECK-MJS[\s\S]*?\/\/ <<< SHARED-WITH-CHECK-MJS/;

const blockOf = (relative: string): string => {
  const source = readFileSync(join(ROOT, relative), 'utf8');
  const match = source.match(MARKER);
  expect(match, `${relative} has no SHARED-WITH-CHECK-MJS block — the duplication guard is disarmed`).not.toBeNull();
  return match![0];
};

/** The source with `//` comment lines removed, so a comment can never satisfy a code assertion. */
const codeOf = (source: string): string =>
  source
    .split('\n')
    .filter((line) => !line.trim().startsWith('//'))
    .join('\n');

describe('shared registry resolution stays in sync', () => {
  it('is byte-identical in both check scripts', () => {
    expect(blockOf('scripts/check-overrides.mjs')).toBe(blockOf('scripts/check.mjs'));
  });

  it('resolves the registry rather than naming a host', () => {
    // The property the block exists for. A copy that stopped calling `pnpm config get registry`
    // would still be identical to its twin and still be wrong, so identity alone is not enough.
    const block = blockOf('scripts/check.mjs');
    // One command string, not an args array — see the note in the block itself: on Windows
    // pnpm is a shim that needs a shell, and a shell plus an args array is DEP0190.
    expect(block).toContain("execFileSync('pnpm config get registry'");
    expect(block).toContain('/-/npm/v1/security/advisories/bulk');
  });

  /**
   * @regression   11.42.6 — the first form of this case asserted on the raw block text, and the
   *   comment above the code names the variable before the pnpm call. A block whose CODE read the
   *   environment after pnpm, or not at all, stayed green. Comments are stripped now, so only code
   *   can satisfy it.
   * @seen-failing Drop the environment branch from `configuredRegistry()` — registered as mutation
   *   `probe-registry-ignores-environment` in tests/regression-mutations.json.
   */
  it('reads the ENVIRONMENT before asking pnpm, in code rather than in a comment', () => {
    // The probe must ask the registry the audit used. Under pnpm 11 the environment names it as
    // `pnpm_config_registry`; `npm_config_registry` is ignored by pnpm 11 and must not be read.
    const code = codeOf(blockOf('scripts/check.mjs'));
    expect(code).toContain('process.env.pnpm_config_registry');
    expect(code, 'pnpm 11 ignores npm_config_registry; reading it misdirects the probe').not.toMatch(
      /\bnpm_config_registry\b|\bNPM_CONFIG_REGISTRY\b/,
    );
    // Order matters as much as presence: the environment branch has to come BEFORE the call.
    expect(code.indexOf('process.env.pnpm_config_registry')).toBeLessThan(
      code.indexOf("execFileSync('pnpm config get registry'"),
    );
  });

  /**
   * @regression   11.42.6 — byte-identity covers only the marked block, and the probe's CALL SITE
   *   sits outside it. Restoring the hardcoded npmjs URL in `advisoryServiceReachable()` kept the
   *   whole unit suite green while the block itself stayed correct and unused.
   * @seen-failing Hardcode the npmjs bulk URL in `advisoryServiceReachable()` — registered as
   *   mutation `probe-call-site-hardcoded` in tests/regression-mutations.json.
   */
  it('makes the probe in check.mjs actually USE the resolved registry', () => {
    const source = readFileSync(join(ROOT, 'scripts/check.mjs'), 'utf8');
    const start = source.indexOf('async function advisoryServiceReachable()');
    expect(start, 'advisoryServiceReachable() is gone — the probe this file guards no longer exists').toBeGreaterThan(-1);
    const end = source.indexOf('\n}\n', start);
    const body = codeOf(source.slice(start, end));
    expect(body).toContain('configuredRegistry()');
    expect(body).toContain('fetch(advisoryBulkUrl(');
    expect(body, 'the probe names a host itself instead of asking the resolved registry').not.toMatch(/https?:\/\//);
  });

  it('keeps npmjs.org as a FALLBACK only, never as the primary answer', () => {
    // `pnpm config get registry` can return an empty string or fail outright, and a probe that
    // throws would report every clean repo as an outage — worse than the bug being fixed.
    const block = blockOf('scripts/check.mjs');
    expect(block).toMatch(/const fallback = 'https:\/\/registry\.npmjs\.org\/';/);
    expect(block).toMatch(/if \(!\/\^https\?:\\\/\\\/\/i\.test\(base\)\) \{\n\s+base = fallback;/);
  });
});
