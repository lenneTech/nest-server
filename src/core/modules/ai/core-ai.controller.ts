import { Body, Controller, Delete, Get, Param, Post, Put, Res } from '@nestjs/common';
import { Response } from 'express';

import { RESTServiceOptions } from '../../common/decorators/rest-service-options.decorator';
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
 * REST controller for AI prompts and connection management.
 *
 * - `POST /ai/prompt`: any authenticated user.
 * - `/ai/connections*`: admin only.
 *
 * Extend this controller in a project and pass it via `CoreAiModule.forRoot({ controller })`.
 */
@Controller('ai')
@Roles(RoleEnum.ADMIN)
export class CoreAiController {
  constructor(
    protected readonly aiService: CoreAiService,
    protected readonly connectionService: CoreAiConnectionService,
    protected readonly conversationService: CoreAiConversationService,
    protected readonly interactionService: CoreAiInteractionService,
    protected readonly budgetService: CoreAiBudgetService,
    protected readonly connectionResolver: CoreAiConnectionResolverService,
    protected readonly preferenceService: CoreAiConnectionPreferenceService,
  ) {}

  /**
   * Send a prompt to the AI assistant.
   */
  @Post('prompt')
  @Roles(RoleEnum.S_USER)
  async prompt(
    @RESTServiceOptions() serviceOptions: ServiceOptions,
    @Body() input: CoreAiPromptInput,
  ): Promise<CoreAiResponse> {
    return this.aiService.prompt(input, serviceOptions);
  }

  /**
   * Send a prompt and stream the answer via Server-Sent Events.
   *
   * Emits `action`, `token`, `final` and `error` events as `data:` lines.
   * Uses the raw response (`@Res()`), so interceptors are bypassed — the events
   * already carry permission-filtered data from the orchestrator.
   */
  @Post('stream')
  @Roles(RoleEnum.S_USER)
  async stream(
    @RESTServiceOptions() serviceOptions: ServiceOptions,
    @Body() input: CoreAiPromptInput,
    @Res() res: Response,
  ): Promise<void> {
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('Content-Type', 'text/event-stream');
    res.flushHeaders?.();
    try {
      for await (const event of this.aiService.promptStream(input, serviceOptions)) {
        res.write(`data: ${JSON.stringify(event)}\n\n`);
      }
    } catch (err) {
      res.write(`data: ${JSON.stringify({ message: (err as Error).message, type: 'error' })}\n\n`);
    } finally {
      res.end();
    }
  }

  // ===================================================================================================================
  // Connection selection (user self-service + admin preferences)
  //
  // NOTE: literal subpaths (`connections/available`, `connections/preferences`) are
  // declared BEFORE `connections/:id` so Express matches them before the id param.
  // ===================================================================================================================

  /**
   * List the AI connections the current user/tenant may use (non-sensitive).
   */
  @Get('connections/available')
  @Roles(RoleEnum.S_USER)
  async availableConnections(
    @RESTServiceOptions() serviceOptions: ServiceOptions,
  ): Promise<CoreAiAvailableConnection[]> {
    return this.connectionResolver.listAvailable({
      tenantId: RequestContext.getTenantId(),
      userId: serviceOptions?.currentUser?.id,
    });
  }

  /**
   * Set the current user's own default AI connection (validated against availability).
   */
  @Post('connections/select')
  @Roles(RoleEnum.S_USER)
  async setUserConnection(
    @RESTServiceOptions() serviceOptions: ServiceOptions,
    @Body('connectionId') connectionId: string,
  ): Promise<CoreAiAvailableConnection[]> {
    const tenantId = RequestContext.getTenantId();
    const userId = serviceOptions?.currentUser?.id;
    await this.connectionResolver.setUserConnection(userId, connectionId, tenantId);
    return this.connectionResolver.listAvailable({ tenantId, userId });
  }

