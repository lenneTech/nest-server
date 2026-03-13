import * as fs from 'fs';
import * as path from 'path';

import { Module } from '@nestjs/common';
import { MongooseModule, Prop, Schema, SchemaFactory, getModelToken } from '@nestjs/mongoose';
import { Test, TestingModule } from '@nestjs/testing';
import { Model } from 'mongoose';

import { ConfigService } from '../src/core/common/services/config.service';
import { IRequestContext, RequestContext } from '../src/core/common/services/request-context.service';
import { mongooseTenantPlugin } from '../src/core/common/plugins/mongoose-tenant.plugin';

// =============================================================================
// Test Schema: TenantItem (has tenantId → plugin activates)
// =============================================================================
@Schema({ timestamps: true })
class TenantItem {
  @Prop({ type: String })
  tenantId: string;

  @Prop({ type: String, required: true })
  name: string;
}

const TenantItemSchema = SchemaFactory.createForClass(TenantItem);

// =============================================================================
// Test Schema: GlobalItem (no tenantId → plugin ignores)
// =============================================================================
@Schema({ timestamps: true })
class GlobalItem {
  @Prop({ type: String, required: true })
  name: string;
}

const GlobalItemSchema = SchemaFactory.createForClass(GlobalItem);

// =============================================================================
// Test Module
// =============================================================================
const TEST_DB_URI = 'mongodb://127.0.0.1/nest-server-mt-test';

@Module({
  imports: [
    MongooseModule.forRoot(TEST_DB_URI, {
      connectionFactory: (connection) => {
        connection.plugin(mongooseTenantPlugin);
        return connection;
      },
    }),
    MongooseModule.forFeature([
      { name: TenantItem.name, schema: TenantItemSchema },
      { name: GlobalItem.name, schema: GlobalItemSchema },
    ]),
  ],
})
class TestModule {}

// =============================================================================
// Helper: Run function within a tenant context
// =============================================================================
function runAsTenant<T>(tenantId: string, fn: () => T): T {
  const context: IRequestContext = {
    currentUser: { id: 'test-user' },
    tenantId,
  };
  return RequestContext.run(context, fn);
}

function runAsUserWithoutTenant<T>(fn: () => T): T {
  const context: IRequestContext = {
    currentUser: { id: 'test-user-no-tenant' },
    tenantId: undefined,
  };
  return RequestContext.run(context, fn);
}

function runWithoutContext<T>(fn: () => T): T {
  return fn();
}

