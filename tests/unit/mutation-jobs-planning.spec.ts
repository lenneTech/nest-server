/**
 * How `check:mutations` decides between the parallel and the sequential path.
 *
 * WHY THIS IS TESTED AT ALL
 * -------------------------
 * The mutation runner is the thing that proves the regression tests are not vacuous. If it silently
 * answers about the WRONG SOURCE, every verdict it prints is worthless — and the two ways that can
 * happen are both decided here: parallel mode runs each mutation in a `git worktree` checked out at
 * HEAD, so it must refuse to parallelise whenever the caller is testing uncommitted work.
 *
 * The rest of the runner needs a real repo, real worktrees and ~7 minutes. This decision does not,
 * so it is worth pinning on its own.
 */
import { describe, expect, it } from 'vitest';

import {
  applyMutation,
  classifyRun,
  planJobs,
  resolveSinceRef,
  selectMutations,
  stripAnsi,
  tailOf,
} from '../../scripts/check-mutations.mjs';

const clean = { cores: 12, mutationCount: 49 };

describe('planJobs', () => {
  describe('falls back to sequential when a worktree would test the wrong source', () => {
    it('refuses to parallelise a dirty src/ or tests/', () => {
      // A worktree is at HEAD. Parallelising here would give a fast answer about code the caller is
      // not running — strictly worse than a slow answer about the code they are.
      const { jobs, why } = planJobs({ ...clean, sourceDirty: true });

      expect(jobs).toBe(1);
      expect(why).toMatch(/dirty/);
    });

    it('refuses to parallelise under --allow-dirty', () => {
      // --allow-dirty exists for "the fix and its evidence share a working tree", which is exactly
      // the case a HEAD worktree cannot represent.
      const { jobs, why } = planJobs({ ...clean, allowDirty: true });

      expect(jobs).toBe(1);
      expect(why).toMatch(/working tree/);
    });

    it('says WHY it went sequential', () => {
      // Silence here would look identical to "this machine is just slow".
      expect(planJobs({ ...clean, sourceDirty: true }).why).toBeTruthy();
    });
  });

  describe('sizing', () => {
    it('gives the smallest CI runner parallelism too', () => {
      // The dominant cost is vitest's cold start, which barely scales with cores — the registry
      // takes ~744s on 12 cores and ~777s on 4. A core-proportional formula would hand a 4-vCPU
      // runner jobs=1, i.e. no benefit exactly where the wall clock hurts most.
      expect(planJobs({ ...clean, cores: 4 }).jobs).toBe(2);
    });

    it('caps the worker count', () => {
      // Each worker starts a vitest that forks again; past 4 the workers fight each other.
      expect(planJobs({ ...clean, cores: 64 }).jobs).toBe(4);
    });

    it('wants at least two mutations per worker before building worktrees', () => {
      // A worktree costs real setup time. Three mutations across four lanes finishes before the
      // parallelism has paid for itself, so the run stays narrow.
      expect(planJobs({ cores: 12, mutationCount: 3 }).jobs).toBe(1);
      expect(planJobs({ cores: 12, mutationCount: 8 }).jobs).toBe(4);
    });

    it('never spawns more workers than there are mutations', () => {
      expect(planJobs({ cores: 12, mutationCount: 4 }).jobs).toBeLessThanOrEqual(4);
      expect(planJobs({ cores: 12, mutationCount: 2 }).jobs).toBe(1);
    });

    it('caps an explicit --jobs so one run cannot evict the machine-wide governor', () => {
      // `LT_E2E_MAX_RUNS` is raised to the lane count, and that slot directory is shared with every
      // other lt project on the machine.
      expect(planJobs({ ...clean, explicit: 50 }).jobs).toBe(8);
    });

    it('stays sequential for a single mutation', () => {
      // `--id=<one>` is the common local invocation; a worktree would be pure overhead.
      expect(planJobs({ cores: 12, mutationCount: 1 }).jobs).toBe(1);
    });
  });

  describe('explicit --jobs wins', () => {
    it('honours a higher count than the default', () => {
      expect(planJobs({ ...clean, cores: 4, explicit: 4 }).jobs).toBe(4);
    });

    it('honours --jobs=1 as the documented escape hatch', () => {
      expect(planJobs({ ...clean, explicit: 1 }).jobs).toBe(1);
    });

    it('does NOT let --jobs override the dirty-tree refusal', () => {
      // The file's stated safety property. The dirty checks run after `requested` is computed, so a
      // refactor that hoists the explicit branch above them would re-arm testing-the-wrong-source
      // while every other case here stayed green.
      expect(planJobs({ ...clean, explicit: 4, sourceDirty: true }).jobs).toBe(1);
      expect(planJobs({ ...clean, allowDirty: true, explicit: 4 }).jobs).toBe(1);
    });

    it('ignores a non-numeric or non-positive value rather than failing the run', () => {
      // `--jobs=` / `--jobs=oops` come through as NaN; a mutation run must not die over a typo in
      // a performance knob.
      expect(planJobs({ ...clean, explicit: Number.NaN }).jobs).toBe(4);
      expect(planJobs({ ...clean, explicit: 0 }).jobs).toBe(4);
      expect(planJobs({ ...clean, explicit: -2 }).jobs).toBe(4);
    });
  });
});

