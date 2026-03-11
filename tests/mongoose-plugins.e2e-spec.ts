import * as fs from 'fs';
import * as path from 'path';

import { Module } from '@nestjs/common';
import { MongooseModule, Prop, Schema, SchemaFactory, getModelToken } from '@nestjs/mongoose';
import { Test, TestingModule } from '@nestjs/testing';
import { Model } from 'mongoose';

import { RoleEnum } from '../src/core/common/enums/role.enum';
import { mongooseAuditFieldsPlugin } from '../src/core/common/plugins/mongoose-audit-fields.plugin';
import { hashPassword, mongoosePasswordPlugin } from '../src/core/common/plugins/mongoose-password.plugin';
import { mongooseRoleGuardPlugin } from '../src/core/common/plugins/mongoose-role-guard.plugin';
import { ConfigService } from '../src/core/common/services/config.service';
import { IRequestContext, RequestContext } from '../src/core/common/services/request-context.service';

// =============================================================================
// Test Schema: PluginTestUser (has password, roles, createdBy, updatedBy)
// =============================================================================
@Schema({ timestamps: true })
class PluginTestUser {
  @Prop({ type: String })
  email: string;

  @Prop({ type: String })
  password: string;

  @Prop({ type: [String], default: [] })
  roles: string[];

  @Prop({ type: String })
  createdBy: string;

  @Prop({ type: String })
  updatedBy: string;
}

const PluginTestUserSchema = SchemaFactory.createForClass(PluginTestUser);

// =============================================================================
// Test Module
// =============================================================================
const TEST_DB_URI = 'mongodb://127.0.0.1/nest-server-plugins-test';

@Module({
  imports: [
    MongooseModule.forRoot(TEST_DB_URI, {
      connectionFactory: (connection) => {
        connection.plugin(mongoosePasswordPlugin);
        connection.plugin(mongooseRoleGuardPlugin);
        connection.plugin(mongooseAuditFieldsPlugin);
        return connection;
      },
    }),
    MongooseModule.forFeature([{ name: PluginTestUser.name, schema: PluginTestUserSchema }]),
  ],
})
class PluginsTestModule {}

// =============================================================================
// Helpers
// =============================================================================
function runAsAdmin<T>(fn: () => T): T {
  const context: IRequestContext = {
    currentUser: {
      id: 'admin-user',
      roles: [RoleEnum.ADMIN],
      hasRole: (r) => r.includes(RoleEnum.ADMIN),
    },
  };
  return RequestContext.run(context, fn);
}

function runAsRegularUser<T>(fn: () => T): T {
  const context: IRequestContext = {
    currentUser: { id: 'regular-user', roles: ['user'], hasRole: () => false },
  };
  return RequestContext.run(context, fn);
}

function runWithoutContext<T>(fn: () => T): T {
  return fn();
}

function isBcryptHash(value: string): boolean {
  return /^\$2[aby]\$\d+\$/.test(value);
}

