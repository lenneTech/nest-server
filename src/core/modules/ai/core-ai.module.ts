import { DynamicModule, Global, Module, Type } from '@nestjs/common';

import { CoreAiMcpOAuthInitializer } from './core-ai-mcp-oauth.initializer.js';
import { CoreAiMcpController } from './core-ai-mcp.controller.js';
import { CoreAiController } from './core-ai.controller.js';
import { CoreAiResolver } from './core-ai.resolver.js';
import { CoreAiMcpOAuthService } from './services/core-ai-mcp-oauth.service.js';
import { CoreAiMcpService } from './services/core-ai-mcp.service.js';
import { CorePersistenceModule } from '../../common/persistence/core-persistence.module.js';
import {
  AI_MCP_OAUTH_CLIENT_MODEL,
  AI_MCP_OAUTH_CODE_MODEL,
  AI_MCP_OAUTH_REFRESH_TOKEN_MODEL,
} from './core-ai.constants.js';
import { AiBudgetLimitSchema, CoreAiBudgetLimit } from './models/core-ai-budget-limit.model.js';
import {
  AiMcpOAuthClientSchema,
  AiMcpOAuthCodeSchema,
  AiMcpOAuthRefreshTokenSchema,
} from './models/core-ai-mcp-oauth.models.js';
import {
  AiConnectionPreferenceSchema,
  CoreAiConnectionPreference,
} from './models/core-ai-connection-preference.model.js';
import { AiConnectionSchema, CoreAiConnection } from './models/core-ai-connection.model.js';
import { AiConversationSchema, CoreAiConversation } from './models/core-ai-conversation.model.js';
import { AiInteractionSchema, CoreAiInteraction } from './models/core-ai-interaction.model.js';
import { AiPromptHintSchema, CoreAiPromptHint } from './models/core-ai-prompt-hint.model.js';
import { AiPromptSchema, CoreAiPrompt } from './models/core-ai-prompt.model.js';
import { AiSlotSchema, CoreAiSlot } from './models/core-ai-slot.model.js';
import { AiModeSchema, CoreAiMode } from './models/core-ai-mode.model.js';
import { AiToolGrantSchema, CoreAiToolGrant } from './models/core-ai-tool-grant.model.js';
import { AiToolPolicySchema, CoreAiToolPolicy } from './models/core-ai-tool-policy.model.js';
import { LlmProviderFactory } from './providers/llm-provider.factory.js';
import { AiCryptoService } from './services/ai-crypto.service.js';
import {
  AI_BUDGET_LIMIT_CLASS,
  AI_BUDGET_LIMIT_MODEL,
  CoreAiBudgetService,
} from './services/core-ai-budget.service.js';
import {
  AI_CONNECTION_PREFERENCE_CLASS,
  AI_CONNECTION_PREFERENCE_MODEL,
  CoreAiConnectionPreferenceService,
} from './services/core-ai-connection-preference.service.js';
import { CoreAiConnectionResolverService } from './services/core-ai-connection-resolver.service.js';
import {
  AI_CONNECTION_CLASS,
  AI_CONNECTION_MODEL,
  CoreAiConnectionService,
} from './services/core-ai-connection.service.js';
import {
  AI_CONVERSATION_CLASS,
  AI_CONVERSATION_MODEL,
  CoreAiConversationService,
} from './services/core-ai-conversation.service.js';
import {
  AI_INTERACTION_CLASS,
  AI_INTERACTION_MODEL,
  CoreAiInteractionService,
} from './services/core-ai-interaction.service.js';
import { CoreAiPlaceholderRegistry } from './services/core-ai-placeholder.registry.js';
import { CoreAiPromptBuilderService } from './services/core-ai-prompt-builder.service.js';
import {
  AI_PROMPT_HINT_CLASS,
  AI_PROMPT_HINT_MODEL,
  CoreAiPromptHintService,
} from './services/core-ai-prompt-hint.service.js';
import { AI_PROMPT_CLASS, AI_PROMPT_MODEL, CoreAiPromptService } from './services/core-ai-prompt.service.js';
import { AI_SLOT_CLASS, AI_SLOT_MODEL, CoreAiSlotService } from './services/core-ai-slot.service.js';
import {
  AI_TOOL_GRANT_CLASS,
  AI_TOOL_GRANT_MODEL,
  CoreAiToolGrantService,
} from './services/core-ai-tool-grant.service.js';
import {
  AI_TOOL_POLICY_CLASS,
  AI_TOOL_POLICY_MODEL,
  CoreAiToolPolicyService,
} from './services/core-ai-tool-policy.service.js';
import { AI_MODE_CLASS, AI_MODE_MODEL, CoreAiModeService } from './services/core-ai-mode.service.js';
import { CoreAiMcpClientService } from './services/core-ai-mcp-client.service.js';
import { CoreAiService } from './services/core-ai.service.js';
import { AiHookRegistry } from './hooks/ai-hook.registry.js';
import { AskUserQuestionAiTool } from './tools/ask-user-question.tool.js';
import { SearchToolsAiTool } from './tools/search-tools.tool.js';
import { AiToolRegistry } from './tools/ai-tool.registry.js';

