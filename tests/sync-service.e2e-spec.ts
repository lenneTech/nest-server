import { Injectable, Module } from '@nestjs/common';
import { InjectModel, MongooseModule, Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Test, TestingModule } from '@nestjs/testing';
import { Model } from 'mongoose';

import { CoreSyncModule, CoreSyncService, ISyncPushItem } from '../src/core/modules/sync';
import { CoreModel } from '../src/core/common/models/core-model.model';
import { mongooseSyncPlugin } from '../src/core/common/plugins/mongoose-sync.plugin';
import { ConfigService } from '../src/core/common/services/config.service';
import { CrudService } from '../src/core/common/services/crud.service';

@Schema({ syncable: true, timestamps: true } as any)
class Item extends CoreModel {
  @Prop({ type: String })
  title: string;

  @Prop({ type: Number, default: 1 })
  version: number;

  @Prop({ type: Date, default: null })
  deletedAt: Date | null;
}
const ItemSchema = SchemaFactory.createForClass(Item);

@Injectable()
class ItemService extends CrudService<any, any, any> {
  constructor(@InjectModel('Item') model: Model<any>) {
    super({ mainDbModel: model as any, mainModelConstructor: Item });
  }
}

const TEST_DB_URI = 'mongodb://127.0.0.1/nest-server-sync-service-test';

@Module({
  imports: [
    MongooseModule.forRoot(TEST_DB_URI, {
      connectionFactory: (connection) => {
        connection.plugin(mongooseSyncPlugin);
        return connection;
      },
    }),
    MongooseModule.forFeature([{ name: 'Item', schema: ItemSchema }]),
    CoreSyncModule.forRoot({
      enableHint: false,
      enableRest: false,
      models: [{ name: 'Item', service: ItemService }],
    }),
  ],
  providers: [ItemService],
})
class SyncServiceTestModule {}

describe('CoreSyncService — bulk push (e2e)', () => {
  let app: import('@nestjs/common').INestApplication;
  let svc: CoreSyncService;
  let model: Model<any>;

  beforeAll(async () => {
    new ConfigService({ sync: { idempotency: { enabled: false } } } as any);
    const mod: TestingModule = await Test.createTestingModule({
      imports: [SyncServiceTestModule],
    }).compile();
    app = mod.createNestApplication();
    await app.init();
    svc = mod.get(CoreSyncService);
    const itemSvc = mod.get(ItemService);
    model = (itemSvc as any).mainDbModel;
  });

  beforeEach(async () => {
    await model.deleteMany({}).setOptions({ _includeDeleted: true } as any);
  });

  afterAll(async () => {
    await model.deleteMany({}).setOptions({ _includeDeleted: true } as any);
    await app.close();
  });

  it('push creates items', async () => {
    const items: ISyncPushItem[] = [
      { clientId: 'a', data: { title: 'first' } },
      { clientId: 'b', data: { title: 'second' } },
    ];
    const res = await svc.push('Item', items, {});
    expect(res.results.length).toBe(2);
    expect(res.results.every((r) => r.status === 'applied')).toBe(true);
    expect(await model.countDocuments()).toBe(2);
  });

  it('push updates with matching expectedVersion', async () => {
    const created = await model.create({ title: 'orig' });
    const items: ISyncPushItem[] = [
      { clientId: 'u', data: { title: 'changed' }, id: String(created._id), version: 1 },
    ];
    const res = await svc.push('Item', items, {});
    expect(res.results[0].status).toBe('applied');
    const fresh: any = await model.findById(created._id).lean();
    expect(fresh?.title).toBe('changed');
    expect(fresh?.version).toBe(2);
  });

  it('push reports conflict when expectedVersion does not match', async () => {
    const created = await model.create({ title: 'orig' });
    const items: ISyncPushItem[] = [
      { clientId: 'c', data: { title: 'changed' }, id: String(created._id), version: 999 },
    ];
    const res = await svc.push('Item', items, {});
    expect(res.results[0].status).toBe('conflict');
    expect(res.results[0].serverState).toBeDefined();
    expect(res.results[0].serverVersion).toBe(1);
  });

  it('push soft-deletes when item.deleted is true', async () => {
    const created = await model.create({ title: 'orig' });
    const items: ISyncPushItem[] = [
      { clientId: 'd', deleted: true, id: String(created._id), version: 1 },
    ];
    const res = await svc.push('Item', items, {});
    expect(res.results[0].status).toBe('applied');
    const fresh: any = await model.findById(created._id).setOptions({ _includeDeleted: true } as any).lean();
    expect(fresh?.deletedAt).toBeInstanceOf(Date);
  });

  it('push cannot bypass into hard delete via crafted serviceOptions', async () => {
    const created = await model.create({ title: 'orig' });
    const items: ISyncPushItem[] = [
      { clientId: 'h', deleted: true, id: String(created._id), version: 1 },
    ];
    // Even if a malicious caller sneaks hardDelete: true into serviceOptions,
    // the service forces it to false (R14 mitigation).
    const res = await svc.push('Item', items, { hardDelete: true });
    expect(res.results[0].status).toBe('applied');
    const fresh: any = await model.findById(created._id).setOptions({ _includeDeleted: true } as any).lean();
    expect(fresh).not.toBeNull(); // still exists as tombstone
    expect(fresh?.deletedAt).toBeInstanceOf(Date);
  });

  it('push rejects unregistered model with NotFoundException', async () => {
    await expect(svc.push('NotRegistered', [{ data: { title: 'x' } }], {})).rejects.toThrow();
  });

  it('pull returns delta with cursor', async () => {
    const a = await model.create({ title: 'a' });
    const b = await model.create({ title: 'b' });
    const res = await svc.pull('Item', null, { limit: 10 });
    expect(res.changes.length).toBeGreaterThanOrEqual(2);
    expect(res.cursor).not.toBeNull();
    const ids = res.changes.map((c: any) => String(c._id));
    expect(ids).toContain(String(a._id));
    expect(ids).toContain(String(b._id));
  });

  it('pull cursor is opaque base64url and round-trips', async () => {
    await model.create({ title: 'a' });
    const res = await svc.pull('Item', null, { limit: 10 });
    const decoded = svc.decodeCursor(res.cursor!);
    expect(decoded).toBeDefined();
    expect(decoded!.id).toBeDefined();
    expect(decoded!.updatedAt).toBeInstanceOf(Date);
  });

  it('listModels reports the registered model', () => {
    expect(svc.listModels()).toContain('Item');
  });
});
