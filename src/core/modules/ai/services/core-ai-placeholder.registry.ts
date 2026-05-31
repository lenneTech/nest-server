import { Injectable, Logger, OnModuleInit } from '@nestjs/common';

import { ConfigService } from '../../../common/services/config.service';
import { AiPlaceholderContext, AiPlaceholderInfo, IAiPlaceholder } from '../interfaces/ai-placeholder.interface';
import { CoreAiPromptHintService } from './core-ai-prompt-hint.service';

/**
 * Runtime registry of `{{placeholder}}` resolvers used by slots and user
 * prompts. The framework registers a small set of system placeholders on boot
 * (`roles`, `tools`, `toolCatalog`, `documentation`, `learnedHints`, `userId`);
 * projects can add their own via {@link register} from any provider.
 *
 * Why dynamic and not hard-coded in the frontend: the placeholder list is
 * served via `GET /ai/placeholders`, so admins see EVERY currently-supported
 * placeholder (incl. project-specific ones) — without requiring a frontend
 * change when the backend gets new ones. Resolvers stay in TypeScript (no
 * eval, no DB-stored function bodies), which keeps the surface secure and
 * straightforward.
 *
 * Override / extend via `CoreModule.forRoot(env, { ai: { placeholderRegistry } })`
 * or by injecting and calling `register()` from a project provider.
 */
@Injectable()
export class CoreAiPlaceholderRegistry implements OnModuleInit {
  protected readonly logger = new Logger(CoreAiPlaceholderRegistry.name);
  protected readonly placeholders = new Map<string, IAiPlaceholder>();

  constructor(protected readonly hintService?: CoreAiPromptHintService) {}

  onModuleInit(): void {
    this.registerDefaults();
  }

  /**
   * Register a placeholder. Repeated calls with the same `name` overwrite the
   * previous resolver — projects can replace system placeholders if they need
   * different semantics.
   */
  register(placeholder: IAiPlaceholder): void {
    if (!placeholder?.name) {
      this.logger.warn('Refusing to register a placeholder with no name.');
      return;
    }
    this.placeholders.set(placeholder.name, placeholder);
  }

  /** Remove a placeholder by name. Returns true if it was present. */
  unregister(name: string): boolean {
    return this.placeholders.delete(name);
  }

  /** Public metadata of every registered placeholder, sorted by name. */
  list(): AiPlaceholderInfo[] {
    return [...this.placeholders.values()]
      .map((p) => ({ description: p.description, example: p.example, name: p.name }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  /**
   * Resolve every registered placeholder for `ctx` and return a flat record
   * `{ name: value }` suitable for `{{token}}` substitution.
   */
  async resolveAll(ctx: AiPlaceholderContext): Promise<Record<string, string>> {
    const out: Record<string, string> = {};
    for (const p of this.placeholders.values()) {
      try {
        const value = await p.resolve(ctx);
        out[p.name] = value === null || value === undefined ? '' : String(value);
      } catch (err) {
        this.logger.warn(`Placeholder ${p.name} failed to resolve: ${(err as Error).message}`);
        out[p.name] = '';
      }
    }
    return out;
  }

  /**
   * Built-in system placeholders. Override this method in a subclass to swap
   * defaults; project-specific additions should use {@link register} from a
   * provider's `onModuleInit` for clearer separation.
   */
  protected registerDefaults(): void {
    this.register({
      description: 'Comma-separated list of the current user roles (e.g. "admin, editor"). "none" when empty.',
      example: 'admin, editor',
      name: 'roles',
      resolve: (ctx) => (ctx.user?.roles?.length ? ctx.user.roles.join(', ') : 'none'),
    });
    this.register({
      description: 'Comma-separated list of the tools the current user may use this turn.',
      example: 'get_user, find_users',
      name: 'tools',
      resolve: (ctx) => (ctx.tools?.length ? ctx.tools.map((t) => t.name).join(', ') : 'none'),
    });
    this.register({
      description: 'Full tool catalog with names, descriptions and parameter schemas (LLM-readable).',
      name: 'toolCatalog',
      resolve: (ctx) => ctx.toolCatalog ?? '',
    });
    this.register({
      description:
        'System documentation injected into the prompt (from the `ai.documentation` config or a project override).',
      name: 'documentation',
      resolve: () => ConfigService.get<string>('ai.documentation') || '',
    });
    this.register({
      description:
        'Admin-approved hints from the governed learning loop, scoped to the tools in use this turn. Empty when nothing applies.',
      name: 'learnedHints',
      resolve: async (ctx) => {
        if (!this.hintService) return '';
        const learned = await this.hintService.approvedHints((ctx.tools || []).map((t) => t.name));
        return learned.length ? learned.map((h) => `- ${h}`).join('\n') : '';
      },
    });
    this.register({
      description: 'Current user id (empty when no user is in context).',
      example: '6a16c51530d808eb40a93d66',
      name: 'userId',
      resolve: (ctx) => ctx.user?.id || '',
    });
  }
}
