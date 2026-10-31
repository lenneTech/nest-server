import { BadRequestException, ForbiddenException, Injectable, Module, NotFoundException } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { Test, TestingModule } from '@nestjs/testing';
import { sql as drizzleSql } from 'drizzle-orm';
import { CompiledQuery } from 'kysely';
import mongoose from 'mongoose';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, vi } from 'vitest';

import { Restricted } from '../src/core/common/decorators/restricted.decorator';
import { UnifiedField } from '../src/core/common/decorators/unified-field.decorator';
import { RoleEnum } from '../src/core/common/enums/role.enum';
import { CorePersistenceModel } from '../src/core/common/models/core-persistence.model';

import { CorePersistenceModule } from '../src/core/common/persistence/core-persistence.module';
import type { DataStore } from '../src/core/common/persistence/data-store.interface';
import { generateId, generateUuidV7, isUuidV7 } from '../src/core/common/persistence/id-format';
import { InjectStore } from '../src/core/common/persistence/inject-store.decorator';
import { PersistedModel } from '../src/core/common/persistence/persisted-model.decorator';
import { VersionConflictError } from '../src/core/common/persistence/policies/sync.policy';
import { resolveSyncOptions, withSequenceField } from '../src/core/common/persistence/sync-model';
import { UnsupportedCapabilityError } from '../src/core/common/persistence/unsupported-capability.error';
import { mongooseAuditFieldsPlugin } from '../src/core/common/plugins/mongoose-audit-fields.plugin';
import { mongooseIdPlugin } from '../src/core/common/plugins/mongoose-id.plugin';
import { mongoosePasswordPlugin } from '../src/core/common/plugins/mongoose-password.plugin';
import { mongooseRoleGuardPlugin } from '../src/core/common/plugins/mongoose-role-guard.plugin';
import { mongooseSystemRolePlugin } from '../src/core/common/plugins/mongoose-system-role.plugin';
import { mongooseTenantPlugin } from '../src/core/common/plugins/mongoose-tenant.plugin';
import { describeSchema, registerModelSchema } from '../src/core/common/persistence/model-metadata.registry';
import { registerDataStore } from '../src/core/common/persistence/persistence-runtime.registry';
import { MysqlDataStore } from '../src/core/common/persistence/sql/mysql/mysql-data-store';
import type { MysqlExecutor } from '../src/core/common/persistence/sql/mysql/mysql-executor';
import { applyMysqlSchema, mysqlAccount } from '../src/core/common/persistence/sql/mysql/mysql-schema.migrator';
import type { MysqlVariant } from '../src/core/common/persistence/sql/mysql/mysql-session';
import { tableName } from '../src/core/common/persistence/sql/postgres/postgres-schema.compiler';
import { applyPostgresSchema } from '../src/core/common/persistence/sql/postgres/postgres-schema.migrator';
import { SqlDataStore } from '../src/core/common/persistence/sql/sql-data-store';
import { createSqlExecutor } from '../src/core/common/persistence/sql/sql-executor.factory';
import type { SqlExecutor } from '../src/core/common/persistence/sql/sql-executor.interface';
import { ConfigService } from '../src/core/common/services/config.service';
import { CrudService } from '../src/core/common/services/crud.service';
import { IRequestContext, RequestContext } from '../src/core/common/services/request-context.service';
import { deriveTestDbUri } from './db-lifecycle.reporter';
import { createMysqlTestDatabase } from './helpers/mysql-test-db';
import {
  MYSQL_DRIVERS,
  PERSISTENCE_DRIVERS,
  persistenceComplement,
  persistenceIt,
  PersistenceDriver,
  type PersistenceEngine,
} from './helpers/persistence-matrix';
import { createPostgresTestDatabase, PG_APP, type PostgresTestDatabase } from './helpers/postgres-test-db';

/**
 * Executor of the persistence parity matrix (`tests/helpers/persistence-matrix.ts`): every case against every
 * column. MongoDB: a data store obtained exactly as a project obtains it — `CorePersistenceModule.forFeature()` +
 * `@InjectStore()` — with every security plugin registered on the connection, as `CoreModule` does. PostgreSQL, once
 * per engine: a `SqlDataStore` over the schema the migrator created from the same models, connected as the
 * application role, so row-level security binds every statement. MySQL and MariaDB, once per engine: a
 * `MysqlDataStore` over the schema their migrator created, connected as the application account (row reads and writes
 * only).
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
const ScopedSchema = new mongoose.Schema({ amount: Number, labels: [String], name: String, tenantId: String });
const SCOPED_TABLE = tableName(describeSchema('ParityScoped', ScopedSchema));

/**
 * The synchronized models (offline sync, DEV-3900): tenant-scoped, a unique and a sparse unique field, a scope field
 * the tombstone keeps, a self-reference for populate — and one with uuidv7 ids. Declared by class name, as a project
 * registering `{ name, schema }` does
 */
const SyncedSchema = new mongoose.Schema(
  {
    code: { sparse: true, type: String, unique: true },
    // Non-sparse unique: a missing value counts as one, so every record gets its own unless a case says otherwise
    handle: { default: () => randomUUID(), type: String, unique: true },
    labels: [String],
    name: String,
    ownerId: String,
    parentId: { ref: 'ParitySynced', type: mongoose.Schema.Types.ObjectId },
    score: Number,
    tenantId: String,
  },
  { timestamps: true },
);
const UuidSchema = new mongoose.Schema({ name: String }, { timestamps: true });

@PersistedModel({ sync: { scope: ['ownerId'] } })
class ParitySynced {}
@PersistedModel({ sync: { idFormat: 'uuidv7' } })
class ParityUuid {}
const SYNC_DECLARATIONS = {
  ParitySynced: resolveSyncOptions({ scope: ['ownerId'] }, ParitySynced.name),
  ParityUuid: resolveSyncOptions({ idFormat: 'uuidv7' }, ParityUuid.name),
};

