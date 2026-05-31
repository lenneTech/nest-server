import { Injectable, Logger } from '@nestjs/common';

import { ILlmProvider } from '../interfaces/llm-provider.interface';
import { ResolvedAiConnection } from '../interfaces/resolved-ai-connection.interface';
import { OpenAiCompatibleProvider } from './openai-compatible.provider';

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

  constructor() {
    // Default builder for the OpenAI-compatible API shape (protocol, not a vendor).
    const openAiCompatibleBuilder = (connection: ResolvedAiConnection) => new OpenAiCompatibleProvider(connection);
    this.registerBuilder('openai-compatible', openAiCompatibleBuilder);
    // Convenience alias for connections that store the shorter protocol key.
    this.registerBuilder('openai', openAiCompatibleBuilder);
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
