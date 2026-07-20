/**
 * Unit Tests: build identity helpers
 *
 * Verifies that the commit SHA is resolved from the environment with a defined
 * `'unknown'` fallback, and that `getBuildInfo` assembles commit/version/env.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { DEFAULT_COMMIT_ENV, getBuildInfo, getCommit, getVersion, UNKNOWN_COMMIT } from '../../src/core/common/helpers/meta.helper';

describe('meta.helper', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    delete process.env[DEFAULT_COMMIT_ENV];
    delete process.env.CUSTOM_COMMIT;
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  describe('getCommit', () => {
    it('reads the commit from the default env var', () => {
      process.env[DEFAULT_COMMIT_ENV] = 'abc1234';
      expect(getCommit()).toBe('abc1234');
    });

    it('reads the commit from a custom env var', () => {
      process.env.CUSTOM_COMMIT = 'def5678';
      expect(getCommit('CUSTOM_COMMIT')).toBe('def5678');
    });

    it('falls back to "unknown" when the env var is unset', () => {
      expect(getCommit()).toBe(UNKNOWN_COMMIT);
      expect(getCommit()).toBe('unknown');
    });

    it('falls back to "unknown" when the env var is empty', () => {
      process.env[DEFAULT_COMMIT_ENV] = '';
      expect(getCommit()).toBe(UNKNOWN_COMMIT);
    });
  });

  describe('getBuildInfo', () => {
    it('assembles commit, version and env', () => {
      process.env[DEFAULT_COMMIT_ENV] = 'abc1234';
      expect(getBuildInfo({ env: 'production', version: '1.2.3' })).toEqual({
        commit: 'abc1234',
        env: 'production',
        version: '1.2.3',
      });
    });

    it('falls back to the package.json version and leaves env undefined', () => {
      const info = getBuildInfo();
      expect(info.commit).toBe(UNKNOWN_COMMIT);
      expect(info.env).toBeUndefined();
      // Reads this repo's package.json version (a real semver), never the "unknown" placeholder.
      expect(info.version).toBe(getVersion());
      expect(info.version).toMatch(/^\d+\.\d+\.\d+/);
    });
  });

  describe('getVersion', () => {
    it('resolves the semantic version from package.json (cached)', () => {
      expect(getVersion()).toMatch(/^\d+\.\d+\.\d+/);
      expect(getVersion()).toBe(getVersion());
    });
  });
});
