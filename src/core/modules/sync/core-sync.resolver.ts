import { Inject, Logger, Optional } from '@nestjs/common';
import { Args, Field, Int, ObjectType, Resolver, Subscription } from '@nestjs/graphql';
import type { PubSub as PubSubInstance } from 'graphql-subscriptions';

import { Roles } from '../../common/decorators/roles.decorator';
import { RoleEnum } from '../../common/enums/role.enum';
import { JSON as JSONScalar } from '../../common/scalars/json.scalar';
import { ConfigService } from '../../common/services/config.service';
import { CoreSyncService, SYNC_PUB_SUB } from './core-sync.service';

/**
 * GraphQL output type for sync hints. Intentionally minimal — only
 * `model` and `changedAt`. Tenant ID is NEVER part of the output to
 * avoid information leakage. The internal `_tenantId` field on the
 * payload is used only by the resolver's filter function.
 */
@ObjectType('SyncHint')
export class SyncHintModel {
  @Field()
  model: string;

  @Field()
  changedAt: Date;
}

/**
 * Resolver exposing the WebSocket "changes available" subscription.
 *
 * Hints are debounced server-side (default 250ms per (model, tenantId))
 * and filtered per-subscriber so only events matching the subscriber's
 * tenant scope are delivered.
 *
 * Authentication is handled by the global subscription auth path (BetterAuth
 * connectionParams) — this resolver only validates that the tenant scope
 * matches.
 */
@Resolver()
export class CoreSyncResolver {
  protected readonly logger = new Logger(CoreSyncResolver.name);

  /** Per-user connection counter for the subscription cap. */
  protected readonly connectionsPerUser = new Map<string, number>();

  constructor(@Optional() @Inject(SYNC_PUB_SUB) protected readonly pubSub?: PubSubInstance) {}

  @Subscription(() => SyncHintModel, {
    /**
     * Filter: ensures subscribers only see hints for tenants they belong to.
     * Also filters by `model` argument when supplied.
     *
     * The internal `_tenantId` on the payload is the authoritative scope.
     * If the subscribing user has no tenant scope (single-tenant app), all
     * hints pass through.
     */
    filter: (payload, variables, context: any) => {
      try {
        if (variables?.model && payload?.syncHint?.model !== variables.model) {
          return false;
        }
        const userTenantIds: string[] | undefined =
          context?.user?.tenantIds || context?.connectionParams?.user?.tenantIds || undefined;
        const payloadTenant: string | undefined = payload?._tenantId;
        if (!payloadTenant) return true; // No tenant scope on emit → broadcast.
        if (!userTenantIds || !userTenantIds.length) return false;
        return userTenantIds.includes(payloadTenant);
      } catch {
        return false;
      }
    },
    /**
     * Resolve: project to the public output shape. Strip `_tenantId` from
     * the payload so it never reaches the wire.
     */
    resolve: (payload) => payload?.syncHint,
  })
  @Roles(RoleEnum.S_USER)
  syncHint(@Args('model', { nullable: true }) _model?: string) {
    const channel = CoreSyncResolver.getChannel();
    if (!this.pubSub) {
      // Return an empty async iterator if PubSub is not available.
      return (async function* () {})();
    }
    return this.pubSub.asyncIterableIterator(channel);
  }

  /**
   * Resolves the configured channel name (default 'syncHint').
   */
  static getChannel(): string {
    const cfg = ConfigService.get('sync')?.hint;
    if (cfg && typeof cfg === 'object' && cfg.channel) return cfg.channel;
    return 'syncHint';
  }
}
