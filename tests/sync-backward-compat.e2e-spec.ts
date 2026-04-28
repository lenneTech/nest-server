import { Module } from '@nestjs/common';
import { MongooseModule, Prop, Schema, SchemaFactory, getModelToken } from '@nestjs/mongoose';
import { Test, TestingModule } from '@nestjs/testing';
import { Model } from 'mongoose';

import { mongooseAuditFieldsPlugin } from '../src/core/common/plugins/mongoose-audit-fields.plugin';
import { mongooseSyncPlugin } from '../src/core/common/plugins/mongoose-sync.plugin';

/**
 * Backward-compat verification: with the sync plugin loaded but a schema
 * that does NOT opt into syncable, behaviour must be identical to the
 * pre-sync baseline. No version, no deletedAt, no cursor index — and no
 * tombstone filter on read paths.
 */

@Schema({ timestamps: true })
class LegacyDoc {
  @Prop({ type: String })
  name: string;

  @Prop({ type: String })
  createdBy: string;

  @Prop({ type: String })
  updatedBy: string;
}
const LegacyDocSchema = SchemaFactory.createForClass(LegacyDoc);

const TEST_DB_URI = 'mongodb://127.0.0.1/nest-server-sync-bc-test';

@Module({
  imports: [
    MongooseModule.forRoot(TEST_DB_URI, {
      connectionFactory: (connection) => {
        // Both plugins active. Sync plugin must remain inert for non-syncable schemas.
        connection.plugin(mongooseAuditFieldsPlugin);
        connection.plugin(mongooseSyncPlugin);
        return connection;
      },
    }),
    MongooseModule.forFeature([{ name: LegacyDoc.name, schema: LegacyDocSchema }]),
  ],
})
class BackwardCompatModule {}

describe('Sync feature — backward compatibility (e2e)', () => {
  let app: import('@nestjs/common').INestApplication;
  let model: Model<LegacyDoc>;

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [BackwardCompatModule],
    }).compile();
    app = moduleFixture.createNestApplication();
    await app.init();
    model = moduleFixture.get<Model<LegacyDoc>>(getModelToken(LegacyDoc.name));
  });

  beforeEach(async () => {
    await model.deleteMany({});
  });

  afterAll(async () => {
    await model.deleteMany({});
    await app.close();
  });

  it('non-syncable schema has NO version field', () => {
    expect(model.schema.path('version')).toBeUndefined();
  });

  it('non-syncable schema has NO deletedAt field', () => {
    expect(model.schema.path('deletedAt')).toBeUndefined();
  });

  it('save() does NOT trigger version increment (legacy behaviour preserved)', async () => {
    const doc = await model.create({ name: 'a' });
    const fresh: any = await model.findById(doc._id).lean();
    expect(fresh?.version).toBeUndefined();
  });

  it('findOneAndUpdate() does NOT add $inc.version', async () => {
    const doc = await model.create({ name: 'a' });
    const updated: any = await model.findByIdAndUpdate(doc._id, { name: 'b' }, { new: true }).lean();
    expect(updated?.name).toBe('b');
    expect(updated?.version).toBeUndefined();
  });

  it('find() returns all documents — no tombstone filter applied', async () => {
    await model.create({ name: 'a' });
    await model.create({ name: 'b' });
    const all = await model.find().lean();
    expect(all.length).toBe(2);
  });

  it('schema does NOT have the sync cursor compound index', () => {
    const indexes = (model.schema as any).indexes();
    const hasCursorIndex = indexes.some((idx: any[]) => {
      const def = idx[0];
      return def && def.updatedAt === 1 && def._id === 1;
    });
    expect(hasCursorIndex).toBe(false);
  });
});
