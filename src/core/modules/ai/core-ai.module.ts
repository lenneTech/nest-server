import { DynamicModule, Global, Module, Type } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';

import { CoreAiMcpController } from './core-ai-mcp.controller';
import { CoreAiController } from './core-ai.controller';
import { CoreAiResolver } from './core-ai.resolver';
import { CoreAiMcpOAuthService } from './services/core-ai-mcp-oauth.service';
import { CoreAiMcpService } from './services/core-ai-mcp.service';
import { AiBudgetLimitSchema, CoreAiBudgetLimit } from './models/core-ai-budget-limit.model';
import { AiConnectionPreferenceSchema, CoreAiConnectionPreference } from './models/core-ai-connection-preference.model';
import { AiConnectionSchema, CoreAiConnection } from './models/core-ai-connection.model';
import { AiConversationSchema, CoreAiConversation } from './models/core-ai-conversation.model';
import { AiInteractionSchema, CoreAiInteraction } from './models/core-ai-interaction.model';
import { AiPromptHintSchema, CoreAiPromptHint } from './models/core-ai-prompt-hint.model';
import { AiPromptTemplateSchema, CoreAiPromptTemplate } from './models/core-ai-prompt-template.model';
import { AiModeSchema, CoreAiMode } from './models/core-ai-mode.model';
import { AiToolGrantSchema, CoreAiToolGrant } from './models/core-ai-tool-grant.model';
import { AiToolPolicySchema, CoreAiToolPolicy } from './models/core-ai-tool-policy.model';
import { LlmProviderFactory } from './providers/llm-provider.factory';
import { AiCryptoService } from './services/ai-crypto.service';
import { AI_BUDGET_LIMIT_CLASS, AI_BUDGET_LIMIT_MODEL, CoreAiBudgetService } from './services/core-ai-budget.service';
import {
  AI_CONNECTION_PREFERENCE_CLASS,
  AI_CONNECTION_PREFERENCE_MODEL,
  CoreAiConnectionPreferenceService,
} from './services/core-ai-connection-preference.service';
import { CoreAiConnectionResolverService } from './services/core-ai-connection-resolver.service';
import {
  AI_CONNECTION_CLASS,
  AI_CONNECTION_MODEL,
  CoreAiConnectionService,
} from './services/core-ai-connection.service';
import {
  AI_CONVERSATION_CLASS,
  AI_CONVERSATION_MODEL,
  CoreAiConversationService,
} from './services/core-ai-conversation.service';
import {
  AI_INTERACTION_CLASS,
  AI_INTERACTION_MODEL,
  CoreAiInteractionService,
} from './services/core-ai-interaction.service';
import { CoreAiPromptBuilderService } from './services/core-ai-prompt-builder.service';
import {
  AI_PROMPT_HINT_CLASS,
  AI_PROMPT_HINT_MODEL,
  CoreAiPromptHintService,
} from './services/core-ai-prompt-hint.service';
import {
  AI_PROMPT_TEMPLATE_CLASS,
  AI_PROMPT_TEMPLATE_MODEL,
  CoreAiPromptTemplateService,
} from './services/core-ai-prompt-template.service';
import {
  AI_TOOL_GRANT_CLASS,
  AI_TOOL_GRANT_MODEL,
  CoreAiToolGrantService,
} from './services/core-ai-tool-grant.service';
import {
  AI_TOOL_POLICY_CLASS,
  AI_TOOL_POLICY_MODEL,
  CoreAiToolPolicyService,
} from './services/core-ai-tool-policy.service';
import { AI_MODE_CLASS, AI_MODE_MODEL, CoreAiModeService } from './services/core-ai-mode.service';
import { CoreAiService } from './services/core-ai.service';
import { AiHookRegistry } from './hooks/ai-hook.registry';
import { AskUserQuestionAiTool } from './tools/ask-user-question.tool';
import { SearchToolsAiTool } from './tools/search-tools.tool';
import { AiToolRegistry } from './tools/ai-tool.registry';

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

  /** Custom connection-preference service (extends CoreAiConnectionPreferenceService). */
  preferenceService?: Type<CoreAiConnectionPreferenceService>;

  /** Custom prompt builder (extends CoreAiPromptBuilderService). */
  promptBuilder?: Type<CoreAiPromptBuilderService>;

  /** Custom learned-hint service / learning loop (extends CoreAiPromptHintService). */
  promptHintService?: Type<CoreAiPromptHintService>;

  /** Custom prompt-template store (extends CoreAiPromptTemplateService). */
  promptTemplateService?: Type<CoreAiPromptTemplateService>;

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
    const PromptBuilderClass = options.promptBuilder || CoreAiPromptBuilderService;
    const PromptHintServiceClass = options.promptHintService || CoreAiPromptHintService;
    const PromptTemplateServiceClass = options.promptTemplateService || CoreAiPromptTemplateService;
    const ResolverClass = options.resolver || CoreAiResolver;
    const ServiceClass = options.service || CoreAiService;
    const ToolGrantServiceClass = options.toolGrantService || CoreAiToolGrantService;
    const ToolPolicyServiceClass = options.toolPolicyService || CoreAiToolPolicyService;
    const ModeServiceClass = options.modeService || CoreAiModeService;

    // Register the MCP controller only when enabled (it lazy-loads the MCP SDK).
    const controllers: Type<any>[] = [ControllerClass];
    if (options.mcpEnabled) {
      controllers.push(CoreAiMcpController);
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
        CoreAiPromptBuilderService,
        CoreAiPromptHintService,
        CoreAiPromptTemplateService,
        CoreAiService,
        CoreAiToolGrantService,
        CoreAiToolPolicyService,
        CoreAiModeService,
        LlmProviderFactory,
        MongooseModule,
      ],
      imports: [
        MongooseModule.forFeature([
          { name: AI_BUDGET_LIMIT_MODEL, schema: AiBudgetLimitSchema },
          { name: AI_CONNECTION_MODEL, schema: AiConnectionSchema },
          { name: AI_CONNECTION_PREFERENCE_MODEL, schema: AiConnectionPreferenceSchema },
          { name: AI_CONVERSATION_MODEL, schema: AiConversationSchema },
          { name: AI_INTERACTION_MODEL, schema: AiInteractionSchema },
          { name: AI_PROMPT_HINT_MODEL, schema: AiPromptHintSchema },
          { name: AI_PROMPT_TEMPLATE_MODEL, schema: AiPromptTemplateSchema },
          { name: AI_TOOL_GRANT_MODEL, schema: AiToolGrantSchema },
          { name: AI_TOOL_POLICY_MODEL, schema: AiToolPolicySchema },
          { name: AI_MODE_MODEL, schema: AiModeSchema },
        ]),
      ],
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
        { provide: AI_PROMPT_TEMPLATE_CLASS, useValue: CoreAiPromptTemplate },
        { provide: AI_TOOL_GRANT_CLASS, useValue: CoreAiToolGrant },
        { provide: AI_TOOL_POLICY_CLASS, useValue: CoreAiToolPolicy },
        { provide: AI_MODE_CLASS, useValue: CoreAiMode },
        { provide: CoreAiBudgetService, useClass: BudgetServiceClass },
        { provide: CoreAiConversationService, useClass: ConversationServiceClass },
        { provide: CoreAiInteractionService, useClass: InteractionServiceClass },
        CoreAiMcpService,
        CoreAiMcpOAuthService,
        // Bind base-class tokens to the (possibly overridden) implementations so
        // injections by base type resolve to the project's subclass.
        { provide: CoreAiConnectionPreferenceService, useClass: PreferenceServiceClass },
        { provide: CoreAiConnectionResolverService, useClass: ConnectionResolverClass },
        { provide: CoreAiConnectionService, useClass: ConnectionServiceClass },
        { provide: CoreAiPromptBuilderService, useClass: PromptBuilderClass },
        { provide: CoreAiPromptHintService, useClass: PromptHintServiceClass },
        { provide: CoreAiPromptTemplateService, useClass: PromptTemplateServiceClass },
        { provide: CoreAiService, useClass: ServiceClass },
        { provide: CoreAiToolGrantService, useClass: ToolGrantServiceClass },
        { provide: CoreAiToolPolicyService, useClass: ToolPolicyServiceClass },
        { provide: CoreAiModeService, useClass: ModeServiceClass },
        ResolverClass,
      ],
    };
  }
}