// =============================================================================
// Tests
// =============================================================================
describe('Multi-Tenancy Plugin (e2e)', () => {
  let tenantItemModel: Model<TenantItem>;
  let globalItemModel: Model<GlobalItem>;
  let app: import('@nestjs/common').INestApplication;

  beforeAll(async () => {
    // Set up ConfigService with multiTenancy enabled
    new ConfigService({ multiTenancy: {} } as any);

    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [TestModule],
    }).compile();

    app = moduleFixture.createNestApplication();
    await app.init();

    tenantItemModel = moduleFixture.get<Model<TenantItem>>(getModelToken(TenantItem.name));
    globalItemModel = moduleFixture.get<Model<GlobalItem>>(getModelToken(GlobalItem.name));
  });

  beforeEach(async () => {
    await tenantItemModel.deleteMany({});
    await globalItemModel.deleteMany({});
  });

  afterAll(async () => {
    await tenantItemModel.deleteMany({});
    await globalItemModel.deleteMany({});
    await app.close();
  });

  // =========================================================================
  // Test 1: Schema without tenantId is not affected
  // =========================================================================
  it('should not filter schemas without tenantId field', async () => {
    // Create items without tenant context (system op)
    await globalItemModel.create({ name: 'global-1' });
    await globalItemModel.create({ name: 'global-2' });

    // Query as Tenant A → should still see all items (no tenantId field on schema)
    const items = await runAsTenant('tenant-a', () => globalItemModel.find().lean().exec());
    expect(items).toHaveLength(2);
  });

  // =========================================================================
  // Test 2: Tenant A isolation
  // =========================================================================
  it('should isolate Tenant A data', async () => {
    // Seed data directly (no context = system op)
    await tenantItemModel.create({ name: 'item-a1', tenantId: 'tenant-a' });
    await tenantItemModel.create({ name: 'item-a2', tenantId: 'tenant-a' });
    await tenantItemModel.create({ name: 'item-b1', tenantId: 'tenant-b' });

    // Tenant A should only see its own items
    const items = await runAsTenant('tenant-a', () => tenantItemModel.find().lean().exec());
    expect(items).toHaveLength(2);
    expect(items.every((i) => i.tenantId === 'tenant-a')).toBe(true);
  });

  // =========================================================================
  // Test 3: Cross-tenant isolation
  // =========================================================================
  it('should prevent Tenant A from seeing Tenant B data', async () => {
    await tenantItemModel.create({ name: 'item-b1', tenantId: 'tenant-b' });
    await tenantItemModel.create({ name: 'item-b2', tenantId: 'tenant-b' });

    const items = await runAsTenant('tenant-a', () => tenantItemModel.find().lean().exec());
    expect(items).toHaveLength(0);
  });

  // =========================================================================
  // Test 4: Auto-set tenantId on save
  // =========================================================================
  it('should auto-set tenantId on new documents via save', async () => {
    const doc = await runAsTenant('tenant-a', async () => {
      const item = new tenantItemModel({ name: 'auto-item' });
      return item.save();
    });

    expect(doc.tenantId).toBe('tenant-a');
  });

  // =========================================================================
  // Test 5: Auto-set tenantId on insertMany
  // =========================================================================
  it('should auto-set tenantId on insertMany', async () => {
    const docs = await runAsTenant('tenant-a', () =>
      tenantItemModel.insertMany([{ name: 'bulk-1' }, { name: 'bulk-2' }]),
    );

    expect(docs).toHaveLength(2);
    expect(docs.every((d) => d.tenantId === 'tenant-a')).toBe(true);
  });

  // =========================================================================
  // Test 6: Explicit tenantId is preserved
  // =========================================================================
  it('should preserve explicitly set tenantId on save', async () => {
    const doc = await runAsTenant('tenant-a', async () => {
      const item = new tenantItemModel({ name: 'explicit-item', tenantId: 'tenant-x' });
      return item.save();
    });

    expect(doc.tenantId).toBe('tenant-x');
  });

  // =========================================================================
  // Test 7: findOneAndUpdate is filtered
  // =========================================================================
  it('should not update documents of other tenants via findOneAndUpdate', async () => {
    await tenantItemModel.create({ name: 'target', tenantId: 'tenant-b' });

    // Tenant A tries to update Tenant B's document
    const result = await runAsTenant('tenant-a', () =>
      tenantItemModel.findOneAndUpdate({ name: 'target' }, { name: 'hacked' }, { new: true }).lean().exec(),
    );

    expect(result).toBeNull();

    // Verify original is untouched
    const original = await tenantItemModel.findOne({ name: 'target' }).lean().exec();
    expect(original).toBeTruthy();
    expect(original.name).toBe('target');
  });

  // =========================================================================
  // Test 8: deleteOne is filtered
  // =========================================================================
  it('should not delete documents of other tenants via deleteOne', async () => {
    await tenantItemModel.create({ name: 'protected', tenantId: 'tenant-b' });

    await runAsTenant('tenant-a', () => tenantItemModel.deleteOne({ name: 'protected' }).exec());

    // Document should still exist
    const doc = await tenantItemModel.findOne({ name: 'protected' }).lean().exec();
    expect(doc).toBeTruthy();
  });

  // =========================================================================
  // Test 9: findOneAndDelete is filtered
  // =========================================================================
  it('should not delete documents of other tenants via findOneAndDelete', async () => {
    await tenantItemModel.create({ name: 'target', tenantId: 'tenant-b' });

    const result = await runAsTenant('tenant-a', () =>
      tenantItemModel.findOneAndDelete({ name: 'target' }).lean().exec(),
    );

    expect(result).toBeNull();

    const doc = await tenantItemModel.findOne({ name: 'target' }).lean().exec();
    expect(doc).toBeTruthy();
  });

  // =========================================================================
  // Test 10: countDocuments is filtered
  // =========================================================================
  it('should only count own tenant documents', async () => {
    await tenantItemModel.create({ name: 'a1', tenantId: 'tenant-a' });
    await tenantItemModel.create({ name: 'a2', tenantId: 'tenant-a' });
    await tenantItemModel.create({ name: 'b1', tenantId: 'tenant-b' });

    const count = await runAsTenant('tenant-a', () => tenantItemModel.countDocuments().exec());
    expect(count).toBe(2);
  });

  // =========================================================================
  // Test 11: aggregate is filtered
  // =========================================================================
  it('should prepend $match in aggregates', async () => {
    await tenantItemModel.create({ name: 'a1', tenantId: 'tenant-a' });
    await tenantItemModel.create({ name: 'a2', tenantId: 'tenant-a' });
    await tenantItemModel.create({ name: 'b1', tenantId: 'tenant-b' });

    const result = await runAsTenant('tenant-a', () =>
      tenantItemModel.aggregate([{ $group: { _id: '$tenantId', count: { $sum: 1 } } }]).exec(),
    );

    expect(result).toHaveLength(1);
    expect(result[0]._id).toBe('tenant-a');
    expect(result[0].count).toBe(2);
  });

  // =========================================================================
  // Test 12: No context = no filter (system operations)
  // =========================================================================
  it('should not filter when there is no RequestContext', async () => {
    await tenantItemModel.create({ name: 'a1', tenantId: 'tenant-a' });
    await tenantItemModel.create({ name: 'b1', tenantId: 'tenant-b' });

    const items = await runWithoutContext(() => tenantItemModel.find().lean().exec());
    expect(items).toHaveLength(2);
  });

  // =========================================================================
  // Test 13: Bypass = no filter
  // =========================================================================
  it('should not filter when bypassTenantGuard is active', async () => {
    await tenantItemModel.create({ name: 'a1', tenantId: 'tenant-a' });
    await tenantItemModel.create({ name: 'b1', tenantId: 'tenant-b' });

    const items = await runAsTenant('tenant-a', () =>
      RequestContext.runWithBypassTenantGuard(() => tenantItemModel.find().lean().exec()),
    );

    expect(items).toHaveLength(2);
  });

  // =========================================================================
  // Test 14: User without tenant header sees all data (no filter)
  // =========================================================================
  it('should not filter when user has no tenantId (no tenant header)', async () => {
    await tenantItemModel.create({ name: 'assigned', tenantId: 'tenant-a' });
    await tenantItemModel.create({ name: 'unassigned', tenantId: null });

    const items = await runAsUserWithoutTenant(() => tenantItemModel.find().lean().exec());
    expect(items).toHaveLength(2);
  });

  // =========================================================================
  // Test 15: excludeSchemas
  // =========================================================================
  it('should not filter excluded schemas', async () => {
    // Reconfigure with TenantItem excluded
    new ConfigService({ multiTenancy: { excludeSchemas: ['TenantItem'] } } as any);

    await tenantItemModel.create({ name: 'a1', tenantId: 'tenant-a' });
    await tenantItemModel.create({ name: 'b1', tenantId: 'tenant-b' });

    const items = await runAsTenant('tenant-a', () => tenantItemModel.find().lean().exec());
    expect(items).toHaveLength(2);

    // Restore original config (must explicitly clear excludeSchemas since ConfigService merges)
    new ConfigService({ multiTenancy: { excludeSchemas: [] } } as any);
  });

  // =========================================================================
  // Test 16: updateMany is filtered
  // =========================================================================
  it('should only update own tenant documents via updateMany', async () => {
    await tenantItemModel.create({ name: 'old', tenantId: 'tenant-a' });
    await tenantItemModel.create({ name: 'old', tenantId: 'tenant-b' });

    const result = await runAsTenant('tenant-a', () =>
      tenantItemModel.updateMany({ name: 'old' }, { name: 'new' }).exec(),
    );

    expect(result.modifiedCount).toBe(1);

    // Tenant B's document should be unchanged
    const bDoc = await tenantItemModel.findOne({ tenantId: 'tenant-b' }).lean().exec();
    expect(bDoc.name).toBe('old');
  });

  // =========================================================================
  // Test 17: findOne is filtered
  // =========================================================================
  it('should not find documents of other tenants via findOne', async () => {
    await tenantItemModel.create({ name: 'secret', tenantId: 'tenant-b' });

    const result = await runAsTenant('tenant-a', () => tenantItemModel.findOne({ name: 'secret' }).lean().exec());

    expect(result).toBeNull();
  });

  // =========================================================================
  // Test 18: deleteMany is filtered
  // =========================================================================
  it('should only delete own tenant documents via deleteMany', async () => {
    await tenantItemModel.create({ name: 'del', tenantId: 'tenant-a' });
    await tenantItemModel.create({ name: 'del', tenantId: 'tenant-b' });

    await runAsTenant('tenant-a', () => tenantItemModel.deleteMany({ name: 'del' }).exec());

    // Tenant B's document should still exist
    const remaining = await tenantItemModel.find().lean().exec();
    expect(remaining).toHaveLength(1);
    expect(remaining[0].tenantId).toBe('tenant-b');
  });

  // =========================================================================
  // Test 19: updateOne is filtered
  // =========================================================================
  it('should not update documents of other tenants via updateOne', async () => {
    await tenantItemModel.create({ name: 'target', tenantId: 'tenant-b' });

    const result = await runAsTenant('tenant-a', () =>
      tenantItemModel.updateOne({ name: 'target' }, { name: 'hacked' }).exec(),
    );

    expect(result.modifiedCount).toBe(0);

    const original = await tenantItemModel.findOne({ name: 'target' }).lean().exec();
    expect(original.name).toBe('target');
  });

  // =========================================================================
  // Test 20: replaceOne is filtered
  // =========================================================================
  it('should not replace documents of other tenants via replaceOne', async () => {
    await tenantItemModel.create({ name: 'target', tenantId: 'tenant-b' });

    const result = await runAsTenant('tenant-a', () =>
      tenantItemModel.replaceOne({ name: 'target' }, { name: 'replaced', tenantId: 'tenant-a' }).exec(),
    );

    expect(result.modifiedCount).toBe(0);

    const original = await tenantItemModel.findOne({ tenantId: 'tenant-b' }).lean().exec();
    expect(original.name).toBe('target');
  });

  // =========================================================================
  // Test 21: findOneAndReplace is filtered
  // =========================================================================
  it('should not replace documents of other tenants via findOneAndReplace', async () => {
    await tenantItemModel.create({ name: 'target', tenantId: 'tenant-b' });

    const result = await runAsTenant('tenant-a', () =>
      tenantItemModel.findOneAndReplace({ name: 'target' }, { name: 'replaced', tenantId: 'tenant-a' }).lean().exec(),
    );

    expect(result).toBeNull();

    const original = await tenantItemModel.findOne({ tenantId: 'tenant-b' }).lean().exec();
    expect(original.name).toBe('target');
  });

  // =========================================================================
  // Test 22: distinct is filtered
  // =========================================================================
  it('should only return distinct values from own tenant', async () => {
    await tenantItemModel.create({ name: 'shared-name', tenantId: 'tenant-a' });
    await tenantItemModel.create({ name: 'unique-a', tenantId: 'tenant-a' });
    await tenantItemModel.create({ name: 'shared-name', tenantId: 'tenant-b' });
    await tenantItemModel.create({ name: 'unique-b', tenantId: 'tenant-b' });

    const names = await runAsTenant('tenant-a', () => tenantItemModel.distinct('name').exec());

    expect(names).toHaveLength(2);
    expect(names.sort()).toEqual(['shared-name', 'unique-a']);
  });

  // =========================================================================
  // Test 23: User without tenant creates document — no tenantId set
  // =========================================================================
  it('should not auto-set tenantId when user has no tenantId (save)', async () => {
    const doc = await runAsUserWithoutTenant(async () => {
      const item = new tenantItemModel({ name: 'no-tenant-item' });
      return item.save();
    });

    expect(doc.tenantId).toBeFalsy();
  });

  // =========================================================================
  // Test 24: User without tenant creates via insertMany — no tenantId set
  // =========================================================================
  it('should not auto-set tenantId when user has no tenantId (insertMany)', async () => {
    const docs = await runAsUserWithoutTenant(() => tenantItemModel.insertMany([{ name: 'no-tenant-bulk' }]));

    expect(docs[0].tenantId).toBeFalsy();
  });

  // =========================================================================
  // Test 25: Empty string tenantId treated as falsy (no filter applied)
  // =========================================================================
  it('should treat empty string tenantId as falsy (no filter)', async () => {
    await tenantItemModel.create({ name: 'assigned', tenantId: 'tenant-a' });
    await tenantItemModel.create({ name: 'unassigned', tenantId: null });

    const context: IRequestContext = {
      currentUser: { id: 'empty-tenant-user' },
      tenantId: '',
    };
    const items = await RequestContext.run(context, () => tenantItemModel.find().lean().exec());
    expect(items).toHaveLength(2);
  });

  // =========================================================================
  // Test 26: Public endpoint (no user) = no filter
  // =========================================================================
  it('should not filter when there is a context but no user (public endpoint)', async () => {
    await tenantItemModel.create({ name: 'a1', tenantId: 'tenant-a' });
    await tenantItemModel.create({ name: 'b1', tenantId: 'tenant-b' });

    const context: IRequestContext = {};
    const items = await RequestContext.run(context, () => tenantItemModel.find().lean().exec());
    expect(items).toHaveLength(2);
  });

  // =========================================================================
  // Test 26b: User with tenantIds (multiple memberships) sees only their workspaces
  // =========================================================================
  it('should filter by tenantIds ($in) when user has multiple tenant memberships', async () => {
    await tenantItemModel.create({ name: 'ws-a', tenantId: 'workspace-a' });
    await tenantItemModel.create({ name: 'ws-b', tenantId: 'workspace-b' });
    await tenantItemModel.create({ name: 'ws-c', tenantId: 'workspace-c' });

    const context: IRequestContext = {
      currentUser: { id: 'multi-ws-user' },
      tenantIds: ['workspace-a', 'workspace-b'],
    };
    const items = await RequestContext.run(context, () => tenantItemModel.find().lean().exec());
    expect(items).toHaveLength(2);
    expect(items.map((i: any) => i.name).sort()).toEqual(['ws-a', 'ws-b']);
  });

  // =========================================================================
  // Test 26c: User with empty tenantIds array sees no tenant-scoped data
  // =========================================================================
  it('should filter to no results when tenantIds is empty array', async () => {
    await tenantItemModel.create({ name: 'ws-a', tenantId: 'workspace-a' });

    const context: IRequestContext = {
      currentUser: { id: 'no-membership-user' },
      tenantIds: [],
    };
    const items = await RequestContext.run(context, () => tenantItemModel.find().lean().exec());
    expect(items).toHaveLength(0);
  });

  // =========================================================================
  // Test 26d: tenantId (single) takes precedence over tenantIds (array)
  // =========================================================================
  it('should use single tenantId over tenantIds when both are set', async () => {
    await tenantItemModel.create({ name: 'ws-a', tenantId: 'workspace-a' });
    await tenantItemModel.create({ name: 'ws-b', tenantId: 'workspace-b' });

    const context: IRequestContext = {
      currentUser: { id: 'both-set-user' },
      tenantId: 'workspace-a',
      tenantIds: ['workspace-a', 'workspace-b'],
    };
    const items = await RequestContext.run(context, () => tenantItemModel.find().lean().exec());
    expect(items).toHaveLength(1);
    expect((items[0] as any).name).toBe('ws-a');
  });

  // =========================================================================
  // Test 27: bulkWrite insertOne auto-sets tenantId
  // =========================================================================
  it('should auto-set tenantId on bulkWrite insertOne', async () => {
    await runAsTenant('tenant-a', () =>
      tenantItemModel.bulkWrite([{ insertOne: { document: { name: 'bulk-insert' } as any } }]),
    );

    const doc = await tenantItemModel.findOne({ name: 'bulk-insert' }).lean().exec();
    expect(doc).toBeTruthy();
    expect(doc.tenantId).toBe('tenant-a');
  });

  // =========================================================================
  // Test 28: bulkWrite updateOne is filtered by tenant
  // =========================================================================
  it('should not update other tenant documents via bulkWrite updateOne', async () => {
    await tenantItemModel.create({ name: 'target', tenantId: 'tenant-b' });

    await runAsTenant('tenant-a', () =>
      tenantItemModel.bulkWrite([{ updateOne: { filter: { name: 'target' }, update: { $set: { name: 'hacked' } } } }]),
    );

    const doc = await tenantItemModel.findOne({ tenantId: 'tenant-b' }).lean().exec();
    expect(doc.name).toBe('target');
  });

  // =========================================================================
  // Test 29: bulkWrite deleteOne is filtered by tenant
  // =========================================================================
  it('should not delete other tenant documents via bulkWrite deleteOne', async () => {
    await tenantItemModel.create({ name: 'protected', tenantId: 'tenant-b' });

    await runAsTenant('tenant-a', () => tenantItemModel.bulkWrite([{ deleteOne: { filter: { name: 'protected' } } }]));

    const doc = await tenantItemModel.findOne({ name: 'protected' }).lean().exec();
    expect(doc).toBeTruthy();
  });

  // =========================================================================
  // Test 30: bulkWrite deleteMany is filtered by tenant
  // =========================================================================
  it('should not delete other tenant documents via bulkWrite deleteMany', async () => {
    await tenantItemModel.create({ name: 'keep-1', tenantId: 'tenant-b' });
    await tenantItemModel.create({ name: 'keep-2', tenantId: 'tenant-b' });

    await runAsTenant('tenant-a', () =>
      tenantItemModel.bulkWrite([{ deleteMany: { filter: { name: { $regex: /^keep/ } } } }]),
    );

    const docs = await tenantItemModel.find({ tenantId: 'tenant-b' }).lean().exec();
    expect(docs).toHaveLength(2);
  });

  // =========================================================================
  // Test 31: bulkWrite replaceOne is filtered by tenant
  // =========================================================================
  it('should not replace other tenant documents via bulkWrite replaceOne', async () => {
    await tenantItemModel.create({ name: 'original', tenantId: 'tenant-b' });

    await runAsTenant('tenant-a', () =>
      tenantItemModel.bulkWrite([
        { replaceOne: { filter: { name: 'original' }, replacement: { name: 'replaced', tenantId: 'tenant-a' } } },
      ]),
    );

    const doc = await tenantItemModel.findOne({ tenantId: 'tenant-b' }).lean().exec();
    expect(doc.name).toBe('original');
  });
});

