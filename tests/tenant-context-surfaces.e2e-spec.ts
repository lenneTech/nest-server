import { Logger } from '@nestjs/common';
import { ApolloDriver, ApolloDriverConfig } from '@nestjs/apollo';
import { Field, GraphQLModule, Int, ObjectType, Query, Resolver, Subscription } from '@nestjs/graphql';
import { getModelToken, MongooseModule, Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Test, TestingModule } from '@nestjs/testing';
import { PubSub } from 'graphql-subscriptions';
import { Model } from 'mongoose';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

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
// Imported from the module rather than the `../src` barrel on purpose: the barrel evaluates every
// framework `@ObjectType()`, and `autoSchemaFile` then tries to build a schema out of all of them —
// which this deliberately bare GraphQL app (no CoreModule) cannot satisfy.
import { TestGraphQLType, TestHelper } from '../src/test/test.helper';
import { deriveTestDbUri } from './db-lifecycle.reporter';

/**
 * The SURFACES tenant filtering reaches — and the ones it did not.
 *
 * `tenant-isolation.e2e-spec.ts` asks whether a filtered path filters correctly. This file asks the
 * prior question: does the path run inside a tenant context AT ALL? Both failures look identical to
 * a caller (rows come back), but they have opposite fixes, and the second is invisible in a review
 * of the query — the query is fine; nothing told it which tenant it is in.
 *
 * Two surfaces are under test:
 *
 *  1. `excludeSchemas` — an explicit, per-model OFF SWITCH for isolation. The framework's own
 *     documentation recommended `excludeSchemas: ['User', 'Session']` from 11.20.0 in an `@example`
 *     that gets copied verbatim. On a project whose users are per-tenant that switches isolation off
 *     for the user collection, and nothing anywhere said so.
 *
 *  2. GraphQL SUBSCRIPTIONS — delivered over a WebSocket, which never traverses the Express
 *     middleware stack that installs `RequestContext`, and whose context object has no `req` for
 *     `CoreTenantGuard.getRequest()` to find. Every tenant decision reads one of those two.
 *
 * Written thesis-first: each `it()` states what the framework is BELIEVED to guarantee, and was run
 * before any fix so a red identifies a real defect rather than confirming a design already correct.
 */

@Schema({ timestamps: true })
class Note {
  @Prop({ type: String })
  tenantId: string;

  @Prop({ required: true, type: String })
  body: string;
}
const NoteSchema = SchemaFactory.createForClass(Note);

/** Declares `tenantId` — so its author meant per-tenant rows — and is nevertheless excluded. */
@Schema({ timestamps: true })
class Excluded {
  @Prop({ type: String })
  tenantId: string;

  @Prop({ required: true, type: String })
  body: string;
}
const ExcludedSchema = SchemaFactory.createForClass(Excluded);

@Schema({ timestamps: true })
class TenantMember extends CoreTenantMemberModel {}
const TenantMemberSchema = SchemaFactory.createForClass(TenantMember);
TenantMemberSchema.index({ tenant: 1, user: 1 }, { unique: true });

const TENANT_A = 'ctx-tenant-a';
const TENANT_B = 'ctx-tenant-b';
/** Member of TENANT_A only — the identity every WebSocket in this file connects as. */
const MEMBER_ID = '6a0000000000000000000001';

@ObjectType()
class ContextProbe {
  @Field(() => Boolean)
  hasRequestContext: boolean;

  @Field(() => String, { nullable: true })
  tenantId?: string;

  @Field(() => [String])
  tenantIds: string[];

  /** How many rows a tenant-scoped read returns from here. `-1` = the safety net refused it. */
  @Field(() => Int)
  visibleNotes: number;
}

const pubSub = new PubSub();

