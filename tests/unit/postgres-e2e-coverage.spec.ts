import { existsSync, readdirSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { describe, expect, it } from 'vitest';

import { POSTGRES_E2E_EXCLUDED } from '../../vitest.include-globs.mjs';

const ROOT = join(__dirname, '..', '..');

/** The e2e suites as `E2E_TEST_INCLUDE` claims them: `*.e2e-spec.ts` anywhere under tests/, story tests in tests/stories */
function e2eSuites(dir = join(ROOT, 'tests'), acc: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    const name = relative(ROOT, path).split(sep).join('/');
    if (entry.isDirectory()) {
      e2eSuites(path, acc);
    } else if (
      name.endsWith('.e2e-spec.ts') ||
      (name.startsWith('tests/stories/') && name.endsWith('.story.test.ts'))
    ) {
      acc.push(name);
    }
  }
  return acc;
}

/**
 * The `postgres` project runs every e2e suite a second time, with PostgreSQL as the default data source — except the
 * suites in POSTGRES_E2E_EXCLUDED. That list is where coverage could disappear quietly: a suite that fails on
 * PostgreSQL because it reads MongoDB directly can be "fixed" by adding it. So the list is held to the two reasons
 * that justify an exclusion, and to suites that exist.
 */
describe('PostgreSQL e2e coverage', () => {
  const e2eFiles = new Set(e2eSuites());

  it.each(Object.entries(POSTGRES_E2E_EXCLUDED))('%s carries a reason the list allows', (file, reason) => {
    expect(existsSync(join(ROOT, file)), `${file} does not exist — remove the stale entry`).toBe(true);
    expect(e2eFiles.has(file), `${file} is not an e2e suite`).toBe(true);
    expect(reason).toMatch(/^(MONGODB-ONLY|OWN-DATABASES): \S.{20,}/);
  });

  it('runs the large majority of the e2e suites on PostgreSQL', () => {
    // A ratchet in one direction: an exclusion added to get a run green has to justify itself here as well.
    // 21 since phase 6: three MySQL / MariaDB suites that never touch the default source — no PostgreSQL coverage lost.
    // 22 since DEV-3901: the sync contract matrix runs every PostgreSQL engine itself — no PostgreSQL coverage lost
    // 23 since DEV-3903: the clock-skew suite boots its server processes on PostgreSQL itself — no coverage lost
    const excluded = Object.keys(POSTGRES_E2E_EXCLUDED).length;
    expect(
      excluded,
      `${excluded} of ${e2eFiles.size} suites are excluded from the postgres project`,
    ).toBeLessThanOrEqual(23);
    expect(e2eFiles.size - excluded).toBeGreaterThan(90);
  });
});
