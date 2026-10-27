import { BadRequestException, ForbiddenException, Injectable, Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { Test, TestingModule } from '@nestjs/testing';
import mongoose from 'mongoose';
import { afterAll, beforeAll, beforeEach, describe, expect } from 'vitest';

import { CorePersistenceModule } from '../src/core/common/persistence/core-persistence.module';
import type { DataStore } from '../src/core/common/persistence/data-store.interface';
import { InjectStore } from '../src/core/common/persistence/inject-store.decorator';
import { mongooseAuditFieldsPlugin } from '../src/core/common/plugins/mongoose-audit-fields.plugin';
import { mongooseIdPlugin } from '../src/core/common/plugins/mongoose-id.plugin';
import { mongoosePasswordPlugin } from '../src/core/common/plugins/mongoose-password.plugin';
import { mongooseRoleGuardPlugin } from '../src/core/common/plugins/mongoose-role-guard.plugin';
import { mongooseSystemRolePlugin } from '../src/core/common/plugins/mongoose-system-role.plugin';
import { mongooseTenantPlugin } from '../src/core/common/plugins/mongoose-tenant.plugin';
import { ConfigService } from '../src/core/common/services/config.service';
import { IRequestContext, RequestContext } from '../src/core/common/services/request-context.service';
import { deriveTestDbUri } from './db-lifecycle.reporter';
import { persistenceIt, PersistenceDriver } from './helpers/persistence-matrix';

/**
 * Executor of the persistence parity matrix (`tests/helpers/persistence-matrix.ts`). Every case runs against a
 * data store obtained exactly as a project obtains it — `CorePersistenceModule.forFeature()` + `@InjectStore()` —
 * with every security plugin registered on the connection, as `CoreModule` does.
 */
const ItemSchema = new mongoose.Schema(
  {
    age: Number,
    createdBy: String,
    logs: [{ _id: false, level: String, message: String }],
    name: String,
    password: String,
    roles: [String],
    tags: [String],
    updatedBy: String,
  },
  { timestamps: true },
);
const ScopedSchema = new mongoose.Schema({ name: String, tenantId: String });

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

const driver: PersistenceDriver = 'mongodb';

describe(`persistence parity — ${driver}`, () => {
  let moduleRef: TestingModule;
  let items: DataStore<any>;
  let scoped: DataStore<any>;

  beforeAll(async () => {
    ConfigService.setConfig({ multiTenancy: {} } as any, { reInit: true });
    moduleRef = await Test.createTestingModule({ imports: [ParityModule] }).compile();
    await moduleRef.init();
    ({ items, scoped } = moduleRef.get(StoreHolder));
  });

  beforeEach(async () => {
    const itemModel = items.native<mongoose.Model<any>>('test fixture: reset the parity collection');
    const scopedModel = scoped.native<mongoose.Model<any>>('test fixture: reset the parity collection');
    await itemModel.deleteMany({});
    await scopedModel.deleteMany({});
  });

  afterAll(async () => {
    await items?.native<mongoose.Model<any>>('test teardown: drop the per-run database').db.dropDatabase();
    await moduleRef?.close();
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

  persistenceIt('update-partial', driver, async () => {
    const record = await items.insert({ age: 1, name: 'a' });
    const updated = await items.updateById(record.id, { name: 'b' });
    expect(updated).toMatchObject({ age: 1, id: record.id, name: 'b' });
    expect(await items.updateById('651f00010203040506070809', { name: 'c' })).toBeNull();
  });

  persistenceIt('update-operators', driver, async () => {
    const record = await items.insert({ age: 1, name: 'a' });
    const updated = await items.updateById(record.id, { $inc: { age: 2 }, $unset: { name: '' } });
    expect(updated.age).toBe(3);
    expect(updated).not.toHaveProperty('name');
  });

  persistenceIt('delete-by-id', driver, async () => {
    const record = await items.insert({ name: 'a' });
    expect((await items.deleteById(record.id))?.name).toBe('a');
    expect(await items.findById(record.id)).toBeNull();
  });

  persistenceIt('push-with-slice', driver, async () => {
    const record = await items.insert({ tags: ['t1'] });
    await items.pushToArray(record.id, 'tags', ['t2', 't3', 't4'], { slice: -3 });
    expect((await items.findById(record.id)).tags).toEqual(['t2', 't3', 't4']);
  });

  persistenceIt('pull-by-condition', driver, async () => {
    const record = await items.insert({ logs: [{ level: 'DEBUG' }, { level: 'INFO' }, { level: 'DEBUG' }] });
    await items.pullFromArray(record.id, 'logs', { level: 'DEBUG' });
    expect((await items.findById(record.id)).logs.map((log) => log.level)).toEqual(['INFO']);
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