/**
 * Options for {@link CoreAiModule.forRoot}. Every collaborator can be replaced
 * with a project-specific subclass for full customization (Module Inheritance
 * Pattern). Pass these via `CoreModule.forRoot(envConfig, { ai: { ... } })`.
 */
export interface CoreAiModuleOptions {
  /** Custom connection-resolution service (extends CoreAiConnectionResolverService). */
  connectionResolver?: Type<CoreAiConnectionResolverService>;

  /** Custom CRUD service for AI connections (extends CoreAiConnectionService). */
  connectionService?: Type<CoreAiConnectionService>;

  /** Custom REST controller (extends CoreAiController). */
  controller?: Type<CoreAiController>;

  /** Custom budget service (extends CoreAiBudgetService). */
  budgetService?: Type<CoreAiBudgetService>;

  /** Custom conversation service (extends CoreAiConversationService). */
  conversationService?: Type<CoreAiConversationService>;

  /** Custom audit/interaction service (extends CoreAiInteractionService). */
  interactionService?: Type<CoreAiInteractionService>;

  /** Whether to register the MCP server controller at /ai/mcp. */
  mcpEnabled?: boolean;

  /**
   * Custom MCP OAuth service (extends CoreAiMcpOAuthService) — where `authorizeConsent()` wires the
   * login/consent UI. Bound to the base token, so the MCP controller and the OAuth endpoints use it.
   */
  mcpOAuthService?: Type<CoreAiMcpOAuthService>;

  /** Custom connection-preference service (extends CoreAiConnectionPreferenceService). */
  preferenceService?: Type<CoreAiConnectionPreferenceService>;

  /** Custom placeholder registry (extends CoreAiPlaceholderRegistry). */
  placeholderRegistry?: Type<CoreAiPlaceholderRegistry>;

  /** Custom prompt builder (extends CoreAiPromptBuilderService). */
  promptBuilder?: Type<CoreAiPromptBuilderService>;

  /** Custom learned-hint service / learning loop (extends CoreAiPromptHintService). */
  promptHintService?: Type<CoreAiPromptHintService>;

  /** Custom user-facing user prompt store (extends CoreAiPromptService). */
  promptService?: Type<CoreAiPromptService>;

  /** Custom slot store (extends CoreAiSlotService). */
  slotService?: Type<CoreAiSlotService>;

  /** Custom GraphQL resolver (extends CoreAiResolver). */
  resolver?: Type<CoreAiResolver>;

  /** Custom orchestrator service (extends CoreAiService). */
  service?: Type<CoreAiService>;

  /** Custom tool-grant ("remember my decision") store (extends CoreAiToolGrantService). */
  toolGrantService?: Type<CoreAiToolGrantService>;

  /** Custom scoped tool-policy store (extends CoreAiToolPolicyService). */
  toolPolicyService?: Type<CoreAiToolPolicyService>;

  /** Custom named-mode store (extends CoreAiModeService). */
  modeService?: Type<CoreAiModeService>;

  /** Custom MCP-client wiring (extends CoreAiMcpClientService). */
  mcpClientService?: Type<CoreAiMcpClientService>;
}