  /**
   * Find AI connection preferences (admin).
   */
  @Get('connections/preferences')
  @Roles(RoleEnum.ADMIN)
  async findConnectionPreferences(
    @RESTServiceOptions() serviceOptions: ServiceOptions,
  ): Promise<CoreAiConnectionPreference[]> {
    return this.preferenceService.find({}, serviceOptions);
  }

  /**
   * Upsert a tenant/user connection preference (admin).
   */
  @Post('connections/preferences')
  @Roles(RoleEnum.ADMIN)
  async setConnectionPreference(@Body() input: CoreAiConnectionPreferenceInput): Promise<CoreAiConnectionPreference> {
    return this.preferenceService.upsertPreference(
      input.scope as 'tenant' | 'user',
      input.refId,
      input.connectionId,
      input.enforced ?? false,
    );
  }

  /**
   * Delete an AI connection preference by id (admin).
   */
  @Delete('connections/preferences/:id')
  @Roles(RoleEnum.ADMIN)
  async deleteConnectionPreference(
    @RESTServiceOptions() serviceOptions: ServiceOptions,
    @Param('id') id: string,
  ): Promise<CoreAiConnectionPreference> {
    return this.preferenceService.delete(id, serviceOptions);
  }

  /**
   * Find all AI connections.
   */
  @Get('connections')
  @Roles(RoleEnum.ADMIN)
  async findConnections(@RESTServiceOptions() serviceOptions: ServiceOptions): Promise<CoreAiConnection[]> {
    return this.connectionService.find({}, serviceOptions);
  }

  /**
   * Get an AI connection by id.
   */
  @Get('connections/:id')
  @Roles(RoleEnum.ADMIN)
  async getConnection(
    @RESTServiceOptions() serviceOptions: ServiceOptions,
    @Param('id') id: string,
  ): Promise<CoreAiConnection> {
    return this.connectionService.get(id, serviceOptions);
  }

  /**
   * Create a new AI connection.
   */
  @Post('connections')
  @Roles(RoleEnum.ADMIN)
  async createConnection(
    @RESTServiceOptions() serviceOptions: ServiceOptions,
    @Body() input: CoreAiConnectionCreateInput,
  ): Promise<CoreAiConnection> {
    return this.connectionService.create(input, { ...serviceOptions, inputType: CoreAiConnectionCreateInput });
  }

  /**
   * Update an AI connection.
   */
  @Put('connections/:id')
  @Roles(RoleEnum.ADMIN)
  async updateConnection(
    @RESTServiceOptions() serviceOptions: ServiceOptions,
    @Param('id') id: string,
    @Body() input: CoreAiConnectionInput,
  ): Promise<CoreAiConnection> {
    return this.connectionService.update(id, input, { ...serviceOptions, inputType: CoreAiConnectionInput });
  }

  /**
   * Delete an AI connection.
   */
  @Delete('connections/:id')
  @Roles(RoleEnum.ADMIN)
  async deleteConnection(
    @RESTServiceOptions() serviceOptions: ServiceOptions,
    @Param('id') id: string,
  ): Promise<CoreAiConnection> {
    return this.connectionService.delete(id, serviceOptions);
  }

  /**
   * Create a new AI conversation for the current user.
   */
  @Post('conversations')
  @Roles(RoleEnum.S_USER)
  async createConversation(
    @RESTServiceOptions() serviceOptions: ServiceOptions,
    @Body() input: CoreAiConversationCreateInput,
  ): Promise<CoreAiConversation> {
    return this.conversationService.create(input, { ...serviceOptions, inputType: CoreAiConversationCreateInput });
  }

  /**
   * Find the current user's AI conversations (admins see all).
   */
  @Get('conversations')
  @Roles(RoleEnum.S_USER)
  async findConversations(@RESTServiceOptions() serviceOptions: ServiceOptions): Promise<CoreAiConversation[]> {
    const currentUser = serviceOptions?.currentUser;
    const filterQuery = currentUser?.roles?.includes(RoleEnum.ADMIN) ? {} : { createdBy: currentUser?.id };
    return this.conversationService.find(
      { filterQuery },
      { ...serviceOptions, roles: [RoleEnum.ADMIN, RoleEnum.S_CREATOR, RoleEnum.S_SELF] },
    );
  }

