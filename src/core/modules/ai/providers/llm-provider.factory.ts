import { Injectable, Logger } from '@nestjs/common';

import { ILlmProvider } from '../interfaces/llm-provider.interface';
import { ResolvedAiConnection } from '../interfaces/resolved-ai-connection.interface';
import { OpenAiCompatibleProvider } from './openai-compatible.provider';

/**
 * Builds an {@link ILlmProvider} from a resolved connection.
 *
 * Builders are keyed by `providerType`. The factory ships with an
 * `openai-compatible` builder (mittwald, Azure OpenAI, vLLM, Ollama `/v1`, …).
 * Projects extend support for new backends (e.g. native Anthropic) by calling
 * {@link registerBuilder} — typically from a module's `onModuleInit` — without
 * subclassing the factory.
 *
 * @example
 * ```typescript
 * factory.registerBuilder('anthropic', (conn) => new AnthropicProvider(conn));
 * ```
 */
@Injectable()
export class LlmProviderFactory {
  private readonly logger = new Logger(LlmProviderFactory.name);
  private readonly builders = new Map<string, (connection: ResolvedAiConnection) => ILlmProvider>();

  constructor() {
    // Default builder: OpenAI-compatible (covers mittwald and most gateways).
    const openAiBuilder = (connection: ResolvedAiConnection) => new OpenAiCompatibleProvider(connection);
    this.registerBuilder('openai-compatible', openAiBuilder);
    // Aliases so a connection stored as plain 'openai' resolves too.
    this.registerBuilder('openai', openAiBuilder);
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
