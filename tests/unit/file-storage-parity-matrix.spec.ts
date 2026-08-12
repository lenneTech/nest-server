/**
 * Unit Tests: the file-storage parity matrix is COMPLETE and HONEST.
 *
 * THE BUG CLASS
 * -------------
 * Two defects of the same shape shipped in 11.33.0 and 11.33.1, and both were found downstream.
 * Neither was hard to catch; both were impossible to catch, because the suite had no place where
 * "does this hold under the other two drivers?" was a question anyone could fail to answer. Each
 * driver had its own file, so a missing case and an impossible case produced the same artefact:
 * nothing.
 *
 * WHY THIS FILE EXISTS AND WHY IT IS NOT REDUNDANT
 * ------------------------------------------------
 * The e2e executors prove the behaviours HOLD. They cannot prove the list of behaviours is the one
 * the matrix declares — a case quietly dropped from an executor, or a driver quietly dropped from a
 * case, leaves both executors green and the coverage smaller. That is the same asymmetry
 * `import-cycle-invariants.spec.ts` exists for: the runtime guard catches the failure, not the
 * disarming of the safety property.
 *
 * So this asserts the STRUCTURE:
 *   - every (case, driver) cell is EXECUTED, IMPOSSIBLE, or DIFFERENT-BY-DESIGN — never undeclared;
 *   - every DIFFERENT-BY-DESIGN cell names a complementary case that actually runs for that driver,
 *     and registers a `parityComplement()` for it (a design difference nobody asserts is
 *     indistinguishable from a bug nobody noticed);
 *   - every declared case is registered by its layer's executor, and every id an executor registers
 *     is declared — so the matrix and the runs cannot drift apart in either direction;
 *   - every case folded in from a consolidated suite still names a live case, and those suites are
 *     gone rather than left behind to duplicate and drift.
 *
 * Structural on purpose. If one fails, do not relax the assertion — read what it points at.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import {
  FOLDED_IN,
  getParityCase,
  PARITY_CASES,
  PARITY_DRIVERS,
  PARITY_EXCLUSIONS,
  ParityLayer,
} from '../helpers/file-storage-matrix';

const TESTS = join(__dirname, '..');

const EXECUTOR: Record<ParityLayer, string> = {
  http: 'file-storage-http-parity.e2e-spec.ts',
  service: 'file-storage-parity.e2e-spec.ts',
};

function executorSource(layer: ParityLayer): string {
  return readFileSync(join(TESTS, EXECUTOR[layer]), 'utf8');
}

/** Every `parityIt('<id>'` / `parityComplement('<id>'` id an executor registers. */
function registeredIds(source: string, fn: 'parityComplement' | 'parityIt'): string[] {
  return [...source.matchAll(new RegExp(`${fn}\\(\\s*'([^']+)'`, 'g'))].map(match => match[1]);
}

