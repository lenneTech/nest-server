import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  CORE_MODULE_CASES,
  CORE_MODULE_DRIVERS,
  CORE_MODULE_EXCLUSIONS,
  getCoreModuleCase,
} from '../helpers/core-module-matrix';

const executor = readFileSync(join(__dirname, '..', 'core-module-parity.e2e-spec.ts'), 'utf8');

/**
 * Structural guard of the core module parity matrix: every (case, driver) cell is EXECUTED, IMPOSSIBLE or
 * DIFFERENT-BY-DESIGN — never merely absent — and the executor registers every executed case.
 */
describe('core module parity matrix', () => {
  it('has unique case ids', () => {
    const ids = CORE_MODULE_CASES.map((entry) => entry.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('declares every cell', () => {
    const undeclared: string[] = [];
    for (const entry of CORE_MODULE_CASES) {
      for (const driver of CORE_MODULE_DRIVERS) {
        const executed = entry.drivers.includes(driver);
        const excluded = CORE_MODULE_EXCLUSIONS.some((ex) => ex.case === entry.id && ex.driver === driver);
        if (executed === excluded) {
          undeclared.push(`${entry.id} × ${driver} (${executed ? 'executed AND excluded' : 'neither'})`);
        }
      }
    }
    expect(undeclared).toEqual([]);
  });

  it('gives every exclusion a valid reason, and a complement for a design difference', () => {
    for (const exclusion of CORE_MODULE_EXCLUSIONS) {
      getCoreModuleCase(exclusion.case);
      if (exclusion.reason.startsWith('DIFFERENT-BY-DESIGN:')) {
        expect(exclusion.provenBy, exclusion.case).toBeDefined();
        expect(getCoreModuleCase(exclusion.provenBy).drivers).toContain(exclusion.driver);
      } else {
        expect(exclusion.reason.startsWith('IMPOSSIBLE:'), exclusion.case).toBe(true);
        expect(exclusion.provenBy, exclusion.case).toBeUndefined();
      }
    }
  });

  it('registers every executed case in the executor', () => {
    const missing = CORE_MODULE_CASES.filter((entry) => !executor.includes(`moduleIt('${entry.id}'`)).map(
      (entry) => entry.id,
    );
    expect(missing).toEqual([]);
  });

  it('registers the complement of every design difference in the executor', () => {
    const missing = CORE_MODULE_EXCLUSIONS.filter(
      (entry) =>
        entry.reason.startsWith('DIFFERENT-BY-DESIGN:') && !executor.includes(`moduleComplement('${entry.case}'`),
    ).map((entry) => `${entry.case} × ${entry.driver}`);
    expect(missing).toEqual([]);
  });
});
