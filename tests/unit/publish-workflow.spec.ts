/**
 * `.github/workflows/publish.yml` publishes through npm Trusted Publishing (OIDC, DEV-3143).
 *
 * The workflow runs once per release, after the tag and the GitHub release exist, so a mistake here shows on a release
 * day as a half release: tag and release on GitHub, nothing on npm. These tests pin what the OIDC path needs, offline:
 *  - `id-token: write` on the publish job, or npm never sees an OIDC token and the publish fails;
 *  - the npm CLI, because JS-DevTools/npm-publish takes a token and cannot do OIDC;
 *  - an npm >= 11.5.1, pinned to a major, so no new npm major arrives in a release run untried;
 *  - every gate before the publish, no lifecycle script next to the publish token, and no long-lived token anywhere
 *    (12.6.5 proved OIDC: published by "GitHub Actions" with trustedPublisher github and SLSA provenance).
 *
 * This repository's workflow has more than one job: the regression-evidence shards run alongside the publish, and the
 * report job opens issues. So the permissions sit on the publish job — a job-level block REPLACES the workflow-level
 * one, it does not add to it — and only that job is read as the step list.
 */
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const WORKFLOW = readFileSync(resolve(process.cwd(), '.github/workflows/publish.yml'), 'utf8');

// Comments explain the steps and name the old action; only the YAML itself counts.
const CODE = WORKFLOW.split('\n')
  .filter((line) => !/^\s*#/.test(line))
  .join('\n');

/** The `publish` job, from its key to the next job */
const JOB = (() => {
  const start = CODE.indexOf('\n  publish:\n');
  const rest = CODE.slice(start + 1);
  const next = rest.slice(1).search(/\n {2}[\w-]+:[ \t]*\n/);
  return next === -1 ? rest : rest.slice(0, next + 1);
})();

const STEPS_MARKER = '\n    steps:\n';
const STEPS = JOB.slice(JOB.indexOf(STEPS_MARKER) + STEPS_MARKER.length)
  .split(/\n(?= {6}- )/)
  .map((step) => step.trim())
  .filter(Boolean);

function stepIndex(pattern: RegExp): number {
  return STEPS.findIndex((step) => pattern.test(step));
}

const PUBLISH = stepIndex(/^- name: Publish\n\s+run: npm publish\b/);

describe('publish.yml — npm Trusted Publishing (DEV-3143)', () => {
  it('finds the publish job and its steps', () => {
    expect(CODE).toContain('\n  publish:\n');
    expect(JOB).toContain(STEPS_MARKER);
    expect(STEPS.length).toBeGreaterThan(10);
    expect(PUBLISH).toBeGreaterThan(0);
  });

  it('lets the publish job request an OIDC token, and nothing more', () => {
    const block = /^ {4}permissions:\n((?: {6}\S[^\n]*\n?)+)/m.exec(JOB)?.[1] ?? '';
    const entries = Object.fromEntries(
      block
        .trim()
        .split('\n')
        .map((line) => line.trim().split(/:\s*/)),
    );

    expect(entries).toEqual({ contents: 'read', 'id-token': 'write' });
  });

  it('grants id-token on no other job', () => {
    const others = CODE.slice(CODE.indexOf('\n  publish:\n') + 1).replace(JOB, '');
    expect(others).not.toMatch(/id-token:/);
    expect(CODE.slice(0, CODE.indexOf('\njobs:\n'))).not.toMatch(/id-token:/);
  });

  it('publishes with the npm CLI, once, never with a token-only action', () => {
    expect(CODE).not.toMatch(/JS-DevTools\/npm-publish/);
    expect(STEPS.filter((step) => /\bnpm publish\b/.test(step))).toHaveLength(1);
    // Only the infrastructure cleanup (`if: always()`) may follow the publish
    expect(STEPS.slice(PUBLISH + 1).every((step) => /if: always\(\)/.test(step))).toBe(true);
  });

  it('publishes the build the gates checked, with no lifecycle script next to the token', () => {
    // npm runs `prepack` (the build) and `prepublishOnly` (lint + suite) unless told not to: code in the step that
    // obtains the publish token, and a second build after the gates looked at the first.
    expect(STEPS[PUBLISH]).toMatch(/\brun: npm publish\b[^\n]*\s--ignore-scripts\b/);
  });

  it('publishes as `latest` on the main line (a maintenance line names its own dist-tag)', () => {
    expect(STEPS[PUBLISH]).not.toMatch(/--tag\b/);
  });

  it('runs every gate before the publish', () => {
    const gates = [
      /\brun: pnpm install$/m,
      /\brun: pnpm audit$/m,
      /\brun: node scripts\/check-overrides\.mjs\b/m,
      /\brun: pnpm run prepublishOnly$/m,
      /\brun: pnpm run check:swc-tdz$/m,
      /\brun: pnpm run build$/m,
      /\brun: node scripts\/check-consumer\.mjs\b/m,
      /\brun: node scripts\/check-without-mongodb\.mjs --package$/m,
    ];
    const indexes = gates.map((gate) => stepIndex(gate));

    for (const [i, gate] of gates.entries()) {
      expect(indexes[i], String(gate)).toBeGreaterThanOrEqual(0);
      expect(indexes[i], String(gate)).toBeLessThan(PUBLISH);
    }
    expect(indexes).toEqual([...indexes].sort((a, b) => a - b));
  });

  // Since 11.44.1: the Trusted Publishing backport carried a 12.x step onto release/11.x whose script that line does
  // not have, and the publish failed after the tag and the release existed. This repository's lines share the file.
  it('runs only scripts this branch has', () => {
    const scripts = [...JOB.matchAll(/\brun: node (scripts\/[\w.-]+)/g)].map((match) => match[1]);

    expect(scripts.length).toBeGreaterThan(0);
    for (const script of scripts) {
      expect(existsSync(resolve(process.cwd(), script)), script).toBe(true);
    }
  });

  it('installs an npm that can do Trusted Publishing, pinned to a major, before the publish', () => {
    const upgrade = stepIndex(/\brun: npm install -g npm@/);
    const spec = /\brun: npm install -g npm@(\S+)/.exec(STEPS[upgrade] ?? '')?.[1] ?? '';
    const nodeMajor = Number(/node-version: \[ ?(\d+)\.x ?\]/.exec(JOB)?.[1]);

    expect(upgrade).toBeGreaterThan(stepIndex(/\brun: node scripts\/check-without-mongodb\.mjs --package$/m));
    expect(upgrade).toBeLessThan(PUBLISH);
    // `latest`, `next` or a caret/tilde range would let a new major in unseen.
    expect(spec).toMatch(/^\d+$/);
    // OIDC needs npm >= 11.5.1, which `npm@11` resolves to; npm 12 needs Node ^24.15.0.
    expect(Number(spec)).toBeGreaterThanOrEqual(11);
    expect(nodeMajor).toBeGreaterThanOrEqual(Number(spec) >= 12 ? 24 : 22);
  });

  it('lets setup-node pin the registry npm publishes to', () => {
    const setupNode = STEPS[stepIndex(/uses: actions\/setup-node@/)] ?? '';

    expect(setupNode).toMatch(/^\s+registry-url: https:\/\/registry\.npmjs\.org\/?$/m);
  });

  it('uses no long-lived npm token: OIDC only, since 12.6.5 proved it', () => {
    // With a token configured, npm silently uses it whenever the OIDC exchange fails and publishes without
    // provenance, so a broken Trusted Publisher would go unnoticed.
    expect(CODE).not.toMatch(/secrets\.NPM_TOKEN|NODE_AUTH_TOKEN|NPM_CONFIG_\w*AUTH|_authToken/i);
  });
});
