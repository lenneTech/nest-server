/**
 * The consumer gate must test the starter in the state a consumer's documented update produces.
 *
 * A starter-based project moves to a new framework version with `pnpm run update`
 * (extras/sync-packages.mjs in nest-server-starter), which raises every pin the framework declares
 * in the same section. The gate cannot call that script — it reads the npm registry, which does not
 * have the version under test yet — so `alignConsumerPins()` applies the same rule to the tarball's
 * manifest. These cases pin that rule, including the three things it must NOT do (lower, add, cross
 * sections), because each of those would test a state no consumer ever reaches.
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
  devDependencies: { '@nestjs/testing': '11.2.6', typescript: '5.9.3' },
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

  it('never lowers, never adds, and never moves a package across sections', () => {
    const consumer = {
      dependencies: { multer: '2.5.0' },
      devDependencies: { mongodb: '7.5.0', typescript: '5.9.3' },
    };
    const raised = alignConsumerPins(consumer, framework);
    expect(raised).toEqual([]);
    // Newer than the framework's → kept.
    expect(consumer.dependencies.multer).toBe('2.5.0');
    // The framework declares mongodb under `dependencies`; sync-packages matches sections, so a
    // devDependency of the same name stays where the consumer put it.
    expect(consumer.devDependencies.mongodb).toBe('7.5.0');
    // Not declared by the consumer → not added (that is `update:all`, not `update`).
    expect(consumer.dependencies).not.toHaveProperty('@nestjs/common');
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
