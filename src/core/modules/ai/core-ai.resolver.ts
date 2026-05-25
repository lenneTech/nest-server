import { Args, Mutation, Query, Resolver } from '@nestjs/graphql';

import { FilterArgs } from '../../common/args/filter.args';
import { GraphQLServiceOptions } from '../../common/decorators/graphql-service-options.decorator';
import { Roles } from '../../common/decorators/roles.decorator';
import { RoleEnum } from '../../common/enums/role.enum';
import { ServiceOptions } from '../../common/interfaces/service-options.interface';
import { RequestContext } from '../../common/services/request-context.service';
import { CoreAiBudgetLimitCreateInput } from './inputs/core-ai-budget-limit-create.input';
import { CoreAiBudgetLimitInput } from './inputs/core-ai-budget-limit.input';
import { CoreAiConnectionCreateInput } from './inputs/core-ai-connection-create.input';
import { CoreAiConnectionPreferenceInput } from './inputs/core-ai-connection-preference.input';
import { CoreAiConnectionInput } from './inputs/core-ai-connection.input';
import { CoreAiConversationCreateInput } from './inputs/core-ai-conversation-create.input';
import { CoreAiPromptInput } from './inputs/core-ai-prompt.input';
import { CoreAiAvailableConnection } from './models/core-ai-available-connection.model';
import { CoreAiBudgetLimit } from './models/core-ai-budget-limit.model';
import { CoreAiConnectionPreference } from './models/core-ai-connection-preference.model';
import { CoreAiConnection } from './models/core-ai-connection.model';
import { CoreAiConversation } from './models/core-ai-conversation.model';
import { CoreAiInteraction } from './models/core-ai-interaction.model';
import { CoreAiResponse } from './models/core-ai-response.model';
import { CoreAiUsageInfo } from './models/core-ai-usage-info.model';
import { CoreAiBudgetService } from './services/core-ai-budget.service';
import { CoreAiConnectionPreferenceService } from './services/core-ai-connection-preference.service';
import { CoreAiConnectionResolverService } from './services/core-ai-connection-resolver.service';
import { CoreAiConnectionService } from './services/core-ai-connection.service';
import { CoreAiConversationService } from './services/core-ai-conversation.service';
import { CoreAiInteractionService } from './services/core-ai-interaction.service';
import { CoreAiService } from './services/core-ai.service';

/**
 * GraphQL resolver for AI prompts and connection management.
 *
 * - `aiPrompt`: any authenticated user (tools are filtered by the user's roles).
 * - connection queries/mutations: admin only (the model is `@Restricted(ADMIN)`).
 *
 * Extend this resolver in a project and pass it via `CoreAiModule.forRoot({ resolver })`.
 * When overriding methods, re-declare ALL decorators (`@Query`/`@Mutation`/`@Roles`)
 * because the GraphQL schema is built from decorators at compile time.
 */
@Resolver(() => CoreAiResponse)
@Roles(RoleEnum.ADMIN)
export class CoreAiResolver {
  constructor(
    protected readonly aiService: CoreAiService,
    protected readonly connectionService: CoreAiConnectionService,
    protected readonly conversationService: CoreAiConversationService,
    protected readonly interactionService: CoreAiInteractionService,
    protected readonly budgetService: CoreAiBudgetService,
    protected readonly connectionResolver: CoreAiConnectionResolverService,
    protected readonly preferenceService: CoreAiConnectionPreferenceService,
  ) {}

  // ===================================================================================================================
  // Prompt
  // ===================================================================================================================

  /**
   * Send a prompt to the AI assistant.
   */
  @Mutation(() => CoreAiResponse, { description: 'Send a prompt to the AI assistant' })
  @Roles(RoleEnum.S_USER)
  async aiPrompt(
    @GraphQLServiceOptions() serviceOptions: ServiceOptions,
    @Args('input') input: CoreAiPromptInput,
  ): Promise<CoreAiResponse> {
    return this.aiService.prompt(input, serviceOptions);
  }

  // ===================================================================================================================
  // Connection management (admin)
  // ===================================================================================================================

