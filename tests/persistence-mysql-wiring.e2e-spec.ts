import {
  Body,
  Controller,
  Delete,
  Get,
  Inject,
  INestApplication,
  Injectable,
  Logger,
  Module,
  Param,
  Post,
  Put,
} from '@nestjs/common';
import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Test, TestingModule } from '@nestjs/testing';
import { createConnection } from 'mysql2/promise';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import {
  CoreCronJobs,
  CoreModule,
  CorePersistenceModel,
  CorePersistenceModule,
  CrudService,
  type DataStore,
  HttpExceptionLogFilter,
  InjectStore,
  JSON as JsonScalar,
  RequestContext,
  Restricted,
  RoleEnum,
  Roles,
  TestHelper,
  UnifiedField,
} from '../src';
import { CorePersistenceLifecycle } from '../src/core/common/persistence/core-persistence.lifecycle';
import { getPersistenceRuntime } from '../src/core/common/persistence/persistence-runtime.registry';
import type { MysqlVariant } from '../src/core/common/persistence/sql/mysql/mysql-session';
import { User, UserSchema } from '../src/server/modules/user/user.model';
import { createMysqlTestDatabase, type MysqlTestDatabase } from './helpers/mysql-test-db';

/**
 * A project on MySQL 8.4 / MariaDB 11.8 alone (plan phase 6), assembled the way a project uses it: `database` names the
 * default source with an owner connection, no MongoDB is configured, `CoreModule.forRoot()` opens the source, migrates
 * the schema as the owner and checks the application account, and a `CrudService` over `@InjectStore()` runs the whole
 * pipeline over REST. Tenant isolation is the application's on these databases, and the boot says so.
 */
@Schema({ collection: 'wiringOwners' })
class WiringOwner extends CorePersistenceModel {
  @UnifiedField({ isOptional: true, mongoose: { type: String } })
  name?: string = undefined;
}

@Restricted(RoleEnum.ADMIN)
@Schema({ collection: 'wiringProjects', timestamps: true })
class WiringProject extends CorePersistenceModel {
  @UnifiedField({ isOptional: true, mongoose: { type: Number }, roles: RoleEnum.S_EVERYONE })
  budget?: number = undefined;

  @UnifiedField({ isOptional: true, mongoose: { type: String, unique: true }, roles: RoleEnum.S_EVERYONE })
  name?: string = undefined;

  @UnifiedField({ isOptional: true, mongoose: { ref: 'WiringOwner', type: String }, roles: RoleEnum.S_EVERYONE })
  ownerId?: string = undefined;

  @UnifiedField({ isOptional: true, mongoose: { type: String }, roles: RoleEnum.ADMIN })
  secretNote?: string = undefined;
}

/** Single-use codes that expire a minute after they were issued */
@Schema({ collection: 'wiringCodes' })
class WiringCode extends CorePersistenceModel {
  @Prop({ type: String })
  code?: string;

  @Prop({ expires: 60, type: Date })
  issuedAt?: Date;
}

/** A tenant-scoped model: on MySQL / MariaDB only the store keeps tenants apart */
@Schema({ collection: 'wiringNotes' })
class WiringNote extends CorePersistenceModel {
  @Prop({ type: String })
  body?: string;

  @Prop({ type: String })
  tenantId?: string;
}

@Injectable()
class WiringProjectService extends CrudService<WiringProject> {
  constructor(@InjectStore('WiringProject') readonly store: DataStore<WiringProject>) {
    super({ dataStore: store, mainModelConstructor: WiringProject });
  }
}

@Injectable()
class WiringStores {
  constructor(
    @InjectStore('WiringCode') readonly codes: DataStore<any>,
    @InjectStore('WiringNote') readonly notes: DataStore<any>,
    @InjectStore('WiringOwner') readonly owners: DataStore<any>,
  ) {}
}

@Controller('wiring-projects')
@Roles(RoleEnum.S_EVERYONE)
class WiringProjectController {
  constructor(@Inject(WiringProjectService) readonly service: WiringProjectService) {}

  @Post()
  create(@Body() input: any) {
    return this.service.create(input, {});
  }

  @Delete(':id')
  delete(@Param('id') id: string) {
    return this.service.delete(id, {});
  }

  @Get(':id')
  get(@Param('id') id: string) {
    return this.service.get(id, {});
  }

  @Put(':id')
  update(@Param('id') id: string, @Body() input: any) {
    return this.service.update(id, input, {});
  }
}

