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

import { planJobs } from '../../scripts/check-mutations.mjs';

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

    it('never spawns more workers than there are mutations', () => {
      expect(planJobs({ cores: 12, mutationCount: 3 }).jobs).toBe(3);
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

    it('ignores a non-numeric or non-positive value rather than failing the run', () => {
      // `--jobs=` / `--jobs=oops` come through as NaN; a mutation run must not die over a typo in
      // a performance knob.
      expect(planJobs({ ...clean, explicit: Number.NaN }).jobs).toBe(4);
      expect(planJobs({ ...clean, explicit: 0 }).jobs).toBe(4);
      expect(planJobs({ ...clean, explicit: -2 }).jobs).toBe(4);
    });
  });
});
