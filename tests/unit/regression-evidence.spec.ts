/**
 * Unit Tests: a regression test must carry the evidence that it was seen FAILING.
 *
 * THE BUG CLASS
 * -------------
 * While fixing 11.33.1, two tests written specifically to pin the defect passed with the defect
 * fully restored. They asserted around it, not on it — one of them because the rule it drove read a
 * missing `currentUser` as "allow", which made the broken, context-less inner lookup succeed too.
 * Both were caught only because somebody re-broke the source by hand and re-ran them.
 *
 * A green test looks exactly the same whether it is checking something or nothing. The single thing
 * that distinguishes the two is having watched it go red — and until now that observation lived in
 * terminal scrollback and evaporated with the session.
 *
 * THE CONVENTION (see `.claude/rules/testing.md` § Regression tests must carry their evidence)
 * -------------------------------------------------------------------------------------------
 * A test that claims to pin a defect says so in a machine-readable way:
 *
 *     @regression   <version / one-line description of the defect>
 *     @seen-failing <how it was observed red, naming a mutation id from
 *                    tests/regression-mutations.json>
 *
 * `pnpm run check:mutations` then re-runs that observation: it applies the registered mutation and
 * requires the named specs to fail.
 *
 * WHAT THIS FILE ADDS ON TOP, AND WHY IT IS NOT REDUNDANT
 * -------------------------------------------------------
 * The mutation runner is deliberately not part of `pnpm run check` — it edits source and re-runs
 * e2e suites. So between runs the registry can rot silently, and a rotted mutation is worse than no
 * mutation: `find` stops matching, the "mutation" becomes a no-op, the specs stay green for the
 * ordinary reason, and the runner reports the evidence as confirmed. This file closes that window
 * cheaply, without running anything: every registered `find` must still match its target EXACTLY
 * ONCE, every `@regression` must reference a registered mutation, and every registered mutation
 * must be referenced by a test. None of those can drift unnoticed.
 *
 * Free prose ("Regression guard: …") is untouched by all of this — it predates the convention, it
 * is often on tests whose defect has no reachable mutation any more, and retro-fitting it would
 * produce ceremony rather than evidence. The TAG is the promise; prose is just a comment.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

import { applyMutation } from '../../scripts/check-mutations.mjs';

const ROOT = join(__dirname, '..', '..');
const TESTS = join(ROOT, 'tests');
const REGISTRY_PATH = join(TESTS, 'regression-mutations.json');

const registry: {
  mutations: {
    after?: string;
    defect: string;
    driverSpecific?: boolean;
    drivers?: string[];
    file: string;
    find: string;
    id: string;
    replace: string;
    specs: string[];
  }[];
} = JSON.parse(readFileSync(REGISTRY_PATH, 'utf8'));

/**
 * This file itself.
 *
 * It documents the convention, so its own docblock necessarily contains the tag it scans for —
 * scanning itself would demand a mutation id for a paragraph of prose. Excluded by path rather than
 * by cleverly disguising the tag above, because a disguised tag is exactly the kind of thing a
 * later edit un-disguises without noticing.
 */
const SELF = join(TESTS, 'unit', 'regression-evidence.spec.ts');

function testFiles(): string[] {
  const found: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else if (/\.(e2e-spec|spec|story\.test)\.ts$/.test(entry.name) && full !== SELF) {
        found.push(full);
      }
    }
  };
  walk(TESTS);
  return found;
}

/** Every block comment in a source file, so a tag and its evidence must sit in the SAME block. */
function blockComments(source: string): string[] {
  return source.match(/\/\*[\s\S]*?\*\//g) ?? [];
}

const TAGGED = testFiles().flatMap(file =>
  blockComments(readFileSync(file, 'utf8'))
    .filter(block => block.includes('@regression'))
    .map((block, index) => ({ block, file: relative(ROOT, file), index })),
);

describe('regression-test evidence', () => {
  it('finds at least one @regression-tagged test, so the convention has subjects', () => {
    // Without this the three checks below are all vacuously true — which would be a fitting way for
    // a vacuity guard to fail.
    expect(TAGGED.length).toBeGreaterThan(0);
  });

  describe('every @regression tag carries a re-runnable observation', () => {
    it.each(TAGGED.map(entry => [`${entry.file} #${entry.index + 1}`, entry] as const))('%s', (_label, entry) => {
      expect(
        entry.block,
        'an @regression block must state how the test was observed failing:\n'
          + '  @seen-failing <mutation …, registered in tests/regression-mutations.json>',
      ).toContain('@seen-failing');

      const referenced = registry.mutations.filter(mutation => entry.block.includes(mutation.id));
      expect(
        referenced.map(mutation => mutation.id),
        'the @seen-failing line must name a mutation id from tests/regression-mutations.json, so '
          + '`pnpm run check:mutations` can re-run the observation',
      ).not.toEqual([]);

      // …and that mutation must actually run the file the tag lives in, or the "evidence" is for
      // some other suite entirely.
      for (const mutation of referenced) {
        expect(
          mutation.specs,
          `mutation '${mutation.id}' does not run ${entry.file}`,
        ).toContain(entry.file);
      }
    });
  });

  describe('the registry cannot rot into a no-op', () => {
    it.each(registry.mutations.map(mutation => [mutation.id, mutation] as const))(
      '%s still matches its target exactly once',
      (_id, mutation) => {
        const target = join(ROOT, mutation.file);
        expect(existsSync(target), `${mutation.file} is gone — re-point or retire this mutation`).toBe(true);

        // The real check: applyMutation throws when the anchor or the target is missing or
        // ambiguous. A silent no-op would let `check:mutations` report confirmed evidence for a
        // mutation that changed nothing.
        const source = readFileSync(target, 'utf8');
        expect(() => applyMutation(source, mutation)).not.toThrow();
        expect(applyMutation(source, mutation)).not.toBe(source);
      },
    );

    it.each(registry.mutations.map(mutation => [mutation.id, mutation] as const))(
      '%s names spec files that exist',
      (_id, mutation) => {
        expect(mutation.specs.length).toBeGreaterThan(0);
        for (const spec of mutation.specs) {
          expect(existsSync(join(ROOT, spec)), `${spec} does not exist`).toBe(true);
        }
      },
    );

    it('has no orphaned mutation — every registered defect is claimed by a test', () => {
      // The other direction of the same contract. An unreferenced mutation is a defect nobody says
      // they cover, so `check:mutations` would be re-proving a claim no test is making.
      const referenced = new Set(
        registry.mutations
          .filter(mutation => TAGGED.some(entry => entry.block.includes(mutation.id)))
          .map(mutation => mutation.id),
      );
      const orphans = registry.mutations.map(mutation => mutation.id).filter(id => !referenced.has(id));
      expect(orphans, 'these mutations are registered but no @regression tag references them').toEqual([]);
    });

    it('has unique ids', () => {
      const ids = registry.mutations.map(mutation => mutation.id);
      expect(ids).toEqual([...new Set(ids)]);
    });

    it('keeps at least one DRIVER-SPECIFIC mutation, the shape the parity matrix exists for', () => {
      // 11.33.0's defect was correct under two drivers and broken under the third. If every
      // registered mutation is driver-agnostic, nothing re-proves that the matrix catches the class
      // it was built for — the parity harness would be trusted rather than checked.
      const driverSpecific = registry.mutations.filter(mutation => mutation.driverSpecific);
      expect(driverSpecific.map(mutation => mutation.id)).not.toEqual([]);
      for (const mutation of driverSpecific) {
        expect(mutation.drivers?.length, `${mutation.id} must name the affected drivers`).toBeGreaterThan(0);
      }
    });
  });
});