  /**
   * Create a new AI connection.
   */
  @Mutation(() => CoreAiConnection, { description: 'Create a new AI connection' })
  @Roles(RoleEnum.ADMIN)
  async createAiConnection(
    @GraphQLServiceOptions() serviceOptions: ServiceOptions,
    @Args('input') input: CoreAiConnectionCreateInput,
  ): Promise<CoreAiConnection> {
    return this.connectionService.create(input, { ...serviceOptions, inputType: CoreAiConnectionCreateInput });
  }

  /**
   * Delete an AI connection.
   */
  @Mutation(() => CoreAiConnection, { description: 'Delete an AI connection' })
  @Roles(RoleEnum.ADMIN)
  async deleteAiConnection(
    @GraphQLServiceOptions() serviceOptions: ServiceOptions,
    @Args('id') id: string,
  ): Promise<CoreAiConnection> {
    return this.connectionService.delete(id, serviceOptions);
  }

  /**
   * Get a single AI connection by id.
   */
  @Query(() => CoreAiConnection, { description: 'Get an AI connection by id' })
  @Roles(RoleEnum.ADMIN)
  async getAiConnection(
    @GraphQLServiceOptions() serviceOptions: ServiceOptions,
    @Args('id') id: string,
  ): Promise<CoreAiConnection> {
    return this.connectionService.get(id, serviceOptions);
  }

  /**
   * Find AI connections (via filter).
   */
  @Query(() => [CoreAiConnection], { description: 'Find AI connections' })
  @Roles(RoleEnum.ADMIN)
  async findAiConnections(
    @GraphQLServiceOptions() serviceOptions: ServiceOptions,
    @Args() args?: FilterArgs,
  ): Promise<CoreAiConnection[]> {
    return this.connectionService.find(args, { ...serviceOptions, inputType: FilterArgs });
  }

  /**
   * Probe an AI connection's endpoint to auto-detect and persist its capabilities
   * (JSON / native tools) for any flag left undefined.
   */
  @Mutation(() => CoreAiConnection, { description: 'Auto-detect and persist AI connection capabilities' })
  @Roles(RoleEnum.ADMIN)
  async detectAiConnectionCapabilities(
    @GraphQLServiceOptions() serviceOptions: ServiceOptions,
    @Args('id') id: string,
  ): Promise<CoreAiConnection> {
    await this.connectionService.detectAndPersistCapabilities(id);
    return this.connectionService.get(id, serviceOptions);
  }

  /**
   * Update an AI connection.
   */
  @Mutation(() => CoreAiConnection, { description: 'Update an AI connection' })
  @Roles(RoleEnum.ADMIN)
  async updateAiConnection(
    @GraphQLServiceOptions() serviceOptions: ServiceOptions,
    @Args('id') id: string,
    @Args('input') input: CoreAiConnectionInput,
  ): Promise<CoreAiConnection> {
    return this.connectionService.update(id, input, { ...serviceOptions, inputType: CoreAiConnectionInput });
  }

  // ===================================================================================================================
  // Connection selection (user self-service + admin preferences)
  // ===================================================================================================================

  /**
   * List the AI connections the current user/tenant may use (non-sensitive), with
   * the currently resolved one flagged and whether the selection is locked.
   */
  @Query(() => [CoreAiAvailableConnection], { description: 'List AI connections available to the current user' })
  @Roles(RoleEnum.S_USER)
  async aiAvailableConnections(
    @GraphQLServiceOptions() serviceOptions: ServiceOptions,
  ): Promise<CoreAiAvailableConnection[]> {
    return this.connectionResolver.listAvailable({
      tenantId: RequestContext.getTenantId(),
      userId: serviceOptions?.currentUser?.id,
    });
  }

  /**
   * Set the current user's own default AI connection (validated against availability).
   * Returns the updated available list.
   */
  @Mutation(() => [CoreAiAvailableConnection], { description: 'Set the current user default AI connection' })
  @Roles(RoleEnum.S_USER)
  async aiSetUserConnection(
    @GraphQLServiceOptions() serviceOptions: ServiceOptions,
    @Args('connectionId') connectionId: string,
  ): Promise<CoreAiAvailableConnection[]> {
    const tenantId = RequestContext.getTenantId();
    const userId = serviceOptions?.currentUser?.id;
    await this.connectionResolver.setUserConnection(userId, connectionId, tenantId);
    return this.connectionResolver.listAvailable({ tenantId, userId });
  }

