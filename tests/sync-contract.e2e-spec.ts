import { randomBytes, randomUUID } from 'node:crypto';
import { get as httpGet, type IncomingMessage } from 'node:http';
import type { AddressInfo } from 'node:net';

import { Injectable, Module } from '@nestjs/common';
import { InputType, ObjectType } from '@nestjs/graphql';
import { ScheduleModule } from '@nestjs/schedule';
import { Test, TestingModule } from '@nestjs/testing';
import { PubSub } from 'graphql-subscriptions';
import { createClient } from 'graphql-ws';
import mongoose from 'mongoose';
import ws from 'ws';
import { afterAll, beforeAll, describe, expect } from 'vitest';

import {
  buildCorsConfig,
  ConfigService,
  CoreBetterAuthModule,
  CoreBetterAuthService,
  CoreInput,
  CoreModule,
  CorePersistenceModel,
  CorePersistenceModule,
  CoreSyncMutationStore,
  CoreSyncService,
  CoreSyncStateStore,
  CoreTenantGuard,
  CoreTenantService,
  CrudService,
  type DataStore,
  equalIds,
  HttpExceptionLogFilter,
  InjectStore,
  type ISyncConflictContext,
  objectIdType,
  PersistedModel,
  Restricted,
  RoleEnum,
  SchemaFactory,
  Schema as MongooseSchema,
  SyncService,
  TestGraphQLType,
  TestHelper,
  UnifiedField,
} from '../src';
import envConfig from '../src/config.env';
import { getStoreToken } from '../src/core/common/persistence/persistence.tokens';
import { generateUuidV7 } from '../src/core/common/persistence/id-format';
import { getModelDescriptor } from '../src/core/common/persistence/model-metadata.registry';
import { tableName } from '../src/core/common/persistence/sql/sql-schema.shared';
import { Any } from '../src/core/common/scalars/any.scalar';
import { DateScalar } from '../src/core/common/scalars/date.scalar';
import { JSON as JSONScalar } from '../src/core/common/scalars/json.scalar';
import { CoreAuthService } from '../src/core/modules/auth/services/core-auth.service';
import { runSqlMigration } from '../src/core/modules/migrate/sql-migration.helper';
import { CronJobs } from '../src/server/common/services/cron-jobs.service';
import { AuthController } from '../src/server/modules/auth/auth.controller';
import { AuthModule } from '../src/server/modules/auth/auth.module';
import { BetterAuthModule } from '../src/server/modules/better-auth/better-auth.module';
import { FileModule } from '../src/server/modules/file/file.module';
import { SyncNoteModule } from '../src/server/modules/sync-note/sync-note.module';
import { ServerController } from '../src/server/server.controller';
import { deriveTestDbUri, isDroppableTestDb } from './db-lifecycle.reporter';
import { API_TOKEN_TEST_ENCRYPTION_KEY } from './helpers/api-token-e2e.helpers';
import { createMysqlTestDatabase } from './helpers/mysql-test-db';
import { createPostgresTestDatabase } from './helpers/postgres-test-db';
import { SYNC_DRIVERS, type SyncDriver, syncIt } from './helpers/sync-contract-matrix';

/**
 * Executor of the sync contract matrix (`tests/helpers/sync-contract-matrix.ts`): the offline-sync protocol through its
 * HTTP API, once per database. Each column assembles a server the way a project does — `CoreModule` with multi-tenancy,
 * legacy auth and Better-Auth, the reference model `SyncNote` (`src/server/modules/sync-note/`) and four test models
 * covering what the reference does not: a tenant- and owner-scoped model (`reject`), a uuidv7 model (`lww`), a `custom`
 * model and one declared without roles (ADMIN only).
 *
 * Every case works on records and users of its own, so a case can run alone.
 */
const PASSWORD = 'Sync-Contract-Password-1!';
const WINDOW_SECONDS = 2;
const MAX_BYTES = 4096;

// =====================================================================================================================
// Test models
// =====================================================================================================================

const SYNC_USER_ROLES = { create: [RoleEnum.S_USER], delete: [RoleEnum.S_USER], pull: [RoleEnum.S_USER], update: [RoleEnum.S_USER] };

/** Tenant-scoped, owner-scoped (`scope: ['ownerId']`), `reject`; only its creator (or an admin) may change it */
@PersistedModel({
  sync: {
    roles: {
      create: [RoleEnum.S_USER],
      delete: [RoleEnum.ADMIN, RoleEnum.S_CREATOR],
      pull: [RoleEnum.S_USER],
      update: [RoleEnum.ADMIN, RoleEnum.S_CREATOR],
    },
    scope: ['ownerId'],
    strategy: 'reject',
  },
})
@MongooseSchema({ timestamps: true })
@ObjectType({ description: 'Sync contract task' })
@Restricted(RoleEnum.ADMIN)
class SyncTask extends CorePersistenceModel {
  @UnifiedField({
    isOptional: true,
    mongoose: { type: objectIdType() },
    roles: RoleEnum.S_EVERYONE,
    swaggerApiOptions: { type: String },
    type: () => String,
  })
  createdBy?: any = undefined;

  @UnifiedField({ isOptional: true, mongoose: true, roles: RoleEnum.S_EVERYONE })
  ownerId?: string = undefined;

  @UnifiedField({ isOptional: true, mongoose: true, roles: RoleEnum.S_EVERYONE })
  tenantId?: string = undefined;

  @UnifiedField({ isOptional: true, mongoose: true, roles: RoleEnum.S_EVERYONE })
  title?: string = undefined;

  /** The tenant's members see its tasks; a task with an owner only its owner (and an admin) */
  override securityCheck(user: any, force?: boolean) {
    if (force || user?.hasRole?.([RoleEnum.ADMIN]) || !this.ownerId || equalIds(this.ownerId, user)) {
      return this;
    }
    return undefined;
  }
}
const SyncTaskSchema = SchemaFactory.createForClass(SyncTask);

@InputType({ description: 'Sync contract task input' })
@Restricted(RoleEnum.ADMIN)
class SyncTaskInput extends CoreInput {
  @UnifiedField({ isOptional: true, roles: RoleEnum.S_EVERYONE })
  ownerId?: string = undefined;

  @UnifiedField({ isOptional: true, roles: RoleEnum.S_EVERYONE })
  title?: string = undefined;
}

/** uuidv7 ids, `lww`, visible to every signed-in user */
@PersistedModel({ sync: { idFormat: 'uuidv7', roles: SYNC_USER_ROLES, strategy: 'lww' } })
@MongooseSchema({ timestamps: true })
@ObjectType({ description: 'Sync contract lww item' })
@Restricted(RoleEnum.ADMIN)
class SyncLww extends CorePersistenceModel {
  @UnifiedField({ isOptional: true, mongoose: true, roles: RoleEnum.S_EVERYONE })
  count?: number = undefined;

  @UnifiedField({ isOptional: true, mongoose: true, roles: RoleEnum.S_EVERYONE })
  title?: string = undefined;
}
const SyncLwwSchema = SchemaFactory.createForClass(SyncLww);

@InputType({ description: 'Sync contract lww input' })
@Restricted(RoleEnum.ADMIN)
class SyncLwwInput extends CoreInput {
  @UnifiedField({ isOptional: true, roles: RoleEnum.S_EVERYONE })
  count?: number = undefined;

  @UnifiedField({ isOptional: true, roles: RoleEnum.S_EVERYONE })
  title?: string = undefined;
}

/** `custom`: the service decides */
@PersistedModel({ sync: { roles: SYNC_USER_ROLES, strategy: 'custom' } })
@MongooseSchema({ timestamps: true })
@ObjectType({ description: 'Sync contract custom item' })
@Restricted(RoleEnum.ADMIN)
class SyncCustom extends CorePersistenceModel {
  @UnifiedField({ isOptional: true, mongoose: true, roles: RoleEnum.S_EVERYONE })
  title?: string = undefined;
}
const SyncCustomSchema = SchemaFactory.createForClass(SyncCustom);

@InputType({ description: 'Sync contract custom input' })
@Restricted(RoleEnum.ADMIN)
class SyncCustomInput extends CoreInput {
  @UnifiedField({ isOptional: true, roles: RoleEnum.S_EVERYONE })
  title?: string = undefined;
}

/** `sync: true`: no roles declared — every operation open to ADMIN only */
@PersistedModel({ sync: true })
@MongooseSchema({ timestamps: true })
@ObjectType({ description: 'Sync contract locked item' })
@Restricted(RoleEnum.ADMIN)
class SyncLocked extends CorePersistenceModel {
  @UnifiedField({ isOptional: true, mongoose: true, roles: RoleEnum.S_EVERYONE })
  title?: string = undefined;
}
const SyncLockedSchema = SchemaFactory.createForClass(SyncLocked);

@InputType({ description: 'Sync contract locked input' })
@Restricted(RoleEnum.ADMIN)
class SyncLockedInput extends CoreInput {
  @UnifiedField({ isOptional: true, roles: RoleEnum.S_EVERYONE })
  title?: string = undefined;
}

@SyncService({ createInput: SyncTaskInput, model: SyncTask, updateInput: SyncTaskInput })
@Injectable()
class SyncTaskService extends CrudService<SyncTask> {
  constructor(@InjectStore(SyncTask) store: DataStore<SyncTask>) {
    super({ dataStore: store, mainModelConstructor: SyncTask });
  }
}

@SyncService({ createInput: SyncLwwInput, model: SyncLww, updateInput: SyncLwwInput })
@Injectable()
class SyncLwwService extends CrudService<SyncLww> {
  constructor(@InjectStore(SyncLww) store: DataStore<SyncLww>) {
    super({ dataStore: store, mainModelConstructor: SyncLww });
  }
}

@SyncService({ createInput: SyncCustomInput, model: SyncCustom, updateInput: SyncCustomInput })
@Injectable()
class SyncCustomService extends CrudService<SyncCustom> {
  constructor(@InjectStore(SyncCustom) store: DataStore<SyncCustom>) {
    super({ dataStore: store, mainModelConstructor: SyncCustom });
  }

  /** Refuse when the client asks for it, otherwise append the client's title to the server's */
  resolveSyncConflict(context: ISyncConflictContext) {
    if ((context.change.data as any)?.refuse) {
      return { refuse: true as const };
    }
    return { data: { title: `${(context.server.data as any)?.title}+${(context.change.data as any)?.title}` } };
  }
}