// =============================================================================
// Header-based tenantId tests (tenantId from X-Workspace-Id header)
// =============================================================================
describe('Multi-Tenancy Plugin — header-based tenantId (e2e)', () => {
  let tenantItemModel: Model<TenantItem>;
  let app: import('@nestjs/common').INestApplication;

  beforeAll(async () => {
    // Configure with defaults (header-based)
    new ConfigService({ multiTenancy: {} } as any);

    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [TestModule],
    }).compile();

    app = moduleFixture.createNestApplication();
    await app.init();

    tenantItemModel = moduleFixture.get<Model<TenantItem>>(getModelToken(TenantItem.name));
  });

  beforeEach(async () => {
    await tenantItemModel.deleteMany({});
  });

  afterAll(async () => {
    await tenantItemModel.deleteMany({});
    await app.close();
    // Restore default config
    new ConfigService({ multiTenancy: {} } as any);
  });

  it('should filter by tenantId set directly in RequestContext (simulates header)', async () => {
    await tenantItemModel.create({ name: 'ws-a', tenantId: 'workspace-a' });
    await tenantItemModel.create({ name: 'ws-b', tenantId: 'workspace-b' });

    // Simulate RequestContext with tenantId set from header
    const context: IRequestContext = {
      currentUser: { id: 'user-1' },
      tenantId: 'workspace-a',
    };

    const items = await RequestContext.run(context, () => tenantItemModel.find().lean().exec());
    expect(items).toHaveLength(1);
    expect(items[0].name).toBe('ws-a');
  });

  it('should not filter when no tenantId in context (no header)', async () => {
    await tenantItemModel.create({ name: 'ws-a', tenantId: 'workspace-a' });
    await tenantItemModel.create({ name: 'ws-b', tenantId: 'workspace-b' });

    // Context without tenantId = no tenant header sent
    const context: IRequestContext = {
      currentUser: { id: 'user-1' },
    };

    const items = await RequestContext.run(context, () => tenantItemModel.find().lean().exec());
    expect(items).toHaveLength(2);
  });
});

