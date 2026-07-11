/**
 * Unit Tests: DEFAULT_MIGRATION_FILE_PATTERN
 *
 * The migration runner picks up every file in the migrations directory that
 * matches this pattern and `require()`s it. Compiled migrations ship a
 * declaration file next to the JavaScript one, so the pattern must accept
 * `foo.js` / `foo.ts` while rejecting `foo.d.ts` — requiring a declaration file
 * throws, since `export declare …` is not valid CommonJS.
 */

import { describe, expect, it } from 'vitest';

import { DEFAULT_MIGRATION_FILE_PATTERN as PATTERN } from '../../src/core/modules/migrate/migration-runner';

/** `RegExp.test` is stateless here (no /g flag), but be explicit about it. */
const matches = (file: string) => PATTERN.test(file);

describe('DEFAULT_MIGRATION_FILE_PATTERN', () => {
  it('matches TypeScript migrations (source / ts-node runs)', () => {
    expect(matches('1750000000000-add-user-email.ts')).toBe(true);
  });

  it('matches JavaScript migrations (compiled / production image)', () => {
    expect(matches('1750000000000-add-user-email.js')).toBe(true);
  });

  it('rejects declaration files emitted next to a compiled migration', () => {
    expect(matches('1750000000000-add-user-email.d.ts')).toBe(false);
  });

  it('rejects source maps emitted next to a compiled migration', () => {
    expect(matches('1750000000000-add-user-email.js.map')).toBe(false);
  });

  it('picks exactly one file from a compiled migration triplet', () => {
    const emitted = [
      '1750000000000-add-user-email.js',
      '1750000000000-add-user-email.d.ts',
      '1750000000000-add-user-email.js.map',
    ];
    expect(emitted.filter(matches)).toEqual(['1750000000000-add-user-email.js']);
  });

  it('does not mistake a migration named "*.d.js" for a declaration file', () => {
    expect(matches('1750000000000-3.d.js')).toBe(true);
  });

  it('ignores unrelated files in the migrations directory', () => {
    expect(matches('README.md')).toBe(false);
    expect(matches('tsconfig.json')).toBe(false);
  });
});
