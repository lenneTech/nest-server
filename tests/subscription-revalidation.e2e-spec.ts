import { INestApplication } from '@nestjs/common';
import { ApolloDriver, ApolloDriverConfig } from '@nestjs/apollo';
import { Field, GraphQLModule, Int, ObjectType, Query, Resolver, Subscription } from '@nestjs/graphql';
import { getModelToken, MongooseModule, Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Test, TestingModule } from '@nestjs/testing';
import { EventEmitter } from 'events';
import { PubSub } from 'graphql-subscriptions';
import { Client, createClient } from 'graphql-ws';
import { Model } from 'mongoose';
import ws = require('ws');
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { registerWsConnection } from '../src/core/common/helpers/graphql-ws-connection.helper';
import {
  buildRequestContextAwareExecute,
  buildRequestContextAwareSubscribe,
} from '../src/core/common/helpers/graphql-ws-context.helper';
import { mongooseTenantPlugin } from '../src/core/common/plugins/mongoose-tenant.plugin';
import { ConfigService } from '../src/core/common/services/config.service';
import { RequestContext } from '../src/core/common/services/request-context.service';
import { CoreTenantMemberModel } from '../src/core/modules/tenant/core-tenant-member.model';
import { TenantMemberStatus } from '../src/core/modules/tenant/core-tenant.enums';
import { CoreTenantGuard } from '../src/core/modules/tenant/core-tenant.guard';
import envConfig from '../src/config.env';
import { deriveTestDbUri } from './db-lifecycle.reporter';

/**
 * An OPEN WebSocket connection loses what its user lost — over a real socket.
 *
 * Until 11.42.3 a connection was authorized once. `onConnect` validated the session and recorded the
 * user, the subscribe wrapper resolved the tenant, and from then on every delivered event and every
 * further operation on the socket ran on that snapshot. Removing somebody from a tenant, switching a
 * tenant off, withdrawing a role or ending a session took effect on every NEW request — and on none of
 * the sockets that were already open, for as long as the client kept them open, which for a browser
 * tab is hours.
 *
 * Two mechanisms close that, and both are driven here:
 *
 *  - an INVALIDATION (`invalidateUser`, `invalidateTenant`, a role change) re-checks the affected
 *    connections at once, before any further event;
 *  - every event and every operation re-checks a connection whose last check is older than
 *    `graphQl.subscriptionRevalidationMs`, which bounds a change nobody invalidated.
 *
 * A connection whose authorization changed is closed with 4403. The graphql-ws client RETRIES that
 * code, so the user reconnects and continues with the rights they hold NOW — the last case proves it.
 *
 * The app is bare on purpose (no CoreModule): `onConnect` registers the connection exactly as the
 * three `CoreModule` driver builders do, with a re-authentication that reads a session table this
 * file controls. `tests/unit/graphql-ws-context-wiring.spec.ts` pins that every builder does register.
 *
 * NOTE ON THE PROCESS-WIDE CONFIG: layered over `envConfig` and restored in `afterAll` — see
 * `tests/tenant-context-surfaces.e2e-spec.ts` for why replacing it breaks unrelated specs.
 *
 * @regression   11.42.3 — an open GraphQL subscription kept the tenant, roles and session it was opened
 *   with until the client reconnected, so a removed membership, a deactivated tenant, a withdrawn role
 *   or a revoked session kept receiving events.
 * @seen-failing Make `ensureWsConnectionCurrent()` in src/core/common/helpers/graphql-ws-connection.helper.ts
 *   return `true` without checking — registered as mutation `ws-connection-never-revalidated` in
 *   tests/regression-mutations.json.
 */

@Schema({ timestamps: true })
class RevalNote {
  @Prop({ type: String })
  tenantId: string;

  @Prop({ required: true, type: String })
  body: string;
}
const RevalNoteSchema = SchemaFactory.createForClass(RevalNote);

@Schema({ timestamps: true })
class TenantMember extends CoreTenantMemberModel {}
const TenantMemberSchema = SchemaFactory.createForClass(TenantMember);
TenantMemberSchema.index({ tenant: 1, user: 1 }, { unique: true });

const TENANT_A = 'reval-tenant-a';
const TENANT_B = 'reval-tenant-b';
const MEMBER_ID = '6a00000000000000000000d1';
const MEMBER = { email: 'reval-member@example.com', id: MEMBER_ID, roles: [] as string[] };