  /**
   * Get an AI conversation by id (owner or admin).
   */
  @Get('conversations/:id')
  @Roles(RoleEnum.S_USER)
  async getConversation(
    @RESTServiceOptions() serviceOptions: ServiceOptions,
    @Param('id') id: string,
  ): Promise<CoreAiConversation> {
    return this.conversationService.get(id, {
      ...serviceOptions,
      roles: [RoleEnum.ADMIN, RoleEnum.S_CREATOR, RoleEnum.S_SELF],
    });
  }

  /**
   * Delete an AI conversation (owner or admin).
   */
  @Delete('conversations/:id')
  @Roles(RoleEnum.S_USER)
  async deleteConversation(
    @RESTServiceOptions() serviceOptions: ServiceOptions,
    @Param('id') id: string,
  ): Promise<CoreAiConversation> {
    return this.conversationService.delete(id, {
      ...serviceOptions,
      roles: [RoleEnum.ADMIN, RoleEnum.S_CREATOR, RoleEnum.S_SELF],
    });
  }

  /**
   * Find AI interaction audit records.
   */
  @Get('interactions')
  @Roles(RoleEnum.ADMIN)
  async findInteractions(@RESTServiceOptions() serviceOptions: ServiceOptions): Promise<CoreAiInteraction[]> {
    return this.interactionService.find({}, serviceOptions);
  }

  /**
   * Get an AI interaction audit record by id.
   */
  @Get('interactions/:id')
  @Roles(RoleEnum.ADMIN)
  async getInteraction(
    @RESTServiceOptions() serviceOptions: ServiceOptions,
    @Param('id') id: string,
  ): Promise<CoreAiInteraction> {
    return this.interactionService.get(id, serviceOptions);
  }

  /**
   * Token usage for the current user (and tenant) until the next reset.
   */
  @Get('usage')
  @Roles(RoleEnum.S_USER)
  async usage(@RESTServiceOptions() serviceOptions: ServiceOptions): Promise<CoreAiUsageInfo> {
    return this.budgetService.getUsageInfo(serviceOptions?.currentUser?.id, RequestContext.getTenantId());
  }

  /**
   * Find AI budget limits (admin).
   */
  @Get('budget-limits')
  @Roles(RoleEnum.ADMIN)
  async findBudgetLimits(@RESTServiceOptions() serviceOptions: ServiceOptions): Promise<CoreAiBudgetLimit[]> {
    return this.budgetService.find({}, serviceOptions);
  }

  /**
   * Create an AI budget limit (admin).
   */
  @Post('budget-limits')
  @Roles(RoleEnum.ADMIN)
  async createBudgetLimit(
    @RESTServiceOptions() serviceOptions: ServiceOptions,
    @Body() input: CoreAiBudgetLimitCreateInput,
  ): Promise<CoreAiBudgetLimit> {
    return this.budgetService.create(input, { ...serviceOptions, inputType: CoreAiBudgetLimitCreateInput });
  }

  /**
   * Update an AI budget limit (admin).
   */
  @Put('budget-limits/:id')
  @Roles(RoleEnum.ADMIN)
  async updateBudgetLimit(
    @RESTServiceOptions() serviceOptions: ServiceOptions,
    @Param('id') id: string,
    @Body() input: CoreAiBudgetLimitInput,
  ): Promise<CoreAiBudgetLimit> {
    return this.budgetService.update(id, input, { ...serviceOptions, inputType: CoreAiBudgetLimitInput });
  }

  /**
   * Delete an AI budget limit (admin).
   */
  @Delete('budget-limits/:id')
  @Roles(RoleEnum.ADMIN)
  async deleteBudgetLimit(
    @RESTServiceOptions() serviceOptions: ServiceOptions,
    @Param('id') id: string,
  ): Promise<CoreAiBudgetLimit> {
    return this.budgetService.delete(id, serviceOptions);
  }
}
