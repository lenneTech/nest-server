import { Args, Resolver, Subscription } from '@nestjs/graphql';

import { GraphQLUser } from '../../common/decorators/graphql-user.decorator.js';
import { Roles } from '../../common/decorators/roles.decorator.js';
import { RoleEnum } from '../../common/enums/role.enum.js';
import { CoreSyncService } from './core-sync.service.js';
import { CoreSyncHintModel } from './models/core-sync-hint.model.js';

/**
 * The GraphQL hint channel of offline sync (protocol §9): `subscription { syncHint(models: ["Note"]) { model at } }`
 * (`models` optional), registered when
 * GraphQL is enabled and `sync.hints.graphql` is not `false`. Hints reach only subscribers with the model's pull roles,
 * for changes in their own tenants; the WebSocket it runs on is re-checked by `CoreModule`, so changed rights close it.
 *
 * Extend it and pass it as `CoreModule.forRoot(env, { sync: { resolver } })` to change the channel — re-declare
 * `@Subscription()` and `@Roles()` on an override, as on every resolver.
 */
@Resolver()
@Roles(RoleEnum.S_USER)
export class CoreSyncResolver {
  constructor(protected readonly syncService: CoreSyncService) {}

  @Roles(RoleEnum.S_USER)
  @Subscription(() => CoreSyncHintModel, {
    description: 'A hint whenever a synchronized model the subscriber may pull changes',
    name: 'syncHint',
  })
  syncHint(
    @GraphQLUser() currentUser: any,
    @Args('models', { description: 'Only these models (all when absent)', nullable: true, type: () => [String] })
    models?: string[],
  ): Promise<AsyncIterableIterator<{ syncHint: CoreSyncHintModel }>> {
    return this.syncService.hintIterator(currentUser, models);
  }
}