/** token -> user the token currently authenticates as; a missing entry is a revoked session. */
const sessions = new Map<string, any>();
/** Tenants `multiTenancy.isTenantActive` reports as switched off. */
const inactiveTenants = new Set<string>();

const emitter = new EventEmitter();
const pubSub = new PubSub({ eventEmitter: emitter });

@ObjectType()
class RevalProbe {
  @Field(() => String, { nullable: true })
  tenantId?: string;

  /** Rows a tenant-scoped read returns from the delivery path. `-1` = the safety net refused it. */
  @Field(() => Int)
  visibleNotes: number;
}

@Resolver()
class RevalProbeResolver {
  static noteModel: Model<RevalNote>;

  static async probe(): Promise<RevalProbe> {
    const context = RequestContext.get();
    let visibleNotes: number;
    try {
      visibleNotes = (await RevalProbeResolver.noteModel.find({}).lean().exec()).length;
    } catch {
      visibleNotes = -1;
    }
    return { tenantId: context?.tenantId, visibleNotes };
  }

  @Query(() => RevalProbe)
  async revalProbeQuery(): Promise<RevalProbe> {
    return RevalProbeResolver.probe();
  }

  @Subscription(() => RevalProbe, { resolve: () => RevalProbeResolver.probe() })
  async revalProbeSubscription() {
    return pubSub.asyncIterableIterator('reval-probe');
  }
}

const GRAPHQL_OPTIONS: any = {
  autoSchemaFile: true,
  driver: ApolloDriver,
  installSubscriptionHandlers: true,
  subscriptions: {
    execute: buildRequestContextAwareExecute(),
    subscribe: buildRequestContextAwareSubscribe(),
    'graphql-ws': {
      context: ({ extra }: any) => extra,
      onConnect: (ctx: any) => {
        const token = String(ctx.connectionParams?.Authorization ?? '').split(' ')[1];
        const user = sessions.get(token);
        if (!user) {
          return false;
        }
        ctx.extra.user = user;
        ctx.extra.headers = ctx.connectionParams ?? {};
        // Exactly what every CoreModule driver builder does after a successful handshake.
        registerWsConnection({
          carrier: ctx.extra,
          reauthenticate: async () => sessions.get(token) ?? null,
          socket: ctx.extra.socket,
          user,
        });
        return true;
      },
    },
  },
};

interface OpenSubscription {
  client: Client;
  /** Every close the client observed, in order. */
  closes: Array<{ code: number; reason: string }>;
  messages: any[];
  token: string;
}