// =============================================================================
// Password Plugin Tests
// =============================================================================
describe('mongoosePasswordPlugin — bulk operations (e2e)', () => {
  let userModel: Model<PluginTestUser>;
  let app: import('@nestjs/common').INestApplication;

  beforeAll(async () => {
    new ConfigService({} as any);
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [PluginsTestModule],
    }).compile();
    app = moduleFixture.createNestApplication();
    await app.init();
    userModel = moduleFixture.get<Model<PluginTestUser>>(getModelToken(PluginTestUser.name));
  });

  beforeEach(async () => {
    await userModel.deleteMany({});
  });

  afterAll(async () => {
    await userModel.deleteMany({});
    await app.close();
  });

  it('should hash passwords on insertMany', async () => {
    await userModel.insertMany([
      { email: 'a@test.com', password: 'plaintext1' },
      { email: 'b@test.com', password: 'plaintext2' },
    ]);

    const docs = await userModel.find().lean().exec();
    expect(docs).toHaveLength(2);
    for (const doc of docs) {
      expect(isBcryptHash(doc.password)).toBe(true);
      expect(doc.password).not.toBe('plaintext1');
      expect(doc.password).not.toBe('plaintext2');
    }
  });

  it('should hash passwords on bulkWrite insertOne', async () => {
    await userModel.bulkWrite([
      { insertOne: { document: { email: 'bulk@test.com', password: 'secret' } as any } },
    ]);

    const doc = await userModel.findOne({ email: 'bulk@test.com' }).lean().exec();
    expect(isBcryptHash(doc.password)).toBe(true);
  });

  it('should hash passwords on bulkWrite updateOne', async () => {
    const oldHash = await hashPassword('old');
    await userModel.create({ email: 'target@test.com', password: oldHash });

    await userModel.bulkWrite([
      { updateOne: { filter: { email: 'target@test.com' }, update: { $set: { password: 'newplain' } } } },
    ]);

    const doc = await userModel.findOne({ email: 'target@test.com' }).lean().exec();
    expect(isBcryptHash(doc.password)).toBe(true);
    // Verify it's a different hash than the old one
    expect(doc.password).not.toBe(oldHash);
  });

  it('should hash passwords on bulkWrite replaceOne', async () => {
    await userModel.create({ email: 'replace@test.com', password: await hashPassword('old') });

    await userModel.bulkWrite([
      {
        replaceOne: {
          filter: { email: 'replace@test.com' },
          replacement: { email: 'replace@test.com', password: 'newpassword' } as any,
        },
      },
    ]);

    const doc = await userModel.findOne({ email: 'replace@test.com' }).lean().exec();
    expect(isBcryptHash(doc.password)).toBe(true);
  });

  it('should hash passwords on replaceOne', async () => {
    await userModel.create({ email: 'rep@test.com', password: await hashPassword('old') });

    await userModel.replaceOne({ email: 'rep@test.com' }, { email: 'rep@test.com', password: 'newplain' }).exec();

    const doc = await userModel.findOne({ email: 'rep@test.com' }).lean().exec();
    expect(isBcryptHash(doc.password)).toBe(true);
  });

  it('should hash passwords on findOneAndReplace', async () => {
    await userModel.create({ email: 'far@test.com', password: await hashPassword('old') });

    await userModel
      .findOneAndReplace({ email: 'far@test.com' }, { email: 'far@test.com', password: 'newplain' })
      .exec();

    const doc = await userModel.findOne({ email: 'far@test.com' }).lean().exec();
    expect(isBcryptHash(doc.password)).toBe(true);
  });
});

// =============================================================================
// Role Guard Plugin Tests
// =============================================================================
describe('mongooseRoleGuardPlugin — bulk operations (e2e)', () => {
  let userModel: Model<PluginTestUser>;
  let app: import('@nestjs/common').INestApplication;

  beforeAll(async () => {
    new ConfigService({} as any);
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [PluginsTestModule],
    }).compile();
    app = moduleFixture.createNestApplication();
    await app.init();
    userModel = moduleFixture.get<Model<PluginTestUser>>(getModelToken(PluginTestUser.name));
  });

  beforeEach(async () => {
    await userModel.deleteMany({});
  });

  afterAll(async () => {
    await userModel.deleteMany({});
    await app.close();
  });

  it('should strip roles from insertMany when user is not admin', async () => {
    await runAsRegularUser(() =>
      userModel.insertMany([
        { email: 'a@test.com', roles: [RoleEnum.ADMIN] },
        { email: 'b@test.com', roles: [RoleEnum.ADMIN, 'MODERATOR'] },
      ]),
    );

    const docs = await userModel.find().lean().exec();
    for (const doc of docs) {
      expect(doc.roles).toEqual([]);
    }
  });

  it('should allow roles on insertMany when user is admin', async () => {
    await runAsAdmin(() =>
      userModel.insertMany([{ email: 'a@test.com', roles: [RoleEnum.ADMIN] }]),
    );

    const doc = await userModel.findOne({ email: 'a@test.com' }).lean().exec();
    expect(doc.roles).toEqual([RoleEnum.ADMIN]);
  });

  it('should allow roles on insertMany when no user context (system op)', async () => {
    await runWithoutContext(() =>
      userModel.insertMany([{ email: 'sys@test.com', roles: [RoleEnum.ADMIN] }]),
    );

    const doc = await userModel.findOne({ email: 'sys@test.com' }).lean().exec();
    expect(doc.roles).toEqual([RoleEnum.ADMIN]);
  });

  it('should strip roles from bulkWrite insertOne when user is not admin', async () => {
    await runAsRegularUser(() =>
      userModel.bulkWrite([
        { insertOne: { document: { email: 'bw@test.com', roles: [RoleEnum.ADMIN] } as any } },
      ]),
    );

    const doc = await userModel.findOne({ email: 'bw@test.com' }).lean().exec();
    expect(doc.roles).toEqual([]);
  });

  it('should strip roles from bulkWrite updateOne when user is not admin', async () => {
    await userModel.create({ email: 'target@test.com', roles: [] });

    await runAsRegularUser(() =>
      userModel.bulkWrite([
        { updateOne: { filter: { email: 'target@test.com' }, update: { $set: { roles: [RoleEnum.ADMIN] } } } },
      ]),
    );

    const doc = await userModel.findOne({ email: 'target@test.com' }).lean().exec();
    expect(doc.roles).toEqual([]);
  });

  it('should strip roles from bulkWrite replaceOne when user is not admin', async () => {
    await userModel.create({ email: 'rep@test.com', roles: [] });

    await runAsRegularUser(() =>
      userModel.bulkWrite([
        {
          replaceOne: {
            filter: { email: 'rep@test.com' },
            replacement: { email: 'rep@test.com', roles: [RoleEnum.ADMIN] } as any,
          },
        },
      ]),
    );

    const doc = await userModel.findOne({ email: 'rep@test.com' }).lean().exec();
    expect(doc.roles).not.toContain(RoleEnum.ADMIN);
  });

  it('should strip roles from replaceOne when user is not admin', async () => {
    await userModel.create({ email: 'r@test.com', roles: [] });

    await runAsRegularUser(() =>
      userModel.replaceOne({ email: 'r@test.com' }, { email: 'r@test.com', roles: [RoleEnum.ADMIN] }).exec(),
    );

    const doc = await userModel.findOne({ email: 'r@test.com' }).lean().exec();
    expect(doc.roles).not.toContain(RoleEnum.ADMIN);
  });

  it('should strip roles from findOneAndReplace when user is not admin', async () => {
    await userModel.create({ email: 'fr@test.com', roles: [] });

    await runAsRegularUser(() =>
      userModel.findOneAndReplace({ email: 'fr@test.com' }, { email: 'fr@test.com', roles: [RoleEnum.ADMIN] }).exec(),
    );

    const doc = await userModel.findOne({ email: 'fr@test.com' }).lean().exec();
    expect(doc.roles).not.toContain(RoleEnum.ADMIN);
  });

  it('should allow roles via bypassRoleGuard on insertMany', async () => {
    await runAsRegularUser(() =>
      RequestContext.runWithBypassRoleGuard(() =>
        userModel.insertMany([{ email: 'bypass@test.com', roles: [RoleEnum.ADMIN] }]),
      ),
    );

    const doc = await userModel.findOne({ email: 'bypass@test.com' }).lean().exec();
    expect(doc.roles).toEqual([RoleEnum.ADMIN]);
  });
});

