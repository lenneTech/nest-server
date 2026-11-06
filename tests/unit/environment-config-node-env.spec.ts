/**
 * `getEnvironmentConfig()` and the value of `NODE_ENV` (DEV-4061, 12.7.0).
 *
 * Until 12.7.0 the lookup was `config[NODE_ENV || defaultEnv] || config.local`: a `NODE_ENV` without a block, and an
 * empty one, booted on the local block. Its `env` claims `local` on a deployed stage, which opens what the framework
 * keeps to laptops — the anonymous system setup, `GET /config`, private outbound targets, the development MCP OAuth
 * secret, the auth links in the log — and the starter's check for required secrets never runs. These cases pin the
 * refusal, the one exception a test runner needs, and the unchanged default.
 */
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { getEnvironmentConfig } from '../../src/core/common/helpers/config.helper';

/** No .env is read: a developer's local file must not set NODE_ENV or anything else in this process */
const MISSING_ENV_FILE = join(tmpdir(), 'nest-server-dev-4061-no-env-file');

/** A fresh configuration per call: getEnvironmentConfig() merges into the block it returns */
function matrix(): Record<string, Record<string, unknown>> {
  return {
    local: { env: 'local', marker: 'local-block' },
    production: { env: 'production', marker: 'production-block' },
  };
}

function load(config = matrix(), defaultEnv?: string) {
  return getEnvironmentConfig({ config, defaultEnv, envPath: MISSING_ENV_FILE });
}

describe('getEnvironmentConfig() and NODE_ENV', () => {
  beforeEach(() => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  /**
   * @regression   DEV-4061 — a NODE_ENV without a block got the local block, so a deployed stage started with
   *   NODE_ENV=development, dev or staging ran with `env: 'local'`: dummy secrets, the anonymous system setup and
   *   every other local-only switch open, and no required-secret check.
   * @seen-failing Answer a NODE_ENV without a block with the local block again in selectEnvironmentBlock() in
   *   src/core/common/helpers/config.helper.ts — registered as mutation `env-config-unknown-node-env-runs-local` in
   *   tests/regression-mutations.json.
   */
  it.each(['development', 'dev', 'staging', 'Production', 'constructor'])(
    'refuses NODE_ENV=%s, which has no block, naming the blocks that exist',
    (nodeEnv) => {
      vi.stubEnv('NODE_ENV', nodeEnv);

      expect(() => load()).toThrow(`NODE_ENV='${nodeEnv}' has no block in the configuration (known: local, production)`);
    },
  );

  /**
   * @regression   DEV-4061 — `'' || 'local'` turned an empty NODE_ENV into local. `NODE_ENV=${NODE_ENV}` in a compose
   *   file passes exactly that when the host does not set the variable.
   * @seen-failing Treat an empty NODE_ENV as unset again in selectEnvironmentBlock() in
   *   src/core/common/helpers/config.helper.ts — registered as mutation `env-config-empty-node-env-runs-local` in
   *   tests/regression-mutations.json.
   */
  it.each(['', '   '])('refuses an empty NODE_ENV (%j)', (nodeEnv) => {
    vi.stubEnv('NODE_ENV', nodeEnv);

    expect(() => load()).toThrow('NODE_ENV is set but empty (known: local, production)');
  });

  it('loads the block NODE_ENV names', () => {
    vi.stubEnv('NODE_ENV', 'production');

    expect(load()).toMatchObject({ env: 'production', marker: 'production-block' });
  });

  it('loads the local block when NODE_ENV is not set, as before', () => {
    vi.stubEnv('NODE_ENV', undefined);

    expect(load()).toMatchObject({ env: 'local', marker: 'local-block' });
  });

  it('loads the defaultEnv block when NODE_ENV is not set and a defaultEnv is given', () => {
    vi.stubEnv('NODE_ENV', undefined);

    expect(load(matrix(), 'production')).toMatchObject({ env: 'production', marker: 'production-block' });
  });

  it('keeps the local block for NODE_ENV=test under a test runner, and warns once', async () => {
    vi.stubEnv('NODE_ENV', 'test');
    vi.stubEnv('VITEST', 'true');
    // A fresh module instance: the warning is reported once per instance
    vi.resetModules();
    const { getEnvironmentConfig: fresh } = await import('../../src/core/common/helpers/config.helper');
    const warn = vi.mocked(console.warn);

    const first = fresh({ config: matrix(), envPath: MISSING_ENV_FILE });
    const second = fresh({ config: matrix(), envPath: MISSING_ENV_FILE });

    expect(first).toMatchObject({ env: 'local', marker: 'local-block' });
    expect(second).toMatchObject({ env: 'local', marker: 'local-block' });
    const reports = warn.mock.calls.filter(([message]) => String(message).startsWith("NODE_ENV='test' has no block"));
    expect(reports).toHaveLength(1);
  });

  it('keeps the local block for NODE_ENV=test under jest (JEST_WORKER_ID)', () => {
    vi.stubEnv('NODE_ENV', 'test');
    vi.stubEnv('VITEST', undefined);
    vi.stubEnv('JEST_WORKER_ID', '1');

    expect(load()).toMatchObject({ env: 'local', marker: 'local-block' });
  });

  /**
   * @regression   DEV-4061 — the test-runner exception must not reach a deployed `test` stage: a project without a
   *   `test` block that deploys with NODE_ENV=test would run on the local block again.
   * @seen-failing Drop the test-runner condition from the NODE_ENV=test exception in selectEnvironmentBlock() in
   *   src/core/common/helpers/config.helper.ts — registered as mutation `env-config-test-fallback-outside-runner` in
   *   tests/regression-mutations.json.
   */
  it('refuses NODE_ENV=test without a test runner', () => {
    vi.stubEnv('NODE_ENV', 'test');
    vi.stubEnv('VITEST', undefined);
    vi.stubEnv('JEST_WORKER_ID', undefined);

    expect(() => load()).toThrow("NODE_ENV='test' has no block in the configuration (known: local, production)");
  });

  it('loads a test block when the configuration has one, without the warning', () => {
    vi.stubEnv('NODE_ENV', 'test');
    const config = { ...matrix(), test: { env: 'test', marker: 'test-block' } };

    expect(load(config)).toMatchObject({ env: 'test', marker: 'test-block' });
    expect(vi.mocked(console.warn)).not.toHaveBeenCalled();
  });
});
