import { Injectable, Logger, Optional } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import type { LanguageModel } from 'ai';

import { ILlmProvider } from '../interfaces/llm-provider.interface.js';
import { ResolvedAiConnection } from '../interfaces/resolved-ai-connection.interface.js';
import { createAiEgressFetch } from './ai-egress.helper.js';
import { AiSdkPackageError, loadAiSdk, loadNestjsAi } from './ai-sdk.packages.js';
import { AiSdkProvider } from './ai-sdk.provider.js';
import { OpenAiCompatibleProvider } from './openai-compatible.provider.js';

/**
 * What a project's AI SDK model builder receives besides the connection (nestjs-ai plan §2).
 */
export interface AiSdkModelBuilderContext {
  /**
   * A `fetch` that refuses every host outside `ai.allowedBaseUrlHosts` — hand it to the provider
   * (`createAnthropic({ apiKey, baseURL, fetch })`), or the egress allowlist does not cover the provider's requests.
   */
  fetch: typeof fetch;
}

/**
 * Builds the AI SDK `LanguageModel` of a database-managed connection: `connection.apiKey` is the DECRYPTED key,
 * `connection.model` the model id. The core imports no `@ai-sdk/*` package — the project does:
 *
 * ```typescript
 * factory.registerAiSdkModel('anthropic', (connection, { fetch }) =>
 *   createAnthropic({ apiKey: connection.apiKey, fetch })(connection.model),
 * );
 * ```
 */
export type AiSdkModelBuilder = (
  connection: ResolvedAiConnection,
  context: AiSdkModelBuilderContext,
) => LanguageModel | Promise<LanguageModel>;

/** The `providerType` of a connection that names a model registered in `@nestjs/ai`'s `AiModule.forRoot({ models })`. */
export const NESTJS_AI_PROVIDER_TYPE = 'nestjs-ai';

/**
 * Builds an {@link ILlmProvider} from a resolved connection.
 *
 * Builders are keyed by `providerType`. The factory ships with a builder for the
 * `openai-compatible` chat API shape (a de-facto standard spoken by many local and
 * hosted backends — not a specific vendor). Projects add builders for other
 * backends/protocols by calling {@link registerBuilder} — typically from a
 * module's `onModuleInit` — without subclassing the factory.
 *
 * @example
 * ```typescript
 * factory.registerBuilder('my-provider', (conn) => new MyProvider(conn));
 * ```
 */
@Injectable()
export class LlmProviderFactory {
  private readonly logger = new Logger(LlmProviderFactory.name);
  private readonly builders = new Map<string, (connection: ResolvedAiConnection) => ILlmProvider>();

  constructor(@Optional() protected readonly moduleRef?: ModuleRef) {
    // Default builder for the OpenAI-compatible API shape (protocol, not a vendor).
    const openAiCompatibleBuilder = (connection: ResolvedAiConnection) => new OpenAiCompatibleProvider(connection);
    this.registerBuilder('openai-compatible', openAiCompatibleBuilder);
    // Convenience alias for connections that store the shorter protocol key.
    this.registerBuilder('openai', openAiCompatibleBuilder);
    // A model registered in @nestjs/ai's AiModule.forRoot({ models }), by name (`connection.model`). Inert until a
    // connection names this providerType: nothing of @nestjs/ai is loaded before (nestjs-ai plan §2).
    this.registerBuilder(
      NESTJS_AI_PROVIDER_TYPE,
      (connection) =>
        new AiSdkProvider(connection, {
          model: () => this.resolveNestjsAiModel(connection),
          resilience: 'nestjs',
        }),
    );
  }

  /**
   * Register an AI SDK model builder for a `providerType` (12.10.0, nestjs-ai plan §2): connections of that type —
   * managed in the database, with encrypted keys, per tenant — run on an {@link AiSdkProvider} over the model the
   * builder returns. The builder runs on the first call of each connection; `ai` is checked against its tested range
   * then, and immediately here so a missing or untested `ai` fails the boot of the module that registers the builder.
   */
  async registerAiSdkModel(providerType: string, builder: AiSdkModelBuilder): Promise<void> {
    await loadAiSdk(`LlmProviderFactory.registerAiSdkModel('${providerType}')`);
    this.registerBuilder(
      providerType,
      (connection) =>
        new AiSdkProvider(connection, {
          model: () => builder(connection, { fetch: createAiEgressFetch(connection.name) }),
        }),
    );
  }

  /**
   * The `@nestjs/ai` model a `nestjs-ai` connection names. Resolved from the application, never constructed: a model
   * name the project did not register fails the call with a message naming it.
   */
  protected async resolveNestjsAiModel(connection: ResolvedAiConnection): Promise<LanguageModel> {
    const nestjsAi = await loadNestjsAi(
      `The AI connection "${connection.name}" (providerType "${NESTJS_AI_PROVIDER_TYPE}")`,
    );
    let models: { get(name?: string): LanguageModel; has(name: string): boolean } | undefined;
    try {
      models = this.moduleRef?.get(nestjsAi.AiModels, { strict: false });
    } catch {
      models = undefined;
    }
    if (!models) {
      throw new AiSdkPackageError(
        `The AI connection "${connection.name}" names a @nestjs/ai model, but the application imports no ` +
          'AiModule.forRoot({ models }).',
      );
    }
    const name = connection.model || 'default';
    if (!models.has(name)) {
      throw new AiSdkPackageError(
        `The AI connection "${connection.name}" names the @nestjs/ai model "${name}", which AiModule.forRoot({ models }) ` +
          'does not register.',
      );
    }
    return models.get(name);
  }

  /**
   * Register (or override) a provider builder for a `providerType`.
   */
  registerBuilder(providerType: string, builder: (connection: ResolvedAiConnection) => ILlmProvider): void {
    this.builders.set(providerType, builder);
    this.logger.debug(`Registered LLM provider builder: ${providerType}`);
  }

  /**
   * Create a provider for a resolved connection.
   * @throws Error if no builder is registered for the connection's providerType.
   */
  create(connection: ResolvedAiConnection): ILlmProvider {
    const builder = this.builders.get(connection.providerType);
    if (!builder) {
      throw new Error(
        `No LLM provider builder registered for providerType "${connection.providerType}". ` +
          `Register one via LlmProviderFactory.registerBuilder().`,
      );
    }
    return builder(connection);
  }

  /**
   * Whether a builder exists for the given provider type.
   */
  supports(providerType: string): boolean {
    return this.builders.has(providerType);
  }
}