// =============================================================================
// Audit Fields Plugin Tests
// =============================================================================
describe('mongooseAuditFieldsPlugin — bulk operations (e2e)', () => {
  let userModel: Model<PluginTestUser>;
  let app: import('@nestjs/common').INestApplication;

  beforeAll(async () => {
    new ConfigService({} as any);
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [PluginsTestModule],
    }).compile();
    app = moduleFixture.createNestApplication();
    await app.init();
    userModel = moduleFixture.get<Model<PluginTestUser>>(getModelToken(PluginTestUser.name));
  });

  beforeEach(async () => {
    await userModel.deleteMany({});
  });

  afterAll(async () => {
    await userModel.deleteMany({});
    await app.close();
  });

  it('should set createdBy and updatedBy on insertMany', async () => {
    await runAsRegularUser(() =>
      userModel.insertMany([
        { email: 'a@test.com' },
        { email: 'b@test.com' },
      ]),
    );

    const docs = await userModel.find().lean().exec();
    for (const doc of docs) {
      expect(doc.createdBy).toBe('regular-user');
      expect(doc.updatedBy).toBe('regular-user');
    }
  });

  it('should not overwrite explicit createdBy on insertMany', async () => {
    await runAsRegularUser(() =>
      userModel.insertMany([{ email: 'explicit@test.com', createdBy: 'system' }]),
    );

    const doc = await userModel.findOne({ email: 'explicit@test.com' }).lean().exec();
    expect(doc.createdBy).toBe('system');
    expect(doc.updatedBy).toBe('regular-user');
  });

  it('should set createdBy and updatedBy on bulkWrite insertOne', async () => {
    await runAsRegularUser(() =>
      userModel.bulkWrite([
        { insertOne: { document: { email: 'bw@test.com' } as any } },
      ]),
    );

    const doc = await userModel.findOne({ email: 'bw@test.com' }).lean().exec();
    expect(doc.createdBy).toBe('regular-user');
    expect(doc.updatedBy).toBe('regular-user');
  });

  it('should set updatedBy on bulkWrite updateOne', async () => {
    await userModel.create({ email: 'target@test.com' });

    await runAsAdmin(() =>
      userModel.bulkWrite([
        { updateOne: { filter: { email: 'target@test.com' }, update: { $set: { email: 'updated@test.com' } } } },
      ]),
    );

    const doc = await userModel.findOne({ email: 'updated@test.com' }).lean().exec();
    expect(doc.updatedBy).toBe('admin-user');
  });

  it('should set updatedBy on bulkWrite replaceOne', async () => {
    await userModel.create({ email: 'rep@test.com' });

    await runAsAdmin(() =>
      userModel.bulkWrite([
        {
          replaceOne: {
            filter: { email: 'rep@test.com' },
            replacement: { email: 'replaced@test.com' } as any,
          },
        },
      ]),
    );

    const doc = await userModel.findOne({ email: 'replaced@test.com' }).lean().exec();
    expect(doc.updatedBy).toBe('admin-user');
    expect(doc.createdBy).toBe('admin-user');
  });

  it('should set updatedBy on replaceOne', async () => {
    await userModel.create({ email: 'r@test.com' });

    await runAsAdmin(() =>
      userModel.replaceOne({ email: 'r@test.com' }, { email: 'r@test.com' }).exec(),
    );

    const doc = await userModel.findOne({ email: 'r@test.com' }).lean().exec();
    expect(doc.updatedBy).toBe('admin-user');
  });

  it('should set updatedBy on findOneAndReplace', async () => {
    await userModel.create({ email: 'fr@test.com' });

    await runAsAdmin(() =>
      userModel.findOneAndReplace({ email: 'fr@test.com' }, { email: 'fr@test.com' }).exec(),
    );

    const doc = await userModel.findOne({ email: 'fr@test.com' }).lean().exec();
    expect(doc.updatedBy).toBe('admin-user');
  });

  it('should not set audit fields when there is no user context', async () => {
    await runWithoutContext(() =>
      userModel.insertMany([{ email: 'sys@test.com' }]),
    );

    const doc = await userModel.findOne({ email: 'sys@test.com' }).lean().exec();
    expect(doc.createdBy).toBeUndefined();
    expect(doc.updatedBy).toBeUndefined();
  });
});