/**
 * Core AI module: database-backed LLM connections, a provider abstraction, a
 * global tool registry and the prompt orchestrator.
 *
 * `@Global()` so the {@link AiToolRegistry} (and the other services) can be
 * injected from any module — projects register tools by declaring providers that
 * call `registry.register(...)` (typically via the {@link AiTool} base class).
 *
 * Auto-registered by `CoreModule.forRoot()` when an `ai` config block is present
 * (presence implies enabled). Disable with `ai: { enabled: false }`.
 *
 * @example
 * ```typescript
 * // Zero-config (uses defaults + config.env.ts `ai` block)
 * CoreModule.forRoot(envConfig)
 *
 * // With a custom orchestrator and resolver
 * CoreModule.forRoot(envConfig, { ai: { service: MyAiService, resolver: MyAiResolver } })
 * ```
 */
@Global()
@Module({})
export class CoreAiModule {
  static forRoot(options: CoreAiModuleOptions = {}): DynamicModule {
    const BudgetServiceClass = options.budgetService || CoreAiBudgetService;
    const ConnectionResolverClass = options.connectionResolver || CoreAiConnectionResolverService;
    const ConnectionServiceClass = options.connectionService || CoreAiConnectionService;
    const ControllerClass = options.controller || CoreAiController;
    const ConversationServiceClass = options.conversationService || CoreAiConversationService;
    const InteractionServiceClass = options.interactionService || CoreAiInteractionService;
    const PreferenceServiceClass = options.preferenceService || CoreAiConnectionPreferenceService;
    const PlaceholderRegistryClass = options.placeholderRegistry || CoreAiPlaceholderRegistry;
    const PromptBuilderClass = options.promptBuilder || CoreAiPromptBuilderService;
    const PromptHintServiceClass = options.promptHintService || CoreAiPromptHintService;
    const PromptServiceClass = options.promptService || CoreAiPromptService;
    const SlotServiceClass = options.slotService || CoreAiSlotService;
    const ResolverClass = options.resolver || CoreAiResolver;
    const ServiceClass = options.service || CoreAiService;
    // Registered through the persistence layer, so `database` routes them like every other model (db-agnostic phase 4);
    // `@InjectModel()` keeps working, and each service reaches its routed store through `dataStore`
    const aiModels = CorePersistenceModule.forFeature([
      { model: CoreAiBudgetLimit, name: AI_BUDGET_LIMIT_MODEL, schema: AiBudgetLimitSchema },
      { model: CoreAiConnection, name: AI_CONNECTION_MODEL, schema: AiConnectionSchema },
      { model: CoreAiConnectionPreference, name: AI_CONNECTION_PREFERENCE_MODEL, schema: AiConnectionPreferenceSchema },
      { model: CoreAiConversation, name: AI_CONVERSATION_MODEL, schema: AiConversationSchema },
      { model: CoreAiInteraction, name: AI_INTERACTION_MODEL, schema: AiInteractionSchema },
      { model: CoreAiPromptHint, name: AI_PROMPT_HINT_MODEL, schema: AiPromptHintSchema },
      { model: CoreAiPrompt, name: AI_PROMPT_MODEL, schema: AiPromptSchema },
      { model: CoreAiSlot, name: AI_SLOT_MODEL, schema: AiSlotSchema },
      { model: CoreAiToolGrant, name: AI_TOOL_GRANT_MODEL, schema: AiToolGrantSchema },
      { model: CoreAiToolPolicy, name: AI_TOOL_POLICY_MODEL, schema: AiToolPolicySchema },
      { model: CoreAiMode, name: AI_MODE_MODEL, schema: AiModeSchema },
      // Stored natively on MongoDB; the models give them their tables on a SQL source
      { name: AI_MCP_OAUTH_CLIENT_MODEL, schema: AiMcpOAuthClientSchema },
      { name: AI_MCP_OAUTH_CODE_MODEL, schema: AiMcpOAuthCodeSchema },
      { name: AI_MCP_OAUTH_REFRESH_TOKEN_MODEL, schema: AiMcpOAuthRefreshTokenSchema },
    ]);
    const ToolGrantServiceClass = options.toolGrantService || CoreAiToolGrantService;
    const ToolPolicyServiceClass = options.toolPolicyService || CoreAiToolPolicyService;
    const ModeServiceClass = options.modeService || CoreAiModeService;
    const McpClientServiceClass = options.mcpClientService || CoreAiMcpClientService;
    const McpOAuthServiceClass = options.mcpOAuthService || CoreAiMcpOAuthService;

    // Register the MCP controller only when enabled (it lazy-loads the MCP SDK), together with the
    // initializer that mounts its OAuth endpoints when `ai.mcp.oauth` is enabled.
    const controllers: Type<any>[] = [ControllerClass];
    const mcpProviders: Type<any>[] = [];
    if (options.mcpEnabled) {
      controllers.push(CoreAiMcpController);
      mcpProviders.push(CoreAiMcpOAuthInitializer);
    }

    return {
      controllers,
      exports: [
        AiCryptoService,
        AiHookRegistry,
        AiToolRegistry,
        CoreAiBudgetService,
        CoreAiConnectionPreferenceService,
        CoreAiConnectionResolverService,
        CoreAiConnectionService,
        CoreAiConversationService,
        CoreAiInteractionService,
        CoreAiMcpOAuthService,
        CoreAiMcpService,
        CoreAiPlaceholderRegistry,
        CoreAiPromptBuilderService,
        CoreAiPromptHintService,
        CoreAiPromptService,
        CoreAiSlotService,
        CoreAiService,
        CoreAiToolGrantService,
        CoreAiToolPolicyService,
        CoreAiModeService,
        CoreAiMcpClientService,
        LlmProviderFactory,
        aiModels,
      ],
      imports: [aiModels],
      module: CoreAiModule,
      providers: [
        AiCryptoService,
        AiHookRegistry,
        AiToolRegistry,
        AskUserQuestionAiTool,
        SearchToolsAiTool,
        LlmProviderFactory,
        { provide: AI_BUDGET_LIMIT_CLASS, useValue: CoreAiBudgetLimit },
        { provide: AI_CONNECTION_CLASS, useValue: CoreAiConnection },
        { provide: AI_CONNECTION_PREFERENCE_CLASS, useValue: CoreAiConnectionPreference },
        { provide: AI_CONVERSATION_CLASS, useValue: CoreAiConversation },
        { provide: AI_INTERACTION_CLASS, useValue: CoreAiInteraction },
        { provide: AI_PROMPT_HINT_CLASS, useValue: CoreAiPromptHint },
        { provide: AI_PROMPT_CLASS, useValue: CoreAiPrompt },
        { provide: AI_SLOT_CLASS, useValue: CoreAiSlot },
        { provide: AI_TOOL_GRANT_CLASS, useValue: CoreAiToolGrant },
        { provide: AI_TOOL_POLICY_CLASS, useValue: CoreAiToolPolicy },
        { provide: AI_MODE_CLASS, useValue: CoreAiMode },
        { provide: CoreAiBudgetService, useClass: BudgetServiceClass },
        { provide: CoreAiConversationService, useClass: ConversationServiceClass },
        { provide: CoreAiInteractionService, useClass: InteractionServiceClass },
        CoreAiMcpService,
        ...mcpProviders,
        // Bind base-class tokens to the (possibly overridden) implementations so
        // injections by base type resolve to the project's subclass.
        { provide: CoreAiConnectionPreferenceService, useClass: PreferenceServiceClass },
        { provide: CoreAiConnectionResolverService, useClass: ConnectionResolverClass },
        { provide: CoreAiConnectionService, useClass: ConnectionServiceClass },
        { provide: CoreAiPlaceholderRegistry, useClass: PlaceholderRegistryClass },
        { provide: CoreAiPromptBuilderService, useClass: PromptBuilderClass },
        { provide: CoreAiPromptHintService, useClass: PromptHintServiceClass },
        { provide: CoreAiPromptService, useClass: PromptServiceClass },
        { provide: CoreAiSlotService, useClass: SlotServiceClass },
        { provide: CoreAiService, useClass: ServiceClass },
        { provide: CoreAiToolGrantService, useClass: ToolGrantServiceClass },
        { provide: CoreAiToolPolicyService, useClass: ToolPolicyServiceClass },
        { provide: CoreAiModeService, useClass: ModeServiceClass },
        { provide: CoreAiMcpClientService, useClass: McpClientServiceClass },
        { provide: CoreAiMcpOAuthService, useClass: McpOAuthServiceClass },
        ResolverClass,
      ],
    };
  }
}
