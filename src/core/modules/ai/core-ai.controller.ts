import { Body, Controller, Delete, Get, Param, Post, Put, Query, Res } from '@nestjs/common';
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
import { CoreAiPromptHintCreateInput } from './inputs/core-ai-prompt-hint-create.input';
import { CoreAiPromptHintInput } from './inputs/core-ai-prompt-hint.input';
import { CoreAiPromptCreateInput } from './inputs/core-ai-prompt-create.input';
import { CoreAiPromptUpdateInput } from './inputs/core-ai-prompt-update.input';
import { CoreAiSlotCreateInput } from './inputs/core-ai-slot-create.input';
import { CoreAiSlotUpdateInput } from './inputs/core-ai-slot-update.input';
import { CoreAiPromptInput } from './inputs/core-ai-prompt.input';
import { CoreAiAvailableConnection } from './models/core-ai-available-connection.model';
import { CoreAiBudgetLimit } from './models/core-ai-budget-limit.model';
import { CoreAiConnectionPreference } from './models/core-ai-connection-preference.model';
import { CoreAiConnection } from './models/core-ai-connection.model';
import { CoreAiConversation } from './models/core-ai-conversation.model';
import { CoreAiInteraction } from './models/core-ai-interaction.model';
import { CoreAiPromptHint } from './models/core-ai-prompt-hint.model';
import { CoreAiPrompt } from './models/core-ai-prompt.model';
import { CoreAiSlot } from './models/core-ai-slot.model';
import { CoreAiResponse } from './models/core-ai-response.model';
import { CoreAiUsageInfo } from './models/core-ai-usage-info.model';
import { CoreAiBudgetService } from './services/core-ai-budget.service';
import { CoreAiConnectionPreferenceService } from './services/core-ai-connection-preference.service';
import { CoreAiConnectionResolverService } from './services/core-ai-connection-resolver.service';
import { CoreAiConnectionService } from './services/core-ai-connection.service';
import { CoreAiConversationService } from './services/core-ai-conversation.service';
import { CoreAiInteractionService } from './services/core-ai-interaction.service';
import { CoreAiPlaceholderRegistry } from './services/core-ai-placeholder.registry';
import { CoreAiPromptHintService } from './services/core-ai-prompt-hint.service';
import { CoreAiPromptService } from './services/core-ai-prompt.service';
import { CoreAiSlotService } from './services/core-ai-slot.service';
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
    protected readonly slotService: CoreAiSlotService,
    protected readonly promptHintService: CoreAiPromptHintService,
    protected readonly promptService: CoreAiPromptService,
    protected readonly placeholderRegistry: CoreAiPlaceholderRegistry,
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
    return this.connectionResolver.setPreference(
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
   * Probe an AI connection's endpoint to auto-detect and persist its capabilities
   * (JSON / native tools) for any flag left undefined.
   */
  @Post('connections/:id/detect-capabilities')
  @Roles(RoleEnum.ADMIN)
  async detectConnectionCapabilities(
    @RESTServiceOptions() serviceOptions: ServiceOptions,
    @Param('id') id: string,
  ): Promise<CoreAiConnection> {
    await this.connectionService.detectAndPersistCapabilities(id);
    return this.connectionService.get(id, serviceOptions);
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
   * Find the current user's AI conversations (own only by default). An admin may
   * pass `?all=true` to list every user's conversations; each result carries its
   * `createdBy` owner id for attribution. The flag is ignored for non-admins.
   *
   * The `messages` subdocument array is excluded from the list result — clients
   * fetching the conversation detail via `getConversation` get the full message
   * history. List payloads stay small even for users with many long conversations.
   */
  @Get('conversations')
  @Roles(RoleEnum.S_USER)
  async findConversations(
    @RESTServiceOptions() serviceOptions: ServiceOptions,
    @Query('all') all?: string,
  ): Promise<CoreAiConversation[]> {
    // Owner-scoped list shared with the GraphQL resolver — see
    // CoreAiConversationService.findForCurrentUser for the role/ownership rationale.
    // Admins default to their own conversations and opt in to the cross-user view via ?all=true.
    return this.conversationService.findForCurrentUser(serviceOptions, { all: all === 'true' });
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

  // ===================================================================================================================
  // Placeholders — runtime registry, available to any signed-in user (for slot/prompt editors)
  // ===================================================================================================================

  /** List every registered placeholder with its name + description (for slot/prompt editors). */
  @Get('placeholders')
  @Roles(RoleEnum.S_USER)
  async listPlaceholders(): Promise<unknown[]> {
    return this.placeholderRegistry.list();
  }

  // ===================================================================================================================
  // Slots — admin-editable system-prompt building blocks (tenant-scoped)
  // ===================================================================================================================

  /**
   * Effective slots for the admin UI — framework defaults + tenant overrides + tenant customs.
   * Each entry carries `isSystem` / `isOverride` flags so the UI can render the correct action.
   * NOTE: this route comes BEFORE `:id` parameter routes so Express matches it literally.
   */
  @Get('slots/effective')
  @Roles(RoleEnum.ADMIN)
  async listEffectiveSlots(@RESTServiceOptions() serviceOptions: ServiceOptions): Promise<unknown[]> {
    return this.slotService.listEffective(serviceOptions);
  }

  /**
   * Reset a system-slot override (deletes the row → framework default applies
   * again). Returns the now-effective system-default slot so the caller can
   * refresh its UI without a follow-up `/ai/slots/effective` call.
   */
  @Post('slots/:id/reset')
  @Roles(RoleEnum.ADMIN)
  async resetSlot(@RESTServiceOptions() serviceOptions: ServiceOptions, @Param('id') id: string) {
    return this.slotService.resetSystemSlot(id, serviceOptions);
  }

  /** Find slots stored for the current tenant (admin). Custom + override rows only — system defaults are virtual. */
  @Get('slots')
  @Roles(RoleEnum.ADMIN)
  async findSlots(@RESTServiceOptions() serviceOptions: ServiceOptions): Promise<CoreAiSlot[]> {
    return this.slotService.find({}, serviceOptions);
  }

  /** Create a tenant slot (admin). Use the system-default `key` to override a default. */
  @Post('slots')
  @Roles(RoleEnum.ADMIN)
  async createSlot(
    @RESTServiceOptions() serviceOptions: ServiceOptions,
    @Body() input: CoreAiSlotCreateInput,
  ): Promise<CoreAiSlot> {
    return this.slotService.create(input, { ...serviceOptions, inputType: CoreAiSlotCreateInput });
  }

  /** Update a tenant slot (admin). Slot must belong to the calling admin's tenant. */
  @Put('slots/:id')
  @Roles(RoleEnum.ADMIN)
  async updateSlot(
    @RESTServiceOptions() serviceOptions: ServiceOptions,
    @Param('id') id: string,
    @Body() input: CoreAiSlotUpdateInput,
  ): Promise<CoreAiSlot> {
    return this.slotService.update(id, input, { ...serviceOptions, inputType: CoreAiSlotUpdateInput });
  }

  /** Delete a tenant slot (admin). Real delete; custom slots cannot be restored. */
  @Delete('slots/:id')
  @Roles(RoleEnum.ADMIN)
  async deleteSlot(@RESTServiceOptions() serviceOptions: ServiceOptions, @Param('id') id: string): Promise<CoreAiSlot> {
    return this.slotService.delete(id, serviceOptions);
  }

  // ===================================================================================================================
  // Learned prompt hints (governed self-improvement loop)
  // ===================================================================================================================

  /** Find learned prompt hints (admin). */
  @Get('prompt-hints')
  @Roles(RoleEnum.ADMIN)
  async findPromptHints(@RESTServiceOptions() serviceOptions: ServiceOptions): Promise<CoreAiPromptHint[]> {
    return this.promptHintService.find({}, serviceOptions);
  }

  /** Create a learned prompt hint manually (admin). */
  @Post('prompt-hints')
  @Roles(RoleEnum.ADMIN)
  async createPromptHint(
    @RESTServiceOptions() serviceOptions: ServiceOptions,
    @Body() input: CoreAiPromptHintCreateInput,
  ): Promise<CoreAiPromptHint> {
    return this.promptHintService.create(input, { ...serviceOptions, inputType: CoreAiPromptHintCreateInput });
  }

  /** Update a learned prompt hint (admin) — typically approve/reject or edit. */
  @Put('prompt-hints/:id')
  @Roles(RoleEnum.ADMIN)
  async updatePromptHint(
    @RESTServiceOptions() serviceOptions: ServiceOptions,
    @Param('id') id: string,
    @Body() input: CoreAiPromptHintInput,
  ): Promise<CoreAiPromptHint> {
    return this.promptHintService.update(id, input, { ...serviceOptions, inputType: CoreAiPromptHintInput });
  }

  /** Delete a learned prompt hint (admin). */
  @Delete('prompt-hints/:id')
  @Roles(RoleEnum.ADMIN)
  async deletePromptHint(
    @RESTServiceOptions() serviceOptions: ServiceOptions,
    @Param('id') id: string,
  ): Promise<CoreAiPromptHint> {
    return this.promptHintService.delete(id, serviceOptions);
  }

  // ===================================================================================================================
  // User-facing user prompts ("Vorlagen") — own / tenant / global
  // ===================================================================================================================

  /** List user prompts visible to the current user (own + tenant + global). */
  @Get('prompts')
  @Roles(RoleEnum.S_USER)
  async findPrompts(@RESTServiceOptions() serviceOptions: ServiceOptions): Promise<CoreAiPrompt[]> {
    return this.promptService.listVisible(serviceOptions);
  }

  /** Create a user prompt for the current user / tenant (global requires admin). */
  @Post('prompts')
  @Roles(RoleEnum.S_USER)
  async createPrompt(
    @RESTServiceOptions() serviceOptions: ServiceOptions,
    @Body() input: CoreAiPromptCreateInput,
  ): Promise<CoreAiPrompt> {
    return this.promptService.create(input, { ...serviceOptions, inputType: CoreAiPromptCreateInput });
  }

  /** Update a user prompt (owner only; admins via standard admin pipeline). */
  @Put('prompts/:id')
  @Roles(RoleEnum.S_USER)
  async updatePrompt(
    @RESTServiceOptions() serviceOptions: ServiceOptions,
    @Param('id') id: string,
    @Body() input: CoreAiPromptUpdateInput,
  ): Promise<CoreAiPrompt> {
    return this.promptService.update(id, input, { ...serviceOptions, inputType: CoreAiPromptUpdateInput });
  }

  /** Delete a user prompt (owner only; admins via standard admin pipeline). */
  @Delete('prompts/:id')
  @Roles(RoleEnum.S_USER)
  async deletePrompt(
    @RESTServiceOptions() serviceOptions: ServiceOptions,
    @Param('id') id: string,
  ): Promise<CoreAiPrompt> {
    return this.promptService.delete(id, serviceOptions);
  }
}
