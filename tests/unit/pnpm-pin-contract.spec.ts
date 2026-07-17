/**
 * Unit Tests: pnpm version pin contract (packageManager as single source of truth).
 *
 * Node >= 25 no longer ships corepack, so nothing may depend on `corepack enable` anymore.
 * Instead, package.json's `packageManager` field is the ONLY place the pnpm version is pinned:
 *
 * - Dockerfiles provision it via the derive-line
 *   `npm install -g "$(node -p "require('./package.json').packageManager.split('+')[0]")"`,
 * - pnpm/action-setup reads the field automatically (its `version` input must stay absent, or the
 *   two sources drift and the action fails on a version mismatch),
 * - `engines.pnpm` stays a soft major-range guard aligned with the pin.
 *
 * These tests assert the contract structurally. The final describe block proves the derive-chain
 * actually works by provisioning the pinned pnpm into a throwaway prefix — it needs network and
 * ~10MB, so it only runs in CI or when PIN_PROVISION_TEST is set.
 */
import { execSync } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = join(__dirname, '..', '..');

const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
const packageManager: string = pkg.packageManager;

/** Exact version, no range, integrity hash present — e.g. `pnpm@11.13.1+sha512.<hash>`. */
const PIN_PATTERN = /^pnpm@(\d+)\.\d+\.\d+\+sha512\.[A-Za-z0-9]+$/;

/** The `pnpm@<major>.<minor>.<patch>` part, without the integrity suffix. */
const pinnedSpec = packageManager?.split('+')[0];
const pinnedVersion = pinnedSpec?.split('@')[1];
const pinnedMajor = pinnedVersion?.split('.')[0];

/** The load-bearing fragment of the derive-line every Dockerfile must provision pnpm with. */
const DERIVE_PATTERN = "packageManager.split('+')[0]";

describe('pnpm pin contract: package.json', () => {
  it('pins an exact pnpm version with integrity hash in packageManager', () => {
    expect(packageManager).toMatch(PIN_PATTERN);
  });

  it("keeps engines.pnpm as the pin's major range", () => {
    expect(pkg.engines?.pnpm).toBe(`^${pinnedMajor}.0.0`);
  });

  // npm/npx abort with EBADDEVENGINES on devEngines.packageManager, and corepack rejects ranges
  // in it — the field must never (re)appear.
  it('does not declare devEngines.packageManager', () => {
    expect(pkg.devEngines?.packageManager).toBeUndefined();
  });
});

describe('pnpm pin contract: Dockerfile', () => {
  const dockerfile = readFileSync(join(ROOT, 'Dockerfile'), 'utf8');

  it('does not rely on corepack (Node >= 25 no longer ships it)', () => {
    expect(dockerfile).not.toContain('corepack enable');
    // No RUN instruction may invoke corepack at all (comments explaining its absence are fine).
    expect(dockerfile).not.toMatch(/^RUN[^\n]*corepack/m);
  });

  it('provisions pnpm from packageManager via the derive-line', () => {
    expect(dockerfile).toContain(DERIVE_PATTERN);
  });

  it('runs the derive-line before the first pnpm command of every pnpm-running stage', () => {
    // Split into build stages; a stage that runs pnpm must have provisioned it first —
    // and AFTER package.json exists in the WORKDIR (an earlier COPY in the same stage,
    // or `COPY --from=` of a directory that contains it).
    const stages = dockerfile.split(/^FROM /m).slice(1);
    const pnpmStages = stages.filter(stage => /^RUN[^\n]*\bpnpm\b/m.test(stage));
    expect(pnpmStages.length).toBeGreaterThan(0);
    for (const stage of pnpmStages) {
      const deriveIndex = stage.indexOf(DERIVE_PATTERN);
      const firstPnpmRun = stage.search(/^RUN[^\n]*\bpnpm\b/m);
      expect(deriveIndex).toBeGreaterThan(-1);
      expect(deriveIndex).toBeLessThan(firstPnpmRun);
      // package.json must already be in place when the derive-line reads it.
      const copyBeforeDerive = /(^COPY |^RUN [^\n]*package\.json)/m.test(stage.slice(0, deriveIndex));
      expect(copyBeforeDerive).toBe(true);
    }
  });
});

describe('pnpm pin contract: GitHub workflows', () => {
  const workflowDir = join(ROOT, '.github', 'workflows');
  const workflows = readdirSync(workflowDir).filter(file => /\.ya?ml$/.test(file));

  it('finds workflow files to check', () => {
    expect(workflows.length).toBeGreaterThan(0);
  });

  for (const file of workflows) {
    const content = readFileSync(join(workflowDir, file), 'utf8');

    it(`${file}: pnpm/action-setup carries no version input (field is read from packageManager)`, () => {
      const lines = content.split('\n');
      lines.forEach((line, index) => {
        if (!line.includes('pnpm/action-setup')) {
          return;
        }
        // Inspect the step's remaining lines (until the next step starts) for a bare `version:`.
        for (let i = index + 1; i < lines.length && !/^\s*- /.test(lines[i]); i++) {
          expect(lines[i]).not.toMatch(/^\s*version:/);
        }
      });
    });

    it(`${file}: contains no hardcoded pnpm install or corepack usage`, () => {
      expect(content).not.toMatch(/npm\s+(?:install|i)\s+-g\s+pnpm@\d/);
      expect(content).not.toMatch(/corepack/i);
    });
  }
});

// Functional proof of the whole chain: derive the spec exactly like the Dockerfile does, install
// it into a throwaway npm prefix, and check the provisioned binary reports the pinned version.
// Needs network + ~10MB, so it is gated to CI / explicit opt-in and must not slow local hooks.
describe.runIf(Boolean(process.env.CI || process.env.PIN_PROVISION_TEST))('pnpm pin contract: provisioning (CI / PIN_PROVISION_TEST only)', () => {
  it(
    'derive-line yields the pinned spec and npm provisions exactly that pnpm version',
    () => {
      const derived = execSync('node -p "require(\'./package.json\').packageManager.split(\'+\')[0]"', {
        cwd: ROOT,
        encoding: 'utf8',
      }).trim();
      expect(derived).toBe(pinnedSpec);
      expect(derived).toBe(`pnpm@${pinnedVersion}`);

      const prefix = mkdtempSync(join(tmpdir(), 'pnpm-pin-contract-'));
      try {
        execSync(`npm install -g --prefix "${prefix}" "${derived}"`, {
          cwd: ROOT,
          encoding: 'utf8',
          stdio: 'pipe',
          timeout: 150_000,
        });
        const provisioned = execSync(`"${join(prefix, 'bin', 'pnpm')}" --version`, { encoding: 'utf8' }).trim();
        expect(provisioned).toBe(pinnedVersion);
      } finally {
        rmSync(prefix, { force: true, recursive: true });
      }
    },
    180_000,
  );
});