for (const [variant, engine] of [
  ['mysql', 'kysely'],
  ['mariadb', 'drizzle'],
] as [MysqlVariant, string][]) {
  describe(`${variant} data source wired through CoreModule (e2e)`, () => {
    let database: MysqlTestDatabase;
    let app: INestApplication;
    let moduleRef: TestingModule;
    let testHelper: TestHelper;
    let service: WiringProjectService;
    let stores: WiringStores;
    let warnings: string[];

    const ownerQuery = async (text: string): Promise<any[]> => {
      const connection = await createConnection({ uri: database.ownerUrl.replace(/^mariadb:/, 'mysql:') });
      try {
        return (await connection.query(text))[0] as any[];
      } finally {
        await connection.end();
      }
    };

    beforeAll(async () => {
      database = await createMysqlTestDatabase(variant, 'mysql-wiring');
      warnings = [];
      vi.spyOn(Logger.prototype, 'warn').mockImplementation((message: any) => {
        warnings.push(String(message));
      });

      @Module({
        controllers: [WiringProjectController],
        imports: [
          CorePersistenceModule.forFeature([
            { name: 'WiringOwner', schema: SchemaFactory.createForClass(WiringOwner) },
            { name: 'WiringProject', schema: SchemaFactory.createForClass(WiringProject) },
            { name: 'WiringCode', schema: SchemaFactory.createForClass(WiringCode) },
            { name: 'WiringNote', schema: SchemaFactory.createForClass(WiringNote) },
          ]),
        ],
        providers: [WiringProjectService, WiringStores],
      })
      class WiringFeatureModule {}

      @Module({
        imports: [
          CoreModule.forRoot({
            betterAuth: false,
            database: { ownerUrl: database.ownerUrl, sqlEngine: engine, url: database.appUrl },
            env: 'test',
            graphQl: false,
            multiTenancy: {},
            port: 0,
          } as any),
          WiringFeatureModule,
        ],
        providers: [JsonScalar],
      })
      class WiringAppModule {}

      moduleRef = await Test.createTestingModule({ imports: [WiringAppModule] }).compile();
      app = moduleRef.createNestApplication();
      app.useGlobalFilters(new HttpExceptionLogFilter());
      await app.init();
      testHelper = new TestHelper(app);
      service = moduleRef.get(WiringProjectService);
      stores = moduleRef.get(WiringStores);
    });

    afterAll(async () => {
      vi.restoreAllMocks();
      await app?.close();
      await database?.drop();
    });

    it(`routes every model to ${variant} and connects no MongoDB`, () => {
      expect((service as any).dataStore.driver).toBe(variant);
      expect(stores.owners.driver).toBe(variant);
      expect(stores.owners.capabilities.rls).toBe(false);
    });

    it('migrated the schema as the owner, with the lease table, and granted the application rows only', async () => {
      const tables = (await ownerQuery('SHOW TABLES')).map((row) => Object.values(row)[0]).sort();
      expect(tables).toEqual(
        expect.arrayContaining(['lt_locks', 'wiring_codes', 'wiring_notes', 'wiring_owners', 'wiring_projects']),
      );
      const grants = await ownerQuery(
        `SELECT PRIVILEGE_TYPE AS privilege FROM information_schema.SCHEMA_PRIVILEGES
          WHERE GRANTEE LIKE '''nest_app''@%' AND TABLE_SCHEMA = DATABASE() ORDER BY PRIVILEGE_TYPE`,
      );
      expect(grants.map((row) => row.privilege)).toEqual(['DELETE', 'INSERT', 'SELECT', 'UPDATE']);
    });

    /**
     * @regression   DEV-3848 (db-agnostic phase 6) — MySQL and MariaDB have no row-level security; a project must
     *   learn at boot that native access to a tenant table is not stopped by the database.
     * @seen-failing Drop the application-only isolation warning from DataSourceRuntime.openStore() in
     *   src/core/common/persistence/data-source.runtime.ts — registered as mutation
     *   `mysql-isolation-warning-missing` in tests/regression-mutations.json.
     */
    it('says at boot, once, that tenant isolation is the application’s on this database', () => {
      const isolation = warnings.filter((message) => message.includes('has no row-level security'));
      expect(isolation).toHaveLength(1);
      expect(isolation[0]).toMatch(/must filter by tenantId itself/);
    });

    it('keeps tenants apart in the store, and refuses tenant data without a tenant context', async () => {
      await RequestContext.run({ fromRequest: true, tenantId: 'A' } as any, () => stores.notes.insert({ body: 'a' }));
      await RequestContext.run({ fromRequest: true, tenantId: 'B' } as any, () => stores.notes.insert({ body: 'b' }));
      const seen = await RequestContext.run({ fromRequest: true, tenantId: 'A' } as any, () => stores.notes.find());
      expect(seen.map((note) => note.body)).toEqual(['a']);
      await expect(
        RequestContext.run({ currentUser: { id: 'u1' }, fromRequest: true } as any, () => stores.notes.find()),
      ).rejects.toThrow(/Tenant/i);
    });

    it('creates, reads, updates and deletes over REST through the full pipeline', async () => {
      const created = await testHelper.rest('/wiring-projects', {
        method: 'POST',
        payload: { budget: 10, name: 'alpha', secretNote: 'admins only' },
        statusCode: 201,
      });
      expect(created.id).toMatch(/^[0-9a-f]{24}$/);
      expect(created).toMatchObject({ budget: 10, name: 'alpha' });
      expect(created.secretNote).toBeUndefined();

      const updated = await testHelper.rest(`/wiring-projects/${created.id}`, {
        method: 'PUT',
        payload: { budget: 20 },
        statusCode: 200,
      });
      expect(updated).toMatchObject({ budget: 20, name: 'alpha' });

      await testHelper.rest(`/wiring-projects/${created.id}`, { method: 'DELETE', statusCode: 200 });
      await testHelper.rest(`/wiring-projects/${created.id}`, { statusCode: 404 });
    });

    it('answers a malformed id with 404 and a duplicate unique value with 400, as on MongoDB', async () => {
      await testHelper.rest('/wiring-projects/not-an-id', { statusCode: 404 });
      await testHelper.rest('/wiring-projects', { method: 'POST', payload: { name: 'twice' }, statusCode: 201 });
      await testHelper.rest('/wiring-projects', { method: 'POST', payload: { name: 'twice' }, statusCode: 400 });
    });

    it('finds, pages and populates through the CrudService', async () => {
      const owner = await stores.owners.insert({ name: 'owner' });
      for (const [name, budget] of [
        ['p1', 1],
        ['p2', 2],
        ['p3', 3],
      ] as const) {
        await service.create({ budget, name, ownerId: owner.id }, {});
      }
      const page = await service.findAndCount(
        {
          filterQuery: { name: { $in: ['p1', 'p2', 'p3'] } },
          queryOptions: { limit: 2, skip: 1, sort: { budget: 1 } },
        },
        {},
      );
      expect(page.totalCount).toBe(3);
      expect(page.items.map((item) => item.name)).toEqual(['p2', 'p3']);
      const populated: any = await service.get(page.items[0].id, { populate: ['ownerId'] });
      expect(populated.ownerId).toMatchObject({ id: owner.id, name: 'owner' });
    });

    it('dedupes a cron tick between two replicas in the lease table of the default source', async () => {
      class ReplicaCronJobs extends CoreCronJobs {
        constructor() {
          super({} as any, {}, {});
        }
        lease(name: string, fireTime: Date): Promise<boolean> {
          return this.acquireLease(name, fireTime);
        }
      }
      const tick = new Date('2026-10-28T10:00:00.000Z');
      const results = await Promise.all([
        new ReplicaCronJobs().lease('wiring-job', tick),
        new ReplicaCronJobs().lease('wiring-job', tick),
      ]);
      expect(results.filter(Boolean)).toHaveLength(1);
      const rows = await ownerQuery(`SELECT id FROM lt_locks WHERE id LIKE 'cron:wiring-job:%'`);
      expect(rows.map((row) => row.id)).toEqual([`cron:wiring-job:${tick.toISOString()}`]);
    });

    it('removes the expired rows of TTL models in the sweep', async () => {
      const expired = await stores.codes.insert({ code: 'expired', issuedAt: new Date(Date.now() - 120_000) });
      const live = await stores.codes.insert({ code: 'live', issuedAt: new Date() });
      await (moduleRef.get(CorePersistenceLifecycle) as any).expirySweep.runNow();
      expect(await stores.codes.findById(expired.id)).toBeNull();
      expect(await stores.codes.findById(live.id)).not.toBeNull();
    });

    it('answers the health ping of the source', async () => {
      const sources = getPersistenceRuntime()!.sqlSources();
      expect(sources.map((source) => source.name)).toEqual(['default']);
      await expect(sources[0].ping()).resolves.toBeUndefined();
    });
  });
}

