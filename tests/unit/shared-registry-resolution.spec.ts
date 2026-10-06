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

  it('reads the ENVIRONMENT before asking pnpm', () => {
    // Asking pnpm is not the same as resolving the registry. `pnpm config get registry` does not
    // report `npm_config_registry`, which pnpm nonetheless honours for the audit — so a block
    // that only calls pnpm sends the probe to npmjs.org while the audit went somewhere else, and
    // identity between two copies that both do that proves nothing. Both copies lacked this for
    // three releases while the comment above the probe claimed the effective value was used.
    const block = blockOf('scripts/check.mjs');
    expect(block).toMatch(/npm_config_registry/);
    // Order matters as much as presence: the environment branch has to come BEFORE the call.
    expect(block.indexOf('npm_config_registry')).toBeLessThan(block.indexOf("execFileSync('pnpm config get registry'"));
  });

  it('keeps npmjs.org as a FALLBACK only, never as the primary answer', () => {
    // `pnpm config get registry` can return an empty string or fail outright, and a probe that
    // throws would report every clean repo as an outage — worse than the bug being fixed.
    const block = blockOf('scripts/check.mjs');
    expect(block).toMatch(/const fallback = 'https:\/\/registry\.npmjs\.org\/';/);
    expect(block).toMatch(/if \(!\/\^https\?:\\\/\\\/\/i\.test\(base\)\) \{\n\s+base = fallback;/);
  });
});