/**
 * The GraphQL options, typed loosely on purpose.
 *
 * `execute` / `subscribe` are read by `GqlSubscriptionService` but are absent from
 * `ApolloDriverConfig`'s type — which is exactly why `CoreModule` reaches them through
 * `Object.assign`. They must sit INSIDE `subscriptions`, because `ApolloDriver.start()` forwards only
 * `{ schema, path, context, ...options.subscriptions }` to that service and drops a top-level pair.
 *
 * The two wrappers here are the SAME ones `CoreModule` installs on all three of its driver builders;
 * that this app declares them by hand is why `tests/unit/graphql-ws-context-wiring.spec.ts` exists as
 * well: that one pins the WIRING, this file pins the MECHANISM over a real socket.
 */
const GRAPHQL_OPTIONS: any = {
  autoSchemaFile: true,
  driver: ApolloDriver,
  installSubscriptionHandlers: true,
  subscriptions: {
    execute: buildRequestContextAwareExecute(),
    subscribe: buildRequestContextAwareSubscribe(),
    'graphql-ws': {
      // Mirrors CoreModule: the WS context IS `extra`, and the authenticated user plus the client's
      // connectionParams are recorded on it at connect time.
      context: ({ extra }: any) => extra,
      onConnect: (ctx: any) => {
        ctx.extra.user = { id: MEMBER_ID, roles: [] };
        ctx.extra.headers = ctx.connectionParams ?? {};
        return true;
      },
    },
  },
};

/**
 * Reports what the tenant machinery can see from where it runs.
 *
 * Exposed as a QUERY and as a SUBSCRIPTION on purpose: the query is the control. If the two differ,
 * the difference is the transport, not the code — which is exactly the claim under test.
 *
 * The probe runs inside the subscription's `resolve`, i.e. on the real delivery path. That matters:
 * `resolve` is executed inside the async iterator's `next()`, which the transport pulls long after
 * `subscribe()` returned — so a fix that only wraps the subscribe call would leave this red.
 */
@Resolver()
class ProbeResolver {
  static noteModel: Model<Note>;

  static async probe(): Promise<ContextProbe> {
    const context = RequestContext.get();
    let visibleNotes: number;
    try {
      visibleNotes = (await ProbeResolver.noteModel.find({}).lean().exec()).length;
    } catch {
      // The plugin's safety net refuses a tenant-scoped read without a tenant — a PASS for the
      // property under test, recorded as -1 so the assertion can tell it apart from a leak.
      visibleNotes = -1;
    }
    return {
      hasRequestContext: !!context,
      tenantId: context?.tenantId,
      tenantIds: context?.tenantIds ?? [],
      visibleNotes,
    };
  }

  @Query(() => ContextProbe)
  async probeQuery(): Promise<ContextProbe> {
    return ProbeResolver.probe();
  }

  @Subscription(() => ContextProbe, {
    resolve: () => ProbeResolver.probe(),
  })
  async probeSubscription() {
    return pubSub.asyncIterableIterator('probe');
  }
}