/**
 * The two LOCAL selection filters. Neither is wired into the publish path, and the thing worth
 * pinning is that a narrowed run can never be mistaken for the full evidence.
 */
describe('selectMutations', () => {
  const mutations = [
    { file: 'src/a.ts', id: 'unit-one', specs: ['tests/unit/a.spec.ts'] },
    { file: 'src/b.ts', id: 'e2e-one', specs: ['tests/b.e2e-spec.ts'] },
    { file: 'src/c.ts', id: 'mixed-one', specs: ['tests/unit/c.spec.ts', 'tests/c.e2e-spec.ts'] },
  ];

  describe('--no-infra', () => {
    it('keeps only mutations whose specs all run without MongoDB', () => {
      // The unit runner has no globalSetup; a mixed set still needs the e2e runner, so it is out.
      const { mutations: selected } = selectMutations({ mutations, noInfra: true });

      expect(selected.map((m) => m.id)).toEqual(['unit-one']);
    });

    it('says how many it did NOT check', () => {
      // A narrowed run that reports only what it ran reads like a full pass. It must not.
      const { notes } = selectMutations({ mutations, noInfra: true });

      expect(notes.join(' ')).toMatch(/2 were NOT checked/);
    });
  });

  describe('--since', () => {
    it('keeps mutations whose target file changed', () => {
      const { mutations: selected } = selectMutations({ changed: ['src/b.ts'], mutations });

      expect(selected.map((m) => m.id)).toEqual(['e2e-one']);
    });

    it('keeps mutations whose spec changed even when the source did not', () => {
      // Editing the spec can make it vacuous without touching the code it judges.
      const { mutations: selected } = selectMutations({ changed: ['tests/unit/a.spec.ts'], mutations });

      expect(selected.map((m) => m.id)).toEqual(['unit-one']);
    });

    it('runs EVERYTHING when a global input changed', () => {
      // A changed registry, vitest config or setup file can move any verdict, so per-mutation
      // reasoning is not available — the only honest answer is the full set. All seven, because a
      // partially-covered list is how one of them quietly stops being honoured.
      const globalInputs = [
        'tests/regression-mutations.json',
        'tests/setup.ts',
        'tests/global-setup.ts',
        'vitest.config.ts',
        'vitest-e2e.config.ts',
        'vitest.include-globs.ts',
        'scripts/check-mutations.mjs',
      ];
      for (const file of globalInputs) {
        const { mutations: selected } = selectMutations({ changed: [file], mutations });
        expect(selected).toHaveLength(3);
      }
    });

    it('labels itself a heuristic', () => {
      // It does not follow transitive imports; saying so in the output is the whole safeguard.
      const { notes } = selectMutations({ changed: ['src/a.ts'], mutations });

      expect(notes.join(' ')).toMatch(/HEURISTIC/);
    });

    it('selects nothing rather than everything when nothing relevant changed', () => {
      // Failing open here would silently turn a narrowed run into a full one and hide the cost.
      const { mutations: selected } = selectMutations({ changed: ['README.md'], mutations });

      expect(selected).toHaveLength(0);
    });
  });

  it('composes both filters', () => {
    const { mutations: selected } = selectMutations({
      changed: ['src/a.ts', 'src/b.ts'],
      mutations,
      noInfra: true,
    });

    expect(selected.map((m) => m.id)).toEqual(['unit-one']);
  });
});

/**
 * The verdict rule, extracted so it can be tested without running vitest 51 times.
 *
 * The third case is the point: a non-zero exit is NOT evidence on its own, because vitest also
 * exits non-zero when it crashed, timed out or was starved. Before that distinction existed, a
 * starved parallel run reported "confirmed" for a mutation nothing had actually checked.
 */