@Restricted(RoleEnum.ADMIN)
class ParitySyncedItem extends CorePersistenceModel {
  @UnifiedField({ isOptional: true, roles: RoleEnum.S_EVERYONE })
  deletedAt?: Date = undefined;

  @UnifiedField({ isOptional: true, roles: RoleEnum.S_EVERYONE })
  name?: string = undefined;

  @UnifiedField({ isOptional: true, roles: RoleEnum.S_EVERYONE })
  parentId?: any = undefined;

  @UnifiedField({ isOptional: true, roles: RoleEnum.S_EVERYONE })
  version?: number = undefined;
}

class SyncedCrudService extends CrudService<ParitySyncedItem> {
  constructor(store: DataStore<any>) {
    super({ dataStore: store, mainModelConstructor: ParitySyncedItem });
  }
}

/** The pull's order and "after this record" filter in the neutral subset, by the store's change order */
const changeOrderSort = (store: DataStore<any>): Record<string, 1> =>
  store.capabilities.changeOrder === 'seq' ? { syncSeq: 1 } : ({ syncAt: 1, id: 1 } as Record<string, 1>);
const afterChange = (store: DataStore<any>, record: any): Record<string, any> =>
  store.capabilities.changeOrder === 'seq'
    ? { syncSeq: { $gt: record.syncSeq } }
    : { $or: [{ syncAt: { $gt: record.syncAt } }, { id: { $gt: record.id }, syncAt: record.syncAt }] };
/** MongoDB stamps milliseconds: spacing writes keeps their clock order unambiguous in a test */
const tick = () => new Promise((resolve) => setTimeout(resolve, 5));
/** The id `generateId()` returns after `id` within the same second (its 3-byte counter + 1) */
const nextGeneratedId = (id: string): string =>
  `${id.slice(0, 18)}${((Number.parseInt(id.slice(18), 16) + 1) % 0x1000000).toString(16).padStart(6, '0')}`;

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
const NATIVE_QUERY: Record<PersistenceEngine, (handle: any, text: string) => Promise<unknown>> = {
  drizzle: (db, text) => db.execute(drizzleSql.raw(text)),
  kysely: (db, text) => db.executeQuery(CompiledQuery.raw(text)),
  typeorm: (dataSource, text) => dataSource.query(text),
};
/** The rows of a native query's result, whichever shape the engine answers with */
const nativeRows = (result: any): any[] =>
  Array.isArray(result) ? (Array.isArray(result[0]) ? result[0] : result) : (result?.rows ?? []);
/** The Postgres error code, wherever an engine's error wrapper put it */
const pgCode = (error: any): unknown => error?.code ?? error?.driverError?.code ?? error?.cause?.code;

