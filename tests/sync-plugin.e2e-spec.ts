import { Module } from '@nestjs/common';
import { MongooseModule, Prop, Schema, SchemaFactory, getModelToken } from '@nestjs/mongoose';
import { Test, TestingModule } from '@nestjs/testing';
import { Model } from 'mongoose';

import { mongooseSyncPlugin } from '../src/core/common/plugins/mongoose-sync.plugin';

// =============================================================================
// Test Schemas
// =============================================================================

@Schema({ syncable: true, timestamps: true } as any)
class SyncableNote {
  @Prop({ type: String })
  title: string;

  @Prop({ type: String })
  body: string;
}
const SyncableNoteSchema = SchemaFactory.createForClass(SyncableNote);

// Non-syncable schema — must remain unaffected by the plugin.
@Schema({ timestamps: true })
class PlainNote {
  @Prop({ type: String })
  title: string;
}
const PlainNoteSchema = SchemaFactory.createForClass(PlainNote);

// =============================================================================
// Test Module
// =============================================================================
const TEST_DB_URI = 'mongodb://127.0.0.1/nest-server-sync-plugin-test';

@Module({
  imports: [
    MongooseModule.forRoot(TEST_DB_URI, {
      connectionFactory: (connection) => {
        connection.plugin(mongooseSyncPlugin);
        return connection;
      },
    }),
    MongooseModule.forFeature([
      { name: SyncableNote.name, schema: SyncableNoteSchema },
      { name: PlainNote.name, schema: PlainNoteSchema },
    ]),
  ],
})
class SyncPluginTestModule {}

describe('mongooseSyncPlugin (e2e)', () => {
  let app: import('@nestjs/common').INestApplication;
  let syncableModel: Model<SyncableNote>;
  let plainModel: Model<PlainNote>;

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [SyncPluginTestModule],
    }).compile();
    app = moduleFixture.createNestApplication();
    await app.init();
    syncableModel = moduleFixture.get<Model<SyncableNote>>(getModelToken(SyncableNote.name));
    plainModel = moduleFixture.get<Model<PlainNote>>(getModelToken(PlainNote.name));
  });

  beforeEach(async () => {
    await syncableModel.deleteMany({}).setOptions({ _includeDeleted: true } as any);
    await plainModel.deleteMany({});
  });

  afterAll(async () => {
    await syncableModel.deleteMany({}).setOptions({ _includeDeleted: true } as any);
    await plainModel.deleteMany({});
    await app.close();
  });

  // -------------------------------------------------------------------------
  // Field provisioning
  // -------------------------------------------------------------------------

  it('adds version + deletedAt fields to syncable schemas', () => {
    expect(syncableModel.schema.path('version')).toBeDefined();
    expect(syncableModel.schema.path('deletedAt')).toBeDefined();
  });

  it('does NOT add version/deletedAt to non-syncable schemas (backward compat)', () => {
    expect(plainModel.schema.path('version')).toBeUndefined();
    expect(plainModel.schema.path('deletedAt')).toBeUndefined();
  });

  // -------------------------------------------------------------------------
  // Version increment
  // -------------------------------------------------------------------------

  it('initialises version=1 on save (new doc)', async () => {
    const note = await syncableModel.create({ body: 'b1', title: 't1' });
    const fresh = await syncableModel.findById(note._id).lean();
    expect((fresh as any)?.version).toBe(1);
  });

  it('increments version on save (existing doc, modified)', async () => {
    const note = await syncableModel.create({ body: 'b1', title: 't1' });
    note.title = 't2';
    await note.save();
    const fresh = await syncableModel.findById(note._id).lean();
    expect((fresh as any)?.version).toBe(2);
  });

  it('increments version on findOneAndUpdate', async () => {
    const note = await syncableModel.create({ body: 'b1', title: 't1' });
    await syncableModel.findByIdAndUpdate(note._id, { title: 't2' }).exec();
    const fresh = await syncableModel.findById(note._id).lean();
    expect((fresh as any)?.version).toBe(2);
  });

  it('increments version on insertMany (initial 1)', async () => {
    const inserted = await syncableModel.insertMany([
      { body: 'b1', title: 't1' },
      { body: 'b2', title: 't2' },
    ]);
    expect(inserted.every((d: any) => d.version === 1)).toBe(true);
  });

  it('increments version on bulkWrite', async () => {
    const note = await syncableModel.create({ body: 'b1', title: 't1' });
    await syncableModel.bulkWrite([{ updateOne: { filter: { _id: note._id }, update: { $set: { title: 't2' } } } }]);
    const fresh = await syncableModel.findById(note._id).lean();
    expect((fresh as any)?.version).toBe(2);
  });

  // -------------------------------------------------------------------------
  // Tombstones (soft delete)
  // -------------------------------------------------------------------------

  it('hides tombstones from regular find()', async () => {
    const note = await syncableModel.create({ body: 'b1', title: 't1' });
    await syncableModel.findByIdAndUpdate(note._id, { $set: { deletedAt: new Date() } } as any).exec();

    const found = await syncableModel.find().lean();
    expect(found.find((n: any) => n._id.toString() === note._id.toString())).toBeUndefined();
  });

  it('exposes tombstones with _includeDeleted bypass', async () => {
    const note = await syncableModel.create({ body: 'b1', title: 't1' });
    await syncableModel.findByIdAndUpdate(note._id, { $set: { deletedAt: new Date() } } as any).exec();

    const found = await syncableModel.find().setOptions({ _includeDeleted: true } as any).lean();
    expect(found.find((n: any) => n._id.toString() === note._id.toString())).toBeDefined();
  });

  it('hides tombstones from countDocuments()', async () => {
    await syncableModel.create({ body: 'b1', title: 't1' });
    const note = await syncableModel.create({ body: 'b2', title: 't2' });
    await syncableModel.findByIdAndUpdate(note._id, { $set: { deletedAt: new Date() } } as any).exec();

    const count = await syncableModel.countDocuments();
    expect(count).toBe(1);
  });

  it('hides tombstones from aggregate()', async () => {
    await syncableModel.create({ body: 'b1', title: 't1' });
    const note = await syncableModel.create({ body: 'b2', title: 't2' });
    await syncableModel.findByIdAndUpdate(note._id, { $set: { deletedAt: new Date() } } as any).exec();

    const result = await syncableModel.aggregate([{ $count: 'total' }]).exec();
    expect(result[0]?.total).toBe(1);
  });

  it('does NOT filter tombstones on non-syncable schemas (no field, no plugin)', async () => {
    await plainModel.create({ title: 't1' });
    const found = await plainModel.find().lean();
    expect(found.length).toBe(1);
  });
});