describe('classifyRun', () => {
  it('calls a green run VACUOUS — the specs passed with the defect restored', () => {
    const verdict = classifyRun({ code: 0, output: 'Tests  20 passed (20)' });

    expect(verdict.ok).toBe(false);
    expect(verdict.label).toContain('VACUOUS');
  });

  it('accepts a non-zero run that REPORTS failing tests', () => {
    const verdict = classifyRun({ code: 1, output: 'Tests  2 failed | 18 passed (20)' });

    expect(verdict.ok).toBe(true);
    expect(verdict.note).toContain('2 test(s) failed');
  });

  it('calls a non-zero run with no reported failures INCONCLUSIVE, not evidence', () => {
    // A crash, a timeout, a collection error, or resource starvation. Each exits non-zero and each
    // would previously have been counted as "the mutation was caught".
    const verdict = classifyRun({ code: 1, output: 'Error: socket hang up' });

    expect(verdict.ok).toBe(false);
    expect(verdict.label).toContain('INCONCLUSIVE');
  });

  it('does not throw on empty or missing output', () => {
    expect(classifyRun({ code: 1, output: '' }).ok).toBe(false);
    expect(classifyRun({ code: 1, output: undefined }).ok).toBe(false);
  });

  /**
   * A refusal has to carry its reason. `0/51 mutations confirmed` with every verdict INCONCLUSIVE
   * and no captured output is what made the 11.36.3 CI failure impossible to diagnose without
   * cutting another release.
   */
  it('attaches the captured output to a verdict that needs explaining', () => {
    const inconclusive = classifyRun({ code: 1, output: 'Error: socket hang up' });
    const vacuous = classifyRun({ code: 0, output: 'Tests  20 passed (20)' });

    expect(inconclusive.evidence).toContain('socket hang up');
    expect(vacuous.evidence).toContain('20 passed');
  });

  it('names the exit code, so a crash and a starved run are distinguishable', () => {
    expect(classifyRun({ code: 137, output: 'killed' }).label).toContain('137');
  });

  it('attaches NO output to a passing verdict — there is nothing to explain', () => {
    expect(classifyRun({ code: 1, output: 'Tests  2 failed | 18 passed (20)' }).evidence).toBeUndefined();
  });
});

/**
 * The defect that cost the 11.36.3 publish: vitest colours its summary on a CI runner, so the raw
 * line reads `Tests <esc>[22m <esc>[1m<esc>[31m3 failed`. `\s+` matches whitespace, never an escape
 * sequence — so the count did not parse, and all 51 mutations reported INCONCLUSIVE while their
 * specs had gone red exactly as required.
 *
 * Locally the same command is COLOURLESS (stdout is a pipe), which is why nothing caught it: the
 * one environment where the parse mattered was the one environment never exercised.
 */
describe('classifyRun on a colourised CI runner', () => {
  const ESC = String.fromCharCode(27);
  const colour = (code: string, text: string) => `${ESC}[${code}m${text}${ESC}[39m`;
  const CI_SUMMARY =
    `${ESC}[2m      Tests ${ESC}[22m ${colour('31', '3 failed')}${ESC}[2m | ${ESC}[22m${colour('32', '19 passed')}${ESC}[90m (22)${ESC}[39m`;

  it('reads the failure count through the colour codes', () => {
    const verdict = classifyRun({ code: 1, output: CI_SUMMARY });

    expect(verdict.ok, 'a coloured "3 failed" is still three failures').toBe(true);
    expect(verdict.note).toContain('3 test(s) failed');
  });

  it('still calls a coloured crash INCONCLUSIVE', () => {
    // The paired refusal: stripping colour must not make everything parse as a pass.
    const verdict = classifyRun({ code: 1, output: colour('31', 'Error: socket hang up') });

    expect(verdict.ok).toBe(false);
    expect(verdict.label).toContain('INCONCLUSIVE');
  });

  it('strips colour from the evidence, so a human can read it', () => {
    const verdict = classifyRun({ code: 1, output: colour('31', 'Error: boom') });

    expect(verdict.evidence).toContain('Error: boom');
    expect(verdict.evidence).not.toContain(ESC);
  });
});

