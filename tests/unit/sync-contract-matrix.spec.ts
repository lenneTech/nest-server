import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { getSyncCase, SYNC_CASES, SYNC_DRIVERS, SYNC_EXCLUSIONS } from '../helpers/sync-contract-matrix';

const executor = readFileSync(join(__dirname, '..', 'sync-contract.e2e-spec.ts'), 'utf8');

/**
 * Structural guard of the sync contract matrix: every (case, driver) cell is EXECUTED, IMPOSSIBLE or
 * DIFFERENT-BY-DESIGN — never merely absent — and the executor registers every case.
 */
describe('sync contract matrix', () => {
  it('has unique case ids', () => {
    const ids = SYNC_CASES.map((entry) => entry.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('declares every cell', () => {
    const undeclared: string[] = [];
    for (const entry of SYNC_CASES) {
      for (const driver of SYNC_DRIVERS) {
        const executed = entry.drivers.includes(driver);
        const excluded = SYNC_EXCLUSIONS.some((exclusion) => exclusion.case === entry.id && exclusion.driver === driver);
        if (executed === excluded) {
          undeclared.push(`${entry.id} × ${driver} (${executed ? 'executed AND excluded' : 'neither'})`);
        }
      }
    }
    expect(undeclared).toEqual([]);
  });

  it('gives every exclusion a valid reason, and a design difference a complement that runs for its driver', () => {
    for (const exclusion of SYNC_EXCLUSIONS) {
      getSyncCase(exclusion.case);
      if (exclusion.reason.startsWith('DIFFERENT-BY-DESIGN:')) {
        expect(exclusion.provenBy, exclusion.case).toBeDefined();
        expect(getSyncCase(exclusion.provenBy).drivers).toContain(exclusion.driver);
      } else {
        expect(exclusion.reason.startsWith('IMPOSSIBLE:'), exclusion.case).toBe(true);
        expect(exclusion.provenBy, exclusion.case).toBeUndefined();
      }
    }
  });

  it('registers every case in the executor', () => {
    const missing = SYNC_CASES.filter((entry) => !new RegExp(`syncIt\\(\\s*'${entry.id}'`).test(executor)).map(
      (entry) => entry.id,
    );
    expect(missing).toEqual([]);
  });

  it('covers every column the ticket names: MongoDB standalone and replica set, PostgreSQL × 3 engines, MySQL, MariaDB', () => {
    expect([...SYNC_DRIVERS].sort()).toEqual(
      ['mariadb', 'mongodb', 'mongodb-rs', 'mysql', 'postgres-drizzle', 'postgres-kysely', 'postgres-typeorm'].sort(),
    );
  });
});
