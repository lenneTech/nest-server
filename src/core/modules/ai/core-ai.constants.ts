/**
 * Dependency-injection tokens of the AI module.
 *
 * They live in a dedicated, import-free leaf file — never in a service or in `core-ai.module.ts` —
 * so that no file needing a token has to import the file that declares it, and no import cycle can
 * form around one.
 *
 * On a cycle, a token read at MODULE-EVALUATION time — inside an `@Inject()` decorator argument, in
 * the `design:paramtypes` metadata `emitDecoratorMetadata` emits, or in a static field initializer —
 * reads a `const` still in its temporal dead zone, and SWC-compiled builds (`nest start -b swc`) die
 * at startup with:
 *
 *   ReferenceError: Cannot access 'AI_CONNECTION_MODEL' before initialization
 *
 * These tokens were previously declared across eleven `*.service.ts` files, every one of which is
 * imported by `core-ai.module.ts` and injects tokens through constructor decorators. Nothing had
 * crashed — the graph happened to be acyclic — but a single back-import from any of those services
 * would have armed it, and `tsc`, `pnpm test` and `oxlint` are ALL blind to that. Only
 * `pnpm run check:swc-tdz` sees it.
 *
 * A file that imports nothing can never be mid-evaluation when someone imports it, in any module
 * system, under any compiler. Keep this file import-free.
 *
 * The old locations re-export their tokens, so every existing import path still resolves.
 * See .claude/rules/architecture.md → "DI Token Placement (SWC-Safe)".
 */

// ---- budget ----
/** DI token for the model constructor (used by CrudService mapping). */
export const AI_BUDGET_LIMIT_CLASS = 'AI_BUDGET_LIMIT_CLASS';
/** Mongoose injection token. */
export const AI_BUDGET_LIMIT_MODEL = 'AiBudgetLimit';

// ---- connection-preference ----
/** DI token for the model constructor (used by CrudService mapping). */
export const AI_CONNECTION_PREFERENCE_CLASS = 'AI_CONNECTION_PREFERENCE_CLASS';
/** Mongoose injection token. */
export const AI_CONNECTION_PREFERENCE_MODEL = 'AiConnectionPreference';

// ---- connection ----
/** DI token for the model constructor (used by CrudService mapping). */
export const AI_CONNECTION_CLASS = 'AI_CONNECTION_CLASS';
/** Mongoose injection token. */
export const AI_CONNECTION_MODEL = 'AiConnection';

// ---- conversation ----
/** DI token for the model constructor (used by CrudService mapping). */
export const AI_CONVERSATION_CLASS = 'AI_CONVERSATION_CLASS';
/** Mongoose injection token. */
export const AI_CONVERSATION_MODEL = 'AiConversation';

// ---- interaction ----
/** DI token for the model constructor (used by CrudService mapping). */
export const AI_INTERACTION_CLASS = 'AI_INTERACTION_CLASS';
/** Mongoose injection token. */
export const AI_INTERACTION_MODEL = 'AiInteraction';

// ---- mode ----
/** DI token for the model constructor (used by CrudService mapping). */
export const AI_MODE_CLASS = 'AI_MODE_CLASS';
/** Mongoose injection token. */
export const AI_MODE_MODEL = 'AiMode';

// ---- prompt-hint ----
/** DI token for the model constructor (used by CrudService mapping). */
export const AI_PROMPT_HINT_CLASS = 'AI_PROMPT_HINT_CLASS';
/** Mongoose injection token. */
export const AI_PROMPT_HINT_MODEL = 'AiPromptHint';

// ---- prompt ----
/** DI token for the model constructor (used by CrudService mapping). */
export const AI_PROMPT_CLASS = 'AI_PROMPT_CLASS';
/** Mongoose injection token. */
export const AI_PROMPT_MODEL = 'AiPrompt';

// ---- slot ----
/** DI token for the model constructor (used by CrudService mapping). */
export const AI_SLOT_CLASS = 'AI_SLOT_CLASS';
/** Mongoose injection token. */
export const AI_SLOT_MODEL = 'AiSlot';

// ---- tool-grant ----
/** DI token for the model constructor (used by CrudService mapping). */
export const AI_TOOL_GRANT_CLASS = 'AI_TOOL_GRANT_CLASS';
/** Mongoose injection token. */
export const AI_TOOL_GRANT_MODEL = 'AiToolGrant';

// ---- tool-policy ----
/** DI token for the model constructor (used by CrudService mapping). */
export const AI_TOOL_POLICY_CLASS = 'AI_TOOL_POLICY_CLASS';
/** Mongoose injection token. */
export const AI_TOOL_POLICY_MODEL = 'AiToolPolicy';