describe('Tenant context surfaces (e2e)', () => {
  let app: import('@nestjs/common').INestApplication;
  let httpServer: any;
  let testHelper: TestHelper;
  let noteModel: Model<Note>;
  let excludedModel: Model<Excluded>;
  let memberModel: Model<TenantMember>;

  const asTenant = <T>(tenantId: string, fn: () => Promise<T>): Promise<T> =>
    RequestContext.run({ currentUser: { id: MEMBER_ID, roles: [] }, tenantId } as any, fn);

  /** Subscribe, publish one event, return the single delivered probe. */
  const probeOverSocket = async (connectionParams?: Record<string, string>): Promise<ContextProbe> => {
    const subscription: any = testHelper.graphQl(
      {
        fields: ['hasRequestContext', 'tenantId', 'tenantIds', 'visibleNotes'],
        name: 'probeSubscription',
        type: TestGraphQLType.SUBSCRIPTION,
      },
      { connectionParams, countOfSubscriptionMessages: 1 },
    );

    // Let the socket finish its handshake before the event is published — an event published into a
    // channel nobody listens on yet is simply lost, and the subscription would hang.
    await new Promise(resolve => setTimeout(resolve, 300));
    await pubSub.publish('probe', {});

    const messages = await subscription;
    expect(messages, 'exactly one subscription message').toHaveLength(1);
    return messages[0];
  };

  beforeAll(async () => {
    new ConfigService({ multiTenancy: { cacheTtlMs: 0, excludeSchemas: ['Excluded'] } } as any);

    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [
        MongooseModule.forRoot(deriveTestDbUri('tctx'), {
          connectionFactory: (connection) => {
            connection.plugin(mongooseTenantPlugin);
            return connection;
          },
        }),
        MongooseModule.forFeature([
          { name: Note.name, schema: NoteSchema },
          { name: Excluded.name, schema: ExcludedSchema },
          { name: 'TenantMember', schema: TenantMemberSchema },
        ]),
        GraphQLModule.forRoot<ApolloDriverConfig>(GRAPHQL_OPTIONS),
      ],
      providers: [ProbeResolver, CoreTenantGuard],
    }).compile();

    app = moduleFixture.createNestApplication();
    await app.init();

    noteModel = moduleFixture.get(getModelToken(Note.name));
    excludedModel = moduleFixture.get(getModelToken(Excluded.name));
    memberModel = moduleFixture.get(getModelToken('TenantMember'));
    ProbeResolver.noteModel = noteModel;

    httpServer = app.getHttpServer();
    await new Promise<void>(resolve => httpServer.listen(0, '127.0.0.1', () => resolve()));
    testHelper = new TestHelper(app, `ws://127.0.0.1:${httpServer.address().port}/graphql`);

    await RequestContext.runWithBypassTenantGuard(async () => {
      await noteModel.deleteMany({});
      await excludedModel.deleteMany({});
      await memberModel.deleteMany({});
      await noteModel.create([
        { body: 'own note', tenantId: TENANT_A },
        { body: 'FOREIGN note', tenantId: TENANT_B },
      ]);
      await excludedModel.create([
        { body: 'own row', tenantId: TENANT_A },
        { body: 'FOREIGN row', tenantId: TENANT_B },
      ]);
      await memberModel.create([{ role: 'member', status: TenantMemberStatus.ACTIVE, tenant: TENANT_A, user: MEMBER_ID }]);
    });
  });

  afterAll(async () => {
    await RequestContext.runWithBypassTenantGuard(async () => {
      await noteModel?.deleteMany({});
      await excludedModel?.deleteMany({});
      await memberModel?.deleteMany({});
    });
    if (httpServer) {
      await new Promise<void>(resolve => httpServer.close(() => resolve()));
    }
    await app?.close();
    new ConfigService({} as any);
  });

  // ===========================================================================
  // A) excludeSchemas — the explicit off switch
  // ===========================================================================
  describe('A) excludeSchemas', () => {
    it('filters a tenant-scoped model that is NOT excluded (control)', async () => {
      const rows = await asTenant(TENANT_A, () => noteModel.find({}).lean().exec());
      expect(rows.map(row => row.body)).toEqual(['own note']);
    });

    /**
     * BOTH halves in ONE case, deliberately: the warning is emitted once per model per PROCESS (a
     * per-query warning on a hot path would be noise), so it can only be observed on the FIRST touch
     * of the excluded model. Splitting this would make the assertion depend on test ordering.
     *
     * THESIS: a schema that DECLARES `tenantId` — i.e. whose author meant per-tenant rows — and is
     * nevertheless excluded says so out loud, naming the model. The exclusion is a legitimate feature
     * for a genuinely global lookup table; silently disabling isolation for a model built for
     * isolation is not, and it is exactly the shape a copied `@example` produces.
     *
     * A warning rather than a boot failure (which is what an ambiguous ROLE vocabulary gets): this
     * configuration is unambiguous, it is simply one nobody may make by accident.
     *
     * @regression   11.35.0 — excluding a tenantId-declaring schema disabled isolation silently.
     * @seen-failing Delete the `warnIsolationDisabled(modelName)` call from `shouldBypass()` in
     *   `src/core/common/plugins/mongoose-tenant.plugin.ts` — registered as mutation
     *   `exclude-schemas-warns-silently` in `tests/regression-mutations.json`.
     */
    it('returns every tenant\'s rows for an EXCLUDED model — and says so out loud', async () => {
      const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
      try {
        const rows = await asTenant(TENANT_A, () => excludedModel.find({}).lean().exec());

        // The consequence of the switch, pinned as a stated property rather than a surprise.
        expect(rows.map(row => row.body).sort()).toEqual(['FOREIGN row', 'own row']);

        const messages = warn.mock.calls.map(call => String(call[0])).join('\n');
        expect(messages, 'the model must be named').toContain('Excluded');
        expect(messages.toLowerCase()).toContain('tenant');
        expect(messages).toContain('excludeSchemas');
      } finally {
        warn.mockRestore();
      }
    });
  });

  // ===========================================================================
  // B) GraphQL subscriptions — a transport that skips the middleware stack
  // ===========================================================================
  describe('B) subscriptions', () => {
    it('filters the probe when it is reached as a QUERY inside a tenant context (control)', async () => {
      const probe = await asTenant(TENANT_A, () => ProbeResolver.probe());
      expect(probe.hasRequestContext).toBe(true);
      expect(probe.visibleNotes).toBe(1);
    });

    /**
     * THESIS: a resolver reached over a WebSocket runs inside a `RequestContext`, exactly as an HTTP
     * resolver does — otherwise every tenant decision silently answers "system operation, no
     * filter", and the plugin's safety net never fires either, because "no context" is
     * indistinguishable from a cron job.
     *
     * @regression   11.35.0 — WS operations ran with no RequestContext at all.
     * @seen-failing Return the unwrapped `graphqlSubscribe` from
     *   `createRequestContextAwareSubscribe()` in
     *   `src/core/common/helpers/graphql-ws-context.helper.ts` — registered as mutation
     *   `ws-subscribe-without-request-context` in `tests/regression-mutations.json`.
     */
    it('delivers a subscription message from inside a RequestContext', async () => {
      const probe = await probeOverSocket();
      expect(probe.hasRequestContext, 'subscription resolvers must carry a request context').toBe(true);
    });

    /**
     * THESIS: a tenant-scoped read performed while delivering a subscription message is scoped to
     * the subscriber's own tenants. What it must never do is quietly return every tenant's rows.
     */
    it('scopes a subscription read to the subscriber\'s tenant memberships', async () => {
      const probe = await probeOverSocket();

      expect(probe.tenantIds, 'memberships resolved for the socket\'s user').toEqual([TENANT_A]);
      expect(probe.visibleNotes, 'unfiltered cross-tenant read on the subscription path').toBe(1);
    });

    /** THESIS: a tenant header sent with the handshake is honoured — and validated against membership. */
    it('honours a validated tenant header from the handshake', async () => {
      const probe = await probeOverSocket({ 'x-tenant-id': TENANT_A });

      expect(probe.tenantId).toBe(TENANT_A);
      expect(probe.visibleNotes).toBe(1);
    });

    /**
     * THESIS: a header naming a tenant the subscriber is NOT a member of grants nothing. The read
     * must be refused (the safety net), never widened — an unvalidated header would be strictly
     * worse than no header at all.
     */
    it('refuses the read when the handshake names a tenant the subscriber does not belong to', async () => {
      const probe = await probeOverSocket({ 'x-tenant-id': TENANT_B });

      // `null`, not `undefined`: a nullable GraphQL String serializes an absent value as null.
      expect(probe.tenantId, 'a foreign tenant must not become the context').toBeNull();
      expect(probe.visibleNotes, 'refused by the safety net, not answered with foreign rows').toBe(-1);
    });
  });
});
