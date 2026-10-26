import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The low-resource worker cap in vitest-e2e.config.mts.
 *
 * It used to be `poolOptions.forks.maxForks`, which Vitest 4 removed: the cap was announced on
 * stderr and silently discarded, so overlapping e2e runs kept starving each other. This file is
 * the only guard against that coming back. The assertions read the value the config resolves from
 * the environment, so a return to `poolOptions` fails here. What they cannot see is Vitest itself
 * removing `maxWorkers`: vitest's resolved config copies user options through unchanged, removed
 * ones included, so asserting on it would be no stronger — only a fork count of a real run is.
 * Do not count on the type-check instead: under this repo's
 * `module: commonjs` vitest's config type collapses to `any` (see the comment at `maxWorkers` in
 * vitest-e2e.config.mts), so an unknown option type-checks clean.
 *
 * The config is evaluated at import time from the environment, hence `vi.resetModules()` and a
 * fresh import per case. `LT_E2E_SLOT_DIR` points at an empty directory so that real e2e runs on
 * this machine cannot switch auto mode on and influence the result.
 */
describe('vitest-e2e.config low-resource cap', () => {
  // `RUNNER_ENVIRONMENT` is pinned (deleted here, set per case) because the config reads it: a
  // spec that inherits it answers differently on a GitHub runner than on the laptop it was written
  // on. `CI` is pinned too, so a future reader of `CI` in the config cannot slip in unnoticed.
  const keys = ['CHECK_LOW_RESOURCE', 'CHECK_LOW_RESOURCE_FORKS', 'CI', 'LT_E2E_SLOT_DIR', 'RUNNER_ENVIRONMENT'];
  const savedEnv: Record<string, string | undefined> = {};
  let dir: string;

  beforeEach(() => {
    for (const key of keys) {
      savedEnv[key] = process.env[key];
      delete process.env[key];
    }
    dir = mkdtempSync(join(os.tmpdir(), 'e2e-config-test-'));
    process.env.LT_E2E_SLOT_DIR = dir;
    // The config announces low-resource mode on stderr; keep the unit run quiet.
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    vi.resetModules();
  });

  afterEach(() => {
    for (const [key, value] of Object.entries(savedEnv)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
    rmSync(dir, { force: true, recursive: true });
    vi.restoreAllMocks();
  });

  async function loadTestConfig() {
    const { default: config } = await import('../../vitest-e2e.config.mjs');
    return config.test;
  }

  /**
   * @regression   11.42.x — Vitest 4 removed `test.poolOptions`, so the low-resource cap
   *   (`poolOptions.forks.maxForks`) was logged and discarded: a run announcing "maxForks=2" used
   *   8 forks on a 12-core machine, the same run with `maxWorkers` used 2.
   * @seen-failing Put `poolOptions.forks.maxForks` back in place of `maxWorkers` in
   *   vitest-e2e.config.mts — registered as mutation `e2e-low-resource-cap-pooloptions` in
   *   tests/regression-mutations.json.
   */
  it('caps the workers via maxWorkers in low-resource mode', async () => {
    process.env.CHECK_LOW_RESOURCE = '1';
    process.env.CHECK_LOW_RESOURCE_FORKS = '3';

    const test = await loadTestConfig();

    expect(test?.maxWorkers).toBe(3);
    expect(test).not.toHaveProperty('poolOptions');
  });

  /**
   * @regression   11.42.x (caught in review, before release) — a GitHub-hosted runner runs one job
   *   per VM, so at config time the 1-minute load is this job's own `vitest:unit`, finished a
   *   second earlier (0.84–0.92/core on the runner builds of 11.42.8–11.42.10). Once the cap took
   *   effect, that self-inflicted load cut the e2e step from vitest's 3 workers to 2 on every build
   *   and release — measured on hosted runners: 133 s -> 198 s mean e2e wall time (+25 % after
   *   normalising for runner speed).
   * @seen-failing Cap the workers on every low-resource trigger in vitest-e2e.config.mts —
   *   registered as mutation `e2e-low-resource-cap-ci-self-load` in tests/regression-mutations.json.
   */
  it('does not cap the workers on a GitHub-hosted runner when only the load signal fired', async () => {
    process.env.CI = 'true';
    process.env.RUNNER_ENVIRONMENT = 'github-hosted';
    vi.spyOn(os, 'loadavg').mockReturnValue([1000, 1000, 1000]);

    const test = await loadTestConfig();

    expect(test?.maxWorkers).toBeUndefined();
    // The raised timeouts stay: they are what CI has run with since Vitest 4 discarded the cap.
    expect(test?.testTimeout).toBe(60000);
  });

  it('still caps the workers on a self-hosted or non-GitHub CI runner when only the load signal fired', async () => {
    // The refusal case that matters most: a shared runner (a GitLab runner starting several test
    // jobs at once, measured 2.6–5.0/core in a consuming project) carries REAL contention, and
    // `CI=true` alone must not switch the cap off there.
    process.env.CI = 'true';
    process.env.RUNNER_ENVIRONMENT = 'self-hosted';
    vi.spyOn(os, 'loadavg').mockReturnValue([1000, 1000, 1000]);
    expect((await loadTestConfig())?.maxWorkers).toBeGreaterThan(0);

    vi.resetModules();
    delete process.env.RUNNER_ENVIRONMENT;
    expect((await loadTestConfig())?.maxWorkers).toBeGreaterThan(0);
  });

  it('still caps the workers outside CI when only the load signal fired', async () => {
    // Locally the load can be genuine pressure from other work on the machine, which is what the
    // load signal exists for.
    vi.spyOn(os, 'loadavg').mockReturnValue([1000, 1000, 1000]);

    const test = await loadTestConfig();

    expect(test?.maxWorkers).toBeGreaterThan(0);
  });

  it('still caps the workers on a GitHub-hosted runner when low-resource mode is forced', async () => {
    // check:mutations forces the mode per lane and divides the machine between the lanes; the
    // runner exception must not undo that split.
    process.env.CI = 'true';
    process.env.RUNNER_ENVIRONMENT = 'github-hosted';
    process.env.CHECK_LOW_RESOURCE = '1';
    process.env.CHECK_LOW_RESOURCE_FORKS = '1';

    const test = await loadTestConfig();

    expect(test?.maxWorkers).toBe(1);
  });

  it("leaves maxWorkers at vitest's default when low-resource mode is off", async () => {
    process.env.CHECK_LOW_RESOURCE = '0';

    const test = await loadTestConfig();

    expect(test?.maxWorkers).toBeUndefined();
  });
});
