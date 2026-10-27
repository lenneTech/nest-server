import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  getPersistenceCase,
  PERSISTENCE_CASES,
  PERSISTENCE_DRIVERS,
  PERSISTENCE_EXCLUSIONS,
} from '../helpers/persistence-matrix';

const executor = readFileSync(join(__dirname, '..', 'persistence-parity.e2e-spec.ts'), 'utf8');

/**
 * Structural guard of the persistence parity matrix: every (case, driver) cell is EXECUTED, IMPOSSIBLE or
 * DIFFERENT-BY-DESIGN — never merely absent — and the executor registers every executed case.
 */
describe('persistence parity matrix', () => {
  it('has unique case ids', () => {
    const ids = PERSISTENCE_CASES.map((entry) => entry.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('declares every cell', () => {
    const undeclared: string[] = [];
    for (const entry of PERSISTENCE_CASES) {
      for (const driver of PERSISTENCE_DRIVERS) {
        const executed = entry.drivers.includes(driver);
        const excluded = PERSISTENCE_EXCLUSIONS.some((ex) => ex.case === entry.id && ex.driver === driver);
        if (executed === excluded) {
          undeclared.push(`${entry.id} × ${driver} (${executed ? 'executed AND excluded' : 'neither'})`);
        }
      }
    }
    expect(undeclared).toEqual([]);
  });

  it('gives every exclusion a valid reason, and a complement for a design difference', () => {
    for (const exclusion of PERSISTENCE_EXCLUSIONS) {
      getPersistenceCase(exclusion.case);
      if (exclusion.reason.startsWith('DIFFERENT-BY-DESIGN:')) {
        expect(exclusion.provenBy, exclusion.case).toBeDefined();
        expect(getPersistenceCase(exclusion.provenBy).drivers).toContain(exclusion.driver);
      } else {
        expect(exclusion.reason.startsWith('IMPOSSIBLE:'), exclusion.case).toBe(true);
        expect(exclusion.provenBy, exclusion.case).toBeUndefined();
      }
    }
  });

  it('registers every executed case in the executor', () => {
    const missing = PERSISTENCE_CASES.filter((entry) => !executor.includes(`persistenceIt('${entry.id}'`)).map(
      (entry) => entry.id,
    );
    expect(missing).toEqual([]);
  });
});
