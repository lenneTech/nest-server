/**
 * How `check:mutations --shard=i/n` splits the registry across parallel CI jobs.
 *
 * WHY THIS IS TESTED AT ALL
 * -------------------------
 * Sharding exists to bring the full regression-evidence run under 30 minutes (54 min for 426
 * mutations on one runner, 2026-10-29) WITHOUT checking less. A split that loses a mutation is the
 * one failure that cannot show up in any run: every shard reports green, the summary of each shard
 * is honest about what it ran, and the mutation nobody ran is simply absent. So the partition is
 * pinned here, against the real registry, and so is the second place it can break — a workflow
 * whose matrix and `--shard` count disagree skips every shard above the matrix.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { parseShard, shardMutations } from '../../scripts/check-mutations.mjs';

interface RegisteredMutation {
  id: string;
  specs: string[];
}

const ROOT = join(__dirname, '..', '..');
const REGISTRY: RegisteredMutation[] = JSON.parse(
  readFileSync(join(ROOT, 'tests', 'regression-mutations.json'), 'utf8'),
).mutations;
const isE2e = (mutation: RegisteredMutation) => mutation.specs.some((spec) => !spec.startsWith('tests/unit/'));

/**
 * @regression   12.1.1 / DEV-3910 — the evidence gate is split across parallel CI jobs; a shard
 *   assignment that drops a residue class leaves a quarter of the registry unchecked while every
 *   job reports green.
 * @seen-failing Replace `position % count === index - 1` with `position % count === index` in
 *   scripts/check-mutations.mjs — registered as mutation `mutation-shard-drops-residue` in
 *   tests/regression-mutations.json.
 */
describe('shardMutations — every mutation runs in exactly one shard', () => {
  for (const count of [1, 2, 3, 4, 5, 6]) {
    it(`splits the real registry into ${count} disjoint shards that cover all of it`, () => {
      const shards = Array.from({ length: count }, (_, i) => shardMutations(REGISTRY, { count, index: i + 1 }));
      const ids = shards.flat().map((mutation) => mutation.id);

      expect(ids).toHaveLength(REGISTRY.length);
      expect(new Set(ids).size).toBe(REGISTRY.length);
      expect([...ids].sort()).toEqual(REGISTRY.map((mutation) => mutation.id).sort());
    });
  }

  it('balances unit and e2e mutations separately, so no shard collects the slow ones', () => {
    // An e2e mutation costs several unit mutations (vitest's globalSetup, MongoDB, containers). A
    // plain positional split would let the registry's ordering decide which shard is slowest.
    const count = 4;
    const shards = Array.from({ length: count }, (_, i) => shardMutations(REGISTRY, { count, index: i + 1 }));
    const e2e = shards.map((shard) => shard.filter(isE2e).length);
    const unit = shards.map((shard) => shard.filter((mutation) => !isE2e(mutation)).length);

    expect(Math.max(...e2e) - Math.min(...e2e)).toBeLessThanOrEqual(1);
    expect(Math.max(...unit) - Math.min(...unit)).toBeLessThanOrEqual(1);
  });

  it('is deterministic and keeps registry order inside a shard', () => {
    const first = shardMutations(REGISTRY, { count: 4, index: 2 });
    const second = shardMutations(REGISTRY, { count: 4, index: 2 });
    const positions = first.map((mutation) => REGISTRY.findIndex((entry) => entry.id === mutation.id));

    expect(second).toEqual(first);
    expect(positions).toEqual([...positions].sort((a, b) => a - b));
  });

  it('returns the whole selection for a single shard', () => {
    expect(shardMutations(REGISTRY, { count: 1, index: 1 })).toEqual(REGISTRY);
  });
});

describe('parseShard', () => {
  it.each(['1/4', '4/4', '1/1'])('accepts %s', (value) => {
    const [index, count] = value.split('/').map(Number);
    expect(parseShard(value)).toEqual({ count, index, ok: true });
  });

  it.each(['0/4', '5/4', '1/0', 'a/b', '2', '', '-1/4', '1/4/2', '1.5/4', '1/65'])('refuses %j', (value) => {
    // A shard spec the runner misreads is a silent gap: `5/4` would run nothing and exit green.
    expect(parseShard(value)).toMatchObject({ ok: false });
  });
});

/**
 * @regression   12.1.1 / DEV-3910 — a matrix with fewer entries than the `--shard` count never starts
 *   the missing shards, and the run is green with part of the registry unchecked.
 * @seen-failing Replace `shard: [ 1, 2, 3, 4 ]` with `shard: [ 1, 2, 3 ]` in .github/workflows/publish.yml —
 *   registered as mutation `evidence-matrix-misses-a-shard` in tests/regression-mutations.json.
 */
describe('the evidence workflows run every shard', () => {
  const publish = readFileSync(join(ROOT, '.github', 'workflows', 'publish.yml'), 'utf8');
  const onDemand = readFileSync(join(ROOT, '.github', 'workflows', 'regression-evidence.yml'), 'utf8');

  it('publish.yml: the matrix lists exactly 1..N for the N its --shard names', () => {
    const matrix = publish.match(/shard: \[([^\]]*)\]/)?.[1];
    const total = publish.match(/--shard=\$\{\{ matrix\.shard \}\}\/(\d+)/)?.[1];

    expect(matrix).toBeDefined();
    expect(total).toBeDefined();
    const listed = matrix!.split(',').map((value) => Number(value.trim()));
    expect(listed).toEqual(Array.from({ length: Number(total) }, (_, i) => i + 1));
  });

  it('regression-evidence.yml: the matrix and the --shard count come from the same planned value', () => {
    // The on-demand workflow takes the shard count as an input, so both halves must read the one
    // value the plan job derived — never two copies of it.
    expect(onDemand).toMatch(/shard: \$\{\{ fromJSON\(needs\.plan\.outputs\.shards\) \}\}/);
    expect(onDemand).toMatch(/MUTATION_SHARD: \$\{\{ matrix\.shard \}\}\/\$\{\{ needs\.plan\.outputs\.count \}\}/);
    expect(onDemand).toMatch(/"--shard=\$MUTATION_SHARD"/);
  });

  it.each([
    ['publish.yml', publish],
    ['regression-evidence.yml', onDemand],
  ])('%s keeps the other shards running when one goes red', (_name, workflow) => {
    // GitHub cancels the rest of a matrix on the first failure by default — and with it the
    // verdicts of every shard that had not finished yet.
    expect(workflow).toMatch(/strategy:\n\s+fail-fast: false\n\s+matrix:/);
  });

  it('publish.yml opens the issue for a red gate once, after all shards', () => {
    // Two red shards that each look for an open issue at the same moment find none and both create
    // one. The issue belongs to a job that runs once, after the matrix.
    expect(publish.match(/issues\.create\(/g)).toHaveLength(1);
    const reportJob = publish.slice(publish.indexOf('regression-evidence-report:'));
    expect(reportJob).toMatch(/needs: regression-evidence\b/);
    expect(reportJob).toMatch(/if: \$\{\{ always\(\) && needs\.regression-evidence\.result == 'failure' \}\}/);
    expect(reportJob.indexOf('issues.create(')).toBeGreaterThan(0);
  });
});