@SyncService({ createInput: SyncLockedInput, model: SyncLocked, updateInput: SyncLockedInput })
@Injectable()
class SyncLockedService extends CrudService<SyncLocked> {
  constructor(@InjectStore(SyncLocked) store: DataStore<SyncLocked>) {
    super({ dataStore: store, mainModelConstructor: SyncLocked });
  }
}

@Module({
  imports: [
    CorePersistenceModule.forFeature([
      { model: SyncTask, name: SyncTask.name, schema: SyncTaskSchema },
      { model: SyncLww, name: SyncLww.name, schema: SyncLwwSchema },
      { model: SyncCustom, name: SyncCustom.name, schema: SyncCustomSchema },
      { model: SyncLocked, name: SyncLocked.name, schema: SyncLockedSchema },
    ]),
  ],
  providers: [SyncCustomService, SyncLockedService, SyncLwwService, SyncTaskService],
})
class SyncContractModelsModule {}

// =====================================================================================================================
// Harness
// =====================================================================================================================

/** The test infrastructure's one-node replica set (`pnpm run test:infra`, container nest-server-2985-mongo-rs) */
const MONGO_RS_URL = `mongodb://${process.env.MONGO_RS_HOST || '127.0.0.1'}:${process.env.MONGO_RS_PORT || '27019'}`;

interface Database {
  config: Record<string, unknown>;
  drop(): Promise<void>;
}

async function databaseFor(driver: SyncDriver): Promise<Database> {
  const local = deriveTestDbUri(`sync-contract-${driver}`);
  if (driver === 'mongodb') {
    return { config: { mongoose: { ...envConfig.mongoose, uri: local } }, drop: async () => undefined };
  }
  if (driver === 'mongodb-rs') {
    const name = new URL(local).pathname.slice(1);
    if (!isDroppableTestDb(name)) {
      throw new Error(`Refusing the replica set database "${name}": its name does not pass the drop guard`);
    }
    const uri = `${MONGO_RS_URL}/${name}?directConnection=true`;
    const probe = await mongoose.createConnection(uri, { serverSelectionTimeoutMS: 3000 }).asPromise().catch((error) => {
      throw new Error(
        `The MongoDB replica set is not reachable on ${MONGO_RS_URL} (${(error as Error).message}). ` +
          'Start the test infrastructure with `pnpm run test:infra` (container nest-server-2985-mongo-rs).',
      );
    });
    await probe.close();
    return {
      config: { mongoose: { ...envConfig.mongoose, uri } },
      drop: async () => {
        const connection = await mongoose.createConnection(uri).asPromise();
        await connection.dropDatabase();
        await connection.close();
      },
    };
  }
  const mongooseConfig = { mongoose: { ...envConfig.mongoose, uri: local } };
  if (driver.startsWith('postgres-')) {
    const database = await createPostgresTestDatabase(`sync-${driver}`);
    return {
      config: {
        ...mongooseConfig,
        database: { ownerUrl: database.ownerUrl, sqlEngine: driver.slice('postgres-'.length), url: database.appUrl },
      },
      drop: () => database.drop(),
    };
  }
  const database = await createMysqlTestDatabase(driver as 'mariadb' | 'mysql', 'sync-contract');
  return {
    config: { ...mongooseConfig, database: { ownerUrl: database.ownerUrl, url: database.appUrl } },
    drop: () => database.drop(),
  };
}

interface Harness {
  app: any;
  /** The listening server: SSE and the GraphQL WebSocket need a real connection */
  baseUrl: string;
  betterAuth: CoreBetterAuthService;
  moduleRef: TestingModule;
  sync: CoreSyncService;
  tenantGuard: CoreTenantGuard;
  tenantService: CoreTenantService;
  testHelper: TestHelper;
  users: DataStore<any>;
  wsUrl: string;
}

function configFor(database: Database): Record<string, any> {
  return {
    ...envConfig,
    apiTokens: { encryptionKey: API_TOKEN_TEST_ENCRYPTION_KEY, scopes: ['read'] },
    auth: { ...envConfig.auth, legacyEndpoints: { enabled: true }, rateLimit: { enabled: false } },
    // The e2e profile mirrors every origin (`allowAll`); the cookie case needs a list of trusted ones to test against
    cors: { allowAll: false },
    ...database.config,
    multiTenancy: {},
    sync: {
      cursorSecret: 'sync-contract-cursor-secret',
      // Short, so a hint case does not wait out the production debounce
      hints: { debounceMs: 20 },
      pull: { maxBytes: MAX_BYTES, windowSeconds: WINDOW_SECONDS },
      rateLimit: false,
    },
  };
}

async function boot(config: Record<string, any>): Promise<Harness> {
  CoreBetterAuthModule.reset();

  @Module({
    controllers: [ServerController, AuthController],
    imports: [
      CoreModule.forRoot(CoreAuthService, AuthModule.forRoot(config.jwt), config as any),
      ScheduleModule.forRoot(),
      AuthModule.forRoot(config.jwt),
      BetterAuthModule.forRoot({}),
      FileModule,
      SyncNoteModule,
      SyncContractModelsModule,
    ],
    providers: [Any, CronJobs, DateScalar, JSONScalar, { provide: 'PUB_SUB', useValue: new PubSub() }],
  })
  class SyncContractServerModule {}

  const moduleRef = await Test.createTestingModule({ imports: [SyncContractServerModule] }).compile();
  const app = moduleRef.createNestApplication();
  app.useGlobalFilters(new HttpExceptionLogFilter());
  (app as any).setBaseViewsDir(config.templates.path);
  (app as any).setViewEngine(config.templates.engine);
  await app.init();
  const server = app.getHttpServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const { port } = server.address() as AddressInfo;
  return {
    app,
    baseUrl: `http://127.0.0.1:${port}`,
    betterAuth: moduleRef.get(CoreBetterAuthService, { strict: false }),
    moduleRef,
    sync: moduleRef.get(CoreSyncService, { strict: false }),
    tenantGuard: moduleRef.get(CoreTenantGuard, { strict: false }),
    tenantService: moduleRef.get(CoreTenantService, { strict: false }),
    testHelper: new TestHelper(app),
    users: moduleRef.get(getStoreToken('User'), { strict: false }),
    wsUrl: `ws://127.0.0.1:${port}/graphql`,
  };
}

/** An ObjectId-hex client id with the random tail protocol §3 asks for */
function clientObjectId(): string {
  return Math.floor(Date.now() / 1000).toString(16).padStart(8, '0') + randomBytes(8).toString('hex');
}

const mutationId = () => generateUuidV7();

// =====================================================================================================================
// Contract
// =====================================================================================================================

