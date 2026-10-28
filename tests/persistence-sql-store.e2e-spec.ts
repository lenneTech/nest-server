import { ForbiddenException } from '@nestjs/common';
import { Schema } from 'mongoose';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { Where } from '../src/core/common/persistence/data-store.interface';
import type { ModelDescriptor } from '../src/core/common/persistence/model-descriptor.interface';
import { describeSchema } from '../src/core/common/persistence/model-metadata.registry';
import { applyPostgresSchema } from '../src/core/common/persistence/sql/postgres/postgres-schema.migrator';
import { compilePostgresWhere } from '../src/core/common/persistence/sql/postgres/postgres-where.compiler';
import { SqlDataStore } from '../src/core/common/persistence/sql/sql-data-store';
import { UnsupportedQueryError } from '../src/core/common/persistence/sql/sql-errors';
import { createSqlExecutor } from '../src/core/common/persistence/sql/sql-executor.factory';
import type { SqlExecutor } from '../src/core/common/persistence/sql/sql-executor.interface';
import { isGuardedPool } from '../src/core/common/persistence/sql/sql-session';
import type { SqlParams } from '../src/core/common/persistence/sql/sql-naming';
import { ConfigService } from '../src/core/common/services/config.service';
import { IRequestContext, RequestContext } from '../src/core/common/services/request-context.service';
import { createPostgresTestDatabase, PG_APP, type PostgresTestDatabase } from './helpers/postgres-test-db';

/**
 * The three tenant layers of the SQL store (plan §3.4), each proven on its own: every layer must hold when the
 * others do not. The parity matrix proves the layers together; here one is taken away at a time.
 *
 * - `layer_plain`: tenant-scoped, WITHOUT row-level security — only the store's own layers stand
 * - `layer_rls`: tenant-scoped, WITH row-level security
 * - `UnfilteredStore`: a store whose before-layer filter is gone, as a compiler bug or a wrong path would lose it
 */
const plainModel = describeSchema(
  'LayerPlain',
  new Schema({ name: String, tenantId: String }, { collection: 'layerPlain' }),
);
const rlsModel = describeSchema('LayerRls', new Schema({ name: String, tenantId: String }, { collection: 'layerRls' }));

class UnfilteredStore extends SqlDataStore<any> {
  protected override where(where: undefined | Where, params: SqlParams): string {
    return compilePostgresWhere(this.model, where ?? {}, params);
  }
}

const run = <T>(context: Partial<IRequestContext>, fn: () => Promise<T>): Promise<T> =>
  RequestContext.run({ fromRequest: true, ...context } as IRequestContext, fn);
const names = (records: Array<{ name?: string }>) => records.map((record) => record.name).sort();

