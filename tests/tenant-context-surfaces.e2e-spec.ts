import { Logger } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
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
import { Roles } from '../src/core/common/decorators/roles.decorator';
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
import envConfig from '../src/config.env';
import { deriveTestDbUri } from './db-lifecycle.reporter';
/**
 * NOTE ON THE PROCESS-WIDE CONFIG — read before touching the `ConfigService` calls below.
 *
 * `new ConfigService({ … })` REPLACES the config, it does not merge into the environment config, and
 * that config is SHARED with every other spec in the same vitest fork. A spec that passes only its own
 * keys therefore drops every other setting for the rest of the fork — and the settings that then fall
 * back to a zero-config DEFAULT are the dangerous half: `betterAuth.emailVerification` defaults to
 * ENABLED, so losing the test config's explicit `false` makes every later sign-in in that fork answer
 * 401 "Email verification required". Which specs share a fork varies per run, so the symptom is an
 * unrelated file failing intermittently.
 *
 * Layer over `envConfig` and restore it in `afterAll`.
 */


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

  /**
   * A subscription gated on a TENANT role the subscriber does not hold.
   *
   * The socket connects as a plain `member`; `tenantAdmin` is a higher level in the hierarchy below.
   * On the HTTP path `CoreTenantGuard` answers this from `membership.role`. The question is whether
   * the guard is reached at all over a WebSocket — its `getRequest()` looks for `context.req`, which a
   * subscription context does not have.
   */
  @Subscription(() => ContextProbe, {
    resolve: () => ProbeResolver.probe(),
  })
  @Roles('tenantAdmin')
  async guardedSubscription() {
    return pubSub.asyncIterableIterator('probe');
  }

  /** The same gate on a QUERY — the control, proving the role itself is denying. */
  @Query(() => ContextProbe)
  @Roles('tenantAdmin')
  async guardedQuery(): Promise<ContextProbe> {
    return ProbeResolver.probe();
  }
}