  /**
   * Upsert a tenant/user connection preference (admin). Use for tenant defaults,
   * tenant-enforced selection or managing a user's default.
   */
  @Mutation(() => CoreAiConnectionPreference, { description: 'Upsert an AI connection preference' })
  @Roles(RoleEnum.ADMIN)
  async setAiConnectionPreference(
    @Args('input') input: CoreAiConnectionPreferenceInput,
  ): Promise<CoreAiConnectionPreference> {
    return this.connectionResolver.setPreference(
      input.scope as 'tenant' | 'user',
      input.refId,
      input.connectionId,
      input.enforced ?? false,
    );
  }

  /**
   * Find AI connection preferences (admin).
   */
  @Query(() => [CoreAiConnectionPreference], { description: 'Find AI connection preferences' })
  @Roles(RoleEnum.ADMIN)
  async findAiConnectionPreferences(
    @GraphQLServiceOptions() serviceOptions: ServiceOptions,
    @Args() args?: FilterArgs,
  ): Promise<CoreAiConnectionPreference[]> {
    return this.preferenceService.find(args, { ...serviceOptions, inputType: FilterArgs });
  }

  /**
   * Delete an AI connection preference by id (admin).
   */
  @Mutation(() => CoreAiConnectionPreference, { description: 'Delete an AI connection preference' })
  @Roles(RoleEnum.ADMIN)
  async deleteAiConnectionPreference(
    @GraphQLServiceOptions() serviceOptions: ServiceOptions,
    @Args('id') id: string,
  ): Promise<CoreAiConnectionPreference> {
    return this.preferenceService.delete(id, serviceOptions);
  }

  // ===================================================================================================================
  // Conversations (owner-scoped)
  // ===================================================================================================================

  /**
   * Create a new AI conversation for the current user.
   */
  @Mutation(() => CoreAiConversation, { description: 'Create a new AI conversation' })
  @Roles(RoleEnum.S_USER)
  async createAiConversation(
    @GraphQLServiceOptions() serviceOptions: ServiceOptions,
    @Args('input') input: CoreAiConversationCreateInput,
  ): Promise<CoreAiConversation> {
    return this.conversationService.create(input, { ...serviceOptions, inputType: CoreAiConversationCreateInput });
  }

  /**
   * Delete an AI conversation (owner or admin).
   */
  @Mutation(() => CoreAiConversation, { description: 'Delete an AI conversation' })
  @Roles(RoleEnum.S_USER)
  async deleteAiConversation(
    @GraphQLServiceOptions() serviceOptions: ServiceOptions,
    @Args('id') id: string,
  ): Promise<CoreAiConversation> {
    return this.conversationService.delete(id, {
      ...serviceOptions,
      roles: [RoleEnum.ADMIN, RoleEnum.S_CREATOR, RoleEnum.S_SELF],
    });
  }

  /**
   * Find the current user's AI conversations (admins see all).
   */
  @Query(() => [CoreAiConversation], { description: 'Find AI conversations of the current user' })
  @Roles(RoleEnum.S_USER)
  async findAiConversations(@GraphQLServiceOptions() serviceOptions: ServiceOptions): Promise<CoreAiConversation[]> {
    const currentUser = serviceOptions?.currentUser;
    const filterQuery = currentUser?.roles?.includes(RoleEnum.ADMIN) ? {} : { createdBy: currentUser?.id };
    return this.conversationService.find(
      { filterQuery },
      { ...serviceOptions, roles: [RoleEnum.ADMIN, RoleEnum.S_CREATOR, RoleEnum.S_SELF] },
    );
  }