describe('SQL store: the three tenant layers, one at a time (e2e)', () => {
  let database: PostgresTestDatabase;
  let app: SqlExecutor;
  const ids: Record<string, string> = {};

  beforeAll(async () => {
    ConfigService.setConfig({ multiTenancy: {} } as any, { reInit: true });
    database = await createPostgresTestDatabase('sql-store-layers');
    const owner = await createSqlExecutor({ engine: 'typeorm', maxConnections: 1, url: database.ownerUrl });
    try {
      await applyPostgresSchema(owner, [plainModel, rlsModel], {
        appRole: PG_APP.user,
        isTenantIsolated: (model: ModelDescriptor) => model === rlsModel,
      });
    } finally {
      await owner.close();
    }
    app = await createSqlExecutor({ engine: 'typeorm', maxConnections: 2, url: database.appUrl });
    for (const model of [plainModel, rlsModel]) {
      const store = new SqlDataStore<any>(app, model);
      for (const tenantId of ['A', 'B']) {
        ids[`${model.name}:${tenantId}`] = (await store.insert({ name: tenantId.toLowerCase(), tenantId })).id;
      }
    }
  });

  afterAll(async () => {
    await app?.close();
    await database?.drop();
    ConfigService.setConfig({} as any, { reInit: true });
  });

  /**
   * @regression   DEV-3829 (db-agnostic phase 1) — the store's own tenant predicate is the guarantee on every
   *   database without row-level security (MySQL, MariaDB) and on a table that has none; without it a tenant reads
   *   and writes every tenant's rows.
   * @seen-failing Drop the tenant filter from SqlDataStore.where() in
   *   src/core/common/persistence/sql/sql-data-store.ts — registered as mutation `sql-store-drops-tenant-filter`
   *   in tests/regression-mutations.json.
   */
  it('the before-layer filters reads and writes without row-level security', async () => {
    const store = new SqlDataStore<any>(app, plainModel);
    expect(names(await run({ tenantId: 'A' }, () => store.find()))).toEqual(['a']);
    expect(await run({ tenantId: 'A' }, () => store.count())).toBe(1);
    expect(await run({ tenantId: 'A' }, () => store.updateById(ids['LayerPlain:B'], { name: 'hijacked' }))).toBeNull();
    expect(await run({ tenantId: 'A' }, () => store.deleteById(ids['LayerPlain:B']))).toBeNull();
    expect((await store.findById(ids['LayerPlain:B'])).name).toBe('b');
  });

  /**
   * @regression   DEV-3829 (db-agnostic phase 1) — row-level security only isolates what the store tells it: a
   *   statement sent with the system scope reads every tenant, whatever the request's tenant is.
   * @seen-failing Send the system scope with every statement in SqlDataStore.run() in
   *   src/core/common/persistence/sql/sql-data-store.ts — registered as mutation `sql-store-scope-always-system`
   *   in tests/regression-mutations.json.
   */
  it('row-level security filters when the before-layer does not', async () => {
    const store = new UnfilteredStore(app, rlsModel);
    expect(names(await run({ tenantId: 'A' }, () => store.find()))).toEqual(['a']);
    expect(names(await run({ tenantIds: ['A', 'B'] }, () => store.find()))).toEqual(['a', 'b']);
    expect(await run({ tenantId: 'A' }, () => store.updateById(ids['LayerRls:B'], { name: 'hijacked' }))).toBeNull();
  });

  it('the database refuses a tenant-scoped read without a tenant context (42501 → 403)', async () => {
    const store = new UnfilteredStore(app, rlsModel);
    await expect(run({ currentUser: { id: 'u1' } as any }, () => store.find())).rejects.toBeInstanceOf(
      ForbiddenException,
    );
  });

  /**
   * @regression   DEV-3829 (db-agnostic phase 1) — the after-layer is what is left when a filter is lost on a
   *   database without row-level security: a read that returns a foreign tenant's row must fail, not answer.
   * @seen-failing Skip assertRowsInTenantScope() in SqlDataStore.toRecords() in
   *   src/core/common/persistence/sql/sql-data-store.ts — registered as mutation `sql-store-skips-row-check` in
   *   tests/regression-mutations.json.
   */
  it('the row check refuses a foreign row that reached the store', async () => {
    const store = new UnfilteredStore(app, plainModel);
    await expect(run({ tenantId: 'A' }, () => store.find())).rejects.toBeInstanceOf(ForbiddenException);
    await expect(run({ tenantId: 'A' }, () => store.findById(ids['LayerPlain:B']))).rejects.toBeInstanceOf(
      ForbiddenException,
    );
    // System work and a platform admin without a tenant header see everything, as on MongoDB
    expect(names(await store.find())).toEqual(['a', 'b']);
    expect(names(await run({ isAdminBypass: true }, () => store.find()))).toEqual(['a', 'b']);
  });

  /**
   * @regression   DEV-3829 (db-agnostic phase 1) — an update operator the compiler does not know was skipped, so the
   *   caller's write silently did something else than asked.
   * @seen-failing Skip unknown operators in the update compiler in
   *   src/core/common/persistence/sql/postgres/postgres-update.compiler.ts — registered as mutation
   *   `sql-update-drops-unknown-operator` in tests/regression-mutations.json.
   */
  it('refuses a filter or an update it cannot express', async () => {
    const store = new SqlDataStore<any>(app, plainModel);
    await expect(store.find({ unknown: 1 })).rejects.toBeInstanceOf(UnsupportedQueryError);
    await expect(store.count({ name: { $text: 'x' } })).rejects.toBeInstanceOf(UnsupportedQueryError);
    await expect(store.updateById(ids['LayerPlain:A'], { $rename: { name: 'title' } } as any)).rejects.toBeInstanceOf(
      UnsupportedQueryError,
    );
    await expect(store.updateById(ids['LayerPlain:A'], { $set: { id: 'other' } } as any)).rejects.toBeInstanceOf(
      UnsupportedQueryError,
    );
    expect((await store.findById(ids['LayerPlain:A'])).name).toBe('a');
  });

  it('switching the engine on the same database is a configuration change', async () => {
    const executors = await Promise.all(
      (['kysely', 'drizzle'] as const).map((engine) =>
        createSqlExecutor({ engine, maxConnections: 2, url: database.appUrl }),
      ),
    );
    try {
      const [viaTypeOrm, viaKysely, viaDrizzle] = [app, ...executors].map(
        (executor) => new SqlDataStore<any>(executor, rlsModel),
      );
      const created = await run({ tenantId: 'C' }, () => viaTypeOrm.insert({ name: 'c' }));
      await run({ tenantId: 'C' }, () => viaKysely.updateById(created.id, { name: 'c2' }));
      expect(await run({ tenantId: 'C' }, () => viaDrizzle.findById(created.id))).toMatchObject({
        name: 'c2',
        tenantId: 'C',
      });
      for (const store of [viaTypeOrm, viaKysely, viaDrizzle]) {
        expect(names(await run({ tenantId: 'A' }, () => store.find()))).toEqual(['a']);
        await expect(run({ currentUser: { id: 'u1' } as any }, () => store.find())).rejects.toBeInstanceOf(
          ForbiddenException,
        );
      }
      expect(await viaDrizzle.deleteById(created.id)).toMatchObject({ name: 'c2' });
    } finally {
      await Promise.all(executors.map((executor) => executor.close()));
    }
  });

  it('hands out the engine API and the guarded pool, each with a stated reason', () => {
    const store = new SqlDataStore<any>(app, plainModel);
    expect(store.native('test: reach the TypeORM DataSource for a report')).toBe(app.native());
    expect(isGuardedPool(store.raw('test: reach the node-postgres pool for a report'))).toBe(true);
  });
});