describe('stripAnsi', () => {
  const ESC = String.fromCharCode(27);

  it('removes colour sequences and keeps the text', () => {
    expect(stripAnsi(`${ESC}[31mred${ESC}[39m`)).toBe('red');
    expect(stripAnsi(`${ESC}[1m${ESC}[2mbold-dim${ESC}[22m`)).toBe('bold-dim');
  });

  it('leaves uncoloured text untouched and tolerates nothing at all', () => {
    expect(stripAnsi('plain')).toBe('plain');
    expect(stripAnsi('')).toBe('');
    expect(stripAnsi(undefined)).toBe('');
  });
});

describe('tailOf', () => {
  it('keeps the last lines, where a failure summary lives', () => {
    const out = tailOf(Array.from({ length: 100 }, (_, i) => `line ${i}`).join('\n'), 3);

    expect(out).toContain('line 99');
    expect(out).not.toContain('line 50');
  });

  it('says how much it dropped rather than truncating silently', () => {
    const out = tailOf(Array.from({ length: 100 }, (_, i) => `line ${i}`).join('\n'), 3);

    expect(out).toContain('97 earlier line(s) omitted');
  });

  it('returns everything when it fits, with no omission notice', () => {
    expect(tailOf('a\nb', 25)).toBe('a\nb');
  });

  it('says so explicitly when nothing was captured', () => {
    // Distinguishes "the run printed nothing" from "we forgot to capture it".
    expect(tailOf('')).toBe('(no output captured)');
    expect(tailOf(undefined)).toBe('(no output captured)');
  });
});

/**
 * The only security-shaped code in this script: git reads a leading dash as an OPTION, so an
 * unvalidated `--since` value reaches `--output=<path>` and TRUNCATES that file.
 */
describe('resolveSinceRef', () => {
  const neverCalled = () => {
    throw new Error('rev-parse must not run for a value rejected on shape alone');
  };

  it('refuses a value git would read as an option, without invoking git', () => {
    for (const evil of ['--output=victim.txt', '-O/tmp/victim', '--no-such-flag', '-']) {
      const result = resolveSinceRef(evil, neverCalled);

      expect(result.ok, `${evil} must be refused`).toBe(false);
    }
  });

  it('refuses an empty or non-string value', () => {
    expect(resolveSinceRef('', neverCalled).ok).toBe(false);
    expect(resolveSinceRef(undefined, neverCalled).ok).toBe(false);
  });

  it('refuses a ref git cannot resolve', () => {
    // Cast rather than narrowed: the helper is JSDoc-typed in a .mjs, so `ok` widens to `boolean`
    // and cannot discriminate the union.
    const result = resolveSinceRef('no-such-branch', () => ({ status: 1, stdout: '' })) as {
      ok: boolean;
      reason: string;
    };

    expect(result.ok).toBe(false);
    expect(result.reason).toContain('not a commit');
  });

  it('refuses output that is not a full 40-character SHA', () => {
    // Belt and braces: the shape check does not depend on git having behaved.
    const result = resolveSinceRef('weird', () => ({ status: 0, stdout: 'not-a-sha\n' }));

    expect(result.ok).toBe(false);
  });

  it('resolves a real ref to its SHA', () => {
    const sha = 'a'.repeat(40);
    const result = resolveSinceRef('develop', () => ({ status: 0, stdout: `${sha}\n` }));

    expect(result).toEqual({ ok: true, sha });
  });
});

/**
 * `applyMutation` uses index arithmetic rather than `String.replace`, because `replace` interprets
 * `$&`, `$1` and `` $` `` in the REPLACEMENT even when the pattern is a plain string. A registry
 * entry containing one would write code the registry does not describe — and the run would then
 * report a verdict about a defect nobody introduced.
 */
describe('applyMutation', () => {
  it('treats `$&` in the replacement as a literal', () => {
    const source = 'const a = 1;\nconst target = original;\n';
    const result = applyMutation(source, { find: 'original', replace: '$& + $&' });

    expect(result).toContain('const target = $& + $&;');
  });

  it('treats `$1` and backtick-dollar in the replacement as literals', () => {
    const source = 'const target = original;\n';

    expect(applyMutation(source, { find: 'original', replace: '$1' })).toContain('= $1;');
    expect(applyMutation(source, { find: 'original', replace: '$`x' })).toContain('= $`x;');
  });

  it('still refuses a find string that does not match exactly once', () => {
    const source = 'dup\ndup\n';

    expect(() => applyMutation(source, { find: 'dup', replace: 'x' })).toThrow(/expected exactly 1/);
    expect(() => applyMutation(source, { find: 'absent', replace: 'x' })).toThrow(/expected exactly 1/);
  });
});
