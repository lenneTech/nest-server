import { Injectable, Module } from '@nestjs/common';
import { InjectModel, MongooseModule, Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Test, TestingModule } from '@nestjs/testing';
import { Model } from 'mongoose';

import { CoreModel } from '../src/core/common/models/core-model.model';
import { mongooseSyncPlugin } from '../src/core/common/plugins/mongoose-sync.plugin';
import { ConfigService } from '../src/core/common/services/config.service';
import { CrudService } from '../src/core/common/services/crud.service';
import { SyncConflictException } from '../src/core/common/exceptions/sync-conflict.exception';

// =============================================================================
// Test Model & Schema
// =============================================================================

@Schema({ syncable: true, timestamps: true } as any)
class TodoDoc extends CoreModel {
  @Prop({ type: String })
  title: string;

  @Prop({ type: String })
  body: string;

  @Prop({ type: Number, default: 1 })
  version: number;

  @Prop({ type: Date, default: null })
  deletedAt: Date | null;
}
const TodoSchema = SchemaFactory.createForClass(TodoDoc);

// CrudService subclass for the test model.
@Injectable()
class TodoService extends CrudService<any, any, any> {
  constructor(@InjectModel('TodoDoc') model: Model<any>) {
    super({ mainDbModel: model as any, mainModelConstructor: TodoDoc });
  }
}

// =============================================================================
// Test Module
// =============================================================================
const TEST_DB_URI = 'mongodb://127.0.0.1/nest-server-sync-crud-test';

@Module({
  imports: [
    MongooseModule.forRoot(TEST_DB_URI, {
      connectionFactory: (connection) => {
        connection.plugin(mongooseSyncPlugin);
        return connection;
      },
    }),
    MongooseModule.forFeature([{ name: 'TodoDoc', schema: TodoSchema }]),
  ],
  providers: [TodoService],
  exports: [TodoService],
})
class SyncCrudTestModule {}

describe('CrudService — sync extensions (e2e)', () => {
  let app: import('@nestjs/common').INestApplication;
  let svc: TodoService;
  let model: Model<any>;

  beforeAll(async () => {
    new ConfigService({} as any);
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [SyncCrudTestModule],
    }).compile();
    app = moduleFixture.createNestApplication();
    await app.init();
    svc = moduleFixture.get(TodoService);
    model = (svc as any).mainDbModel;
  });

  beforeEach(async () => {
    await model.deleteMany({}).setOptions({ _includeDeleted: true } as any);
  });

  afterAll(async () => {
    await model.deleteMany({}).setOptions({ _includeDeleted: true } as any);
    await app.close();
  });

  // -------------------------------------------------------------------------
  // expectedVersion (optimistic concurrency)
  // -------------------------------------------------------------------------

  it('update without expectedVersion succeeds (legacy path unchanged)', async () => {
    const created = await model.create({ body: 'b', title: 't' });
    await svc.update(String(created._id), { title: 'u' });
    const fresh: any = await model.findById(created._id).lean();
    expect(fresh?.title).toBe('u');
  });

  it('update with matching expectedVersion succeeds and increments version', async () => {
    const created = await model.create({ body: 'b', title: 't' });
    const v1 = (created as any).version;
    await svc.update(String(created._id), { title: 'u' }, { expectedVersion: v1 } as any);
    const fresh: any = await model.findById(created._id).lean();
    expect(fresh?.version).toBe(v1 + 1);
    expect(fresh?.title).toBe('u');
  });

  it('update with mismatched expectedVersion throws SyncConflictException', async () => {
    const created = await model.create({ body: 'b', title: 't' });
    await expect(
      svc.update(String(created._id), { title: 'u' }, { expectedVersion: 999 } as any),
    ).rejects.toThrow(SyncConflictException);
  });

  it('SyncConflictException carries serverState', async () => {
    const created = await model.create({ body: 'b', title: 't' });
    try {
      await svc.update(String(created._id), { title: 'u' }, { expectedVersion: 999 } as any);
      throw new Error('should have thrown');
    } catch (e: any) {
      expect(e).toBeInstanceOf(SyncConflictException);
      expect(e.payload.serverState).toBeDefined();
      expect(e.payload.serverVersion).toBe((created as any).version);
      expect(e.payload.clientVersion).toBe(999);
    }
  });

  // -------------------------------------------------------------------------
  // delete (soft-delete on syncable schemas)
  // -------------------------------------------------------------------------

  it('delete sets deletedAt instead of removing the document (soft delete)', async () => {
    const created = await model.create({ body: 'b', title: 't' });
    await svc.delete(String(created._id));
    const direct = await model.findById(String(created._id)).setOptions({ _includeDeleted: true } as any).lean();
    expect(direct).toBeDefined();
    expect((direct as any)?.deletedAt).toBeInstanceOf(Date);
  });

  it('soft-deleted document is not returned by find()', async () => {
    const created = await model.create({ body: 'b', title: 't' });
    await svc.delete(String(created._id));
    const all = await model.find().exec();
    expect(all.find((d: any) => d._id.toString() === String(created._id))).toBeUndefined();
  });

  it('hardDelete: true removes the document permanently', async () => {
    const created = await model.create({ body: 'b', title: 't' });
    await svc.delete(String(created._id), { hardDelete: true } as any);
    const direct = await model.findById(String(created._id)).setOptions({ _includeDeleted: true } as any).lean();
    expect(direct).toBeNull();
  });

  // -------------------------------------------------------------------------
  // findChangesSince
  // -------------------------------------------------------------------------

  it('findChangesSince returns all changes when cursor is null', async () => {
    const a = await model.create({ body: 'b', title: 'a' });
    const b = await model.create({ body: 'b', title: 'b' });
    const result = await svc.findChangesSince(null, { limit: 10 });
    expect(result.changes.length).toBeGreaterThanOrEqual(2);
    expect(result.cursor).not.toBeNull();
    const ids = result.changes.map((c: any) => String(c._id));
    expect(ids).toContain(String(a._id));
    expect(ids).toContain(String(b._id));
  });

  it('findChangesSince paginates correctly via cursor', async () => {
    for (let i = 0; i < 5; i++) {
      await model.create({ body: 'b', title: `t${i}` });
    }
    const first = await svc.findChangesSince(null, { limit: 3 });
    expect(first.changes.length).toBe(3);
    expect(first.hasMore).toBe(true);

    const second = await svc.findChangesSince(first.cursor, { limit: 3 });
    expect(second.changes.length).toBeGreaterThan(0);
    expect(second.changes.length).toBeLessThanOrEqual(3);
  });

  it('findChangesSince includes tombstones', async () => {
    const created = await model.create({ body: 'b', title: 't' });
    await svc.delete(String(created._id));
    const result = await svc.findChangesSince(null, { limit: 10 });
    const tombstone: any = result.changes.find((c: any) => String(c._id) === String(created._id));
    expect(tombstone).toBeDefined();
    expect(tombstone.deletedAt).toBeInstanceOf(Date);
  });

  it('findChangesSince with lean: true returns plain objects', async () => {
    await model.create({ body: 'b', title: 't' });
    const result = await svc.findChangesSince(null, { lean: true, limit: 10 });
    expect(result.changes.length).toBeGreaterThan(0);
    // Lean docs do not have .save method.
    expect((result.changes[0] as any).save).toBeUndefined();
  });
});
