import { Args, Mutation, Query, Resolver } from '@nestjs/graphql';

import { FilterArgs } from '../../common/args/filter.args';
import { GraphQLServiceOptions } from '../../common/decorators/graphql-service-options.decorator';
import { Roles } from '../../common/decorators/roles.decorator';
import { RoleEnum } from '../../common/enums/role.enum';
import { ServiceOptions } from '../../common/interfaces/service-options.interface';
import { CoreAiConnectionCreateInput } from './inputs/core-ai-connection-create.input';
import { CoreAiConnectionInput } from './inputs/core-ai-connection.input';
import { CoreAiPromptInput } from './inputs/core-ai-prompt.input';
import { CoreAiConnection } from './models/core-ai-connection.model';
import { CoreAiResponse } from './models/core-ai-response.model';
import { CoreAiConnectionService } from './services/core-ai-connection.service';
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
}
