import {
  Body,
  Controller,
  Delete,
  Get,
  Inject,
  INestApplication,
  Injectable,
  Module,
  Param,
  Post,
  Put,
} from '@nestjs/common';
import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Test, TestingModule } from '@nestjs/testing';
import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  CoreModule,
  CorePersistenceModel,
  CorePersistenceModule,
  CrudService,
  type DataStore,
  HttpExceptionLogFilter,
  InjectStore,
  JSON as JsonScalar,
  PersistedModel,
  Restricted,
  RoleEnum,
  Roles,
  TestHelper,
  UnifiedField,
  UnsupportedCapabilityError,
} from '../src';
import { deriveTestDbUri } from './db-lifecycle.reporter';
import { createPostgresTestDatabase, type PostgresTestDatabase } from './helpers/postgres-test-db';

/**
 * The SQL data source assembled the way a project uses it (plan §3.9): `database` names a PostgreSQL default with an
 * owner connection, `CoreModule.forRoot()` opens it, migrates the schema and checks the application role, models
 * registered with `CorePersistenceModule.forFeature()` are routed by configuration > `@PersistedModel` > default,
 * and a `CrudService` over `@InjectStore()` runs the whole pipeline on plain records — rights, output filtering,
 * populate, the cast-error filter — over REST.
 */
@Schema({ collection: 'wiringOwners' })
class WiringOwner extends CorePersistenceModel {
  @UnifiedField({ isOptional: true, mongoose: { type: String } })
  name?: string = undefined;
}

// Restricted like a real model (the user model does the same): `CorePersistenceModel` grants S_EVERYONE on the class,
// and with `mergeRoles` a field restriction is OR-ed with the class roles — without this, `@Restricted(ADMIN)` on
// `secretNote` would grant everyone
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

/** Declares the `archive` source in code; the configuration moves it to MongoDB */
@PersistedModel({ dataSource: 'archive' })
@Schema({ collection: 'wiringArchive' })
class WiringArchive extends CorePersistenceModel {
  @Prop({ type: String })
  label?: string;
}

/** Declares MongoDB in code and is registered WITHOUT `model:` — the declaration is found by the class name */
@PersistedModel({ dataSource: 'mongoose' })
@Schema({ collection: 'wiringLedger' })
class WiringLedger extends CorePersistenceModel {
  @Prop({ type: String })
  entry?: string;
}

@Injectable()
class WiringProjectService extends CrudService<WiringProject> {
  constructor(@InjectStore('WiringProject') readonly store: DataStore<WiringProject>) {
    super({ dataStore: store, mainModelConstructor: WiringProject });
  }
}

/** The same model routed to MongoDB by configuration — the reference every SQL answer is compared with */
@Injectable()
class WiringMongoProjectService extends CrudService<WiringProject> {
  constructor(@InjectStore('WiringMongoProject') readonly store: DataStore<WiringProject>) {
    super({ dataStore: store, mainModelConstructor: WiringProject });
  }
}

@Injectable()
class WiringStores {
  constructor(
    @InjectStore('WiringArchive') readonly archive: DataStore<any>,
    @InjectStore('WiringLedger') readonly ledger: DataStore<any>,
    @InjectStore('WiringOwner') readonly owners: DataStore<any>,
  ) {}
}