  /**
   * Get a single AI conversation by id (owner or admin).
   */
  @Query(() => CoreAiConversation, { description: 'Get an AI conversation by id' })
  @Roles(RoleEnum.S_USER)
  async getAiConversation(
    @GraphQLServiceOptions() serviceOptions: ServiceOptions,
    @Args('id') id: string,
  ): Promise<CoreAiConversation> {
    return this.conversationService.get(id, {
      ...serviceOptions,
      roles: [RoleEnum.ADMIN, RoleEnum.S_CREATOR, RoleEnum.S_SELF],
    });
  }

  // ===================================================================================================================
  // Audit (admin)
  // ===================================================================================================================

  /**
   * Find AI interaction audit records (via filter).
   */
  @Query(() => [CoreAiInteraction], { description: 'Find AI interaction audit records' })
  @Roles(RoleEnum.ADMIN)
  async findAiInteractions(
    @GraphQLServiceOptions() serviceOptions: ServiceOptions,
    @Args() args?: FilterArgs,
  ): Promise<CoreAiInteraction[]> {
    return this.interactionService.find(args, { ...serviceOptions, inputType: FilterArgs });
  }

  /**
   * Get a single AI interaction audit record by id.
   */
  @Query(() => CoreAiInteraction, { description: 'Get an AI interaction audit record by id' })
  @Roles(RoleEnum.ADMIN)
  async getAiInteraction(
    @GraphQLServiceOptions() serviceOptions: ServiceOptions,
    @Args('id') id: string,
  ): Promise<CoreAiInteraction> {
    return this.interactionService.get(id, serviceOptions);
  }

  // ===================================================================================================================
  // Token usage + budget limits
  // ===================================================================================================================

  /**
   * Full token usage for the current user (and tenant) until the next reset.
   */
  @Query(() => CoreAiUsageInfo, { description: 'Token usage for the current user (and tenant)' })
  @Roles(RoleEnum.S_USER)
  async aiUsage(@GraphQLServiceOptions() serviceOptions: ServiceOptions): Promise<CoreAiUsageInfo> {
    return this.budgetService.getUsageInfo(serviceOptions?.currentUser?.id, RequestContext.getTenantId());
  }

  /**
   * Create an AI budget limit (admin).
   */
  @Mutation(() => CoreAiBudgetLimit, { description: 'Create an AI budget limit' })
  @Roles(RoleEnum.ADMIN)
  async createAiBudgetLimit(
    @GraphQLServiceOptions() serviceOptions: ServiceOptions,
    @Args('input') input: CoreAiBudgetLimitCreateInput,
  ): Promise<CoreAiBudgetLimit> {
    return this.budgetService.create(input, { ...serviceOptions, inputType: CoreAiBudgetLimitCreateInput });
  }

  /**
   * Delete an AI budget limit (admin).
   */
  @Mutation(() => CoreAiBudgetLimit, { description: 'Delete an AI budget limit' })
  @Roles(RoleEnum.ADMIN)
  async deleteAiBudgetLimit(
    @GraphQLServiceOptions() serviceOptions: ServiceOptions,
    @Args('id') id: string,
  ): Promise<CoreAiBudgetLimit> {
    return this.budgetService.delete(id, serviceOptions);
  }

  /**
   * Find AI budget limits (admin).
   */
  @Query(() => [CoreAiBudgetLimit], { description: 'Find AI budget limits' })
  @Roles(RoleEnum.ADMIN)
  async findAiBudgetLimits(
    @GraphQLServiceOptions() serviceOptions: ServiceOptions,
    @Args() args?: FilterArgs,
  ): Promise<CoreAiBudgetLimit[]> {
    return this.budgetService.find(args, { ...serviceOptions, inputType: FilterArgs });
  }

  /**
   * Update an AI budget limit (admin).
   */
  @Mutation(() => CoreAiBudgetLimit, { description: 'Update an AI budget limit' })
  @Roles(RoleEnum.ADMIN)
  async updateAiBudgetLimit(
    @GraphQLServiceOptions() serviceOptions: ServiceOptions,
    @Args('id') id: string,
    @Args('input') input: CoreAiBudgetLimitInput,
  ): Promise<CoreAiBudgetLimit> {
    return this.budgetService.update(id, input, { ...serviceOptions, inputType: CoreAiBudgetLimitInput });
  }
}