describe('Tenant context surfaces (e2e)', () => {
  let app: import('@nestjs/common').INestApplication;
  let httpServer: any;
  let testHelper: TestHelper;
  let noteModel: Model<Note>;
  let excludedModel: Model<Excluded>;
  let memberModel: Model<TenantMember>;
  /** The environment config, restored in afterAll — see the note above the imports. */
  let previousConfig: Record<string, any>;

  const asTenant = <T>(tenantId: string, fn: () => Promise<T>): Promise<T> =>
    RequestContext.run({ currentUser: { id: MEMBER_ID, roles: [] }, tenantId } as any, fn);

  /**
   * Subscribe, publish one event, return the single delivered probe.
   *
   * The outcome is captured with `.then(…, …)` IMMEDIATELY rather than awaited at the end. A REFUSED
   * subscription rejects on the very first message, i.e. long before the 300 ms handshake wait is
   * over — and a promise that rejects while no handler is attached yet is reported by Node as an
   * unhandled rejection, which vitest turns into a failed file even though every assertion passed.
   * Attaching first and re-throwing afterwards keeps the semantics and removes the race.
   */
  const probeOverSocket = async (connectionParams?: Record<string, string>): Promise<ContextProbe> => {
    const outcome = testHelper
      .graphQl(
        {
          fields: ['hasRequestContext', 'tenantId', 'tenantIds', 'visibleNotes'],
          name: 'probeSubscription',
          type: TestGraphQLType.SUBSCRIPTION,
        },
        { connectionParams, countOfSubscriptionMessages: 1 },
      )
      .then(
        (messages: any) => ({ messages }),
        (reason: unknown) => ({ reason }),
      );

    // Let the socket finish its handshake before the event is published — an event published into a
    // channel nobody listens on yet is simply lost, and the subscription would hang.
    await new Promise(resolve => setTimeout(resolve, 300));
    await pubSub.publish('probe', {});

    const settled: any = await outcome;
    if ('reason' in settled) {
      throw settled.reason;
    }
    expect(settled.messages, 'exactly one subscription message').toHaveLength(1);
    return settled.messages[0];
  };

  beforeAll(async () => {
    // Layered over the environment config, not replacing it — see the note above the imports.
    previousConfig = { ...(envConfig as any) };
    ConfigService.setConfig(
      {
        ...(previousConfig as any),
        multiTenancy: {
          cacheTtlMs: 0,
          excludeSchemas: ['Excluded'],
          roleHierarchy: { member: 1, owner: 3, tenantAdmin: 2 },
        },
      } as any,
      { reInit: true },
    );

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
      providers: [
        ProbeResolver,
        // Registered as APP_GUARD, exactly as CoreTenantModule does it — otherwise the role gate is
        // not in the chain at all and a green result would prove nothing.
        CoreTenantGuard,
        { provide: APP_GUARD, useExisting: CoreTenantGuard },
      ],
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
    ConfigService.setConfig(previousConfig as any, { reInit: true });
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
     * THESIS: `@Roles()` on a `@Subscription` is enforced, exactly as it is on a query.
     *
     * `CoreTenantGuard.getRequest()` returns `ctx.getContext()?.req` for a GraphQL context and falls
     * back to `context.switchToHttp().getRequest()`. A subscription context is the graphql-ws `extra`
     * object, which has no `req`, and the HTTP fallback on a GraphQL context yields the resolver's
     * ROOT value — `undefined` at subscribe time. The guard then hits `if (!request) return true` and
     * grants access without deciding anything.
     *
     * That is the shape that matters: when multi-tenancy is active, the role guard PASSES non-system
     * roles through to this guard, so if this guard abstains the role is never checked by anyone.
     *
     * @regression   11.35.0 — `@Roles()` on a subscription was not enforced: CoreTenantGuard could not
     *   find a request on the WebSocket path and returned true, and the role guard delegates non-system
     *   roles to it, so nothing checked them.
     * @seen-failing Make `getRequest()` in `src/core/modules/tenant/core-tenant.guard.ts` skip its
     *   WebSocket branch (return `ctx.getContext()?.req` only) — registered as mutation
     *   `tenant-guard-blind-on-websocket` in `tests/regression-mutations.json`.
     */
    it('enforces @Roles() on a subscription for a subscriber who lacks the role', async () => {
      // Raced against a timer, and an event IS published: an unenforced gate then delivers a message
      // (fast, unambiguous), while an enforced one rejects the subscribe. Awaiting the subscription
      // alone would sit there for the full test timeout — which is exactly what an unenforced gate did.
      const attempt = testHelper
        .graphQl(
          {
            fields: ['hasRequestContext'],
            name: 'guardedSubscription',
            type: TestGraphQLType.SUBSCRIPTION,
          },
          { countOfSubscriptionMessages: 1, log: true },
        )
        .then(
          (messages: any) => ({ delivered: messages }),
          (reason: unknown) => ({ refused: reason }),
        );

      await new Promise(resolve => setTimeout(resolve, 300));
      await pubSub.publish('probe', {});

      const outcome: any = await Promise.race([
        attempt,
        new Promise(resolve => setTimeout(() => resolve({ stillSubscribed: true }), 1500)),
      ]);

      expect(
        outcome.refused,
        `a member must not reach a tenantAdmin-gated subscription (got ${JSON.stringify(outcome)})`,
      ).toBeTruthy();
    });

    /**
     * The control: the SAME gate on a query, over HTTP. It must deny — otherwise a red subscription
     * case above would only prove that `tenantAdmin` denies everyone everywhere, which is a different
     * (and uninteresting) failure.
     *
     * There is no session on this HTTP request, so the denial here is "not authenticated" rather than
     * "wrong membership role". That is enough for what the control has to establish: the gate is live
     * and refuses a caller who does not satisfy it.
     */
    it('enforces the same @Roles() gate on a QUERY (control)', async () => {
      const result: any = await testHelper.graphQl({
        fields: ['hasRequestContext'],
        name: 'guardedQuery',
        type: TestGraphQLType.QUERY,
      });

      expect(JSON.stringify(result ?? {}), 'the gate must be live on the HTTP path').toMatch(
        /Forbidden|ACCESS_DENIED|Unauthorized|UNAUTHORIZED/i,
      );
    });

    /**
     * THESIS: a handshake naming a tenant the subscriber is NOT a member of grants nothing.
     *
     * TWO layers answer this, and since 11.35.0 the outer one answers first. Once `CoreTenantGuard`
     * can see the WebSocket context it validates membership at subscribe time and refuses outright —
     * the same 403 the HTTP path gives. Behind it, the plugin's safety net still refuses a
     * tenant-scoped read that reaches a resolver with no tenant in context.
     *
     * Either layer satisfies the thesis; what must never happen is a delivered message carrying
     * foreign rows. Accepting both is not hedging — pinning WHICH layer refuses would make this case
     * fail on a future ordering change that is equally correct, and the property under test is the
     * outcome, not the mechanism.
     */
    it('refuses the subscription when the handshake names a tenant the subscriber does not belong to', async () => {
      const outcome: any = await probeOverSocket({ 'x-tenant-id': TENANT_B }).then(
        (probe: ContextProbe) => ({ probe }),
        (reason: unknown) => ({ refused: reason }),
      );

      if (outcome.refused) {
        // Refused at the GUARD — membership is validated before the subscription is established.
        // The guard's own wording: "Not a member of this tenant".
        expect(String(outcome.refused)).toMatch(/Forbidden|member|ACCESS_DENIED|role/i);
        return;
      }

      // Refused at the PLUGIN — no tenant in context, so the tenant-scoped read throws.
      // `null`, not `undefined`: a nullable GraphQL String serializes an absent value as null.
      expect(outcome.probe.tenantId, 'a foreign tenant must not become the context').toBeNull();
      expect(outcome.probe.visibleNotes, 'never answered with foreign rows').toBe(-1);
    });
  });
});
