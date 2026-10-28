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
import { getConnectionToken, InjectModel, Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Test, TestingModule } from '@nestjs/testing';
import type { Model } from 'mongoose';
import { Client } from 'pg';
import supertest from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  CoreBetterAuthModule,
  CoreCronJobs,
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
import { User, UserSchema } from '../src/server/modules/user/user.model';

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

/** Written the way every existing project service is: only the Mongoose model, no store */
@Injectable()
class WiringModelProjectService extends CrudService<WiringProject> {
  constructor(@InjectModel('WiringProject') readonly model: Model<any>) {
    super({ mainDbModel: model, mainModelConstructor: WiringProject });
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
      providers: [WiringModelProjectService, WiringMongoProjectService, WiringProjectService, WiringStores],
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
  /**
   * @regression   DEV-3830 (db-agnostic phase 2) — a service written against `@InjectModel()` (every existing project
   *   service, `CoreUserService` included) kept writing to MongoDB although its model was routed to PostgreSQL.
   * @seen-failing Drop the getStoreForModel() lookup from ModuleService.dataStore in
   *   src/core/common/services/module.service.ts — registered as mutation `module-service-ignores-routed-store` in
   *   tests/regression-mutations.json.
   */
  it('serves a service that only knows its Mongoose model from the routed SQL store', async () => {
    const modelService = moduleRef.get(WiringModelProjectService);
    const created: any = await modelService.create({ name: 'via-model' }, {});
    expect(await service.store.findById(created.id)).toMatchObject({ name: 'via-model' });
  });

  /**
   * @regression   DEV-3830 (db-agnostic phase 2) — project code calling the Mongoose model of a model routed to
   *   PostgreSQL (`this.mainDbModel.findByIdAndUpdate(…)`, `doc.save()`) read and wrote MongoDB: the model's data split
   *   across two databases without an error.
   *   The first guard replaced `save` but not `$save`, Mongoose's separate reference to it, which `insertOne()` writes
   *   through.
   * @seen-failing Skip guardRoutedModel() in CorePersistenceModule.forFeature() in
   *   src/core/common/persistence/core-persistence.module.ts, or drop `$save` from DOCUMENT_DATA_METHODS in
   *   src/core/common/persistence/routed-model.guard.ts — registered as mutations `routed-model-not-guarded` and
   *   `routed-model-misses-save-alias` in tests/regression-mutations.json.
   */
  it('refuses data access through the Mongoose model of a model routed to SQL', async () => {
    const { model } = moduleRef.get(WiringModelProjectService);
    expect(() => model.countDocuments({})).toThrow(UnsupportedCapabilityError);
    expect(() => model.findByIdAndUpdate('651f00010203040506070809', { name: 'x' })).toThrow(/stored on postgres/);
    expect(() => new model({ name: 'x' }).save()).toThrow(UnsupportedCapabilityError);
    // Ways in that do not pass `save` or `find`: insertOne writes through `$save`, where() starts a query of its own
    expect(() => model.insertOne({ name: 'x' })).toThrow(UnsupportedCapabilityError);
    expect(() => new model({ name: 'x' }).$save()).toThrow(UnsupportedCapabilityError);
    expect(() => model.where('name').equals('x')).toThrow(UnsupportedCapabilityError);
    // What does not touch data stays available: the schema, the name
    expect(model.modelName).toBe('WiringProject');
    expect(model.schema.path('name')).toBeDefined();
  });

  /**
   * @regression   DEV-3830 (db-agnostic phase 2) — with a SQL default source the cron lease still went to MongoDB, so
   *   replicas sharing only the SQL database ran every tick each.
   * @seen-failing Ignore defaultSqlLockStore() in CoreCronJobs.acquireLease() in
   *   src/core/common/services/core-cron-jobs.service.ts — registered as mutation `cron-lease-ignores-sql-source` in
   *   tests/regression-mutations.json.
   */
  it('dedupes a cron tick between two replicas in the lease table of the default SQL source', async () => {
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
    const owner = new Client({ connectionString: database.ownerUrl });
    await owner.connect();
    try {
      const { rows } = await owner.query(`SELECT id FROM lt_locks WHERE id LIKE 'cron:wiring-job:%'`);
      expect(rows.map((row) => row.id)).toEqual([`cron:wiring-job:${tick.toISOString()}`]);
    } finally {
      await owner.end();
    }
  });

  /**
   * @regression   DEV-3830 (db-agnostic phase 2) — the anonymous `POST /system-setup/init` is check-then-act on the user
   *   count; only the claim keeps concurrent callers from each getting an admin, and with a SQL default source the
   *   claim must hold in its lease table.
   * @seen-failing Ignore defaultSqlLockStore() in CoreSystemSetupService.setupLocks() in
   *   src/core/modules/system-setup/core-system-setup.service.ts — registered as mutation
   *   `system-setup-claim-ignores-sql-source` in tests/regression-mutations.json.
   */
  it('lets exactly one of several anonymous setup calls win the claim in the SQL lease table', async () => {
    const owner = new Client({ connectionString: database.ownerUrl });
    await owner.connect();
    try {
      // A claim in MongoDB must not decide anything here: plant one there, held, to prove it is not read
      await (moduleRef.get(getConnectionToken()) as any).collection('system-setup-locks').insertOne({
        _id: 'initial-admin',
        claimedAt: new Date(),
      });
      const statuses = await Promise.all(
        Array.from({ length: 6 }, (_, caller) =>
          supertest(app.getHttpServer())
            .post('/system-setup/init')
            .send({ email: `wiring-setup-${caller}@test.com`, password: 'Wiring-Setup-1!' })
            .then((response) => response.status),
        ),
      );
      expect(statuses.filter((status) => status === 201)).toHaveLength(1);
      expect(statuses.filter((status) => status === 403)).toHaveLength(5);
      const { rows } = await owner.query(`SELECT id FROM lt_locks WHERE id = 'system-setup:initial-admin'`);
      expect(rows).toHaveLength(1);
    } finally {
      await owner.end();
    }
  });

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

  /**
   * @regression   DEV-3831 (db-agnostic phase 3) — with the user model on PostgreSQL, Better-Auth kept its users in
   *   MongoDB: the users were split across two databases, and the system setup counted Better-Auth's empty `users` and
   *   let an anonymous caller create an administrator next to the existing users (phase 2 refused that boot).
   *   The user mapper then still wrote the app fields of a signed-up user into a MongoDB document of its own, and the
   *   boot created the indices of Better-Auth's collections in MongoDB.
   * @seen-failing Make DataSourceRuntime.iamStorage() answer undefined in
   *   src/core/common/persistence/data-source.runtime.ts, skip the SQL branch of
   *   CoreBetterAuthUserMapper.linkOrCreateUser() in src/core/modules/better-auth/core-better-auth-user.mapper.ts, or
   *   let CoreBetterAuthService.onModuleInit() run its MongoDB steps on SQL too — registered as mutations
   *   `better-auth-ignores-sql-users`, `iam-mapper-link-on-mongo-on-sql` and `iam-mongo-indices-on-sql` in
   *   tests/regression-mutations.json.
   */
  it('runs Better-Auth on the PostgreSQL source the users table lives in, one row per user', async () => {
    const database = await createPostgresTestDatabase('sql-wiring-iam');
    const owner = new Client({ connectionString: database.ownerUrl });
    await owner.connect();
    let iamApp: INestApplication | undefined;
    const boot = async () => {
      CoreBetterAuthModule.reset();
      @Module({ imports: [CorePersistenceModule.forFeature([{ model: User, name: User.name, schema: UserSchema }])] })
      class IamUsersModule {}

      @Module({
        imports: [
          CoreModule.forRoot({
            betterAuth: {
              basePath: '/iam',
              baseUrl: `http://localhost:${3400 + Math.floor(Math.random() * 100)}`,
              emailVerification: false,
              secret: 'TEST_BETTERAUTH_SECRET_32_CHARS_MIN',
              signUpChecks: false,
            },
            database: { ownerUrl: database.ownerUrl, url: database.appUrl },
            env: 'test',
            graphQl: { driver: { introspection: true }, maxComplexity: 1000 },
            mongoose: { uri: deriveTestDbUri('sql-wiring-iam') },
            port: 0,
          } as any),
          IamUsersModule,
        ],
        providers: [JsonScalar],
      })
      class IamAppModule {}

      const moduleRef = await Test.createTestingModule({ imports: [IamAppModule] }).compile();
      const app = moduleRef.createNestApplication();
      await app.init();
      return app;
    };
    try {
      iamApp = await boot();
      const email = `iam-sql-${Date.now()}@test.com`;
      await supertest(iamApp.getHttpServer())
        .post('/iam/sign-up/email')
        .send({ email, name: 'Iam Sql', password: 'Iam-Sql-Password-1!', termsAndPrivacyAccepted: true })
        .expect((response) => expect(response.status).toBeLessThan(300));
      await supertest(iamApp.getHttpServer())
        .post('/iam/sign-in/email')
        .send({ email, password: 'Iam-Sql-Password-1!' })
        .expect((response) => expect(response.status).toBeLessThan(300));

      // One row in the framework's users table, written through the framework's columns, with the framework's id
      const { rows: users } = await owner.query('SELECT id, email, name, email_verified FROM users WHERE email = $1', [
        email,
      ]);
      expect(users).toHaveLength(1);
      expect(users[0].id).toMatch(/^[0-9a-f]{24}$/);
      expect(users[0].name).toBe('Iam Sql');
      const { rows: sessions } = await owner.query('SELECT user_id FROM session WHERE user_id = $1', [users[0].id]);
      expect(sessions.length).toBeGreaterThan(0);

      // Better-Auth's tables are owned by the owner; the application role only reads and writes them
      const { rows: owned } = await owner.query(
        `SELECT c.relname FROM pg_class c WHERE c.relkind = 'r' AND pg_get_userbyid(c.relowner) = $1
           AND c.relname IN ('session', 'account', 'verification', 'jwks', 'two_factor')`,
        [new URL(database.appUrl).username],
      );
      expect(owned).toEqual([]);

      // Nothing of it in MongoDB — not even the indices of Better-Auth's collections
      const connection = iamApp.get<any>(getConnectionToken());
      expect(await connection.db.collection('users').countDocuments({ email })).toBe(0);
      const collections = (await connection.db.listCollections().toArray()).map((collection) => collection.name);
      expect(collections.filter((name) => ['account', 'session', 'verification'].includes(name))).toEqual([]);
      await iamApp.close();
      iamApp = undefined;

      // A second boot finds everything in place and changes nothing
      iamApp = await boot();
      await supertest(iamApp.getHttpServer())
        .post('/iam/sign-in/email')
        .send({ email, password: 'Iam-Sql-Password-1!' })
        .expect((response) => expect(response.status).toBeLessThan(300));
    } finally {
      await iamApp?.close();
      CoreBetterAuthModule.reset();
      await owner.end();
      await database.drop();
    }
  });

  /**
   * @regression   DEV-3831 (db-agnostic phase 3) — the system setup counted the users in MongoDB although the users
   *   table lives in PostgreSQL: with an empty table it reported "set up", and with an empty MongoDB collection it let
   *   an anonymous caller create an administrator next to the existing users.
   * @seen-failing Count the MongoDB collection in CoreSystemSetupService.countUsers() in
   *   src/core/modules/system-setup/core-system-setup.service.ts — registered as mutation
   *   `system-setup-counts-mongo-users-on-sql` in tests/regression-mutations.json.
   */
  it('counts and creates the initial administrator in the SQL users table', async () => {
    const database = await createPostgresTestDatabase('sql-wiring-setup');
    const owner = new Client({ connectionString: database.ownerUrl });
    await owner.connect();
    let setupApp: INestApplication | undefined;
    try {
      CoreBetterAuthModule.reset();
      @Module({ imports: [CorePersistenceModule.forFeature([{ model: User, name: User.name, schema: UserSchema }])] })
      class SetupUsersModule {}

      @Module({
        imports: [
          CoreModule.forRoot({
            betterAuth: {
              basePath: '/iam',
              baseUrl: `http://localhost:${3500 + Math.floor(Math.random() * 100)}`,
              emailVerification: false,
              secret: 'TEST_BETTERAUTH_SECRET_32_CHARS_MIN',
              signUpChecks: false,
            },
            database: { ownerUrl: database.ownerUrl, url: database.appUrl },
            env: 'test',
            graphQl: { driver: { introspection: true }, maxComplexity: 1000 },
            mongoose: { uri: deriveTestDbUri(`sql-wiring-setup-${Date.now()}`) },
            port: 0,
          } as any),
          SetupUsersModule,
        ],
        providers: [JsonScalar],
      })
      class SetupAppModule {}

      const moduleRef = await Test.createTestingModule({ imports: [SetupAppModule] }).compile();
      setupApp = moduleRef.createNestApplication();
      await setupApp.init();
      // A user only MongoDB knows: the setup must not count it — the users live in PostgreSQL
      const connection = setupApp.get<any>(getConnectionToken());
      await connection.db.collection('users').insertOne({ email: `mongo-only-${Date.now()}@test.com` });

      const http = supertest(setupApp.getHttpServer());
      expect((await http.get('/system-setup/status').expect(200)).body).toMatchObject({ needsSetup: true });

      const email = `setup-sql-${Date.now()}@test.com`;
      await http
        .post('/system-setup/init')
        .send({ email, name: 'Setup Admin', password: 'Setup-Admin-Password-1!' })
        .expect(201);
      const { rows } = await owner.query('SELECT id, roles, email_verified FROM users WHERE email = $1', [email]);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ email_verified: true, roles: ['admin'] });

      // Set up now: a second anonymous caller gets nothing
      expect((await http.get('/system-setup/status').expect(200)).body).toMatchObject({ needsSetup: false });
      await http
        .post('/system-setup/init')
        .send({ email: `setup-sql-second-${Date.now()}@test.com`, password: 'Setup-Admin-Password-1!' })
        .expect(403);
    } finally {
      await setupApp?.close();
      CoreBetterAuthModule.reset();
      await owner.end();
      await database.drop();
    }
  });
});