describe.each(SYNC_DRIVERS)('sync contract — %s (e2e)', (driver) => {
  let database: Database;
  let config: Record<string, any>;
  let harness: Harness;
  let testHelper: TestHelper;
  let adminToken: string;
  let adminId: string;

  const unique = (label: string) =>
    `sync-${label}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@test.com`.toLowerCase();

  const signUp = async (label: string): Promise<{ email: string; id: string; token: string }> => {
    const email = unique(label);
    const result: any = await testHelper.graphQl({
      arguments: { input: { email, firstName: 'Sync', password: PASSWORD } },
      fields: ['token', { user: ['id'] }],
      name: 'signUp',
      type: TestGraphQLType.MUTATION,
    });
    return { email, id: String(result.user.id), token: String(result.token) };
  };

  const signIn = async (email: string): Promise<string> => {
    const result: any = await testHelper.graphQl({
      arguments: { input: { email, password: PASSWORD } },
      fields: ['token'],
      name: 'signIn',
      type: TestGraphQLType.MUTATION,
    });
    return String(result.token);
  };

  interface CallOptions {
    cookies?: string;
    headers?: Record<string, string>;
    statusCode?: number;
    tenant?: string;
    token?: string;
  }

  const headersOf = (options: CallOptions) => ({
    ...(options.tenant ? { 'x-tenant-id': options.tenant } : {}),
    ...options.headers,
  });

  const pull = (model: string, options: CallOptions & { cursor?: string; limit?: number | string } = {}) => {
    const query = new URLSearchParams();
    if (options.cursor !== undefined) {
      query.set('cursor', options.cursor);
    }
    if (options.limit !== undefined) {
      query.set('limit', String(options.limit));
    }
    const suffix = query.toString() ? `?${query.toString()}` : '';
    return testHelper.rest(`/sync/${model}${suffix}`, {
      cookies: options.cookies,
      headers: headersOf(options),
      statusCode: options.statusCode ?? 200,
      token: options.token,
    }) as Promise<any>;
  };

  const push = (model: string, items: any[], options: CallOptions = {}) =>
    testHelper.rest(`/sync/${model}`, {
      cookies: options.cookies,
      headers: headersOf(options),
      method: 'POST',
      payload: { items },
      statusCode: options.statusCode ?? 200,
      token: options.token,
    }) as Promise<any>;

  /** Push one item and answer its result */
  const pushOne = async (model: string, item: any, options: CallOptions = {}) => (await push(model, [item], options)).results[0];

  const create = (model: string, data: Record<string, unknown>, options: CallOptions, id = clientObjectId()) =>
    pushOne(model, { data, id, mutationId: mutationId(), op: 'upsert' }, options).then((result) => ({ ...result, id }));

  const change = (model: string, id: string, baseVersion: number, data: Record<string, unknown>, options: CallOptions, extra = {}) =>
    pushOne(model, { baseVersion, data, id, mutationId: mutationId(), op: 'upsert', ...extra }, options);

  const remove = (model: string, id: string, baseVersion: number | undefined, options: CallOptions) =>
    pushOne(model, { ...(baseVersion === undefined ? {} : { baseVersion }), id, mutationId: mutationId(), op: 'delete' }, options);

  /** Pull until `hasMore` is false: every item, the pages and the last cursor */
  const pullAll = async (model: string, options: CallOptions & { cursor?: string; limit?: number } = {}) => {
    const items: any[] = [];
    const pages: any[] = [];
    let cursor = options.cursor;
    for (let page = 0; page < 2000; page++) {
      const result = await pull(model, { ...options, cursor });
      expect(typeof result.cursor).toBe('string');
      pages.push(result);
      items.push(...result.items);
      cursor = result.cursor;
      if (!result.hasMore) {
        return { cursor, items, pages };
      }
    }
    throw new Error('pull did not end');
  };

  /** The latest version of every record among pulled items */
  const latest = (items: any[]) => {
    const result = new Map<string, any>();
    for (const item of items) {
      const known = result.get(item.id);
      if (!known || known.version <= item.version) {
        result.set(item.id, item);
      }
    }
    return result;
  };

  const tenant = () => randomBytes(12).toString('hex');

  const member = async (tenantId: string, userId: string) => {
    await harness.tenantService.addMember(tenantId, userId, 'member');
    harness.tenantGuard.invalidateUser(userId);
  };

  const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

  /** Wait until `check` holds; `false` after `timeoutMs` (a negative assertion waits it out on purpose) */
  const until = async (check: () => boolean, timeoutMs = 3000): Promise<boolean> => {
    const deadline = Date.now() + timeoutMs;
    while (!check()) {
      if (Date.now() >= deadline) {
        return false;
      }
      await sleep(20);
    }
    return true;
  };

  /** Longer than the hint debounce and a delivery: a hint that would come has come by then */
  const HINT_SETTLE_MS = 400;

  /** Open `GET /sync/hints` as a real stream and collect its `change` events */
  const openHints = async (options: CallOptions & { models?: string }) => {
    const events: any[] = [];
    let ended = false;
    let buffer = '';
    const query = options.models ? `?models=${encodeURIComponent(options.models)}` : '';
    const request = httpGet(`${harness.baseUrl}/sync/hints${query}`, {
      headers: {
        accept: 'text/event-stream',
        ...(options.token ? { authorization: `Bearer ${options.token}` } : {}),
        ...headersOf(options),
      },
    });
    const response = await new Promise<IncomingMessage>((resolve, reject) => {
      request.once('response', resolve);
      request.once('error', reject);
    });
    response.setEncoding('utf8');
    response.on('data', (chunk: string) => {
      buffer += chunk;
      let index: number;
      while ((index = buffer.indexOf('\n\n')) >= 0) {
        const lines = buffer.slice(0, index).split('\n');
        buffer = buffer.slice(index + 2);
        const event = lines.find((line) => line.startsWith('event: '))?.slice('event: '.length);
        const data = lines.find((line) => line.startsWith('data: '))?.slice('data: '.length);
        if (event === 'change' && data) {
          events.push(JSON.parse(data));
        }
      }
    });
    response.once('end', () => (ended = true));
    response.once('close', () => (ended = true));
    return {
      close: () => request.destroy(),
      get ended() {
        return ended;
      },
      events,
      of: (model: string) => events.filter((hint) => hint.model === model),
      status: response.statusCode,
    };
  };

  /** Subscribe `syncHint` over the GraphQL WebSocket and collect its hints */
  const subscribeHints = async (options: CallOptions) => {
    const events: any[] = [];
    const errors: any[] = [];
    let connected = false;
    const client = createClient({
      connectionParams: {
        ...(options.token ? { Authorization: `Bearer ${options.token}` } : {}),
        ...(options.tenant ? { 'x-tenant-id': options.tenant } : {}),
      },
      on: { connected: () => (connected = true) },
      retryAttempts: 0,
      url: harness.wsUrl,
      webSocketImpl: ws,
    });
    const unsubscribe = client.subscribe(
      { query: 'subscription { syncHint { at model } }' },
      {
        complete: () => undefined,
        error: (error) => errors.push(error),
        next: (message: any) => (message.errors ? errors.push(message.errors) : events.push(message.data?.syncHint)),
      },
    );
    await until(() => connected);
    // The subscription is set up after the handshake (its filter reads the subscriber's rights)
    await sleep(200);
    return {
      close: async () => {
        unsubscribe();
        await client.dispose();
      },
      errors,
      events,
      of: (model: string) => events.filter((hint) => hint?.model === model),
    };
  };

  /** A hint channel is live: a write in the subscriber's own scope has arrived (so a later silence means something) */
  const awaitLive = async (channel: { of(model: string): any[] }, write: () => Promise<unknown>, model: string) => {
    await write();
    expect(await until(() => channel.of(model).length > 0)).toBe(true);
    await sleep(HINT_SETTLE_MS);
  };

  beforeAll(async () => {
    database = await databaseFor(driver);
    config = configFor(database);
    harness = await boot(config);
    testHelper = harness.testHelper;
    const email = unique('admin');
    const admin = await harness.users.insert({ email, password: PASSWORD, roles: ['admin'], verified: true });
    adminId = String(admin.id);
    adminToken = await signIn(email);
  }, 120_000);

  afterAll(async () => {
    const server = harness?.app?.getHttpServer();
    if (server?.listening) {
      server.closeAllConnections?.();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
    await harness?.app?.close();
    await database?.drop();
    CoreBetterAuthModule.reset();
  });

  // --- pull ----------------------------------------------------------------------------------------------------

  syncIt('pull-full-state', driver, async () => {
    const alice = await signUp('full');
    const ids: string[] = [];
    for (let index = 0; index < 7; index++) {
      const created = await create('SyncNote', { body: `body ${index}`, title: `note ${index}` }, { token: alice.token });
      expect(created.status).toBe('applied');
      ids.push(created.id);
    }
    expect((await remove('SyncNote', ids[3], 1, { token: alice.token })).status).toBe('applied');

    const { items, pages } = await pullAll('SyncNote', { limit: 3, token: alice.token });
    expect(pages.length).toBeGreaterThan(2);
    const byId = latest(items);
    expect([...byId.keys()].sort()).toEqual([...ids].sort());
    expect(byId.get(ids[3])).toMatchObject({ id: ids[3], version: 2 });
    expect(byId.get(ids[3]).deletedAt).toBeTruthy();
    expect(byId.get(ids[3]).data).toBeUndefined();
    expect(byId.get(ids[0])).toMatchObject({ data: { body: 'body 0', title: 'note 0' }, deletedAt: null, version: 1 });
  });

  syncIt('pull-resume', driver, async () => {
    const alice = await signUp('resume');
    const ids: string[] = [];
    for (let index = 0; index < 6; index++) {
      ids.push((await create('SyncNote', { title: `resume ${index}` }, { token: alice.token })).id);
    }
    const first = await pull('SyncNote', { limit: 2, token: alice.token });
    const second = await pull('SyncNote', { cursor: first.cursor, limit: 2, token: alice.token });
    // The client crashed after storing page one: it asks again with the same cursor and gets the same page
    const again = await pull('SyncNote', { cursor: first.cursor, limit: 2, token: alice.token });
    expect(again.items.map((item: any) => item.id)).toEqual(second.items.map((item: any) => item.id));
    const rest = await pullAll('SyncNote', { cursor: again.cursor, limit: 2, token: alice.token });
    const delivered = [...first.items, ...again.items, ...rest.items].map((item: any) => item.id);
    expect(new Set(delivered)).toEqual(new Set(ids));
  });

  syncIt('pull-delta', driver, async () => {
    const alice = await signUp('delta');
    const a = await create('SyncNote', { title: 'a' }, { token: alice.token });
    const b = await create('SyncNote', { title: 'b' }, { token: alice.token });
    await create('SyncNote', { title: 'c' }, { token: alice.token });
    const { cursor } = await pullAll('SyncNote', { token: alice.token });

    expect((await change('SyncNote', a.id, 1, { title: 'a2' }, { token: alice.token })).status).toBe('applied');
    expect((await remove('SyncNote', b.id, 1, { token: alice.token })).status).toBe('applied');
    const d = await create('SyncNote', { title: 'd' }, { token: alice.token });

    const delta = await pullAll('SyncNote', { cursor, token: alice.token });
    const byId = latest(delta.items);
    expect(byId.get(a.id)).toMatchObject({ data: { title: 'a2' }, version: 2 });
    expect(byId.get(b.id)).toMatchObject({ version: 2 });
    expect(byId.get(b.id).deletedAt).toBeTruthy();
    expect(byId.get(d.id)).toMatchObject({ data: { title: 'd' }, version: 1 });
    expect(delta.pages.at(-1).hasMore).toBe(false);
  });

  syncIt('pull-no-repeats', driver, async () => {
    const alice = await signUp('no-repeats');
    await create('SyncNote', { title: 'once' }, { token: alice.token });
    const { cursor } = await pullAll('SyncNote', { token: alice.token });
    const next = await pull('SyncNote', { cursor, token: alice.token });
    expect(next).toMatchObject({ hasMore: false, items: [] });
  });

  syncIt(
    'pull-window-repeats',
    driver,
    async () => {
      const alice = await signUp('window');
      const record = await create('SyncNote', { title: 'windowed' }, { token: alice.token });
      const first = await pullAll('SyncNote', { token: alice.token });
      expect(latest(first.items).get(record.id)).toMatchObject({ version: 1 });
      // A run right after starts W below the previous start: the unchanged record comes again, in the same version
      const second = await pullAll('SyncNote', { cursor: first.cursor, token: alice.token });
      expect(latest(second.items).get(record.id)).toMatchObject({ version: 1 });
      // Once a run started more than W after the record's stamp, the next one no longer reaches it
      await new Promise((resolve) => setTimeout(resolve, (WINDOW_SECONDS + 1) * 1000));
      const third = await pullAll('SyncNote', { cursor: second.cursor, token: alice.token });
      const fourth = await pullAll('SyncNote', { cursor: third.cursor, token: alice.token });
      expect(fourth.items.map((item: any) => item.id)).not.toContain(record.id);
    },
    30_000,
  );

  syncIt('pull-tombstone-shape', driver, async () => {
    const alice = await signUp('tombstone');
    const note = await create('SyncNote', { body: 'secret body', priority: 3, title: 'gone' }, { token: alice.token });
    await remove('SyncNote', note.id, 1, { token: alice.token });
    const tombstone = latest((await pullAll('SyncNote', { token: alice.token })).items).get(note.id);
    expect(Object.keys(tombstone).sort()).toEqual(['deletedAt', 'id', 'updatedAt', 'version']);
    expect(JSON.stringify(tombstone)).not.toContain('secret body');

    const tenantId = tenant();
    await member(tenantId, alice.id);
    const task = await create('SyncTask', { ownerId: alice.id, title: 'scoped' }, { tenant: tenantId, token: alice.token });
    await remove('SyncTask', task.id, 1, { tenant: tenantId, token: alice.token });
    const taskTombstone = latest((await pullAll('SyncTask', { tenant: tenantId, token: alice.token })).items).get(task.id);
    expect(taskTombstone).toMatchObject({ id: task.id, ownerId: alice.id, tenantId, version: 2 });
    expect(Object.keys(taskTombstone).sort()).toEqual(['deletedAt', 'id', 'ownerId', 'tenantId', 'updatedAt', 'version']);
  });

  syncIt('pull-page-bytes', driver, async () => {
    const alice = await signUp('bytes');
    const ids: string[] = [];
    for (let index = 0; index < 3; index++) {
      ids.push((await create('SyncNote', { body: 'x'.repeat(3000), title: `big ${index}` }, { token: alice.token })).id);
    }
    // Larger than a page on its own: still delivered, one per page
    ids.push((await create('SyncNote', { body: 'y'.repeat(MAX_BYTES + 500), title: 'huge' }, { token: alice.token })).id);
    const { items, pages } = await pullAll('SyncNote', { limit: 10, token: alice.token });
    expect(new Set(items.map((item: any) => item.id))).toEqual(new Set(ids));
    for (const page of pages.filter((entry: any) => entry.items.length > 1)) {
      expect(Buffer.byteLength(JSON.stringify(page.items))).toBeLessThanOrEqual(MAX_BYTES);
    }
    expect(pages.every((page: any) => page.items.length >= 1 || !page.hasMore || page.items.length === 0)).toBe(true);
    expect(pages.filter((page: any) => page.items.length === 1).length).toBeGreaterThanOrEqual(3);
  });

  syncIt('pull-limit', driver, async () => {
    // `limit` counts the records read, visible or not — an administrator sees every one of them
    for (let index = 0; index < 3; index++) {
      await create('SyncLocked', { title: `limit ${index}` }, { token: adminToken });
    }
    const page = await pull('SyncLocked', { limit: 2, token: adminToken });
    expect(page.items).toHaveLength(2);
    expect(page.hasMore).toBe(true);
    for (const limit of [0, 1001, 'abc', -1, 1.5]) {
      await pull('SyncLocked', { limit, statusCode: 400, token: adminToken });
    }
  });

  syncIt('pull-roles', driver, async () => {
    const alice = await signUp('pull-roles');
    await pull('SyncNote', { statusCode: 401 });
    await pull('SyncLocked', { statusCode: 403, token: alice.token });
    expect((await pull('SyncLocked', { token: adminToken })).items).toBeDefined();
    await pull('NoSuchModel', { statusCode: 404, token: alice.token });
    // A model that exists but is not offered for sync answers the same as an unknown one
    await pull('User', { statusCode: 404, token: alice.token });
  });

  /**
   * @regression   DEV-3901 — a pull must run every record through the model's securityCheck() (no lean path): the
   *   archived concept's pullLean skipped it, and every member received every record of the tenant.
   * @seen-failing Use the record without securityCheck() in CoreSyncService.toSyncRecord() in
   *   src/core/modules/sync/core-sync.service.ts — registered as mutation `sync-pull-skips-security-check` in
   *   tests/regression-mutations.json.
   */
  syncIt('pull-security-check', driver, async () => {
    const alice = await signUp('visible-a');
    const bob = await signUp('visible-b');
    const aliceNotes = [
      (await create('SyncNote', { title: 'alice 1' }, { token: alice.token })).id,
      (await create('SyncNote', { title: 'alice 2' }, { token: alice.token })).id,
    ];
    const bobNote = (await create('SyncNote', { title: 'bob 1' }, { token: bob.token })).id;
    // One record per page: alice's notes come before bob's in the change order and must still move his cursor on
    const bobItems = (await pullAll('SyncNote', { limit: 1, token: bob.token })).items.map((item: any) => item.id);
    expect(bobItems).toContain(bobNote);
    expect(bobItems.some((id: string) => aliceNotes.includes(id))).toBe(false);
    const aliceItems = (await pullAll('SyncNote', { token: alice.token })).items.map((item: any) => item.id);
    expect(aliceItems).toEqual(expect.arrayContaining(aliceNotes));
    expect(aliceItems).not.toContain(bobNote);
  });

  /**
   * @regression   DEV-3901 — a pull read the content first and the change positions second: a record changed between
   *   the two reads lent the page its NEW position, so the cursor jumped past every record after its old one — lost to
   *   the client for good, without a resync.
   * @seen-failing Take the cursor position from a read made after the content read in CoreSyncService.pull()
   *   (src/core/modules/sync/core-sync.service.ts) — registered as mutation `sync-pull-position-after-content` in
   *   tests/regression-mutations.json.
   */
  syncIt('pull-change-between-reads', driver, async () => {
    const alice = await signUp('between');
    const notes: any[] = [];
    for (const title of ['a', 'b', 'c', 'd']) {
      notes.push(await create('SyncNote', { title }, { token: alice.token }));
    }
    const service: any = harness.sync;
    const readContents = service.readContents;
    let changed = false;
    // Another device changes b while this pull holds b's position and has not read its content yet
    service.readContents = async function (this: any, ...args: any[]) {
      if (!changed && args[1]?.includes(notes[1].id)) {
        changed = true;
        expect((await change('SyncNote', notes[1].id, 1, { title: 'b2' }, { token: alice.token })).status).toBe(
          'applied',
        );
      }
      return readContents.apply(this, args);
    };
    try {
      const run = await pullAll('SyncNote', { limit: 1, token: alice.token });
      expect(changed).toBe(true);
      const byId = latest(run.items);
      for (const note of notes) {
        expect(byId.has(note.id), note.id).toBe(true);
      }
      expect(byId.get(notes[1].id)).toMatchObject({ data: { title: 'b2' }, version: 2 });
      // A version is never newer than the content it labels
      for (const item of run.items.filter((entry: any) => entry.id === notes[1].id && entry.version === 2)) {
        expect(item.data.title).toBe('b2');
      }
    } finally {
      service.readContents = readContents;
    }
  });

  /**
   * @regression   DEV-3901 — without X-Tenant-Id a tenant-scoped model is read once per tenant (an equality the
   *   tenant-led change index can deliver the order for) and the pages are merged by position; a merge out of order
   *   moves the cursor past records of the other tenants.
   * @seen-failing Drop the merge sort from CoreSyncService.readPositions() (src/core/modules/sync/core-sync.service.ts)
   *   — registered as mutation `sync-tenant-pages-unmerged` in tests/regression-mutations.json.
   */
  syncIt('pull-across-tenants', driver, async () => {
    const alice = await signUp('across');
    const tenantA = tenant();
    const tenantB = tenant();
    await member(tenantA, alice.id);
    await member(tenantB, alice.id);
    const created: string[] = [];
    for (let index = 0; index < 6; index++) {
      const options = { tenant: index % 2 ? tenantB : tenantA, token: alice.token };
      const result = await create('SyncTask', { ownerId: alice.id, title: `t${index}` }, options);
      expect(result.status).toBe('applied');
      created.push(result.id);
    }
    const run = await pullAll('SyncTask', { limit: 2, token: alice.token });
    const ids = run.items.map((item: any) => item.id).filter((id: string) => created.includes(id));
    expect(new Set(ids).size).toBe(ids.length);
    expect([...ids].sort()).toEqual([...created].sort());
  });

  /**
   * @regression   DEV-3901 — the window W is derived from the server (transaction lifetime plus a margin on a replica
   *   set, the margin alone on a standalone); the suite pins `pull.windowSeconds`, so a derived W of the margin alone
   *   on a replica set — every late commit lost for good — went unnoticed.
   * @seen-failing Make readChangeWindow() answer the margin alone on a replica set in
   *   src/core/common/persistence/mongo/sync-schema.plugin.ts — registered as mutation
   *   `sync-window-ignores-transaction-lifetime` in tests/regression-mutations.json.
   */
  syncIt('pull-window-derived', driver, async () => {
    const store: any = harness.moduleRef.get(getStoreToken('SyncNote'), { strict: false });
    const { windowMs } = await store.changeClock();
    if (driver === 'mongodb') {
      expect(windowMs).toBe(30_000);
      return;
    }
    const connection = await mongoose.createConnection(String(config.mongoose.uri)).asPromise();
    try {
      const parameter = await (connection.db as any)
        .admin()
        .command({ getParameter: 1, transactionLifetimeLimitSeconds: 1 });
      expect(windowMs).toBe(Number(parameter.transactionLifetimeLimitSeconds) * 1000 + 30_000);
    } finally {
      await connection.close();
    }
  });

  // --- resync --------------------------------------------------------------------------------------------------

  /**
   * @regression   DEV-3901 — a cursor is bound to its user: another user's cursor is invalid, not an access change.
   * @seen-failing Drop the user comparison from CoreSyncService.continuedCursor() in
   *   src/core/modules/sync/core-sync.service.ts — registered as mutation `sync-cursor-ignores-user` in
   *   tests/regression-mutations.json.
   */
  syncIt('resync-invalid', driver, async () => {
    const alice = await signUp('invalid-a');
    const bob = await signUp('invalid-b');
    await create('SyncNote', { title: 'n' }, { token: alice.token });
    const { cursor } = await pullAll('SyncNote', { token: alice.token });
    const tampered = `${cursor.slice(0, -2)}${cursor.endsWith('AA') ? 'BB' : 'AA'}`;
    for (const [model, value, token] of [
      ['SyncNote', tampered, alice.token],
      ['SyncNote', 'not-a-cursor', alice.token],
      ['SyncLww', cursor, alice.token],
      ['SyncNote', cursor, bob.token],
    ]) {
      expect(await pull(model, { cursor: value, statusCode: 410, token })).toMatchObject({
        code: 'SYNC_RESYNC_REQUIRED',
        reason: 'invalid',
      });
    }
    // The same cursor still works for its own user and model
    await pull('SyncNote', { cursor, token: alice.token });
  });

  syncIt('resync-horizon', driver, async () => {
    await create('SyncLocked', { title: 'horizon' }, { token: adminToken });
    const { cursor } = await pullAll('SyncLocked', { token: adminToken });
    await pull('SyncLocked', { cursor, token: adminToken });
    await harness.sync.advanceHorizon('SyncLocked', new Date(Date.now() + 1000));
    expect(await pull('SyncLocked', { cursor, statusCode: 410, token: adminToken })).toMatchObject({
      code: 'SYNC_RESYNC_REQUIRED',
      reason: 'horizon',
    });
    // A full resync starts without a cursor
    await pullAll('SyncLocked', { token: adminToken });
  });

  syncIt('resync-access-roles', driver, async () => {
    const carol = await signUp('roles-c');
    const dave = await signUp('roles-d');
    await create('SyncNote', { title: 'c' }, { token: carol.token });
    const carolCursor = (await pullAll('SyncNote', { token: carol.token })).cursor;
    const daveCursor = (await pullAll('SyncNote', { token: dave.token })).cursor;
    await harness.users.updateById(carol.id, { roles: ['editor'] });
    expect(await pull('SyncNote', { cursor: carolCursor, statusCode: 410, token: carol.token })).toMatchObject({
      reason: 'access',
    });
    await pull('SyncNote', { cursor: daveCursor, token: dave.token });
  });

  /**
   * @regression   DEV-3901 — CrudService.update() compared the scope fields after mergePlain() had merged the input
   *   into the stored object, so a record handed to another owner looked unchanged and the previous owner kept it.
   * @seen-failing Return the stored object itself from CrudService.syncAccessSnapshot() in
   *   src/core/common/services/crud.service.ts — registered as mutation `sync-scope-move-reads-merged-record` in
   *   tests/regression-mutations.json.
   */
  syncIt('resync-access-scope', driver, async () => {
    const alice = await signUp('scope-a');
    const bob = await signUp('scope-b');
    const tenantId = tenant();
    await member(tenantId, alice.id);
    await member(tenantId, bob.id);
    const task = await create('SyncTask', { ownerId: alice.id, title: 'mine' }, { tenant: tenantId, token: alice.token });
    const aliceCursor = (await pullAll('SyncTask', { tenant: tenantId, token: alice.token })).cursor;
    const bobCursor = (await pullAll('SyncTask', { tenant: tenantId, token: bob.token })).cursor;

    // Alice hands the task to bob: it leaves her scope
    expect((await change('SyncTask', task.id, 1, { ownerId: bob.id }, { tenant: tenantId, token: alice.token })).status).toBe(
      'applied',
    );
    expect(await pull('SyncTask', { cursor: aliceCursor, statusCode: 410, tenant: tenantId, token: alice.token })).toMatchObject({
      reason: 'access',
    });
    const bobDelta = await pullAll('SyncTask', { cursor: bobCursor, tenant: tenantId, token: bob.token });
    expect(latest(bobDelta.items).get(task.id)).toMatchObject({ data: { ownerId: bob.id }, version: 2 });
  });

  syncIt('resync-access-tenant', driver, async () => {
    const erin = await signUp('tenant-e');
    const frank = await signUp('tenant-f');
    const tenantA = tenant();
    const tenantB = tenant();
    await member(tenantA, erin.id);
    await member(tenantB, erin.id);
    await member(tenantA, frank.id);

    // Without a header erin pulls both tenants; losing one changes her access
    const erinCursor = (await pullAll('SyncTask', { token: erin.token })).cursor;
    await harness.tenantService.removeMember(tenantB, erin.id);
    harness.tenantGuard.invalidateUser(erin.id);
    expect(await pull('SyncTask', { cursor: erinCursor, statusCode: 410, token: erin.token })).toMatchObject({
      reason: 'access',
    });

    // An invalidated tenant: every member resyncs (the epoch is bumped in the background)
    const frankCursor = (await pullAll('SyncTask', { tenant: tenantA, token: frank.token })).cursor;
    harness.tenantGuard.invalidateTenant(tenantA);
    let resynced: any;
    for (let attempt = 0; attempt < 20 && !resynced; attempt++) {
      resynced = await pull('SyncTask', { cursor: frankCursor, statusCode: 410, tenant: tenantA, token: frank.token }).catch(
        () => new Promise((resolve) => setTimeout(() => resolve(undefined), 100)),
      );
    }
    expect(resynced).toMatchObject({ reason: 'access' });
  });

  // --- push ----------------------------------------------------------------------------------------------------

  /**
   * @regression   DEV-3901 — the client's id went into the input, and mapping the input to its class dropped it: the
   *   record got a server id and the client's own id answered not_found.
   * @seen-failing Drop `createId` from the create in CoreSyncService.applyCreate() in
   *   src/core/modules/sync/core-sync.service.ts — registered as mutation `sync-create-drops-client-id` in
   *   tests/regression-mutations.json.
   */
  syncIt('push-create', driver, async () => {
    const alice = await signUp('create');
    const id = clientObjectId();
    const result = await pushOne('SyncNote', { data: { title: 'hello' }, id, mutationId: mutationId(), op: 'upsert' }, { token: alice.token });
    expect(result).toMatchObject({ id, status: 'applied', version: 1 });
    expect(latest((await pullAll('SyncNote', { token: alice.token })).items).get(id)).toMatchObject({
      data: { title: 'hello' },
      version: 1,
    });
  });

  syncIt('push-create-repeat', driver, async () => {
    const alice = await signUp('repeat');
    const id = clientObjectId();
    const item = { data: { title: 'first' }, id, mutationId: mutationId(), op: 'upsert' };
    expect(await pushOne('SyncNote', item, { token: alice.token })).toMatchObject({ status: 'applied', version: 1 });
    // The response was lost: the same mutation is answered with its outcome
    expect(await pushOne('SyncNote', item, { token: alice.token })).toMatchObject({ status: 'applied', version: 1 });
    // Another mutation creating the same id meets the record — never a second one, never compared with data
    const again = await pushOne('SyncNote', { ...item, data: { title: 'second' }, mutationId: mutationId() }, { token: alice.token });
    expect(again).toMatchObject({ record: { data: { title: 'first' }, id, version: 1 }, status: 'conflict', version: 1 });
    const pulled = (await pullAll('SyncNote', { token: alice.token })).items.filter((entry: any) => entry.id === id);
    expect(latest(pulled).get(id)).toMatchObject({ data: { title: 'first' }, version: 1 });
  });

  syncIt('push-update', driver, async () => {
    const alice = await signUp('update');
    const note = await create('SyncNote', { title: 'v1' }, { token: alice.token });
    expect(await change('SyncNote', note.id, 1, { title: 'v2' }, { token: alice.token })).toMatchObject({
      status: 'applied',
      version: 2,
    });
    expect(latest((await pullAll('SyncNote', { token: alice.token })).items).get(note.id)).toMatchObject({
      data: { title: 'v2' },
      version: 2,
    });
  });

  syncIt('push-conflict-reject', driver, async () => {
    const alice = await signUp('reject');
    const tenantId = tenant();
    await member(tenantId, alice.id);
    const options = { tenant: tenantId, token: alice.token };
    const task = await create('SyncTask', { title: 'a' }, options);
    expect((await change('SyncTask', task.id, 1, { title: 'b' }, options)).status).toBe('applied');
    const late = await change('SyncTask', task.id, 1, { title: 'c' }, options);
    expect(late).toMatchObject({ record: { data: { title: 'b' }, version: 2 }, status: 'conflict', version: 2 });
    expect(latest((await pullAll('SyncTask', options)).items).get(task.id)).toMatchObject({ data: { title: 'b' }, version: 2 });
  });

  syncIt('push-strategy-lww', driver, async () => {
    const alice = await signUp('lww');
    const options = { token: alice.token };
    const item = await create('SyncLww', { count: 0, title: 'a' }, options, generateUuidV7());
    expect(item.status).toBe('applied');
    expect((await change('SyncLww', item.id, 1, { count: 1 }, options)).status).toBe('applied');
    // Based on version 1, arriving last: applied on top — the other field stays
    expect(await change('SyncLww', item.id, 1, { title: 'late' }, options)).toMatchObject({ status: 'applied', version: 3 });
    expect(latest((await pullAll('SyncLww', options)).items).get(item.id)).toMatchObject({
      data: { count: 1, title: 'late' },
      version: 3,
    });
  });

  syncIt('push-strategy-merge', driver, async () => {
    const alice = await signUp('merge');
    const options = { token: alice.token };
    const note = await create('SyncNote', { body: 'b1', priority: 1, title: 't1' }, options);
    expect((await change('SyncNote', note.id, 1, { body: 'b2' }, options)).status).toBe('applied');
    // Based on version 1: the client's field wins, the server's change of another field stays
    const merged = await change('SyncNote', note.id, 1, { title: 't2' }, options, { fields: ['title'] });
    expect(merged).toMatchObject({ record: { data: { body: 'b2', title: 't2' }, version: 3 }, status: 'merged', version: 3 });
    // A @SyncField('reject') field still conflicts
    const priority = await change('SyncNote', note.id, 1, { priority: 5 }, options);
    expect(priority).toMatchObject({ record: { data: { priority: 1 }, version: 3 }, status: 'conflict' });
    expect((await change('SyncNote', note.id, 3, { priority: 5 }, options)).status).toBe('applied');
  });

  syncIt('push-strategy-custom', driver, async () => {
    const alice = await signUp('custom');
    const options = { token: alice.token };
    const item = await create('SyncCustom', { title: 'a' }, options);
    expect((await change('SyncCustom', item.id, 1, { title: 'b' }, options)).status).toBe('applied');
    expect(await change('SyncCustom', item.id, 1, { title: 'c' }, options)).toMatchObject({
      record: { data: { title: 'b+c' }, version: 3 },
      status: 'merged',
    });
    expect(await change('SyncCustom', item.id, 1, { refuse: true, title: 'd' }, options)).toMatchObject({
      code: 'CUSTOM_REFUSED',
      status: 'rejected',
    });
    expect(latest((await pullAll('SyncCustom', options)).items).get(item.id)).toMatchObject({ data: { title: 'b+c' } });
  });

  syncIt('push-delete', driver, async () => {
    const alice = await signUp('delete');
    const options = { token: alice.token };
    const note = await create('SyncNote', { title: 'doomed' }, options);
    expect(await remove('SyncNote', note.id, 1, options)).toMatchObject({ status: 'applied', version: 2 });
    expect(latest((await pullAll('SyncNote', options)).items).get(note.id).deletedAt).toBeTruthy();
    // Deleting a tombstone again: what the client wanted is what the server has
    expect(await remove('SyncNote', note.id, 1, options)).toMatchObject({ status: 'applied', version: 2 });
    // Never a silent resurrection
    const revived = await change('SyncNote', note.id, 2, { title: 'back' }, options);
    expect(revived).toMatchObject({ status: 'conflict', version: 2 });
    expect(revived.record.deletedAt).toBeTruthy();
    expect((await create('SyncNote', { title: 'again' }, options, note.id)).status).toBe('conflict');
    const other = await create('SyncNote', { title: 'other' }, options);
    expect(await remove('SyncNote', other.id, undefined, options)).toMatchObject({
      code: 'VALIDATION_FAILED',
      status: 'rejected',
    });
  });

  syncIt('push-validation', driver, async () => {
    const alice = await signUp('validation');
    const bob = await signUp('validation-b');
    const options = { token: alice.token };
    const invalid = await create('SyncNote', { title: 123 }, options);
    expect(invalid).toMatchObject({ code: 'VALIDATION_FAILED', status: 'rejected' });
    expect(invalid.details).toBeDefined();
    const sneaky = await create(
      'SyncNote',
      { createdBy: bob.id, deletedAt: new Date().toISOString(), title: 'sneaky', version: 99 },
      options,
    );
    expect(sneaky).toMatchObject({ status: 'applied', version: 1 });
    expect(latest((await pullAll('SyncNote', options)).items).get(sneaky.id)).toMatchObject({
      data: { createdBy: alice.id, title: 'sneaky' },
      deletedAt: null,
      version: 1,
    });
  });

  syncIt('push-invalid-id', driver, async () => {
    const alice = await signUp('invalid-id');
    const options = { token: alice.token };
    for (const [model, id] of [
      ['SyncNote', 'abc'],
      ['SyncNote', generateUuidV7()],
      ['SyncLww', clientObjectId()],
      ['SyncLww', randomUUID()],
    ]) {
      expect(await create(model, { title: 'x' }, options, id)).toMatchObject({ code: 'INVALID_ID', status: 'rejected' });
    }
  });

  /**
   * @regression   DEV-3901 — the roles of a project's routes do not reach /sync: an update without the model's sync roles
   *   lets any member who may read a record overwrite it.
   * @seen-failing Drop the update roles from CoreSyncService.update() in src/core/modules/sync/core-sync.service.ts —
   *   registered as mutation `sync-push-update-without-roles` in tests/regression-mutations.json.
   */
  syncIt('push-roles', driver, async () => {
    const alice = await signUp('roles-a');
    const bob = await signUp('roles-b');
    expect(await create('SyncLocked', { title: 'x' }, { token: alice.token })).toMatchObject({
      code: 'FORBIDDEN',
      status: 'rejected',
    });
    expect((await create('SyncLocked', { title: 'x' }, { token: adminToken })).status).toBe('applied');

    const tenantId = tenant();
    await member(tenantId, alice.id);
    await member(tenantId, bob.id);
    const task = await create('SyncTask', { title: 'alice' }, { tenant: tenantId, token: alice.token });
    // Bob sees the task (no owner) but is not its creator
    expect(await change('SyncTask', task.id, 1, { title: 'bob' }, { tenant: tenantId, token: bob.token })).toMatchObject({
      code: 'FORBIDDEN',
      status: 'rejected',
    });
    expect(await remove('SyncTask', task.id, 1, { tenant: tenantId, token: bob.token })).toMatchObject({
      code: 'FORBIDDEN',
      status: 'rejected',
    });
    expect(latest((await pullAll('SyncTask', { tenant: tenantId, token: alice.token })).items).get(task.id)).toMatchObject({
      data: { title: 'alice' },
      deletedAt: null,
      version: 1,
    });
  });

  /**
   * @regression   DEV-3901 — a push read the existing record without the model's pull roles and answered a create on
   *   a taken id (or a stale baseVersion) with that record: content of a model the caller may not pull — ADMIN only by
   *   default — went to any signed-in user who knew an id.
   * @seen-failing Drop the pull roles from CoreSyncService.findVisible() in src/core/modules/sync/core-sync.service.ts —
   *   registered as mutation `sync-push-reads-without-pull-roles` in tests/regression-mutations.json.
   */
  syncIt('push-without-pull-roles', driver, async () => {
    const alice = await signUp('no-pull');
    const locked = await create('SyncLocked', { title: 'admin only' }, { token: adminToken });
    expect(locked.status).toBe('applied');
    await pull('SyncLocked', { statusCode: 403, token: alice.token });

    const asCreate = await create('SyncLocked', { title: 'x' }, { token: alice.token }, locked.id);
    expect(asCreate).toMatchObject({ code: 'FORBIDDEN', status: 'rejected' });
    expect(asCreate).not.toHaveProperty('record');
    for (const baseVersion of [1, 999]) {
      const asChange = await change('SyncLocked', locked.id, baseVersion, { title: 'x' }, { token: alice.token });
      expect(asChange).toMatchObject({ status: 'not_found' });
      expect(asChange).not.toHaveProperty('record');
    }
    const asDelete = await remove('SyncLocked', locked.id, 1, { token: alice.token });
    expect(asDelete).toMatchObject({ status: 'not_found' });
    expect(JSON.stringify(asCreate)).not.toContain('admin only');

    // The same push by a caller who may pull: the conflict carries the record
    const asAdmin = await create('SyncLocked', { title: 'y' }, { token: adminToken }, locked.id);
    expect(asAdmin).toMatchObject({ record: { data: { title: 'admin only' } }, status: 'conflict' });
  });

  syncIt('push-items-independent', driver, async () => {
    const alice = await signUp('independent');
    const first = clientObjectId();
    const second = clientObjectId();
    const { results } = await push(
      'SyncNote',
      [
        { data: { title: 'one' }, id: first, mutationId: mutationId(), op: 'upsert' },
        { data: { title: 42 }, id: clientObjectId(), mutationId: mutationId(), op: 'upsert' },
        { data: { title: 'two' }, id: second, mutationId: mutationId(), op: 'upsert' },
      ],
      { token: alice.token },
    );
    expect(results.map((result: any) => result.status)).toEqual(['applied', 'rejected', 'applied']);
    const ids = (await pullAll('SyncNote', { token: alice.token })).items.map((item: any) => item.id);
    expect(ids).toEqual(expect.arrayContaining([first, second]));
  });

  syncIt('push-body-invalid', driver, async () => {
    const alice = await signUp('body');
    const valid = { data: { title: 'never' }, id: clientObjectId(), mutationId: mutationId(), op: 'upsert' };
    const send = (payload: unknown) =>
      testHelper.rest('/sync/SyncNote', { method: 'POST', payload, statusCode: 400, token: alice.token });
    await send({});
    await send({ items: 'nope' });
    await send({ items: [valid, { ...valid, mutationId: mutationId(), op: 'patch' }] });
    await send({ items: [valid, { id: clientObjectId(), op: 'upsert' }] });
    await send({ items: Array.from({ length: 101 }, () => ({ ...valid, id: clientObjectId(), mutationId: mutationId() })) });
    const ids = (await pullAll('SyncNote', { token: alice.token })).items.map((item: any) => item.id);
    expect(ids).not.toContain(valid.id);
  });

  syncIt('push-two-tabs', driver, async () => {
    const alice = await signUp('tabs');
    const options = { token: alice.token };
    const id = clientObjectId();
    const createItem = { data: { title: 'tab' }, id, mutationId: mutationId(), op: 'upsert' };
    const settle = async (item: any) => {
      const outcomes = await Promise.all([pushOne('SyncNote', item, options), pushOne('SyncNote', item, options)]);
      expect(outcomes.every((outcome: any) => ['applied', 'retry'].includes(outcome.status))).toBe(true);
      for (const outcome of outcomes.filter((entry: any) => entry.status === 'retry')) {
        expect(outcome.id).toBe(item.id);
        // The retried tab gets the recorded outcome
        expect((await pushOne('SyncNote', item, options)).status).toBe('applied');
      }
      return outcomes.find((entry: any) => entry.status === 'applied');
    };
    expect(await settle(createItem)).toMatchObject({ status: 'applied', version: 1 });
    expect(await settle({ baseVersion: 1, data: { title: 'tab 2' }, id, mutationId: mutationId(), op: 'upsert' })).toMatchObject({
      status: 'applied',
      version: 2,
    });
    const pulled = (await pullAll('SyncNote', options)).items.filter((item: any) => item.id === id);
    // One record, changed once: version 2, not 3
    expect(latest(pulled).get(id)).toMatchObject({ data: { title: 'tab 2' }, version: 2 });
  });

  syncIt('push-expired-session', driver, async () => {
    const alice = await signUp('expired');
    const item = { data: { title: 'offline' }, id: clientObjectId(), mutationId: mutationId(), op: 'upsert' };
    await push('SyncNote', [item], { statusCode: 401, token: `${alice.token}x` });
    await push('SyncNote', [item], { statusCode: 401 });
    expect((await pullAll('SyncNote', { token: alice.token })).items.map((entry: any) => entry.id)).not.toContain(item.id);
    const token = await signIn(alice.email);
    expect(await pushOne('SyncNote', item, { token })).toMatchObject({ status: 'applied', version: 1 });
    expect(await pushOne('SyncNote', item, { token })).toMatchObject({ status: 'applied', version: 1 });
    const pulled = (await pullAll('SyncNote', { token })).items.filter((entry: any) => entry.id === item.id);
    expect(latest(pulled).get(item.id)).toMatchObject({ version: 1 });
  });

  syncIt('push-cookie-origin', driver, async () => {
    const email = unique('cookie');
    await testHelper.rest('/iam/sign-up/email', {
      method: 'POST',
      payload: { email, name: 'Sync Cookie', password: PASSWORD, termsAndPrivacyAccepted: true },
      statusCode: 201,
    });
    await testHelper.rest('/iam/sign-in/email', { method: 'POST', payload: { email, password: PASSWORD }, statusCode: 200 });
    const userId = String((await harness.users.findOne({ email } as any)).id);
    const cookies = String((await harness.betterAuth.getActiveSessionForUser(userId)).session?.token);
    const trusted = (buildCorsConfig(ConfigService.configFastButReadOnly) as any).origin?.[0];
    expect(typeof trusted).toBe('string');
    const item = () => ({ data: { title: 'cookie' }, id: clientObjectId(), mutationId: mutationId(), op: 'upsert' });

    await push('SyncNote', [item()], { cookies, headers: { origin: 'https://evil.example' }, statusCode: 403 });
    await push('SyncNote', [item()], { cookies, headers: { 'sec-fetch-site': 'cross-site' }, statusCode: 403 });
    await testHelper.rest('/sync/SyncNote', {
      cookies,
      headers: { 'content-type': 'text/plain' },
      method: 'POST',
      payload: JSON.stringify({ items: [item()] }),
      statusCode: 400,
    });
    const accepted = await push('SyncNote', [item()], { cookies, headers: { origin: trusted, 'sec-fetch-site': 'same-site' } });
    expect(accepted.results[0].status).toBe('applied');
    // Without fetch metadata (a native client) the cookie works too
    expect((await push('SyncNote', [item()], { cookies })).results[0].status).toBe('applied');
  });

  syncIt('push-api-token-refused', driver, async () => {
    const alice = await signUp('api-token');
    const created: any = await harness.moduleRef
      .get((await import('../src')).CoreApiTokenService, { strict: false })
      .createUserToken({ name: 'sync', scopes: ['read'] }, await harness.users.findById(alice.id).then((user: any) => ({ ...user, hasRole: () => false })));
    const token = String(created.token);
    // Refused like on every route that releases no scope — before the sync service sees the request
    await pull('SyncNote', { statusCode: 403, token });
    const id = clientObjectId();
    await push('SyncNote', [{ data: { title: 'x' }, id, mutationId: mutationId(), op: 'upsert' }], {
      statusCode: 403,
      token,
    });
    const ids = (await pullAll('SyncNote', { token: alice.token })).items.map((item: any) => item.id);
    expect(ids).not.toContain(id);
  });

  // --- tenants -------------------------------------------------------------------------------------------------

  /**
   * @regression   DEV-3901 — the tenant guard admits an S_USER route without resolving memberships, so a pull without
   *   X-Tenant-Id hit the tenant policy's safety net (403) instead of spanning the caller's tenants.
   * @seen-failing Drop the scopeTenants() call from CoreSyncController.pull() in
   *   src/core/modules/sync/core-sync.controller.ts — registered as mutation `sync-header-less-pull-unscoped` in
   *   tests/regression-mutations.json.
   */
  syncIt('tenant-pull-isolation', driver, async () => {
    const alice = await signUp('iso-a');
    const mallory = await signUp('iso-m');
    const tenantA = tenant();
    const tenantB = tenant();
    await member(tenantA, alice.id);
    await member(tenantB, mallory.id);
    const live = await create('SyncTask', { title: 'b live' }, { tenant: tenantB, token: mallory.token });
    const gone = await create('SyncTask', { title: 'b gone' }, { tenant: tenantB, token: mallory.token });
    await remove('SyncTask', gone.id, 1, { tenant: tenantB, token: mallory.token });
    const own = await create('SyncTask', { title: 'a own' }, { tenant: tenantA, token: alice.token });

    for (const options of [{ tenant: tenantA, token: alice.token }, { token: alice.token }]) {
      const ids = (await pullAll('SyncTask', options)).items.map((item: any) => item.id);
      expect(ids).toContain(own.id);
      expect(ids).not.toContain(live.id);
      expect(ids).not.toContain(gone.id);
    }
    // A header naming a tenant alice does not belong to is refused outright
    await pull('SyncTask', { statusCode: 403, tenant: tenantB, token: alice.token });
  });

  syncIt('tenant-push-foreign-id', driver, async () => {
    const alice = await signUp('foreign-a');
    const mallory = await signUp('foreign-m');
    const tenantA = tenant();
    const tenantB = tenant();
    await member(tenantA, alice.id);
    await member(tenantB, mallory.id);
    const foreign = await create('SyncTask', { title: 'b' }, { tenant: tenantB, token: mallory.token });
    const options = { tenant: tenantA, token: alice.token };
    expect(await create('SyncTask', { title: 'steal' }, options, foreign.id)).toMatchObject({
      code: 'ID_UNAVAILABLE',
      status: 'rejected',
    });
    // The same answer as an id nobody uses — nothing about tenant, owner or content
    const unavailable = await create('SyncTask', { title: 'steal' }, options, foreign.id);
    expect(Object.keys(unavailable).sort()).toEqual(['code', 'id', 'mutationId', 'status']);
    expect(await change('SyncTask', foreign.id, 1, { title: 'steal' }, options)).toMatchObject({ status: 'not_found' });
    expect(await remove('SyncTask', foreign.id, 1, options)).toMatchObject({ status: 'not_found' });
    expect(await change('SyncTask', clientObjectId(), 1, { title: 'x' }, options)).toMatchObject({ status: 'not_found' });
    expect(latest((await pullAll('SyncTask', { tenant: tenantB, token: mallory.token })).items).get(foreign.id)).toMatchObject({
      data: { title: 'b' },
      deletedAt: null,
      version: 1,
    });
  });

  syncIt('tenant-tombstone-scope', driver, async () => {
    const alice = await signUp('scope-owner');
    const bob = await signUp('scope-other');
    const tenantId = tenant();
    await member(tenantId, alice.id);
    await member(tenantId, bob.id);
    const task = await create('SyncTask', { ownerId: alice.id, title: 'private' }, { tenant: tenantId, token: alice.token });
    await remove('SyncTask', task.id, 1, { tenant: tenantId, token: alice.token });
    expect(latest((await pullAll('SyncTask', { tenant: tenantId, token: alice.token })).items).get(task.id)).toMatchObject({
      ownerId: alice.id,
      version: 2,
    });
    expect((await pullAll('SyncTask', { tenant: tenantId, token: bob.token })).items.map((item: any) => item.id)).not.toContain(
      task.id,
    );
  });

  /**
   * @regression   DEV-3901 — a create without X-Tenant-Id ran with the caller's membership list, from which nothing
   *   can stamp a tenant: MongoDB stored the record without one — applied, then invisible to everyone, its creator
   *   included — while SQL refused it.
   * @seen-failing Drop the single-tenant check from CoreSyncService.applyCreate() in
   *   src/core/modules/sync/core-sync.service.ts — registered as mutation `sync-create-without-tenant-stored-tenantless`
   *   in tests/regression-mutations.json.
   */
  syncIt('push-create-without-tenant', driver, async () => {
    const alice = await signUp('no-tenant');
    const tenantA = tenant();
    await member(tenantA, alice.id);
    expect(await create('SyncTask', { title: 'nowhere' }, { token: alice.token })).toMatchObject({
      code: 'FORBIDDEN',
      status: 'rejected',
    });
    const placed = await create('SyncTask', { title: 'in a' }, { tenant: tenantA, token: alice.token });
    expect(placed.status).toBe('applied');
    const items = latest((await pullAll('SyncTask', { token: alice.token })).items);
    expect(items.get(placed.id)).toMatchObject({ data: { title: 'in a' }, deletedAt: null });
  });

  // --- hints (protocol §9) -------------------------------------------------------------------------------------

  syncIt('hints-sse', driver, async () => {
    const alice = await signUp('hints-sse');
    const stream = await openHints({ token: alice.token });
    // Narrowed to another model (and a name that does not exist, which simply never matches)
    const narrowed = await openHints({ models: 'SyncLww,NoSuchModel', token: alice.token });
    try {
      expect(stream.status).toBe(200);
      expect(narrowed.status).toBe(200);
      await create('SyncNote', { body: 'secret body', title: 'hinted' }, { token: alice.token });
      expect(await until(() => stream.of('SyncNote').length > 0)).toBe(true);
      const [hint] = stream.of('SyncNote');
      // The model and the time — nothing of the record
      expect(Object.keys(hint).sort()).toEqual(['at', 'model']);
      expect(Number.isNaN(new Date(hint.at).getTime())).toBe(false);
      expect(JSON.stringify(stream.events)).not.toContain('secret body');
      await sleep(HINT_SETTLE_MS);
      expect(narrowed.of('SyncNote')).toEqual([]);
      await create('SyncLww', { count: 1, title: 'lww' }, { token: alice.token }, generateUuidV7());
      expect(await until(() => narrowed.of('SyncLww').length > 0)).toBe(true);
    } finally {
      stream.close();
      narrowed.close();
    }
  });

  /**
   * @regression   DEV-3902 — a hint names only the model, but it still tells that something changed: one for another
   *   tenant's write would tell a member when a foreign tenant works, over SSE and the GraphQL subscription alike.
   * @seen-failing Let CoreSyncService.hintFilter() accept every tenant (src/core/modules/sync/core-sync.service.ts) —
   *   registered as mutation `sync-hints-tenant-unfiltered` in tests/regression-mutations.json.
   */
  syncIt('hints-tenant', driver, async () => {
    const alice = await signUp('hints-a');
    const mallory = await signUp('hints-m');
    const tenantA = tenant();
    const tenantB = tenant();
    await member(tenantA, alice.id);
    await member(tenantB, mallory.id);
    const writeA = () => create('SyncTask', { title: 'a' }, { tenant: tenantA, token: alice.token });
    const writeB = () => create('SyncTask', { title: 'b' }, { tenant: tenantB, token: mallory.token });
    // Without the header the stream spans alice's memberships; the socket names her tenant
    const stream = await openHints({ token: alice.token });
    const socket = await subscribeHints({ tenant: tenantA, token: alice.token });
    try {
      await awaitLive(stream, writeA, 'SyncTask');
      expect(await until(() => socket.of('SyncTask').length > 0)).toBe(true);
      stream.events.length = 0;
      socket.events.length = 0;

      await writeB();
      await sleep(HINT_SETTLE_MS);
      expect(stream.of('SyncTask')).toEqual([]);
      expect(socket.of('SyncTask')).toEqual([]);
      expect(socket.errors).toEqual([]);

      // The same channels still receive their own tenant's changes
      await writeA();
      expect(await until(() => stream.of('SyncTask').length > 0 && socket.of('SyncTask').length > 0)).toBe(true);
    } finally {
      stream.close();
      await socket.close();
    }
  });

  /**
   * @regression   DEV-3902 — a hint channel delivers only models the subscriber may pull: without the check a user
   *   learns when records of an ADMIN-only model change.
   * @seen-failing Drop the pull-role check from CoreSyncService.hintFilter() (src/core/modules/sync/core-sync.service.ts)
   *   — registered as mutation `sync-hints-roles-unchecked` in tests/regression-mutations.json.
   */
  syncIt('hints-roles', driver, async () => {
    const alice = await signUp('hints-roles');
    const mine = await openHints({ token: alice.token });
    const admins = await openHints({ token: adminToken });
    try {
      await awaitLive(admins, () => create('SyncLocked', { title: 'x' }, { token: adminToken }), 'SyncLocked');
      // The write that reached the administrator sent alice nothing: she may not pull SyncLocked
      expect(mine.of('SyncLocked')).toEqual([]);
      // Her stream is live: a model she may pull reaches her
      await create('SyncNote', { title: 'y' }, { token: alice.token });
      expect(await until(() => mine.of('SyncNote').length > 0)).toBe(true);
    } finally {
      mine.close();
      admins.close();
    }
  });

  /**
   * @regression   DEV-3902 — a hint stream outlives the request that authorized it; registered like a GraphQL
   *   WebSocket, an invalidation naming the subscriber ends it, and the reconnect passes the guards again.
   * @seen-failing Leave the stream out of the connection registry in CoreSyncService.openHintStream()
   *   (src/core/modules/sync/core-sync.service.ts) — registered as mutation `sync-sse-not-registered` in
   *   tests/regression-mutations.json.
   */
  syncIt('hints-revalidation', driver, async () => {
    const alice = await signUp('hints-reval');
    const tenantA = tenant();
    await member(tenantA, alice.id);
    const stream = await openHints({ tenant: tenantA, token: alice.token });
    try {
      expect(stream.status).toBe(200);
      await sleep(100);
      expect(stream.ended).toBe(false);
      harness.tenantGuard.invalidateUser(alice.id);
      expect(await until(() => stream.ended)).toBe(true);
      const again = await openHints({ tenant: tenantA, token: alice.token });
      expect(again.status).toBe(200);
      again.close();
    } finally {
      stream.close();
    }
  });

  // --- concurrent writers --------------------------------------------------------------------------------------

  /**
   * The cursor's promise under load (protocol §5.3): writers on several pooled connections create and change records
   * while the client pulls page after page. Whatever order the writes commit in, the client ends with every record in
   * its final version. Separate application processes with skewed clocks were measured with the phase-2 prototypes
   * (plan §5); the clock of an application never stamps a change (DEV-3900, `sync-server-clock`).
   *
   * @regression   DEV-3901 — Mongoose's UUID type refuses $gt, so a page boundary inside one server millisecond could not
   *   be continued for a uuidv7 model on MongoDB (503).
   * @seen-failing Drop the allowUuidRanges() call from applySyncSchema() in
   *   src/core/common/persistence/mongo/sync-schema.plugin.ts — registered as mutation `sync-uuid-range-refused` in
   *   tests/regression-mutations.json.
   */
  syncIt(
    'pull-during-writes',
    driver,
    async () => {
      const writers = await Promise.all([signUp('writer-a'), signUp('writer-b'), signUp('writer-c')]);
      const reader = await signUp('reader');
      let cursor = (await pullAll('SyncLww', { token: reader.token })).cursor;
      const seen: any[] = [];
      // An object, so the reader sees the writers' flag change across the await
      const state = { writing: true };
      const reading = (async () => {
        while (state.writing) {
          const page = await pull('SyncLww', { cursor, limit: 5, token: reader.token });
          seen.push(...page.items);
          cursor = page.cursor;
        }
      })();
      const ids = Array.from({ length: 18 }, () => generateUuidV7());
      try {
        await Promise.all(
          ids.map(async (id, index) => {
            const options = { token: writers[index % writers.length].token };
            expect((await create('SyncLww', { count: 0, title: 'during' }, options, id)).status).toBe('applied');
            expect((await change('SyncLww', id, 1, { count: 1 }, options)).status).toBe('applied');
            expect((await change('SyncLww', id, 2, { count: 2 }, { token: writers[(index + 1) % writers.length].token })).status).toBe(
              'applied',
            );
          }),
        );
      } finally {
        state.writing = false;
        await reading;
      }
      seen.push(...(await pullAll('SyncLww', { cursor, token: reader.token })).items);
      const byId = latest(seen);
      for (const id of ids) {
        expect(byId.get(id), id).toMatchObject({ data: { count: 2 }, version: 3 });
      }
    },
    90_000,
  );

  // --- cleanup and migrations (plan §3.7 E8, §10) -------------------------------------------------------------

  /**
   * @regression   DEV-3902 — the purge removes tombstones for good; a cursor older than them continued past
   *   deletions it would never receive. The horizon moves first, and such a cursor answers 410 `horizon`.
   * @seen-failing Drop the horizon from CoreSyncService.purgeTombstones() (src/core/modules/sync/core-sync.service.ts) —
   *   registered as mutation `sync-purge-continues-past-horizon` in tests/regression-mutations.json.
   */
  syncIt('purge-horizon', driver, async () => {
    const alice = await signUp('purge');
    const note = await create('SyncNote', { title: 'old' }, { token: alice.token });
    expect((await remove('SyncNote', note.id, 1, { token: alice.token })).status).toBe('applied');
    const run = await pullAll('SyncNote', { token: alice.token });
    expect(latest(run.items).get(note.id)?.deletedAt).toBeTruthy();

    await sleep(5);
    const removed = await harness.sync.purgeTombstones({ before: new Date(), model: 'SyncNote' });
    expect(removed.SyncNote).toBeGreaterThanOrEqual(1);
    expect(await pull('SyncNote', { cursor: run.cursor, statusCode: 410, token: alice.token })).toMatchObject({
      reason: 'horizon',
    });
    // The resync starts clean, and the purged tombstone is gone for good
    const fresh = await pullAll('SyncNote', { token: alice.token });
    expect(latest(fresh.items).has(note.id)).toBe(false);
  });

  /**
   * @regression   DEV-3902 — a data migration's multi-row write on a synchronized table bypassed the store: its rows
   *   kept their version, so a client that had edited the old content overwrote the migration without a conflict.
   * @seen-failing Drop the version increment from applySyncUpdate() in src/core/modules/migrate/sql-migration.helper.ts —
   *   registered as mutation `sync-migration-update-unversioned` in tests/regression-mutations.json.
   */
  syncIt('migration-sync-update', driver, async () => {
    const alice = await signUp('migrate');
    const notes: any[] = [];
    for (const title of ['m-a', 'm-b', 'm-c']) {
      notes.push(await create('SyncNote', { title }, { token: alice.token }));
    }
    const first = await pullAll('SyncNote', { token: alice.token });
    const ids = notes.slice(0, 2).map((note) => `'${note.id}'`).join(', ');
    await runSqlMigration(
      String(config.database.ownerUrl),
      [{ syncUpdate: { set: "title = 'migrated'", table: tableName(getModelDescriptor('SyncNote')!), where: `id IN (${ids})` } }],
      { engine: config.database.sqlEngine },
    );
    const next = latest((await pullAll('SyncNote', { cursor: first.cursor, token: alice.token })).items);
    for (const note of notes.slice(0, 2)) {
      expect(next.get(note.id)).toMatchObject({ data: { title: 'migrated' }, version: 2 });
    }
    expect(next.has(notes[2].id)).toBe(false);
    // A client still holding version 1 meets a conflict on a `reject` field, not a silent overwrite
    expect(await change('SyncNote', notes[0].id, 1, { priority: 5 }, { token: alice.token })).toMatchObject({
      status: 'conflict',
    });
  });

  // --- infrastructure stores (E7) ------------------------------------------------------------------------------

  const mutationStore = (claimTimeoutMs = 30_000, retentionMs = 60_000) =>
    new CoreSyncMutationStore(harness.moduleRef.get(getStoreToken('SyncMutation'), { strict: false }), {
      claimTimeoutMs,
      retentionMs,
    });
  const stateStore = () => new CoreSyncStateStore(harness.moduleRef.get(getStoreToken('SyncState'), { strict: false }));

  syncIt('store-mutation-claim', driver, async () => {
    const store = mutationStore();
    const key = CoreSyncMutationStore.key('SyncNote', adminId, clientObjectId(), mutationId());
    const claims = await Promise.all(Array.from({ length: 5 }, () => store.claim(key)));
    expect(claims.filter((claim) => claim.kind === 'claimed')).toHaveLength(1);
    expect(claims.filter((claim) => claim.kind === 'busy')).toHaveLength(4);
    await store.complete(key, { status: 'applied', version: 1 });
    expect(await store.claim(key)).toEqual({ kind: 'done', outcome: { status: 'applied', version: 1 } });
    // A released claim is free again
    const other = CoreSyncMutationStore.key('SyncNote', adminId, clientObjectId(), mutationId());
    expect((await store.claim(other)).kind).toBe('claimed');
    await store.release(other);
    expect((await store.claim(other)).kind).toBe('claimed');
  });

  syncIt('store-mutation-takeover', driver, async () => {
    const store = mutationStore(1000, 60_000);
    const key = CoreSyncMutationStore.key('SyncNote', adminId, clientObjectId(), mutationId());
    const start = new Date();
    expect((await store.claim(key, start)).kind).toBe('claimed');
    expect((await store.claim(key, new Date(start.getTime() + 500))).kind).toBe('busy');
    // The claimant died: after the claim timeout exactly one contender takes it over
    const later = new Date(start.getTime() + 2000);
    const contenders = await Promise.all(Array.from({ length: 4 }, () => store.claim(key, later)));
    expect(contenders.filter((claim) => claim.kind === 'claimed')).toHaveLength(1);
    // An entry past its expiry counts as absent, whether or not the TTL removed it yet
    await store.complete(key, { status: 'applied', version: 2 }, later);
    expect((await store.claim(key, new Date(later.getTime() + 61_000))).kind).toBe('claimed');
  });

  syncIt('store-epochs', driver, async () => {
    const store = stateStore();
    const key = CoreSyncStateStore.tenantEpochKey('SyncContract', tenant());
    const untouched = CoreSyncStateStore.userEpochKey('SyncContract', tenant(), adminId);
    await Promise.all(Array.from({ length: 6 }, () => store.bump(key)));
    const epochs = await store.epochs([key, untouched]);
    expect(epochs.get(key)).toBe(6);
    expect(epochs.get(untouched)).toBe(0);
  });

  syncIt('store-horizon', driver, async () => {
    const store = stateStore();
    const model = `SyncContract${randomBytes(4).toString('hex')}`;
    expect(await store.horizon(model)).toBeUndefined();
    const early = new Date(Date.now() - 60_000);
    const late = new Date(Date.now() - 30_000);
    await store.advanceHorizon(model, late);
    await store.advanceHorizon(model, early);
    expect((await store.horizon(model))?.getTime()).toBe(late.getTime());
  });
});
