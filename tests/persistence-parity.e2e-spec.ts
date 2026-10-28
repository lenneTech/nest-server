import { BadRequestException, ForbiddenException, Injectable, Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { Test, TestingModule } from '@nestjs/testing';
import { sql as drizzleSql } from 'drizzle-orm';
import { CompiledQuery } from 'kysely';
import mongoose from 'mongoose';
import { afterAll, beforeAll, beforeEach, describe, expect } from 'vitest';

import { Restricted } from '../src/core/common/decorators/restricted.decorator';
import { UnifiedField } from '../src/core/common/decorators/unified-field.decorator';
import { RoleEnum } from '../src/core/common/enums/role.enum';
import { CorePersistenceModel } from '../src/core/common/models/core-persistence.model';

import { CorePersistenceModule } from '../src/core/common/persistence/core-persistence.module';
import type { DataStore } from '../src/core/common/persistence/data-store.interface';
import { InjectStore } from '../src/core/common/persistence/inject-store.decorator';
import { mongooseAuditFieldsPlugin } from '../src/core/common/plugins/mongoose-audit-fields.plugin';
import { mongooseIdPlugin } from '../src/core/common/plugins/mongoose-id.plugin';
import { mongoosePasswordPlugin } from '../src/core/common/plugins/mongoose-password.plugin';
import { mongooseRoleGuardPlugin } from '../src/core/common/plugins/mongoose-role-guard.plugin';
import { mongooseSystemRolePlugin } from '../src/core/common/plugins/mongoose-system-role.plugin';
import { mongooseTenantPlugin } from '../src/core/common/plugins/mongoose-tenant.plugin';
import { describeSchema, registerModelSchema } from '../src/core/common/persistence/model-metadata.registry';
import { registerDataStore } from '../src/core/common/persistence/persistence-runtime.registry';
import { tableName } from '../src/core/common/persistence/sql/postgres/postgres-schema.compiler';
import { applyPostgresSchema } from '../src/core/common/persistence/sql/postgres/postgres-schema.migrator';
import { SqlDataStore } from '../src/core/common/persistence/sql/sql-data-store';
import { createSqlExecutor } from '../src/core/common/persistence/sql/sql-executor.factory';
import type { SqlExecutor } from '../src/core/common/persistence/sql/sql-executor.interface';
import { ConfigService } from '../src/core/common/services/config.service';
import { CrudService } from '../src/core/common/services/crud.service';
import { IRequestContext, RequestContext } from '../src/core/common/services/request-context.service';
import { deriveTestDbUri } from './db-lifecycle.reporter';
import {
  PERSISTENCE_DRIVERS,
  persistenceComplement,
  persistenceIt,
  PersistenceDriver,
} from './helpers/persistence-matrix';
import { createPostgresTestDatabase, PG_APP, type PostgresTestDatabase } from './helpers/postgres-test-db';

/**
 * Executor of the persistence parity matrix (`tests/helpers/persistence-matrix.ts`): every case against every
 * column. MongoDB: a data store obtained exactly as a project obtains it — `CorePersistenceModule.forFeature()` +
 * `@InjectStore()` — with every security plugin registered on the connection, as `CoreModule` does. PostgreSQL, once
 * per engine: a `SqlDataStore` over the schema the migrator created from the same models, connected as the
 * application role, so row-level security binds every statement.
 */
const ItemSchema = new mongoose.Schema(
  {
    age: Number,
    code: { sparse: true, type: String, unique: true },
    createdBy: String,
    deep: { inner: { count: Number, label: String } },
    logs: [{ _id: false, level: String, message: String }],
    name: String,
    ownerId: { ref: 'ParityItem', type: mongoose.Schema.Types.ObjectId },
    password: String,
    profile: { city: String, level: Number },
    roles: [String],
    score: { default: () => 7, type: Number },
    secret: { select: false, type: String },
    status: { default: 'new', type: String },
    tags: [String],
    updatedBy: String,
  },
  { timestamps: true },
);
const ScopedSchema = new mongoose.Schema({ name: String, tenantId: String });
const SCOPED_TABLE = tableName(describeSchema('ParityScoped', ScopedSchema));

/**
 * What a project's CrudService maps the records of `ParityItem` to. Restricted to ADMIN on the class like the user
 * model: `CorePersistenceModel` grants S_EVERYONE there, and `mergeRoles` would OR that into `status`
 */
@Restricted(RoleEnum.ADMIN)
class ParityCrudItem extends CorePersistenceModel {
  @UnifiedField({ isOptional: true, roles: RoleEnum.S_EVERYONE })
  age?: number = undefined;

  @UnifiedField({ isOptional: true, roles: RoleEnum.S_EVERYONE })
  name?: string = undefined;

  @UnifiedField({ isOptional: true, roles: RoleEnum.S_EVERYONE })
  ownerId?: string = undefined;

  @UnifiedField({ isOptional: true, roles: RoleEnum.ADMIN })
  status?: string = undefined;
}

class ParityCrudService extends CrudService<ParityCrudItem> {
  constructor(store: DataStore<any>) {
    super({ dataStore: store, mainModelConstructor: ParityCrudItem });
  }
}

/** A query sent through each engine's OWN API, on the handle `native()` returns — outside every framework layer */
const NATIVE_QUERY: Record<'drizzle' | 'kysely' | 'typeorm', (handle: any, text: string) => Promise<unknown>> = {
  drizzle: (db, text) => db.execute(drizzleSql.raw(text)),
  kysely: (db, text) => db.executeQuery(CompiledQuery.raw(text)),
  typeorm: (dataSource, text) => dataSource.query(text),
};
/** The Postgres error code, wherever an engine's error wrapper put it */
const pgCode = (error: any): unknown => error?.code ?? error?.driverError?.code ?? error?.cause?.code;

@Injectable()
class StoreHolder {
  constructor(
    @InjectStore('ParityItem') readonly items: DataStore<any>,
    @InjectStore('ParityScoped') readonly scoped: DataStore<any>,
  ) {}
}

@Module({
  imports: [
    MongooseModule.forRoot(deriveTestDbUri('persistence-parity'), {
      connectionFactory: (connection) => {
        connection.plugin(mongooseIdPlugin);
        connection.plugin(mongooseTenantPlugin);
        connection.plugin(mongooseAuditFieldsPlugin);
        connection.plugin(mongoosePasswordPlugin);
        connection.plugin(mongooseRoleGuardPlugin);
        connection.plugin(mongooseSystemRolePlugin);
        return connection;
      },
    }),
    CorePersistenceModule.forFeature([
      { name: 'ParityItem', schema: ItemSchema },
      { name: 'ParityScoped', schema: ScopedSchema },
    ]),
  ],
  providers: [StoreHolder],
})
class ParityModule {}

const run = <T>(context: Partial<IRequestContext>, fn: () => Promise<T>): Promise<T> =>
  RequestContext.run({ fromRequest: true, ...context } as IRequestContext, fn);
const user = (id: string, roles: string[] = []) =>
  ({ hasRole: (required: string[]) => required.some((role) => roles.includes(role)), id, roles }) as any;

interface Harness {
  items: DataStore<any>;
  reset(): Promise<void>;
  scoped: DataStore<any>;
  teardown(): Promise<void>;
}

async function mongoHarness(): Promise<Harness> {
  const moduleRef: TestingModule = await Test.createTestingModule({ imports: [ParityModule] }).compile();
  await moduleRef.init();
  const { items, scoped } = moduleRef.get(StoreHolder);
  // The unique index is built in the background; wait for it, as a deployed instance has it long before a request
  await items.native<mongoose.Model<any>>('test fixture: wait for the unique index build').init();
  return {
    items,
    reset: async () => {
      await items.native<mongoose.Model<any>>('test fixture: reset the parity collection').deleteMany({});
      await scoped.native<mongoose.Model<any>>('test fixture: reset the parity collection').deleteMany({});
    },
    scoped,
    teardown: async () => {
      await items.native<mongoose.Model<any>>('test teardown: drop the per-run database').db.dropDatabase();
      await moduleRef.close();
    },
  };
}

async function postgresHarness(engine: 'drizzle' | 'kysely' | 'typeorm'): Promise<Harness> {
  const database: PostgresTestDatabase = await createPostgresTestDatabase(`persistence-parity-${engine}`);
  const models = [describeSchema('ParityItem', ItemSchema), describeSchema('ParityScoped', ScopedSchema)];
  const owner = await createSqlExecutor({ engine, maxConnections: 1, url: database.ownerUrl });
  try {
    await applyPostgresSchema(owner, models, { appRole: PG_APP.user, isTenantIsolated: (model) => model.tenantScoped });
  } finally {
    await owner.close();
  }
  const app: SqlExecutor = await createSqlExecutor({ engine, maxConnections: 4, url: database.appUrl });
  const schemas = { ParityItem: ItemSchema, ParityScoped: ScopedSchema };
  const [items, scoped] = models.map((model) => new SqlDataStore<any>(app, model, { schema: schemas[model.name] }));
  // As CorePersistenceModule.forFeature() does: a populate finds the target model's descriptor and store by name
  for (const [name, store] of [
    ['ParityItem', items],
    ['ParityScoped', scoped],
  ] as const) {
    registerModelSchema(name, schemas[name]);
    registerDataStore(name, store);
  }
  return {
    items,
    reset: async () => {
      for (const model of models) {
        await app.run({ params: [], text: `DELETE FROM "${tableName(model)}"` }, { kind: 'system' });
      }
    },
    scoped,
    teardown: async () => {
      await app.close();
      await database.drop();
    },
  };
}

const HARNESS: Record<PersistenceDriver, () => Promise<Harness>> = {
  mongodb: mongoHarness,
  'postgres-drizzle': () => postgresHarness('drizzle'),
  'postgres-kysely': () => postgresHarness('kysely'),
  'postgres-typeorm': () => postgresHarness('typeorm'),
};

for (const driver of PERSISTENCE_DRIVERS) {
  describe(`persistence parity — ${driver}`, () => {
    let harness: Harness;
    let items: DataStore<any>;
    let scoped: DataStore<any>;

    beforeAll(async () => {
      ConfigService.setConfig({ multiTenancy: {} } as any, { reInit: true });
      harness = await HARNESS[driver]();
      ({ items, scoped } = harness);
    });

    beforeEach(async () => {
      await harness.reset();
    });

    afterAll(async () => {
      await harness?.teardown();
      ConfigService.setConfig({} as any, { reInit: true });
    });

    persistenceIt('insert-returns-string-id', driver, async () => {
      const record = await items.insert({ name: 'a' });
      expect(record.id).toMatch(/^[0-9a-f]{24}$/);
      expect(record).not.toHaveProperty('_id');
      expect(record).not.toHaveProperty('__v');
      expect(record.name).toBe('a');
    });

    persistenceIt('find-by-id', driver, async () => {
      const record = await items.insert({ name: 'a' });
      expect((await items.findById(record.id))?.name).toBe('a');
      expect(await items.findById('651f00010203040506070809')).toBeNull();
    });

    persistenceIt('find-where-sort-skip-limit', driver, async () => {
      for (const [name, age] of [
        ['a', 30],
        ['b', 20],
        ['c', 40],
        ['d', 10],
      ] as const) {
        await items.insert({ age, name });
      }
      const found = await items.find({ age: { $gte: 15 } }, { limit: 2, skip: 1, sort: { age: 1 } });
      expect(found.map((record) => record.name)).toEqual(['a', 'c']);
    });

    persistenceIt('find-by-neutral-id', driver, async () => {
      const a = await items.insert({ name: 'a' });
      await items.insert({ name: 'b' });
      expect((await items.find({ $or: [{ id: a.id }, { name: 'zz' }] })).map((r) => r.name)).toEqual(['a']);
      expect((await items.findOne({ id: a.id }))?.name).toBe('a');
    });

    persistenceIt('find-one', driver, async () => {
      await items.insert({ age: 1, name: 'a' });
      await items.insert({ age: 2, name: 'b' });
      expect((await items.findOne({ age: { $gt: 0 } }, { sort: { age: -1 } }))?.name).toBe('b');
      expect(await items.findOne({ name: 'none' })).toBeNull();
    });

    persistenceIt('find-select', driver, async () => {
      const record = await items.insert({ age: 3, name: 'a' });
      const [selected] = await items.find({}, { select: ['name'] });
      expect(selected).toMatchObject({ id: record.id, name: 'a' });
      expect(selected).not.toHaveProperty('age');
    });

    persistenceIt('select-hidden-fields', driver, async () => {
      const record = await items.insert({ name: 'a', secret: 's' });
      expect(await items.findById(record.id)).not.toHaveProperty('secret');
      expect((await items.find({}, { select: ['name', 'secret'] }))[0]).toMatchObject({ name: 'a', secret: 's' });
    });

    persistenceIt('select-plain-names-only', driver, async () => {
      await items.insert({ name: 'a', password: 'plaintext' });
      await expect(items.find({}, { select: ['+password'] })).rejects.toThrow(/invalid field name/);
      await expect(items.find({}, { select: ['-age'] })).rejects.toThrow(/invalid field name/);
      await expect(items.findById('651f00010203040506070809', { select: ['name age'] })).rejects.toThrow(
        /invalid field name/,
      );
    });

    persistenceIt('sort-missing-first', driver, async () => {
      await items.insert({ age: 2, name: 'a' });
      await items.insert({ name: 'b' });
      await items.insert({ age: 1, name: 'c' });
      expect((await items.find({}, { sort: { age: 1 } })).map((record) => record.name)).toEqual(['b', 'c', 'a']);
      expect((await items.find({}, { sort: { age: -1 } })).map((record) => record.name)).toEqual(['a', 'c', 'b']);
    });

    persistenceIt('insert-applies-defaults', driver, async () => {
      const record = await items.insert({ name: 'a' });
      expect(record).toMatchObject({ score: 7, status: 'new', tags: [] });
      expect(await items.findById(record.id)).toMatchObject({ score: 7, status: 'new', tags: [] });
    });

    persistenceIt('count', driver, async () => {
      await items.insert({ age: 1 });
      await items.insert({ age: 5 });
      expect(await items.count({ age: { $gt: 2 } })).toBe(1);
      expect(await items.count()).toBe(2);
    });

    persistenceIt('distinct', driver, async () => {
      await items.insert({ name: 'x' });
      await items.insert({ name: 'x' });
      await items.insert({ name: 'y' });
      expect((await items.distinct('name')).sort()).toEqual(['x', 'y']);
    });

    persistenceIt('distinct-array-items', driver, async () => {
      await items.insert({ tags: ['x', 'y'] });
      await items.insert({ tags: ['y', 'z'] });
      expect((await items.distinct('tags')).sort()).toEqual(['x', 'y', 'z']);
    });

    /**
     * @regression   DEV-3829 (db-agnostic phase 1, review) — the SQL store copied an update with structuredClone,
     *   which turns an ObjectId into a plain object; the cast then refused the reference CrudService passes.
     * @seen-failing Copy the update with structuredClone() in clone() in
     *   src/core/common/persistence/sql/sql-data-store.ts — registered as mutation `sql-update-clone-loses-object-id`
     *   in tests/regression-mutations.json.
     */
    persistenceIt('update-partial', driver, async () => {
      const record = await items.insert({ age: 1, name: 'a' });
      const updated = await items.updateById(record.id, { name: 'b' });
      expect(updated).toMatchObject({ age: 1, id: record.id, name: 'b' });
      expect(await items.updateById('651f00010203040506070809', { name: 'c' })).toBeNull();
      // An ObjectId instance in the patch, as CrudService passes a populated or cast reference
      const owner = new mongoose.Types.ObjectId();
      const referenced = await items.updateById(record.id, { $set: { ownerId: owner } });
      expect(String(referenced.ownerId)).toBe(owner.toHexString());
    });

    persistenceIt('update-operators', driver, async () => {
      const record = await items.insert({ age: 1, name: 'a' });
      const updated = await items.updateById(record.id, { $inc: { age: 2 }, $unset: { name: '' } });
      expect(updated.age).toBe(3);
      expect(updated).not.toHaveProperty('name');
    });

    persistenceIt('update-nested-path', driver, async () => {
      const record = await items.insert({ name: 'a', profile: { city: 'A', level: 1 } });
      const updated = await items.updateById(record.id, {
        $inc: { 'profile.level': 2 },
        $set: { 'profile.city': 'B' },
      });
      expect(updated.profile).toEqual({ city: 'B', level: 3 });
      const bare = await items.insert({ name: 'n' });
      expect((await items.updateById(bare.id, { $set: { 'profile.city': 'C' } })).profile).toEqual({ city: 'C' });
      // Two levels deep, two operators chained on one column, the parents created on the way
      const chained = await items.updateById(bare.id, {
        $inc: { 'deep.inner.count': 2 },
        $set: { 'deep.inner.label': 'x' },
      });
      expect(chained.deep).toEqual({ inner: { count: 2, label: 'x' } });
    });

    persistenceIt('update-array-operators', driver, async () => {
      const record = await items.insert({ tags: ['a'] });
      expect((await items.updateById(record.id, { $push: { tags: 'b' } })).tags).toEqual(['a', 'b']);
      expect((await items.updateById(record.id, { $addToSet: { tags: { $each: ['b', 'c', 'c'] } } })).tags).toEqual([
        'a',
        'b',
        'c',
      ]);
      expect((await items.updateById(record.id, { $pull: { tags: 'a' } })).tags).toEqual(['b', 'c']);
    });

    persistenceIt('duplicate-key-11000', driver, async () => {
      await items.insert({ code: 'X' });
      const failure = await items.insert({ code: 'X' }).catch((error: unknown) => error);
      expect(failure).toMatchObject({ code: 11000 });
      expect((failure as Error).message).toMatch(/E11000/);
      // sparse: records without the field do not collide
      await items.insert({ name: 'no-code-1' });
      await items.insert({ name: 'no-code-2' });
    });

    persistenceIt('delete-by-id', driver, async () => {
      const record = await items.insert({ name: 'a' });
      expect((await items.deleteById(record.id))?.name).toBe('a');
      expect(await items.findById(record.id)).toBeNull();
    });

    persistenceIt('update-one-first-match', driver, async () => {
      await items.insert({ name: 'a', status: 'done' });
      const open = await items.insert({ name: 'b', status: 'open' });
      const updated = await items.updateOne({ status: 'open' }, { $set: { status: 'taken' } });
      expect(updated).toMatchObject({ id: open.id, name: 'b', status: 'taken' });
      expect((await items.findById(open.id)).status).toBe('taken');
      expect(await items.updateOne({ status: 'open' }, { $set: { status: 'taken' } })).toBeNull();
    });

    persistenceIt('update-one-concurrent', driver, async () => {
      for (let i = 0; i < 8; i++) {
        await items.insert({ age: i, status: 'open' });
      }
      const taken = await Promise.all(
        Array.from({ length: 8 }, () => items.updateOne({ status: 'open' }, { $set: { status: 'taken' } })),
      );
      // Every contender took a record, and no record was taken twice — the queue-claim pattern
      expect(taken.every(Boolean)).toBe(true);
      expect(new Set(taken.map((record) => record.id)).size).toBe(8);
      expect(await items.count({ status: 'open' })).toBe(0);
    });

    persistenceIt('delete-many', driver, async () => {
      await items.insert({ name: 'a', status: 'old' });
      await items.insert({ name: 'b', status: 'old' });
      await items.insert({ name: 'c', status: 'new' });
      expect(await items.deleteMany({ status: 'old' })).toBe(2);
      expect((await items.find()).map((record) => record.name)).toEqual(['c']);
      expect(await items.deleteMany({ status: 'old' })).toBe(0);
    });

    persistenceIt('delete-one', driver, async () => {
      await items.insert({ name: 'a', status: 'keep' });
      const doomed = await items.insert({ name: 'b', status: 'old' });
      expect(await items.deleteOne({ status: 'old' })).toMatchObject({ id: doomed.id, name: 'b' });
      expect(await items.findById(doomed.id)).toBeNull();
      expect(await items.deleteOne({ status: 'old' })).toBeNull();
      expect(await items.count()).toBe(1);
    });

    persistenceIt('update-many', driver, async () => {
      await items.insert({ age: 1, status: 'open' });
      await items.insert({ age: 2, status: 'open' });
      await items.insert({ age: 3, status: 'done' });
      expect(await items.updateMany({ status: 'open' }, { $inc: { age: 10 }, $set: { status: 'closed' } })).toBe(2);
      expect((await items.find({ status: 'closed' }, { sort: { age: 1 } })).map((record) => record.age)).toEqual([
        11, 12,
      ]);
      expect(await items.updateMany({ status: 'open' }, { $set: { status: 'closed' } })).toBe(0);
    });

    persistenceIt('update-without-timestamps', driver, async () => {
      const record = await items.insert({ name: 'a' });
      const before = (await items.findById(record.id)).updatedAt;
      await new Promise((resolve) => setTimeout(resolve, 20));
      const stamped = await items.updateById(record.id, { $set: { age: 1 } }, { timestamps: false });
      expect(stamped.age).toBe(1);
      expect(new Date(stamped.updatedAt).getTime()).toBe(new Date(before).getTime());
      const touched = await items.updateById(record.id, { $set: { age: 2 } });
      expect(new Date(touched.updatedAt).getTime()).toBeGreaterThan(new Date(before).getTime());
    });

    persistenceIt('push-with-slice', driver, async () => {
      const record = await items.insert({ tags: ['t1'] });
      await items.pushToArray(record.id, 'tags', ['t2', 't3', 't4'], { slice: -3 });
      expect((await items.findById(record.id)).tags).toEqual(['t2', 't3', 't4']);
    });

    persistenceIt('push-position-and-sort', driver, async () => {
      const record = await items.insert({ tags: ['b', 'd'] });
      await items.pushToArray(record.id, 'tags', ['a', 'c'], { position: 1 });
      expect((await items.findById(record.id)).tags).toEqual(['b', 'a', 'c', 'd']);
      const logged = await items.insert({ logs: [{ level: 'B' }, { level: 'D' }] });
      await items.pushToArray(logged.id, 'logs', [{ level: 'C' }, { level: 'A' }], { sort: { level: 1 } });
      expect((await items.findById(logged.id)).logs.map((log: { level: string }) => log.level)).toEqual([
        'A',
        'B',
        'C',
        'D',
      ]);
    });

    persistenceIt('push-concurrent', driver, async () => {
      const record = await items.insert({ tags: [] });
      const values = Array.from({ length: 20 }, (_, index) => `v${index}`);
      await Promise.all(values.map((value) => items.pushToArray(record.id, 'tags', [value])));
      expect((await items.findById(record.id)).tags.sort()).toEqual([...values].sort());
    });

    persistenceIt('pull-by-condition', driver, async () => {
      const record = await items.insert({ logs: [{ level: 'DEBUG' }, { level: 'INFO' }, { level: 'DEBUG' }] });
      await items.pullFromArray(record.id, 'logs', { level: 'DEBUG' });
      expect((await items.findById(record.id)).logs.map((log: { level: string }) => log.level)).toEqual(['INFO']);
    });

    persistenceIt('array-field-guard', driver, async () => {
      const record = await items.insert({ tags: [] });
      await expect(items.pushToArray(record.id, '$where', ['x'])).rejects.toThrow(/invalid field name/);
      await expect(items.pullFromArray(record.id, '', 'x')).rejects.toThrow(/invalid field name/);
    });

    persistenceIt('native-access-needs-reason', driver, () => {
      expect(() => items.native('because')).toThrow(/meaningful reason/);
      expect(() => items.raw('')).toThrow(/meaningful reason/);
    });

    persistenceIt('crud-service-pipeline', driver, async () => {
      const service = new ParityCrudService(items);
      const admin = user('651f000102030405060708aa', [RoleEnum.ADMIN]);
      const member = user('651f000102030405060708bb');
      const asAdmin = { currentUser: admin };

      const created: any = await run(asAdmin, () =>
        service.create({ age: 1, name: 'crud', status: 'internal' }, asAdmin),
      );
      expect(created).toMatchObject({ age: 1, name: 'crud', status: 'internal' });
      expect(created.id).toMatch(/^[0-9a-f]{24}$/);

      const seenByMember: any = await run({ currentUser: member }, () =>
        service.get(created.id, { currentUser: member }),
      );
      // Field rights (`status` is ADMIN only) are applied to the RESPONSE by the interceptor, whatever the store
      expect(seenByMember).toMatchObject({ age: 1, id: created.id, name: 'crud' });

      const updated: any = await run(asAdmin, () => service.update(created.id, { age: 2 }, asAdmin));
      expect(updated).toMatchObject({ age: 2, name: 'crud', status: 'internal' });

      await run(asAdmin, () => service.create({ age: 9, name: 'other' }, asAdmin));
      const found = await run(asAdmin, () =>
        service.find({ filterQuery: { age: { $lte: 2 } }, queryOptions: { sort: { age: 1 } } }, asAdmin),
      );
      expect(found.map((item: any) => item.name)).toEqual(['crud']);
      const page = await run(asAdmin, () =>
        service.findAndCount({ queryOptions: { limit: 1, sort: { age: -1 } } }, asAdmin),
      );
      expect(page.totalCount).toBe(2);
      expect(page.items.map((item: any) => item.name)).toEqual(['other']);

      await run(asAdmin, () => service.delete(created.id, asAdmin));
      expect(await items.findById(created.id)).toBeNull();
    });

    persistenceIt('crud-service-populate', driver, async () => {
      const service = new ParityCrudService(items);
      const admin = user('651f000102030405060708aa', [RoleEnum.ADMIN]);
      const owner = await items.insert({ name: 'owner' });
      const record = await items.insert({ name: 'ref', ownerId: owner.id });
      const populated: any = await run({ currentUser: admin }, () =>
        service.get(record.id, { currentUser: admin, populate: ['ownerId'] }),
      );
      expect(populated.ownerId).toMatchObject({ id: owner.id, name: 'owner' });
    });

    persistenceIt('tenant-filters-reads', driver, async () => {
      await scoped.insert({ name: 'a', tenantId: 'A' });
      await scoped.insert({ name: 'b', tenantId: 'B' });
      const seen = await run({ tenantId: 'A' }, () => scoped.find());
      expect(seen.map((record) => record.name)).toEqual(['a']);
    });

    persistenceIt('tenant-stamps-writes', driver, async () => {
      const record = await run({ tenantId: 'A' }, () => scoped.insert({ name: 'a' }));
      expect(record.tenantId).toBe('A');
    });

    persistenceIt('tenant-refuses-foreign-write', driver, async () => {
      await expect(run({ tenantId: 'A' }, () => scoped.insert({ name: 'x', tenantId: 'B' }))).rejects.toBeInstanceOf(
        ForbiddenException,
      );
    });

    persistenceIt('tenant-safety-net', driver, async () => {
      await scoped.insert({ name: 'a', tenantId: 'A' });
      await expect(run({ currentUser: user('u1') }, () => scoped.find())).rejects.toBeInstanceOf(ForbiddenException);
    });

    persistenceIt('tenant-foreign-update-misses', driver, async () => {
      const foreign = await scoped.insert({ name: 'b', tenantId: 'B' });
      expect(await run({ tenantId: 'A' }, () => scoped.updateById(foreign.id, { name: 'hijacked' }))).toBeNull();
      expect((await scoped.findById(foreign.id)).name).toBe('b');
    });

    persistenceIt('tenant-filters-update-one-and-delete-many', driver, async () => {
      const foreign = await scoped.insert({ name: 'shared', tenantId: 'B' });
      const own = await scoped.insert({ name: 'shared', tenantId: 'A' });
      // The filter matches both rows; only the current tenant's row may be reached
      const updated = await run({ tenantId: 'A' }, () => scoped.updateOne({ name: 'shared' }, { name: 'mine' }));
      expect(updated?.id).toBe(own.id);
      expect(await run({ tenantId: 'A' }, () => scoped.updateOne({ id: foreign.id }, { name: 'hijacked' }))).toBeNull();
      expect(await run({ tenantId: 'A' }, () => scoped.updateMany({}, { name: 'all-mine' }))).toBe(1);
      expect(await run({ tenantId: 'A' }, () => scoped.deleteOne({ id: foreign.id }))).toBeNull();
      expect(await run({ tenantId: 'A' }, () => scoped.deleteMany({}))).toBe(1);
      expect((await scoped.findById(foreign.id)).name).toBe('shared');
      expect(await scoped.findById(own.id)).toBeNull();
    });

    /**
     * @regression   DEV-3829 (db-agnostic phase 1, review) — row-level security is the guarantee for code that leaves
     *   the store: a query through an engine's native API sends no tenant scope, and must be refused by the database
     *   itself, on every engine.
     * @seen-failing Make lt_tenant_filter() return NULL instead of raising without a scope in
     *   src/core/common/persistence/sql/postgres/postgres-schema.compiler.ts — registered as mutation
     *   `sql-rls-guard-allows-missing-scope` in tests/regression-mutations.json.
     */
    if (driver !== 'mongodb') {
      persistenceIt('native-api-tenant-refused', driver, async () => {
        await scoped.insert({ name: 'a', tenantId: 'A' });
        const engine = driver.replace('postgres-', '') as keyof typeof NATIVE_QUERY;
        const handle = scoped.native('parity test: query the tenant table outside the framework');
        const query = () => NATIVE_QUERY[engine](handle, `SELECT count(*)::int AS n FROM "${SCOPED_TABLE}"`);
        // Without any context, and inside a request of tenant A: the native API carries no scope either way
        for (const attempt of [query, () => run({ tenantId: 'A' }, query)]) {
          const error = await attempt().then(
            () => undefined,
            (caught: unknown) => caught,
          );
          expect(pgCode(error)).toBe('42501');
        }
      });
    } else {
      persistenceComplement('native-api-tenant-refused', driver, async () => {
        await scoped.insert({ name: 'a', tenantId: 'A' });
        const model = scoped.native<mongoose.Model<any>>('parity test: query the tenant collection outside the store');
        await expect(run({ currentUser: user('u1') }, () => model.find().exec())).rejects.toBeInstanceOf(
          ForbiddenException,
        );
        expect(await run({ tenantId: 'B' }, () => model.countDocuments().exec())).toBe(0);
        expect(await model.countDocuments().exec()).toBe(1);
      });
    }

    persistenceIt('audit-stamps-actor', driver, async () => {
      const record = await run({ currentUser: user('651f00010203040506070809') }, () => items.insert({ name: 'a' }));
      expect(record).toMatchObject({ createdBy: '651f00010203040506070809', updatedBy: '651f00010203040506070809' });
    });

    persistenceIt('password-hashed', driver, async () => {
      const record = await items.insert({ name: 'a', password: 'plaintext' });
      expect((await items.findById(record.id)).password).toMatch(/^\$2[aby]\$/);
    });

    persistenceIt('system-role-refused', driver, async () => {
      await expect(items.insert({ roles: ['s_self'] })).rejects.toBeInstanceOf(BadRequestException);
    });

    persistenceIt('role-change-stripped', driver, async () => {
      const record = await run({ currentUser: user('u1', ['staff']) }, () => items.insert({ roles: ['admin'] }));
      expect(record.roles).toEqual([]);
    });
  });
}