describe('Open WebSocket connections follow revoked access (e2e)', () => {
  let app: INestApplication;
  let httpServer: any;
  let url: string;
  let tenantGuard: CoreTenantGuard;
  let memberModel: Model<TenantMember>;
  let noteModel: Model<RevalNote>;
  let previousConfig: Record<string, any>;
  let tokenCounter = 0;
  const opened: OpenSubscription[] = [];

  const setRevalidationMs = (value: number) =>
    ConfigService.setConfig(
      {
        ...(previousConfig as any),
        graphQl: { subscriptionRevalidationMs: value },
        multiTenancy: {
          cacheTtlMs: 0,
          isTenantActive: (tenantId: string) => !inactiveTenants.has(tenantId),
          roleHierarchy: { member: 1, owner: 3 },
        },
      } as any,
      { reInit: true, warn: false },
    );

  const listeners = () => emitter.listenerCount('reval-probe');

  const waitUntil = async (condition: () => boolean, label: string, timeoutMs = 8000): Promise<void> => {
    const deadline = Date.now() + timeoutMs;
    while (!condition()) {
      if (Date.now() > deadline) {
        throw new Error(`Timed out waiting for: ${label}`);
      }
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  };

  /** Give an event that WOULD be delivered the time to arrive, so its absence means something. */
  const settle = () => new Promise((resolve) => setTimeout(resolve, 300));

  const open = async (options: { retry?: boolean } = {}): Promise<OpenSubscription> => {
    const token = `reval-token-${++tokenCounter}`;
    sessions.set(token, { ...MEMBER });
    const before = listeners();
    const sub: OpenSubscription = { client: undefined as any, closes: [], messages: [], token };
    sub.client = createClient({
      connectionParams: { Authorization: `Bearer ${token}`, 'x-tenant-id': TENANT_A },
      lazy: false,
      on: { closed: (event: any) => sub.closes.push({ code: event?.code, reason: event?.reason }) },
      // A non-lazy client reports a close it does not retry through `console.error` by default. Here
      // that close IS the asserted outcome, recorded above — printing the whole CloseEvent is noise.
      onNonLazyError: () => undefined,
      retryAttempts: options.retry ? 3 : 0,
      retryWait: async () => undefined,
      url,
      webSocketImpl: ws,
    });
    sub.client.subscribe(
      { query: 'subscription { revalProbeSubscription { tenantId visibleNotes } }' },
      { complete: () => undefined, error: () => undefined, next: (message) => sub.messages.push(message) },
    );
    opened.push(sub);
    await waitUntil(() => listeners() > before, 'subscription registered on the server');
    return sub;
  };

  const publish = () => pubSub.publish('reval-probe', {});

  const seedMembership = () =>
    RequestContext.runWithBypassTenantGuard(async () => {
      await memberModel.deleteMany({});
      await memberModel.create([
        { role: 'owner', status: TenantMemberStatus.ACTIVE, tenant: TENANT_A, user: MEMBER_ID },
      ]);
    });

  const removeMembership = () => RequestContext.runWithBypassTenantGuard(() => memberModel.deleteMany({}).exec());

  beforeAll(async () => {
    previousConfig = { ...(envConfig as any) };
    setRevalidationMs(60_000);

    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [
        MongooseModule.forRoot(deriveTestDbUri('wsreval'), {
          connectionFactory: (connection) => {
            connection.plugin(mongooseTenantPlugin);
            return connection;
          },
        }),
        MongooseModule.forFeature([
          { name: RevalNote.name, schema: RevalNoteSchema },
          { name: 'TenantMember', schema: TenantMemberSchema },
        ]),
        GraphQLModule.forRoot<ApolloDriverConfig>(GRAPHQL_OPTIONS),
      ],
      providers: [RevalProbeResolver, CoreTenantGuard],
    }).compile();

    app = moduleFixture.createNestApplication();
    await app.init();

    tenantGuard = moduleFixture.get(CoreTenantGuard);
    memberModel = moduleFixture.get(getModelToken('TenantMember'));
    noteModel = moduleFixture.get(getModelToken(RevalNote.name));
    RevalProbeResolver.noteModel = noteModel;

    httpServer = app.getHttpServer();
    await new Promise<void>((resolve) => httpServer.listen(0, '127.0.0.1', () => resolve()));
    url = `ws://127.0.0.1:${httpServer.address().port}/graphql`;

    await RequestContext.runWithBypassTenantGuard(async () => {
      await noteModel.deleteMany({});
      await noteModel.create([
        { body: 'own note', tenantId: TENANT_A },
        { body: 'FOREIGN note', tenantId: TENANT_B },
      ]);
    });
  }, 60_000);

  beforeEach(async () => {
    inactiveTenants.clear();
    await seedMembership();
  });

  afterEach(async () => {
    while (opened.length) {
      await opened.pop()!.client.dispose();
    }
    await waitUntil(() => listeners() === 0, 'every subscription released');
  });

  afterAll(async () => {
    if (httpServer) {
      httpServer.closeAllConnections?.();
      await new Promise<void>((resolve) => httpServer.close(() => resolve()));
    }
    await app?.close();
    ConfigService.setConfig(previousConfig as any, { reInit: true, warn: false });
  });

  describe('invalidation re-checks open connections at once', () => {
    beforeEach(() => setRevalidationMs(60_000));

    it('delivers events while nothing changed (control)', async () => {
      const sub = await open();
      await publish();
      await publish();
      await waitUntil(() => sub.messages.length === 2, 'two events');
      expect(sub.messages[0].data.revalProbeSubscription).toEqual({ tenantId: TENANT_A, visibleNotes: 1 });
      expect(sub.closes).toEqual([]);
    });

    /**
     * @regression   11.42.3 — `CoreTenantGuard.invalidateUser()` cleared the membership caches for new
     *   requests and left the user's open sockets on the membership they were opened with.
     * @seen-failing Delete the `revalidateWsConnectionsOf({ userId })` call from `clearUser()` in
     *   src/core/modules/tenant/core-tenant.guard.ts — registered as mutation
     *   `tenant-guard-skips-ws-revalidation` in tests/regression-mutations.json.
     */
    it('closes the socket when a removed membership is invalidated — before any further event', async () => {
      const sub = await open();
      await removeMembership();
      tenantGuard.invalidateUser(MEMBER_ID);

      await waitUntil(() => sub.closes.length > 0, 'socket closed');
      expect(sub.closes[0].code).toBe(4403);

      await publish();
      await settle();
      expect(sub.messages).toEqual([]);
    });

    it('closes the socket when a deactivated tenant is invalidated', async () => {
      const sub = await open();
      inactiveTenants.add(TENANT_A);
      tenantGuard.invalidateTenant(TENANT_A);

      await waitUntil(() => sub.closes.length > 0, 'socket closed');
      expect(sub.closes[0].code).toBe(4403);

      await publish();
      await settle();
      expect(sub.messages).toEqual([]);
    });

    it('keeps a connection open when an invalidation changed nothing for it (control)', async () => {
      const sub = await open();
      tenantGuard.invalidateUser(MEMBER_ID);
      tenantGuard.invalidateTenant(TENANT_A);
      await settle();

      await publish();
      await waitUntil(() => sub.messages.length === 1, 'event after a no-op invalidation');
      expect(sub.closes).toEqual([]);
    });

    it('does not re-check an un-invalidated change inside the interval — the documented bound', async () => {
      const sub = await open();
      await removeMembership();

      await publish();
      await waitUntil(() => sub.messages.length === 1, 'event inside the interval');
      expect(sub.closes).toEqual([]);
    });
  });

  describe('every event and operation re-checks a connection older than the interval', () => {
    beforeEach(() => setRevalidationMs(0));

    it('keeps delivering while nothing changed (control)', async () => {
      const sub = await open();
      await publish();
      await publish();
      await waitUntil(() => sub.messages.length === 2, 'two events');
      expect(sub.closes).toEqual([]);
    });

    it('drops the next event once the membership is gone, without any invalidation', async () => {
      const sub = await open();
      await removeMembership();

      await publish();
      await waitUntil(() => sub.closes.length > 0, 'socket closed');
      expect(sub.closes[0].code).toBe(4403);
      await settle();
      expect(sub.messages).toEqual([]);
    });

    it('drops the next event once the session no longer authenticates', async () => {
      const sub = await open();
      sessions.delete(sub.token);

      await publish();
      await waitUntil(() => sub.closes.length > 0, 'socket closed');
      expect(sub.closes[0].code).toBe(4403);
      await settle();
      expect(sub.messages).toEqual([]);
    });

    it('drops the next event once the global roles changed', async () => {
      const sub = await open();
      sessions.set(sub.token, { ...MEMBER, roles: ['auditor'] });

      await publish();
      await waitUntil(() => sub.closes.length > 0, 'socket closed');
      expect(sub.closes[0].code).toBe(4403);
      await settle();
      expect(sub.messages).toEqual([]);
    });

    it('refuses a further operation on the open socket once the session ended', async () => {
      const sub = await open();
      sessions.delete(sub.token);

      const results: any[] = [];
      sub.client.subscribe(
        { query: '{ revalProbeQuery { tenantId visibleNotes } }' },
        { complete: () => undefined, error: () => undefined, next: (message) => results.push(message) },
      );

      await waitUntil(() => sub.closes.length > 0, 'socket closed');
      expect(sub.closes[0].code).toBe(4403);
      await settle();
      expect(results.filter((result) => result?.data?.revalProbeQuery)).toEqual([]);
    });

    it('lets the client reconnect and continue with the rights it holds NOW', async () => {
      const sub = await open({ retry: true });
      await removeMembership();

      await publish();
      await waitUntil(() => sub.closes.length > 0, 'socket closed');
      expect(sub.closes[0].code).toBe(4403);
      expect(sub.messages).toEqual([]);

      // graphql-ws retries 4403 and re-subscribes on the new socket by itself.
      await waitUntil(() => listeners() === 1, 'subscription re-established after the reconnect');
      await publish();
      await waitUntil(() => sub.messages.length === 1, 'event on the reconnected socket');

      // No membership any more: no tenant, and the safety net refuses the tenant-scoped read.
      expect(sub.messages[0].data.revalProbeSubscription).toEqual({ tenantId: null, visibleNotes: -1 });
    });
  });
});
