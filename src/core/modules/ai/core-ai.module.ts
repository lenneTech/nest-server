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
import { CoreAiService } from './services/core-ai.service';
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

  /** Custom GraphQL resolver (extends CoreAiResolver). */
  resolver?: Type<CoreAiResolver>;

  /** Custom orchestrator service (extends CoreAiService). */
  service?: Type<CoreAiService>;
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
    const ResolverClass = options.resolver || CoreAiResolver;
    const ServiceClass = options.service || CoreAiService;

    // Register the MCP controller only when enabled (it lazy-loads the MCP SDK).
    const controllers: Type<any>[] = [ControllerClass];
    if (options.mcpEnabled) {
      controllers.push(CoreAiMcpController);
    }

    return {
      controllers,
      exports: [
        AiCryptoService,
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
        CoreAiService,
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
        ]),
      ],
      module: CoreAiModule,
      providers: [
        AiCryptoService,
        AiToolRegistry,
        LlmProviderFactory,
        { provide: AI_BUDGET_LIMIT_CLASS, useValue: CoreAiBudgetLimit },
        { provide: AI_CONNECTION_CLASS, useValue: CoreAiConnection },
        { provide: AI_CONNECTION_PREFERENCE_CLASS, useValue: CoreAiConnectionPreference },
        { provide: AI_CONVERSATION_CLASS, useValue: CoreAiConversation },
        { provide: AI_INTERACTION_CLASS, useValue: CoreAiInteraction },
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
        { provide: CoreAiService, useClass: ServiceClass },
        ResolverClass,
      ],
    };
  }
}