describe('Better-Auth on a MySQL source (e2e)', () => {
  let database: MysqlTestDatabase;

  beforeAll(async () => {
    database = await createMysqlTestDatabase('mysql', 'mysql-iam');
  });

  afterAll(async () => {
    await database?.drop();
  });

  /**
   * @regression   DEV-3848 (db-agnostic phase 6) — Better-Auth's adapter is not wired for MySQL / MariaDB yet; with the
   *   user model routed there it must refuse at boot, not fall back to a MongoDB that holds no users.
   * @seen-failing Drop the MySQL refusal from DataSourceRuntime.iamStorage() in
   *   src/core/common/persistence/data-source.runtime.ts — registered as mutation `mysql-iam-not-refused` in
   *   tests/regression-mutations.json.
   */
  it('refuses to boot while the user model lives on MySQL', async () => {
    vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    @Module({ imports: [CorePersistenceModule.forFeature([{ model: User, name: User.name, schema: UserSchema }])] })
    class UserFeature {}

    @Module({
      imports: [
        CoreModule.forRoot({
          betterAuth: {
            basePath: '/iam',
            baseUrl: 'http://localhost:3999',
            secret: 'TEST_BETTERAUTH_SECRET_32_CHARS_MIN',
          },
          database: { ownerUrl: database.ownerUrl, url: database.appUrl },
          env: 'test',
          graphQl: false,
          port: 0,
        } as any),
        UserFeature,
      ],
    })
    class IamAppModule {}

    let app: INestApplication | undefined;
    const boot = async () => {
      const moduleRef = await Test.createTestingModule({ imports: [IamAppModule] }).compile();
      app = moduleRef.createNestApplication();
      await app.init();
    };
    try {
      await expect(boot()).rejects.toThrow(/Better-Auth cannot run on MySQL yet/);
    } finally {
      await app?.close().catch(() => undefined);
      vi.restoreAllMocks();
    }
  });
});