// =============================================================================
// Plugin disabled tests (separate describe to avoid ConfigService pollution)
// =============================================================================
describe('Multi-Tenancy Plugin Disabled (e2e)', () => {
  let tenantItemModel: Model<TenantItem>;
  let app: import('@nestjs/common').INestApplication;

  beforeAll(async () => {
    // ConfigService with multiTenancy disabled
    new ConfigService({ multiTenancy: { enabled: false } } as any);

    @Module({
      imports: [
        MongooseModule.forRoot('mongodb://127.0.0.1/nest-server-mt-disabled-test', {
          connectionFactory: (connection) => {
            // Plugin still registered globally, but config says disabled
            // The plugin itself checks tenantId field, but resolveTenantId reads config
            connection.plugin(mongooseTenantPlugin);
            return connection;
          },
        }),
        MongooseModule.forFeature([{ name: TenantItem.name, schema: TenantItemSchema }]),
      ],
    })
    class DisabledTestModule {}

    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [DisabledTestModule],
    }).compile();

    app = moduleFixture.createNestApplication();
    await app.init();

    tenantItemModel = moduleFixture.get<Model<TenantItem>>(getModelToken(TenantItem.name));
  });

  beforeEach(async () => {
    await tenantItemModel.deleteMany({});
  });

  afterAll(async () => {
    await tenantItemModel.deleteMany({});
    await app.close();
    // Reset ConfigService
    new ConfigService({} as any);
  });

  // =========================================================================
  // Test: Plugin registered but config disabled → no filtering
  // =========================================================================
  it('should not filter when multiTenancy config has enabled: false', async () => {
    await tenantItemModel.create({ name: 'a1', tenantId: 'tenant-a' });
    await tenantItemModel.create({ name: 'b1', tenantId: 'tenant-b' });

    // Even though we run as tenant-a, the feature is disabled via config
    const context: IRequestContext = {
      currentUser: { id: 'test-user' },
      tenantId: 'tenant-a',
    };
    const items = await RequestContext.run(context, () => tenantItemModel.find().lean().exec());
    expect(items).toHaveLength(2);
  });
});