// =============================================================================
// Mongoose Hook Coverage Safety Net (all security plugins)
// =============================================================================
describe('Mongoose Security Plugins — Hook Coverage Safety Net', () => {
  it('should cover all Mongoose write-path hooks in password, role-guard, and audit-fields plugins', () => {
    const typesDir = path.resolve(__dirname, '../node_modules/mongoose/types');
    const middlewareFile = fs.readFileSync(path.join(typesDir, 'middlewares.d.ts'), 'utf-8');
    const indexFile = fs.readFileSync(path.join(typesDir, 'index.d.ts'), 'utf-8');

    // Extract all hook names from Mongoose type definitions
    const allHooks = new Set<string>();
    const NON_HOOKS = new Set(['mongoose', 'kareem']);

    for (const [, name] of middlewareFile.matchAll(/'(\w+)'/g)) {
      if (!NON_HOOKS.has(name)) allHooks.add(name);
    }
    for (const [, name] of indexFile.matchAll(/method:\s*'(\w+)'/g)) {
      allHooks.add(name);
    }

    // Write-path hooks that security plugins MUST cover
    const writePathCovered = new Set([
      // All three plugins cover these:
      'save', 'findOneAndUpdate', 'updateOne', 'updateMany',
      'replaceOne', 'findOneAndReplace', 'insertMany', 'bulkWrite',
    ]);

    // Hooks that are read-only or not relevant for security plugins
    const readOrIrrelevant = new Set([
      'find', 'findOne',                  // Read-only queries
      'findOneAndDelete',                 // Delete (no password/roles/audit in deletion)
      'countDocuments',                   // Read-only count
      'estimatedDocumentCount',           // Read-only estimate
      'distinct',                         // Read-only distinct values
      'deleteOne', 'deleteMany',          // Deletes don't need password/roles/audit
      'aggregate',                        // Read-only aggregation
      'validate',                         // Validation only
      'createCollection',                 // DDL operation
      'init',                             // Post-load hydration
    ]);

    const allKnown = new Set([...writePathCovered, ...readOrIrrelevant]);
    const unknown = [...allHooks].filter((h) => !allKnown.has(h));

    // If this fails after a Mongoose upgrade, review the new hook(s):
    // - If it can write data (insert/update/replace): add to all security plugins
    // - If read-only or irrelevant: add to readOrIrrelevant set
    expect(unknown).toEqual([]);
  });
});