describe('file-storage parity matrix', () => {
  describe('the matrix is internally consistent', () => {
    it('has unique case ids', () => {
      const ids = PARITY_CASES.map(entry => entry.id);
      expect(ids).toEqual([...new Set(ids)]);
    });

    it('names only known drivers', () => {
      for (const entry of PARITY_CASES) {
        expect(entry.drivers.length, `${entry.id} must run somewhere`).toBeGreaterThan(0);
        for (const driver of entry.drivers) {
          expect(PARITY_DRIVERS, `${entry.id}`).toContain(driver);
        }
      }
    });

    it('has no exclusion for a driver the case already executes', () => {
      // Both at once is a contradiction, and the executor would happily register the case while the
      // matrix document claims it is not covered.
      for (const exclusion of PARITY_EXCLUSIONS) {
        const spec = getParityCase(exclusion.case);
        expect(
          spec.drivers,
          `${exclusion.case} is both executed and excluded for '${exclusion.driver}'`,
        ).not.toContain(exclusion.driver);
      }
    });
  });

  describe('every cell is declared — an untested cell and an impossible cell must look different', () => {
    const cells = PARITY_CASES.flatMap(entry => PARITY_DRIVERS.map(driver => ({ driver, entry })));

    it.each(cells.map(cell => [cell.entry.id, cell.driver] as const))(
      '%s × %s is EXECUTED, IMPOSSIBLE or DIFFERENT-BY-DESIGN',
      (id, driver) => {
        const spec = getParityCase(id);
        if (spec.drivers.includes(driver)) {
          return;
        }
        const exclusion = PARITY_EXCLUSIONS.find(entry => entry.case === id && entry.driver === driver);
        expect(
          exclusion,
          `${id} does not run under '${driver}' and declares no reason. Either add the driver to the `
            + 'case, or add an exclusion to PARITY_EXCLUSIONS saying why it cannot exist there.',
        ).toBeDefined();
        expect(exclusion.reason).toMatch(/^(DIFFERENT-BY-DESIGN|IMPOSSIBLE): \S/);
      },
    );
  });

  describe('exclusions carry the evidence their kind requires', () => {
    it.each(PARITY_EXCLUSIONS.map(exclusion => [`${exclusion.case} × ${exclusion.driver}`, exclusion] as const))(
      '%s',
      (_label, exclusion) => {
        if (exclusion.reason.startsWith('IMPOSSIBLE:')) {
          // Nothing happens instead, so there is nothing to assert instead. A `provenBy` here would
          // be a claim the executor cannot honour.
          expect(exclusion.provenBy, 'an IMPOSSIBLE cell has no complement').toBeUndefined();
          return;
        }

        expect(exclusion.provenBy, 'a DIFFERENT-BY-DESIGN cell must name the case asserting the difference')
          .toBeTruthy();
        const proof = getParityCase(exclusion.provenBy);
        expect(
          proof.drivers,
          `${exclusion.provenBy} must actually run under '${exclusion.driver}' to prove anything about it`,
        ).toContain(exclusion.driver);

        // …and the complement is really registered, with the driver spelled out — not merely
        // promised in prose.
        const spec = getParityCase(exclusion.case);
        const source = executorSource(spec.layer);
        expect(
          source,
          `${EXECUTOR[spec.layer]} must register parityComplement('${exclusion.case}', '${exclusion.driver}', …)`,
        ).toContain(`parityComplement('${exclusion.case}', '${exclusion.driver}'`);
      },
    );
  });

  describe('the executors and the matrix cannot drift apart', () => {
    it.each(PARITY_CASES.map(entry => [entry.id, entry.layer] as const))(
      '%s is registered by its layer executor',
      (id, layer) => {
        const source = executorSource(layer);
        const registered = [...registeredIds(source, 'parityIt'), ...registeredIds(source, 'parityComplement')];
        expect(registered, `${EXECUTOR[layer]} never registers '${id}'`).toContain(id);
      },
    );

    it.each(Object.keys(EXECUTOR) as ParityLayer[])(
      '%s executor registers only declared case ids',
      (layer) => {
        const source = executorSource(layer);
        const declared = new Set(PARITY_CASES.filter(entry => entry.layer === layer).map(entry => entry.id));
        for (const id of [...registeredIds(source, 'parityIt'), ...registeredIds(source, 'parityComplement')]) {
          expect(
            declared.has(id),
            `${EXECUTOR[layer]} registers '${id}', which is not a ${layer}-layer case in the matrix`,
          ).toBe(true);
        }
      },
    );
  });

  describe('consolidation did not lose coverage', () => {
    it.each(FOLDED_IN.map(entry => [`${entry.from}: ${entry.was}`, entry] as const))(
      '%s survived the fold',
      (_label, entry) => {
        // Throws with the offending id when the target case was renamed or deleted.
        expect(getParityCase(entry.into).id).toBe(entry.into);
      },
    );

    it.each([...new Set(FOLDED_IN.map(entry => entry.from))])(
      '%s.e2e-spec.ts stays consolidated, not re-added alongside the matrix',
      (from) => {
        // Re-adding one would not fail anything — it would just quietly re-create the situation
        // this matrix was built to end: the same behaviour asserted for one driver, in a file
        // nobody re-runs when another driver changes.
        expect(existsSync(join(TESTS, `${from}.e2e-spec.ts`)), `${from}.e2e-spec.ts was folded into the matrix`)
          .toBe(false);
      },
    );

    it('covers every driver for the behaviours the folded-in suites only covered for one', () => {
      // The point of folding: each origin suite asserted its cases for exactly ONE driver. Every
      // target must now run for all three, or the fold traded breadth for tidiness.
      for (const entry of new Set(FOLDED_IN.map(item => item.into))) {
        const spec = getParityCase(entry);
        const covered = new Set([
          ...spec.drivers,
          ...PARITY_EXCLUSIONS.filter(exclusion => exclusion.case === entry).map(exclusion => exclusion.driver),
        ]);
        expect([...covered].sort(), `${entry}`).toEqual([...PARITY_DRIVERS].sort());
      }
    });
  });
});