// =============================================================================
// Mongoose Hook Coverage Safety Net
// Detects new hooks when Mongoose is upgraded, ensuring tenant plugin stays complete.
// =============================================================================
describe('Mongoose Hook Coverage Safety Net', () => {
  it('should cover all Mongoose data-access middleware hooks', () => {
    const typesDir = path.resolve(__dirname, '../node_modules/mongoose/types');
    const middlewareFile = fs.readFileSync(path.join(typesDir, 'middlewares.d.ts'), 'utf-8');
    const indexFile = fs.readFileSync(path.join(typesDir, 'index.d.ts'), 'utf-8');

    // Extract all hook names from Mongoose type definitions
    const hooks = new Set<string>();
    const NON_HOOKS = new Set(['mongoose', 'kareem']);

    // From middlewares.d.ts: all single-quoted strings in type unions (query + document hooks)
    for (const [, name] of middlewareFile.matchAll(/'(\w+)'/g)) {
      if (!NON_HOOKS.has(name)) hooks.add(name);
    }

    // From index.d.ts: model-level hooks (insertMany, bulkWrite, aggregate, etc.)
    for (const [, name] of indexFile.matchAll(/method:\s*'(\w+)'/g)) {
      hooks.add(name);
    }

    // Hooks covered by mongooseTenantPlugin
    const covered = new Set([
      // Query hooks
      'find',
      'findOne',
      'findOneAndUpdate',
      'findOneAndDelete',
      'findOneAndReplace',
      'countDocuments',
      'distinct',
      'updateOne',
      'updateMany',
      'deleteOne',
      'deleteMany',
      'replaceOne',
      // Document hooks
      'save',
      // Model hooks
      'insertMany',
      'bulkWrite',
      // Aggregate
      'aggregate',
    ]);

    // Hooks explicitly excluded (not relevant for tenant filtering)
    const excluded = new Set([
      'estimatedDocumentCount', // MongoDB limitation: uses collection metadata, cannot apply query filters
      'validate', // Document validation only, no data access or modification
      'createCollection', // DDL operation, no data access
      'init', // Post-load document hydration, document already loaded from DB
    ]);

    const allKnown = new Set([...covered, ...excluded]);
    const unknown = [...hooks].filter((h) => !allKnown.has(h));

    // If this fails after a Mongoose upgrade, review the new hook(s):
    // - If it accesses/modifies data: add pre hook to mongooseTenantPlugin + add to 'covered'
    // - If not relevant for tenant filtering: add to 'excluded' with justification
    expect(unknown).toEqual([]);
  });
});