@Injectable()
class StoreHolder {
  constructor(
    @InjectStore('ParityItem') readonly items: DataStore<any>,
    @InjectStore('ParityScoped') readonly scoped: DataStore<any>,
    @InjectStore('ParitySynced') readonly synced: DataStore<any>,
    @InjectStore('ParityUuid') readonly uuids: DataStore<any>,
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
      { name: 'ParitySynced', schema: SyncedSchema },
      { name: 'ParityUuid', schema: UuidSchema },
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
  synced: DataStore<any>;
  teardown(): Promise<void>;
  uuids: DataStore<any>;
}

/** The descriptors a SQL source creates its tables from — the synchronized ones as `openStore()` sees them */
function sqlModels() {
  return [
    describeSchema('ParityItem', ItemSchema),
    describeSchema('ParityScoped', ScopedSchema),
    withSequenceField(registerModelSchema('ParitySynced', SyncedSchema, SYNC_DECLARATIONS.ParitySynced)),
    withSequenceField(registerModelSchema('ParityUuid', UuidSchema, SYNC_DECLARATIONS.ParityUuid)),
  ];
}
const SCHEMAS = {
  ParityItem: ItemSchema,
  ParityScoped: ScopedSchema,
  ParitySynced: SyncedSchema,
  ParityUuid: UuidSchema,
};

async function mongoHarness(): Promise<Harness> {
  const moduleRef: TestingModule = await Test.createTestingModule({ imports: [ParityModule] }).compile();
  await moduleRef.init();
  const { items, scoped, synced, uuids } = moduleRef.get(StoreHolder);
  // The unique index is built in the background; wait for it, as a deployed instance has it long before a request
  await items.native<mongoose.Model<any>>('test fixture: wait for the unique index build').init();
  await synced.native<mongoose.Model<any>>('test fixture: wait for the partial unique index build').init();
  return {
    items,
    reset: async () => {
      await items.native<mongoose.Model<any>>('test fixture: reset the parity collection').deleteMany({});
      await scoped.native<mongoose.Model<any>>('test fixture: reset the parity collection').deleteMany({});
      // The raw collection: the model's own deleteMany() would leave the tombstones in place
      for (const store of [synced, uuids]) {
        await store.raw<mongoose.Collection>('test fixture: reset the synchronized parity collection').deleteMany({});
      }
    },
    scoped,
    synced,
    uuids,
    teardown: async () => {
      await items.native<mongoose.Model<any>>('test teardown: drop the per-run database').db.dropDatabase();
      await moduleRef.close();
    },
  };
}

async function postgresHarness(engine: 'drizzle' | 'kysely' | 'typeorm'): Promise<Harness> {
  const database: PostgresTestDatabase = await createPostgresTestDatabase(`persistence-parity-${engine}`);
  const models = sqlModels();
  const owner = await createSqlExecutor({ engine, maxConnections: 1, url: database.ownerUrl });
  try {
    await applyPostgresSchema(owner, models, { appRole: PG_APP.user, isTenantIsolated: (model) => model.tenantScoped });
  } finally {
    await owner.close();
  }
  const app: SqlExecutor = await createSqlExecutor({ engine, maxConnections: 4, url: database.appUrl });
  const [items, scoped, synced, uuids] = models.map(
    (model) => new SqlDataStore<any>(app, model, { schema: SCHEMAS[model.name] }),
  );
  // As CorePersistenceModule.forFeature() does: a populate finds the target model's descriptor and store by name
  registerSqlStores({ items, scoped, synced, uuids });
  return {
    items,
    reset: async () => {
      for (const model of models) {
        await app.run({ params: [], text: `DELETE FROM "${tableName(model)}"` }, { kind: 'system' });
      }
    },
    scoped,
    synced,
    teardown: async () => {
      await app.close();
      await database.drop();
    },
    uuids,
  };
}

/** Register the stores and descriptors of a SQL harness by model name, as `CorePersistenceModule.forFeature()` does */
function registerSqlStores(stores: Record<'items' | 'scoped' | 'synced' | 'uuids', DataStore<any>>): void {
  registerModelSchema('ParityItem', ItemSchema);
  registerModelSchema('ParityScoped', ScopedSchema);
  registerModelSchema('ParitySynced', SyncedSchema, SYNC_DECLARATIONS.ParitySynced);
  registerModelSchema('ParityUuid', UuidSchema, SYNC_DECLARATIONS.ParityUuid);
  registerDataStore('ParityItem', stores.items);
  registerDataStore('ParityScoped', stores.scoped);
  registerDataStore('ParitySynced', stores.synced);
  registerDataStore('ParityUuid', stores.uuids);
}

async function mysqlHarness(variant: MysqlVariant, engine: PersistenceEngine): Promise<Harness> {
  const database = await createMysqlTestDatabase(variant, `persistence-parity-${engine}`);
  const models = sqlModels();
  const app = (await createSqlExecutor({ engine, maxConnections: 4, url: database.appUrl })) as MysqlExecutor;
  const owner = await createSqlExecutor({ engine, maxConnections: 1, url: database.ownerUrl });
  try {
    await applyMysqlSchema(owner, models, { appAccount: await mysqlAccount(app), variant });
  } finally {
    await owner.close();
  }
  const [items, scoped, synced, uuids] = models.map(
    (model) => new MysqlDataStore<any>(app, model, { schema: SCHEMAS[model.name] }),
  );
  registerSqlStores({ items, scoped, synced, uuids });
  return {
    items,
    reset: async () => {
      for (const model of models) {
        await app.run({ params: [], text: `DELETE FROM \`${tableName(model)}\`` }, { kind: 'system' });
      }
    },
    scoped,
    synced,
    teardown: async () => {
      await app.close();
      await database.drop();
    },
    uuids,
  };
}

const HARNESS: Record<PersistenceDriver, () => Promise<Harness>> = {
  'mariadb-drizzle': () => mysqlHarness('mariadb', 'drizzle'),
  'mariadb-kysely': () => mysqlHarness('mariadb', 'kysely'),
  'mariadb-typeorm': () => mysqlHarness('mariadb', 'typeorm'),
  mongodb: mongoHarness,
  'mysql-drizzle': () => mysqlHarness('mysql', 'drizzle'),
  'mysql-kysely': () => mysqlHarness('mysql', 'kysely'),
  'mysql-typeorm': () => mysqlHarness('mysql', 'typeorm'),
  'postgres-drizzle': () => postgresHarness('drizzle'),
  'postgres-kysely': () => postgresHarness('kysely'),
  'postgres-typeorm': () => postgresHarness('typeorm'),
};

for (const driver of PERSISTENCE_DRIVERS) {
  describe(`persistence parity — ${driver}`, () => {
    let harness: Harness;
    let items: DataStore<any>;
    let scoped: DataStore<any>;
    let synced: DataStore<any>;
    let uuids: DataStore<any>;

    beforeAll(async () => {
      ConfigService.setConfig({ multiTenancy: {} } as any, { reInit: true });
      harness = await HARNESS[driver]();
      ({ items, scoped, synced, uuids } = harness);
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

    /**
     * @regression   DEV-3833 (db-agnostic phase 5) — the SQL store wrote NULL for a field given as undefined; phase 4 had
     *   worked around it at the AI services' call sites only.
     * @seen-failing Stop skipping undefined values in src/core/common/persistence/sql/postgres/postgres-update.compiler.ts
     *   — registered as mutation `sql-update-writes-undefined` in tests/regression-mutations.json.
     */
    persistenceIt('update-undefined-ignored', driver, async () => {
      // `undefined` is "not given" — MongoDB's driver drops such a key; a database that wrote NULL would erase the field
      const record = await items.insert({ age: 1, name: 'a', status: 'open' });
      const partial = await items.updateById(record.id, { age: undefined, name: 'b' });
      expect(partial).toMatchObject({ age: 1, name: 'b', status: 'open' });
      const viaSet = await items.updateById(record.id, { $set: { name: 'c', status: undefined } });
      expect(viaSet).toMatchObject({ age: 1, name: 'c', status: 'open' });
      expect(await items.findById(record.id)).toMatchObject({ age: 1, name: 'c', status: 'open' });
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

    persistenceIt('sum', driver, async () => {
      await items.insert({ age: 2, status: 'open' });
      await items.insert({ age: 5, status: 'open' });
      await items.insert({ status: 'open' });
      await items.insert({ age: 100, status: 'done' });
      expect(await items.sum('age', { status: 'open' })).toEqual({ count: 3, sum: 7 });
      expect(await items.sum('age')).toEqual({ count: 4, sum: 107 });
      expect(await items.sum('age', { status: 'none' })).toEqual({ count: 0, sum: 0 });
    });

    persistenceIt('find-exclude', driver, async () => {
      const record = await items.insert({ age: 3, name: 'a', status: 'x' });
      const found = await items.findById(record.id, { exclude: ['age'] });
      expect(found).toMatchObject({ id: record.id, name: 'a', status: 'x' });
      expect(found?.age).toBeUndefined();
      expect((await items.find({ status: 'x' }, { exclude: ['age', 'name'] }))[0]).toMatchObject({ status: 'x' });
      await expect(items.find({}, { exclude: ['age'], select: ['name'] })).rejects.toThrow();
      await expect(items.find({}, { exclude: ['id'] })).rejects.toThrow();
    });

    /**
     * @regression   DEV-3833 (db-agnostic phase 5) — findAndCount() with samples was refused on a SQL store; the port had no
     *   sample option, so a project moving a model to PostgreSQL lost random sampling.
     * @seen-failing Make the sample wrap in SqlDataStore.find() unreachable — registered as mutation
     *   `sql-store-ignores-sample` in tests/regression-mutations.json.
     */
    persistenceIt('find-sample', driver, async () => {
      for (const [name, age] of [
        ['a', 30],
        ['b', 20],
        ['c', 40],
        ['d', 10],
        ['e', 50],
      ] as const) {
        await items.insert({ age, name });
      }
      // The page first, as MongoDB's $sample after $match, $sort, $skip and $limit: b, a, c, e → skip 1, limit 2 → a, c
      const page = ['a', 'c'];
      const seen = new Set<string>();
      for (let draw = 0; draw < 24; draw++) {
        const sampled = await items.find({ age: { $gte: 15 } }, { limit: 2, sample: 1, skip: 1, sort: { age: 1 } });
        expect(sampled).toHaveLength(1);
        expect(page).toContain(sampled[0].name);
        seen.add(sampled[0].name);
      }
      // Random, not the first of the page: 24 draws of one in two all landing on the same record has a chance of 2⁻²³
      expect([...seen].sort()).toEqual(page);
      // A sample larger than the matches returns every match, once
      expect((await items.find({}, { sample: 10 })).map((record) => record.name).sort()).toEqual([
        'a',
        'b',
        'c',
        'd',
        'e',
      ]);
      await expect(items.find({}, { sample: 0 })).rejects.toThrow(/sample/);
      await expect(items.find({}, { sample: 1.5 })).rejects.toThrow(/sample/);
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

    /**
     * @regression   DEV-3848 (db-agnostic phase 6) — Drizzle's mysql2 session reads DATETIME as text: a record read
     *   inside a store transaction carried its timestamps as strings, which JavaScript parses as local time.
     * @seen-failing Skip the string branch for date fields in fromColumn() of
     *   src/core/common/persistence/sql/mysql/mysql-data-store.ts — registered as mutation
     *   `mysql-drizzle-datetime-local` in tests/regression-mutations.json.
     */
    persistenceIt('update-without-timestamps', driver, async () => {
      const record = await items.insert({ name: 'a' });
      const before = (await items.findById(record.id)).updatedAt;
      await new Promise((resolve) => setTimeout(resolve, 20));
      const stamped = await items.updateById(record.id, { $set: { age: 1 } }, { timestamps: false });
      expect(stamped.age).toBe(1);
      // An instant, whatever the engine's driver hands over — text would be read in the process's time zone
      expect(record.createdAt).toBeInstanceOf(Date);
      expect(stamped.updatedAt).toBeInstanceOf(Date);
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

    /**
     * @regression   DEV-3848 (db-agnostic phase 6, review) — on MySQL 8.4 every stage after the first nested the previous
     *   one into a JSON_TABLE argument, which MySQL refuses when it reads the row being updated: any pushToArray()
     *   with two or three of position, sort and slice failed (ER_BAD_FIELD_ERROR, a 500), the usual "keep the top N"
     *   included.
     * @seen-failing Run every stage of pushToArray() as one nested expression in
     *   src/core/common/persistence/sql/mysql/mysql-data-store.ts — registered as mutation
     *   `mysql-push-stages-nested` in tests/regression-mutations.json.
     */
    persistenceIt('push-combined-modifiers', driver, async () => {
      const levels = async (id: string) => (await items.findById(id)).logs.map((log: { level: string }) => log.level);
      const top = await items.insert({ logs: [{ level: 'B' }, { level: 'E' }] });
      await items.pushToArray(top.id, 'logs', [{ level: 'A' }, { level: 'D' }, { level: 'C' }], {
        slice: 3,
        sort: { level: -1 },
      });
      expect(await levels(top.id)).toEqual(['E', 'D', 'C']);

      const placed = await items.insert({ tags: ['b', 'd'] });
      await items.pushToArray(placed.id, 'tags', ['a', 'c'], { position: 1, slice: -3 });
      expect((await items.findById(placed.id)).tags).toEqual(['a', 'c', 'd']);

      const all = await items.insert({ logs: [{ level: 'M' }] });
      await items.pushToArray(all.id, 'logs', [{ level: 'Z' }, { level: 'A' }], {
        position: 0,
        slice: 2,
        sort: { level: 1 },
      });
      expect(await levels(all.id)).toEqual(['A', 'M']);
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
    if (driver.startsWith('postgres-')) {
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
    } else if (MYSQL_DRIVERS.includes(driver)) {
      persistenceComplement('native-api-tenant-refused', driver, async () => {
        await run({ tenantId: 'A' }, () => scoped.insert({ name: 'a' }));
        await run({ tenantId: 'B' }, () => scoped.insert({ name: 'b' }));
        const engine = driver.replace(/^(mysql|mariadb)-/, '') as PersistenceEngine;
        const handle = scoped.native('parity test: query the tenant table outside the framework');
        const query = async () =>
          Number(nativeRows(await NATIVE_QUERY[engine](handle, `SELECT COUNT(*) AS n FROM \`${SCOPED_TABLE}\``))[0]?.n);
        // Nothing in the database stops it: both tenants' rows, with or without a request of tenant A
        expect(await query()).toBe(2);
        expect(await run({ tenantId: 'A' }, query)).toBe(2);
        // The store itself still isolates
        expect((await run({ tenantId: 'A' }, () => scoped.find())).map((record) => record.name)).toEqual(['a']);
        await expect(run({ currentUser: user('u1') }, () => scoped.find())).rejects.toBeInstanceOf(ForbiddenException);
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

    /**
     * @regression   DEV-3848 (db-agnostic phase 6, review) — aggregates never pass the row check after a read, and MySQL
     *   has no row-level security: the store's tenant filter is all that keeps count(), sum() and distinct() inside the
     *   caller's tenant there. Losing it went unnoticed by every suite.
     * @seen-failing Compile the caller's filter without the tenant filter in count() / distinct() of
     *   src/core/common/persistence/sql/mysql/mysql-data-store.ts — registered as mutations
     *   `mysql-count-without-tenant-filter` and `mysql-distinct-without-tenant-filter` in
     *   tests/regression-mutations.json.
     */
    persistenceIt('tenant-filters-aggregates', driver, async () => {
      await run({ tenantId: 'A' }, () => scoped.insert({ amount: 1, labels: ['own'], name: 'own' }));
      await run({ tenantId: 'B' }, () => scoped.insert({ amount: 100, labels: ['secret'], name: 'secret-of-b' }));
      await run({ tenantId: 'A' }, async () => {
        expect(await scoped.count({ amount: { $gte: 0 } })).toBe(1);
        expect(await scoped.sum('amount', {})).toEqual({ count: 1, sum: 1 });
        expect(await scoped.distinct('name')).toEqual(['own']);
        expect(await scoped.distinct('labels')).toEqual(['own']);
      });
    });

    /**
     * @regression   DEV-3848 (db-agnostic phase 6, review) — pushToArray()/pullFromArray() write without reading the row
     *   back, so nothing checks it afterwards; on MySQL the tenant filter of the statement is the only guard.
     * @seen-failing Compile the id filter without the tenant filter in SqlDataStore.updateColumn() of
     *   src/core/common/persistence/sql/sql-data-store.ts — registered as mutation
     *   `sql-array-update-without-tenant-filter` in tests/regression-mutations.json.
     */
    persistenceIt('tenant-push-pull-misses', driver, async () => {
      const foreign = await run({ tenantId: 'B' }, () => scoped.insert({ labels: ['b1', 'b2'], name: 'b' }));
      await run({ tenantId: 'A' }, () => scoped.pushToArray(foreign.id, 'labels', ['a']));
      await run({ tenantId: 'A' }, () => scoped.pushToArray(foreign.id, 'labels', ['a'], { position: 0, slice: 5 }));
      await run({ tenantId: 'A' }, () => scoped.pullFromArray(foreign.id, 'labels', 'b1'));
      expect((await run({ tenantId: 'B' }, () => scoped.findById(foreign.id))).labels).toEqual(['b1', 'b2']);
    });

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

    /**
     * @regression   DEV-3848 (db-agnostic phase 6, review) — the role guard of pushToArray()/pullFromArray() had no case:
     *   a caller without the right to change roles could push `admin` into its own roles array.
     * @seen-failing Drop the role-guard return from MysqlDataStore.pushToArray() in
     *   src/core/common/persistence/sql/mysql/mysql-data-store.ts — registered as mutation
     *   `mysql-push-roles-unguarded` in tests/regression-mutations.json.
     */
    persistenceIt('role-push-pull-stripped', driver, async () => {
      const record = await items.insert({ roles: ['editor'] });
      const staff = user('u1', ['staff']);
      await run({ currentUser: staff }, () => items.pushToArray(record.id, 'roles', ['admin']));
      await run({ currentUser: staff }, () => items.pullFromArray(record.id, 'roles', 'editor'));
      expect((await items.findById(record.id)).roles).toEqual(['editor']);
    });
    // --- Synchronized models (offline sync, DEV-3900) ----------------------------------------------------------

    const admin = user('651f000102030405060708aa', [RoleEnum.ADMIN]);
    const asAdmin = { currentUser: admin };
    // The synchronized model is tenant-scoped: a request without a tenant meets the safety net, as it should
    const inTenantA = { currentUser: admin, tenantId: 'A' };
    const position = (record: any): number =>
      synced.capabilities.changeOrder === 'seq' ? record.syncSeq : record.syncAt.getTime();

    persistenceIt('sync-model-unaffected', driver, async () => {
      const record = await items.insert({ deletedAt: new Date(), name: 'a', version: 5 } as any);
      for (const field of ['deletedAt', 'syncAt', 'syncSeq', 'version']) {
        expect(record).not.toHaveProperty(field);
      }
      expect(items.capabilities.changeOrder).toBeUndefined();
      expect(items.capabilities.idType).toBe('objectId');
      expect((await items.deleteById(record.id))?.name).toBe('a');
      expect(await items.findById(record.id, { includeTombstones: true })).toBeNull();
    });

    persistenceIt('sync-insert-system-fields', driver, async () => {
      const record = await synced.insert({
        deletedAt: new Date(),
        name: 'a',
        syncAt: new Date(0),
        syncSeq: 99_999,
        version: 9,
      } as any);
      expect(record.version).toBe(1);
      expect(record.deletedAt ?? null).toBeNull();
      expect(synced.capabilities.changeOrder).toBe(driver === 'mongodb' ? 'clock' : 'seq');
      if (synced.capabilities.changeOrder === 'seq') {
        expect(typeof record.syncSeq).toBe('number');
        expect(record.syncSeq).not.toBe(99_999);
        expect(record).not.toHaveProperty('syncAt');
      } else {
        expect(record.syncAt).toBeInstanceOf(Date);
        expect(Math.abs(record.syncAt.getTime() - Date.now())).toBeLessThan(60_000);
        expect(record).not.toHaveProperty('syncSeq');
      }
    });

    persistenceIt('sync-version-every-write', driver, async () => {
      const record = await synced.insert({ labels: ['a'], name: 'a', score: 1 });
      let expected = 1;
      const written = async () => {
        expected++;
        const stored = await synced.findById(record.id);
        expect(stored.version).toBe(expected);
        expect(stored.deletedAt ?? null).toBeNull();
      };
      await synced.updateById(record.id, { deletedAt: new Date(), name: 'b', version: 50 } as any);
      await written();
      await synced.updateById(record.id, { $inc: { score: 1, version: 5 }, $set: { version: 70 } } as any);
      await written();
      await synced.updateOne({ id: record.id }, { $set: { name: 'c' } });
      await written();
      await synced.updateMany({ id: record.id }, { $set: { name: 'd' } });
      await written();
      await synced.pushToArray(record.id, 'labels', ['b']);
      await written();
      await synced.pullFromArray(record.id, 'labels', 'a');
      await written();
      await synced.updateById(record.id, { name: 'e' }, { timestamps: false });
      await written();
      expect(await synced.findById(record.id)).toMatchObject({ labels: ['b'], name: 'e', score: 2 });
    });

    persistenceIt('sync-conditional-update', driver, async () => {
      const service = new SyncedCrudService(synced);
      const created: any = await run(inTenantA, () => service.create({ name: 'a' }, asAdmin));
      expect(created.version).toBe(1);
      const updated: any = await run(inTenantA, () =>
        service.update(created.id, { name: 'b' }, { ...asAdmin, expectedVersion: 1 }),
      );
      expect(updated).toMatchObject({ name: 'b', version: 2 });
      const stale = await run(inTenantA, () =>
        service.update(created.id, { name: 'c' }, { ...asAdmin, expectedVersion: 1 }),
      ).catch((error: unknown) => error);
      expect(stale).toBeInstanceOf(VersionConflictError);
      expect((stale as VersionConflictError).getStatus()).toBe(409);
      await expect(
        run(inTenantA, () => service.delete(created.id, { ...asAdmin, expectedVersion: 1 })),
      ).rejects.toBeInstanceOf(VersionConflictError);
      expect(await synced.findById(created.id)).toMatchObject({ name: 'b', version: 2 });
      await run(inTenantA, () => service.delete(created.id, { ...asAdmin, expectedVersion: 2 }));
      expect(await synced.findById(created.id)).toBeNull();

      // Only a synchronized model has a version to compare
      const plain = new ParityCrudService(items);
      const other: any = await run(inTenantA, () => plain.create({ name: 'x' }, asAdmin));
      await expect(
        run(inTenantA, () => plain.update(other.id, { name: 'y' }, { ...asAdmin, expectedVersion: 1 })),
      ).rejects.toBeInstanceOf(UnsupportedCapabilityError);
    });

    persistenceIt('sync-conditional-concurrent', driver, async () => {
      const service = new SyncedCrudService(synced);
      const created: any = await run(inTenantA, () => service.create({ name: 'a' }, asAdmin));
      const results = await Promise.allSettled(
        Array.from({ length: 5 }, (_, index) =>
          run(inTenantA, () => service.update(created.id, { name: `n${index}` }, { ...asAdmin, expectedVersion: 1 })),
        ),
      );
      const applied = results.filter((result) => result.status === 'fulfilled');
      const refused = results.filter((result): result is PromiseRejectedResult => result.status === 'rejected');
      expect(applied).toHaveLength(1);
      expect(refused.every((result) => result.reason instanceof VersionConflictError)).toBe(true);
      expect((await synced.findById(created.id)).version).toBe(2);
    });

    persistenceIt('sync-delete-tombstone', driver, async () => {
      const record = await synced.insert({
        handle: 'x@example.com',
        labels: ['a'],
        name: 'a',
        ownerId: 'u1',
        score: 3,
        tenantId: 'A',
      });
      if (driver === 'mongodb') {
        await tick();
      }
      const before = await synced.deleteById(record.id);
      expect(before).toMatchObject({ id: record.id, name: 'a', version: 1 });
      expect(await synced.findById(record.id)).toBeNull();
      const tombstone = await synced.findById(record.id, { includeTombstones: true });
      expect(tombstone.deletedAt).toBeInstanceOf(Date);
      expect(tombstone).toMatchObject({ id: record.id, ownerId: 'u1', tenantId: 'A', version: 2 });
      for (const field of ['handle', 'labels', 'name', 'score']) {
        expect(tombstone[field]).toBeUndefined();
      }
      expect(position(tombstone)).toBeGreaterThan(position(record));
    });

    persistenceIt('sync-tombstones-hidden', driver, async () => {
      await synced.insert({ labels: ['x'], name: 'a', score: 1 });
      const b = await synced.insert({ labels: ['y'], name: 'b', score: 2 });
      await synced.insert({ labels: ['z'], name: 'c', score: 4 });
      await synced.deleteById(b.id);
      expect((await synced.find({}, { sort: { name: 1 } })).map((record) => record.name)).toEqual(['a', 'c']);
      expect(await synced.find({}, { includeTombstones: true })).toHaveLength(3);
      expect(await synced.find({ deletedAt: { $ne: null } })).toEqual([]);
      expect(await synced.findOne({ id: b.id })).toBeNull();
      expect((await synced.findOne({ id: b.id }, { includeTombstones: true }))?.id).toBe(b.id);
      expect(await synced.count()).toBe(2);
      expect(await synced.count({}, { includeTombstones: true })).toBe(3);
      expect(((await synced.distinct('name')) as string[]).sort()).toEqual(['a', 'c']);
      expect(((await synced.distinct('labels')) as string[]).sort()).toEqual(['x', 'z']);
      expect(await synced.sum('score')).toEqual({ count: 2, sum: 5 });
    });

    persistenceIt('sync-tombstone-not-written', driver, async () => {
      const record = await synced.insert({ labels: ['a'], name: 'a' });
      await synced.deleteById(record.id);
      expect(await synced.updateById(record.id, { name: 'revived' })).toBeNull();
      expect(await synced.updateOne({ id: record.id }, { $set: { name: 'revived' } })).toBeNull();
      expect(await synced.updateMany({ id: record.id }, { $set: { name: 'revived' } })).toBe(0);
      await synced.pushToArray(record.id, 'labels', ['b']);
      await synced.pullFromArray(record.id, 'labels', 'a');
      expect(await synced.deleteById(record.id)).toBeNull();
      const tombstone = await synced.findById(record.id, { includeTombstones: true });
      expect(tombstone.version).toBe(2);
      expect(tombstone.name).toBeUndefined();
      expect(tombstone.labels).toBeUndefined();
    });

    persistenceIt('sync-delete-many-tombstones', driver, async () => {
      for (let i = 0; i < 3; i++) {
        await synced.insert({ name: `m${i}`, score: i });
      }
      expect(await synced.deleteMany({ score: { $gte: 1 } })).toBe(2);
      expect(await synced.count()).toBe(1);
      const tombstones = await synced.find({ deletedAt: { $ne: null } }, { includeTombstones: true });
      expect(tombstones).toHaveLength(2);
      expect(tombstones.every((record) => record.version === 2 && record.name === undefined)).toBe(true);
      if (synced.capabilities.changeOrder === 'seq') {
        expect(new Set(tombstones.map((record) => record.syncSeq)).size).toBe(2);
      }
      expect((await synced.deleteOne({ name: 'm0' }))?.name).toBe('m0');
      expect(await synced.count()).toBe(0);
      expect(await synced.deleteOne({ name: 'm0' })).toBeNull();
      expect(await synced.deleteMany({})).toBe(0);
    });

    persistenceIt('sync-hard-delete', driver, async () => {
      const record = await synced.insert({ name: 'a' });
      await synced.deleteById(record.id);
      // Without includeTombstones the purge does not even see it
      expect(await synced.deleteById(record.id, { hardDelete: true })).toBeNull();
      expect((await synced.deleteById(record.id, { hardDelete: true, includeTombstones: true }))?.id).toBe(record.id);
      expect(await synced.findById(record.id, { includeTombstones: true })).toBeNull();
    });

    persistenceIt('sync-unique-live-only', driver, async () => {
      const a = await synced.insert({ code: 'C', handle: 'a@example.com' });
      const b = await synced.insert({ handle: 'b@example.com' });
      expect(await synced.insert({ handle: 'a@example.com' }).catch((error: unknown) => error)).toMatchObject({
        code: 11000,
      });
      expect(await synced.insert({ code: 'C' }).catch((error: unknown) => error)).toMatchObject({ code: 11000 });
      // Two tombstones, both without the values (a tombstone keeps no content): no collision
      await synced.deleteById(a.id);
      await synced.deleteById(b.id);
      // The values are free again
      await synced.insert({ code: 'C', handle: 'a@example.com' });
      // A missing value is a value of its own for a unique index — tombstones' missing values do not count
      await synced.insert({ handle: null, name: 'without-handle-1' });
      expect(
        await synced.insert({ handle: null, name: 'without-handle-2' }).catch((error: unknown) => error),
      ).toMatchObject({
        code: 11000,
      });
      // A sparse unique field may be missing on any number of live records
      await synced.insert({ name: 'without-code-1' });
      await synced.insert({ name: 'without-code-2' });
    });

    persistenceIt('sync-change-order', driver, async () => {
      const pause = driver === 'mongodb' ? tick : async () => undefined;
      const a = await synced.insert({ name: 'a' });
      await pause();
      const b = await synced.insert({ name: 'b' });
      await pause();
      await synced.updateById(a.id, { name: 'a2' });
      const ordered = await synced.find({}, { includeTombstones: true, sort: changeOrderSort(synced) });
      expect(ordered.map((record) => record.id)).toEqual([b.id, a.id]);
      expect(position(ordered[1])).toBeGreaterThan(position(ordered[0]));
      const page = await synced.find(afterChange(synced, ordered[0]), {
        includeTombstones: true,
        limit: 10,
        sort: changeOrderSort(synced),
      });
      expect(page.map((record) => record.id)).toEqual([a.id]);
      await pause();
      await synced.deleteById(b.id);
      const later = await synced.find(afterChange(synced, ordered[1]), {
        includeTombstones: true,
        sort: changeOrderSort(synced),
      });
      expect(later.map((record) => [record.id, !!record.deletedAt])).toEqual([[b.id, true]]);
    });

    persistenceIt('sync-pull-across-tenants', driver, async () => {
      const pause = driver === 'mongodb' ? tick : async () => undefined;
      for (const [tenantId, name] of [
        ['A', 'a1'],
        ['B', 'b1'],
        ['C', 'c1'],
        ['A', 'a2'],
      ]) {
        await run({ tenantId }, () => synced.insert({ name }));
        await pause();
      }
      const seen = await run({ tenantIds: ['A', 'B'] }, () =>
        synced.find({}, { includeTombstones: true, sort: changeOrderSort(synced) }),
      );
      expect(seen.map((record) => record.name)).toEqual(['a1', 'b1', 'a2']);
    });

    if (driver === 'mongodb') {
      persistenceIt('sync-server-clock', driver, async () => {
        const realNow = Date.now;
        const serverNow = async () => {
          const hello = await synced
            .native<mongoose.Model<any>>('test: read the server clock')
            .db.db.admin()
            .command({ hello: 1 });
          return (hello.localTime as Date).getTime();
        };
        const spy = vi.spyOn(Date, 'now').mockImplementation(() => realNow() - 10 * 60_000);
        try {
          const record = await synced.insert({ name: 'skewed' });
          const updated = await synced.updateById(record.id, { name: 'still skewed' });
          const now = await serverNow();
          expect(Math.abs(record.syncAt.getTime() - now)).toBeLessThan(5_000);
          expect(Math.abs(updated.syncAt.getTime() - now)).toBeLessThan(5_000);
        } finally {
          spy.mockRestore();
        }
      });
    } else {
      persistenceComplement('sync-server-clock', driver, async () => {
        const realNow = Date.now;
        const spy = vi.spyOn(Date, 'now').mockImplementation(() => realNow() - 10 * 60_000);
        try {
          const first = await synced.insert({ name: 'first' });
          const second = await synced.insert({ name: 'second' });
          expect(second.syncSeq).toBeGreaterThan(first.syncSeq);
        } finally {
          spy.mockRestore();
        }
      });
    }

    persistenceIt('sync-client-ids', driver, async () => {
      const objectId = '6720c0aabbccddeeff001122';
      expect((await synced.insert({ id: objectId, name: 'client' })).id).toBe(objectId);
      await expect(synced.insert({ id: 'not-an-id', name: 'x' })).rejects.toBeInstanceOf(BadRequestException);
      await expect(synced.insert({ id: generateUuidV7(), name: 'x' })).rejects.toBeInstanceOf(BadRequestException);

      expect(uuids.capabilities.idType).toBe('uuidv7');
      const generated = await uuids.insert({ name: 'server' });
      expect(isUuidV7(generated.id)).toBe(true);
      const uuid = generateUuidV7();
      expect((await uuids.insert({ id: uuid, name: 'client' })).id).toBe(uuid);
      expect((await uuids.findById(uuid))?.name).toBe('client');
      await expect(uuids.insert({ id: objectId, name: 'x' })).rejects.toBeInstanceOf(BadRequestException);
      await expect(uuids.insert({ id: uuid.toUpperCase(), name: 'x' })).rejects.toBeInstanceOf(BadRequestException);
      expect((await uuids.updateById(uuid, { name: 'changed' }))?.version).toBe(2);
      await uuids.deleteById(uuid);
      expect((await uuids.findById(uuid, { includeTombstones: true }))?.deletedAt).toBeInstanceOf(Date);
    });

    persistenceIt('sync-taken-id-unchanged', driver, async () => {
      const id = '6720c0aabbccddeeff003344';
      await synced.insert({ id, name: 'original' });
      expect(await synced.insert({ id, name: 'intruder' }).catch((error: unknown) => error)).toMatchObject({
        code: 11000,
      });
      expect(await synced.findById(id)).toMatchObject({ name: 'original', version: 1 });
      // A tombstone's id stays taken
      await synced.deleteById(id);
      expect(await synced.insert({ id, name: 'again' }).catch((error: unknown) => error)).toMatchObject({
        code: 11000,
      });
    });

    persistenceIt('sync-server-id-retried', driver, async () => {
      // Within one second the next server id is predictable from the last one — the case E6 guards against
      vi.useFakeTimers({ now: new Date(), toFake: ['Date'] });
      try {
        const occupied = nextGeneratedId(generateId());
        await synced.insert({ id: occupied, name: 'occupied by a client' });
        const created = await synced.insert({ name: 'server id' });
        expect(created.id).toBe(nextGeneratedId(occupied));
        expect((await synced.findById(occupied))?.name).toBe('occupied by a client');
      } finally {
        vi.useRealTimers();
      }
    });

    persistenceIt('sync-tenant-policy', driver, async () => {
      const foreign = await run({ tenantId: 'B' }, () => synced.insert({ name: 'b' }));
      const own = await run({ tenantId: 'A' }, () => synced.insert({ name: 'a' }));
      expect(await run({ tenantId: 'A' }, () => synced.deleteById(foreign.id))).toBeNull();
      expect(
        await run({ tenantId: 'A' }, () => synced.updateOne({ id: foreign.id, version: 1 }, { $set: { name: 'x' } })),
      ).toBeNull();
      expect(await run({ tenantId: 'A' }, () => synced.deleteMany({}))).toBe(1);
      expect(await run({ tenantId: 'B' }, () => synced.findById(foreign.id))).toMatchObject({ name: 'b', version: 1 });
      await run({ tenantId: 'B' }, () => synced.deleteById(foreign.id));
      const visible = await run({ tenantId: 'A' }, () => synced.find({}, { includeTombstones: true }));
      expect(visible.map((record) => [record.id, record.tenantId])).toEqual([[own.id, 'A']]);
      await expect(
        run({ currentUser: user('u1') }, () => synced.find({}, { includeTombstones: true })),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    persistenceIt('sync-crud-service', driver, async () => {
      const service = new SyncedCrudService(synced);
      const parent: any = await run(inTenantA, () => service.create({ name: 'parent' }, asAdmin));
      const child: any = await run(inTenantA, () => service.create({ name: 'child', parentId: parent.id }, asAdmin));
      const populated: any = await run(inTenantA, () => service.get(child.id, { ...asAdmin, populate: ['parentId'] }));
      expect(populated.parentId).toMatchObject({ id: parent.id, name: 'parent' });

      await run(inTenantA, () => service.delete(parent.id, asAdmin));
      await expect(run(inTenantA, () => service.get(parent.id, asAdmin))).rejects.toBeInstanceOf(NotFoundException);
      const tombstone: any = await run(inTenantA, () =>
        service.get(parent.id, { ...asAdmin, includeTombstones: true }),
      );
      expect(tombstone).toMatchObject({ id: parent.id, version: 2 });
      expect(tombstone.deletedAt).toBeTruthy();
      expect(tombstone.name).toBeFalsy();

      const orphan: any = await run(inTenantA, () => service.get(child.id, { ...asAdmin, populate: ['parentId'] }));
      expect(orphan.parentId?.name).toBeUndefined();
      expect((await run(inTenantA, () => service.find({}, asAdmin))).map((item: any) => item.id)).toEqual([child.id]);
      expect(await run(inTenantA, () => service.find({}, { ...asAdmin, includeTombstones: true }))).toHaveLength(2);
      expect((await run(inTenantA, () => service.findAndCount({}, asAdmin))).totalCount).toBe(1);
    });
  });
}
