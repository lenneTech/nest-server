import { IAiTool } from './ai-tool.interface';

/**
 * Runtime context passed to every placeholder resolver. Mirrors the data a
 * prompt build has on hand (current user, in-scope tools, etc.) — keep it
 * narrow on purpose so resolvers stay testable and don't reach into the
 * orchestrator's internals.
 */
export interface AiPlaceholderContext {
  /** Pre-computed catalog string (formatted tool list with parameter schema). */
  toolCatalog?: string;
  /** Tools the current user is allowed to use this turn. */
  tools?: IAiTool[];
  /** Current user (may be undefined for system contexts). */
  user?: { id?: string; roles?: string[]; [key: string]: any };
}

/**
 * A placeholder registered with {@link CoreAiPlaceholderRegistry}.
 *
 * Placeholders are referenced in slot / prompt content via `{{name}}`. At
 * render time the registry calls each placeholder's {@link resolve} with the
 * current context and inlines the returned string. Unknown placeholder names
 * render as the empty string (forward-compatible — old content survives
 * placeholder removal without crashing).
 */
export interface IAiPlaceholder {
  /**
   * Human-readable description for the admin UI (shown next to the name in
   * the placeholder helper sidebar). Keep it short — one sentence.
   */
  description: string;
  /** Optional example value rendered in the UI tooltip. */
  example?: string;
  /** Placeholder name without curly braces (e.g. `'roles'` matches `{{roles}}`). */
  name: string;
  /**
   * Compute the placeholder's string value for the current context. Sync or
   * async; missing context values should yield `''` rather than throw.
   */
  resolve(ctx: AiPlaceholderContext): Promise<string> | string;
}

/** Public metadata shape returned by the placeholders API (no `resolve`). */
export interface AiPlaceholderInfo {
  description: string;
  example?: string;
  name: string;
}
