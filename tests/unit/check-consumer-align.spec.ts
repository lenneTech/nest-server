/**
 * The consumer gate must test the starter in the state a consumer's documented update produces.
 *
 * A starter-based project moves to a new framework version with `pnpm run update`
 * (extras/sync-packages.mjs in nest-server-starter), which raises every pin the project already
 * declares to the framework's version, in the section the project keeps it — from the framework's
 * `dependencies` for either section, from its `devDependencies` for devDependencies only. The gate cannot
 * call that script — it reads the npm registry, which does not have the version under test yet — so
 * `alignConsumerPins()` applies the same rule to the tarball's manifest. These cases pin that rule,
 * including the three things it must NOT do (lower, add, move a package to another section), because
 * each of those would test a state no consumer ever reaches.
 *
 * @regression   11.41.4 — the gate only re-pointed the framework dependency at the tarball and kept
 *   every other starter pin. The release raised `@nestjs/common` to 11.2.6 while the starter still
 *   pinned 11.2.1, `@nestjs/schedule` was installed twice, `CronJobs extends CoreCronJobs` stopped
 *   type-checking, and a sound tarball was refused. Every release raising a shared exact pin would
 *   have hit the same wall.
 * @seen-failing Make `alignConsumerPins()` raise nothing (compare with `< 0` instead of `> 0`) in
 *   scripts/check-consumer.mjs — registered as mutation `consumer-gate-skips-pin-alignment` in
 *   tests/regression-mutations.json.
 */
import { describe, expect, it } from 'vitest';

import { alignConsumerPins } from '../../scripts/check-consumer.mjs';

const framework = {
  dependencies: { '@nestjs/common': '11.2.6', mongodb: '7.6.0', mongoose: '9.10.2', multer: '2.4.0' },
  devDependencies: { '@nestjs/testing': '11.2.6', 'better-auth': '1.7.8', typescript: '5.9.3' },
  name: '@lenne.tech/nest-server',
};

describe('check-consumer — alignConsumerPins() follows `pnpm run update`', () => {
  it('raises a pin the consumer declares in the same section when the framework is newer', () => {
    const consumer = {
      dependencies: { '@lenne.tech/nest-server': '11.41.3', '@nestjs/common': '11.2.1', mongoose: '9.9.3' },
      devDependencies: { '@nestjs/testing': '11.2.1' },
    };
    const raised = alignConsumerPins(consumer, framework);
    expect(consumer.dependencies).toMatchObject({ '@nestjs/common': '11.2.6', mongoose: '9.10.2' });
    expect(consumer.devDependencies['@nestjs/testing']).toBe('11.2.6');
    expect(raised).toEqual(
      expect.arrayContaining([
        { from: '11.2.1', name: '@nestjs/common', section: 'dependencies', to: '11.2.6' },
        { from: '9.9.3', name: 'mongoose', section: 'dependencies', to: '9.10.2' },
        { from: '11.2.1', name: '@nestjs/testing', section: 'devDependencies', to: '11.2.6' },
      ]),
    );
    expect(raised).toHaveLength(3);
  });

  it('never lowers and never adds', () => {
    const consumer = {
      dependencies: { multer: '2.5.0' },
      devDependencies: { typescript: '5.9.3' },
    };
    const raised = alignConsumerPins(consumer, framework);
    expect(raised).toEqual([]);
    // Newer than the framework's → kept.
    expect(consumer.dependencies.multer).toBe('2.5.0');
    // Not declared by the consumer → not added (that is `update:all`, not `update`).
    expect(consumer.dependencies).not.toHaveProperty('@nestjs/common');
  });

  /**
   * @regression   11.42.15 — the rule matched sections. nest-server declares `mongodb` under
   *   `dependencies`, the starter under `devDependencies`, and Better-Auth's MongoDB adapter resolves
   *   its `mongodb` peer from that pin. A release raising mongoose 9.11 (which needs mongodb ~7.7) left
   *   the starter's mongodb on 7.6.0: two bson copies, the adapter's `instanceof ObjectId` failed and
   *   sign-in answered 401 — the gate broke on 2026-10-06, and every starter-based project's
   *   `pnpm run update` would have produced the same tree.
   * @seen-failing Look the framework version up in the consumer's own section only
   *   (`framework?.[section]?.[name]`) in scripts/check-consumer.mjs — registered as mutation
   *   `consumer-gate-same-section-only` in tests/regression-mutations.json.
   */
  it('raises a framework runtime dependency in the consumer devDependencies too', () => {
    const consumer = { devDependencies: { mongodb: '7.5.0' } };
    const raised = alignConsumerPins(consumer, framework);
    expect(consumer.devDependencies.mongodb).toBe('7.6.0');
    expect(raised).toEqual([{ from: '7.5.0', name: 'mongodb', section: 'devDependencies', to: '7.6.0' }]);
    // Raised where it was — never copied or moved into the framework's section.
    expect(consumer).not.toHaveProperty('dependencies');
  });

  /**
   * @regression   11.42.15 (caught in review) — the first cross-section rule also let a framework
   *   DEVdependency set a consumer's RUNTIME pin. nest-server keeps the better-auth trio as
   *   devDependencies (its own test versions, with a peer range as the contract), a project keeps
   *   them as dependencies — and owns that version, because its api and app must resolve the same
   *   better-auth. The next better-auth patch in nest-server would have moved the api on
   *   `pnpm run update` and left the app behind.
   * @seen-failing Let `dependencies` take its version from both framework sections in
   *   `RAISE_SOURCES` in scripts/check-consumer.mjs — registered as mutation
   *   `consumer-gate-devdeps-drive-runtime-pins` in tests/regression-mutations.json.
   */
  it('never raises a consumer runtime dependency from a framework devDependency', () => {
    const consumer = { dependencies: { 'better-auth': '1.7.7', typescript: '5.8.3' } };
    expect(alignConsumerPins(consumer, framework)).toEqual([]);
    expect(consumer.dependencies).toEqual({ 'better-auth': '1.7.7', typescript: '5.8.3' });
  });

  it('takes the newest version from the framework sections allowed for the consumer section', () => {
    const both = { dependencies: { mongodb: '7.6.0' }, devDependencies: { mongodb: '7.7.0' } };
    const dev = { devDependencies: { mongodb: '7.5.0' } };
    alignConsumerPins(dev, both);
    expect(dev.devDependencies.mongodb).toBe('7.7.0');
    // A runtime pin follows only what the framework ships, never its own test version.
    const runtime = { dependencies: { mongodb: '7.5.0' } };
    alignConsumerPins(runtime, both);
    expect(runtime.dependencies.mongodb).toBe('7.6.0');
  });

  it('leaves ranges, tags and the framework dependency itself alone', () => {
    const consumer = {
      dependencies: { '@lenne.tech/nest-server': 'file:/tmp/pkg.tgz', '@nestjs/common': '^11.2.1', mongoose: 'latest' },
    };
    expect(alignConsumerPins(consumer, framework)).toEqual([]);
    expect(consumer.dependencies).toEqual({
      '@lenne.tech/nest-server': 'file:/tmp/pkg.tgz',
      '@nestjs/common': '^11.2.1',
      mongoose: 'latest',
    });
  });

  it('compares versions numerically, not as strings', () => {
    const consumer = { dependencies: { mongoose: '9.9.3' } };
    alignConsumerPins(consumer, { dependencies: { mongoose: '9.10.0' } });
    expect(consumer.dependencies.mongoose).toBe('9.10.0');
  });
});
