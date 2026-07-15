/**
 * The record passed to `CoreAiService.audit()` for each prompt run.
 *
 * It lives here, in an import-free leaf, rather than in `core-ai.service.ts` — and that is
 * load-bearing, not tidiness.
 *
 * `core-ai.service` imports `core-ai-interaction.service` (it needs the class), and
 * `core-ai-interaction.service` needs this type back. Declared in the service, that pair forms an
 * import cycle. It never crashed for exactly one reason: the type was pulled in with `import type`,
 * which both tsc and SWC erase, so no `require()` was emitted and the cycle was never real at
 * runtime.
 *
 * That is a single keyword of protection, on a file where `core-ai.service` has a constructor
 * `@Inject`, so `emitDecoratorMetadata` emits `design:paramtypes` at module-evaluation time — the
 * exact eval-time dereference that turns a cycle fatal. An IDE "organize imports" or a lint autofix
 * widening `import type` to a plain `import` would have armed it silently, and `tsc`, `pnpm test`
 * and `oxlint` are ALL blind to that (vitest runs SWC through Vite's cycle-tolerant module runner).
 * Only `pnpm run check:swc-tdz` would have caught it — after the fact.
 *
 * Moving the type out removes the edge entirely, so the cycle no longer exists rather than merely
 * being disarmed. `core-ai.service` re-exports it, so every existing import path still resolves.
 *
 * See .claude/rules/architecture.md → "DI Token Placement (SWC-Safe)".
 */
export interface AiInteractionRecord {
  actions: { name: string; success: boolean }[];
  connectionId: string;
  iterations: number;
  prompt: string;
  responseText: string;
  tenantId?: string;
  usage?: { completionTokens?: number; promptTokens?: number; totalTokens?: number };
  userId?: string;
}