function crudController(path: string, serviceType: new (...args: any[]) => CrudService<WiringProject>) {
  @Controller(path)
  @Roles(RoleEnum.S_EVERYONE)
  class WiringController {
    constructor(@Inject(serviceType) readonly service: CrudService<WiringProject>) {}

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
  return WiringController;
}

const WiringProjectController = crudController('wiring-projects', WiringProjectService);
const WiringMongoProjectController = crudController('wiring-mongo-projects', WiringMongoProjectService);

describe('SQL data source wired through CoreModule (e2e)', () => {
  let database: PostgresTestDatabase;
  let app: INestApplication;
  let moduleRef: TestingModule;
  let testHelper: TestHelper;
  let service: WiringProjectService;
  let stores: WiringStores;

  beforeAll(async () => {
    database = await createPostgresTestDatabase('sql-wiring');

    @Module({
      controllers: [WiringProjectController, WiringMongoProjectController],
      imports: [
        CorePersistenceModule.forFeature([
          { name: 'WiringOwner', schema: SchemaFactory.createForClass(WiringOwner) },
          { name: 'WiringProject', schema: SchemaFactory.createForClass(WiringProject) },
          { name: 'WiringMongoProject', schema: SchemaFactory.createForClass(WiringProject) },
          { model: WiringArchive, name: 'WiringArchive', schema: SchemaFactory.createForClass(WiringArchive) },
          { name: 'WiringLedger', schema: SchemaFactory.createForClass(WiringLedger) },
        ]),
      ],
      providers: [WiringMongoProjectService, WiringProjectService, WiringStores],
    })
    class WiringFeatureModule {}

    @Module({
      imports: [
        CoreModule.forRoot({
          betterAuth: {
            autoRegister: true,
            basePath: '/iam',
            baseUrl: `http://localhost:${3200 + Math.floor(Math.random() * 100)}`,
            secret: 'TEST_BETTERAUTH_SECRET_32_CHARS_MIN',
          },
          database: {
            models: { WiringArchive: 'mongoose', WiringMongoProject: 'mongoose' },
            ownerUrl: database.ownerUrl,
            sources: { archive: database.appUrl },
            url: database.appUrl,
          },
          env: 'test',
          graphQl: { driver: { introspection: true }, maxComplexity: 1000 },
          mongoose: { uri: deriveTestDbUri('sql-wiring') },
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
    await app?.close();
    await database?.drop();
  });

  /**
   * @regression   DEV-3829 (db-agnostic phase 1) — a store resolved without the data-source routing serves a model
   *   configured for PostgreSQL from MongoDB.
   * @seen-failing Return the Mongoose store for every model in DataSourceRuntime.resolveStore() in
   *   src/core/common/persistence/data-source.runtime.ts — registered as mutation `sql-runtime-ignores-routing` in
   *   tests/regression-mutations.json.
   */
  it('routes by configuration > @PersistedModel > default', () => {
    expect((service as any).dataStore.driver).toBe('postgres');
    expect((moduleRef.get(WiringMongoProjectService) as any).dataStore.driver).toBe('mongodb');
    expect(stores.owners.driver).toBe('postgres');
    // Declared `archive` in code, moved to MongoDB by `database.models`
    expect(stores.archive.driver).toBe('mongodb');
  });

  /**
   * @regression   DEV-3829 (db-agnostic phase 1, review) — `@PersistedModel` was read only from the class passed as
   *   `model:`; registered the usual way (`{ name, schema }`), the declaration did nothing and the model landed on
   *   the default source.
   * @seen-failing Drop the getPersistedModelOptionsByName() fallback in CorePersistenceModule.forFeature() in
   *   src/core/common/persistence/core-persistence.module.ts — registered as mutation
   *   `persisted-model-needs-model-option` in tests/regression-mutations.json.
   */
  it('reads @PersistedModel by the class name when the registration does not pass the class', () => {
    expect(stores.ledger.driver).toBe('mongodb');
  });

  /**
   * @regression   DEV-3829 (db-agnostic phase 1, review) — the owner (table-owning) connection must not outlive the
   *   boot: released once the application is bootstrapped, not held until shutdown.
   * @seen-failing Drop the releaseBootConnections() call from CorePersistenceLifecycle.onApplicationBootstrap() in
   *   src/core/common/persistence/core-persistence.lifecycle.ts — registered as mutation
   *   `sql-owner-held-after-boot` in tests/regression-mutations.json.
   */
  it('migrated the schema as the owner, with the lease table and a unique index', async () => {
    const owner = new Client({ connectionString: database.ownerUrl });
    await owner.connect();
    try {
      const { rows } = await owner.query(
        'SELECT tablename, tableowner FROM pg_tables WHERE schemaname = current_schema() ORDER BY tablename',
      );
      expect(rows.map((row) => row.tablename)).toEqual(['lt_locks', 'wiring_owners', 'wiring_projects']);
      expect(new Set(rows.map((row) => row.tableowner))).toEqual(new Set([new URL(database.ownerUrl).username]));

      // The owner connection only lives for the boot: released once the application is bootstrapped
      let lingering = -1;
      for (let attempt = 0; attempt < 20 && lingering !== 0; attempt++) {
        const activity = await owner.query(
          "SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname = current_database() AND application_name = 'nest-server-schema'",
        );
        lingering = activity.rows[0].n;
        if (lingering) {
          await new Promise((resolve) => setTimeout(resolve, 100));
        }
      }
      expect(lingering).toBe(0);
    } finally {
      await owner.end();
    }
  });

  it('answers a restricted field exactly as MongoDB does', async () => {
    const answers = [];
    for (const path of ['/wiring-mongo-projects', '/wiring-projects']) {
      const created = await testHelper.rest(path, {
        method: 'POST',
        payload: { name: `restricted${path.length}`, secretNote: 'admins only' },
        statusCode: 201,
      });
      answers.push({
        created: created.secretNote,
        read: (await testHelper.rest(`${path}/${created.id}`, { statusCode: 200 })).secretNote,
      });
    }
    expect(answers[0]).toEqual({ created: undefined, read: undefined });
    expect(answers[1]).toEqual(answers[0]);
  });

  it('creates, reads, updates and deletes over REST through the full pipeline', async () => {
    const created = await testHelper.rest('/wiring-projects', {
      method: 'POST',
      payload: { budget: 10, name: 'alpha' },
      statusCode: 201,
    });
    expect(created.id).toMatch(/^[0-9a-f]{24}$/);
    expect(created).toMatchObject({ budget: 10, name: 'alpha' });

    const read = await testHelper.rest(`/wiring-projects/${created.id}`, { statusCode: 200 });
    expect(read).toMatchObject({ budget: 10, id: created.id, name: 'alpha' });

    const updated = await testHelper.rest(`/wiring-projects/${created.id}`, {
      method: 'PUT',
      payload: { budget: 20 },
      statusCode: 200,
    });
    expect(updated).toMatchObject({ budget: 20, name: 'alpha' });

    await testHelper.rest(`/wiring-projects/${created.id}`, { method: 'DELETE', statusCode: 200 });
    await testHelper.rest(`/wiring-projects/${created.id}`, { statusCode: 404 });
  });

  /**
   * @regression   DEV-3829 (db-agnostic phase 1, review) — CrudService.update() merges `updatedBy` into every update
   *   with a current user; on a model without that field the SQL store refused the path and the update answered 500,
   *   where MongoDB's strict mode drops it.
   * @seen-failing Drop the dropUndeclared() call from SqlDataStore.updateById() in
   *   src/core/common/persistence/sql/sql-data-store.ts — registered as mutation `sql-update-keeps-undeclared` in
   *   tests/regression-mutations.json.
   */
  it('drops undeclared fields of an update with a current user, as MongoDB does', async () => {
    const currentUser = { id: '651f00010203040506070809', roles: [RoleEnum.ADMIN] } as any;
    const answers = [];
    for (const target of [service, moduleRef.get(WiringMongoProjectService)] as CrudService<WiringProject>[]) {
      const created = await target.create({ budget: -1, name: `undeclared-${answers.length}` }, { currentUser });
      const updated: any = await target.update(created.id, { budget: -2, notInTheModel: 'x' } as any, { currentUser });
      answers.push({ budget: updated.budget, extra: 'notInTheModel' in updated, updatedBy: updated.updatedBy });
    }
    expect(answers[0]).toEqual({ budget: -2, extra: false, updatedBy: undefined });
    expect(answers[0]).toEqual(answers[1]);
  });

  it('answers a malformed id with 404 and a duplicate unique value with 400, as on MongoDB', async () => {
    await testHelper.rest('/wiring-projects/not-an-id', { statusCode: 404 });
    await testHelper.rest('/wiring-projects', { method: 'POST', payload: { name: 'twice' }, statusCode: 201 });
    await testHelper.rest('/wiring-projects', { method: 'POST', payload: { name: 'twice' }, statusCode: 400 });
  });

  it('finds, counts and pages through the CrudService', async () => {
    for (const [name, budget] of [
      ['p1', 1],
      ['p2', 2],
      ['p3', 3],
    ] as const) {
      await service.create({ budget, name }, {});
    }
    const found = await service.find(
      { filterQuery: { budget: { $gte: 2 } }, queryOptions: { sort: { budget: -1 } } },
      {},
    );
    expect(found.map((item) => item.name)).toEqual(['p3', 'p2']);
    const page = await service.findAndCount(
      { filterQuery: { name: { $in: ['p1', 'p2', 'p3'] } }, queryOptions: { limit: 2, skip: 1, sort: { budget: 1 } } },
      {},
    );
    expect(page.totalCount).toBe(3);
    expect(page.items.map((item) => item.name)).toEqual(['p2', 'p3']);
    expect((await service.findOne({ filterQuery: { name: 'p1' } }, {}))?.budget).toBe(1);
  });

  it('populates a reference with one batched read through the target store', async () => {
    const owner = await stores.owners.insert({ name: 'owner' });
    const project = await service.create({ name: 'with-owner', ownerId: owner.id }, {});
    const populated: any = await service.get(project.id, { populate: ['ownerId'] });
    expect(populated.ownerId).toMatchObject({ id: owner.id, name: 'owner' });
  });

  /**
   * @regression   DEV-3829 (db-agnostic phase 1) — a model routed to PostgreSQL still has its Mongoose model
   *   registered, so a Mongoose-only API on its service would read and write MongoDB without a word.
   * @seen-failing Make CrudService.assertMongooseStore() a no-op in src/core/common/services/crud.service.ts —
   *   registered as mutation `crud-mongoose-api-on-sql-store` in tests/regression-mutations.json.
   */
  it('refuses the Mongoose-only APIs instead of reaching MongoDB', async () => {
    expect(() => service.getModel()).toThrow(UnsupportedCapabilityError);
    await expect(service.aggregate([])).rejects.toBeInstanceOf(UnsupportedCapabilityError);
  });
});

describe('SQL data source boot check (e2e)', () => {
  /**
   * @regression   DEV-3829 (db-agnostic phase 1) — an application connection that owns the tables (or is a
   *   superuser) is not bound by row-level security; booting with it would leave tenant isolation to the application.
   * @seen-failing Skip assertSafeApplicationRole() in DataSourceRuntime in
   *   src/core/common/persistence/data-source.runtime.ts — registered as mutation `sql-runtime-skips-role-check` in
   *   tests/regression-mutations.json.
   */
  it('refuses to boot when the application connection owns the tables', async () => {
    const database = await createPostgresTestDatabase('sql-wiring-unsafe');
    try {
      @Module({
        imports: [
          CorePersistenceModule.forFeature([
            { name: 'WiringOwner', schema: SchemaFactory.createForClass(WiringOwner) },
          ]),
        ],
      })
      class UnsafeFeatureModule {}

      @Module({
        imports: [
          CoreModule.forRoot({
            betterAuth: {
              autoRegister: true,
              basePath: '/iam',
              baseUrl: `http://localhost:${3300 + Math.floor(Math.random() * 100)}`,
              secret: 'TEST_BETTERAUTH_SECRET_32_CHARS_MIN',
            },
            // The OWNER as the application connection: what a single-role setup does
            database: { ownerUrl: database.ownerUrl, url: database.ownerUrl },
            env: 'test',
            graphQl: { driver: { introspection: true }, maxComplexity: 1000 },
            mongoose: { uri: deriveTestDbUri('sql-wiring-unsafe') },
            port: 0,
          } as any),
          UnsafeFeatureModule,
        ],
        providers: [JsonScalar],
      })
      class UnsafeAppModule {}

      // The store factory opens the source while the module is compiled — the boot stops there
      await expect(Test.createTestingModule({ imports: [UnsafeAppModule] }).compile()).rejects.toThrow(
        /"nest_owner" is a superuser.*owns .*wiring_owners.*Row-level security cannot protect tenant data/,
      );
    } finally {
      await database.drop();
    }
  });
});
