/**
 * Dependency-injection tokens and numeric defaults of the Hub module.
 *
 * They live in a dedicated, import-free leaf file — never in `core-hub.module.ts` or a service — so
 * that no file needing a token has to import the module (or vice versa) and close an import cycle.
 *
 * On a cycle, a token read at MODULE-EVALUATION time — inside an `@Inject()` decorator argument, in
 * `design:paramtypes` metadata, or in a static field initializer — reads a `const` still in its
 * temporal dead zone, and SWC-compiled builds (`nest start -b swc`) die at startup with:
 *
 *   ReferenceError: Cannot access 'HUB_CONFIG' before initialization
 *
 * A file that imports nothing can never be mid-evaluation when someone imports it, in any module
 * system, under any compiler. That is the whole point — keep it import-free.
 *
 * `tsc`, `pnpm test` and `oxlint` are all blind to a regression here; only `pnpm run check:swc-tdz`
 * sees it. See .claude/rules/architecture.md → "DI Token Placement (SWC-Safe)".
 */

/**
 * Token for injecting the resolved Hub configuration.
 *
 * Injected type: `ResolvedHubConfig` (see interfaces/hub-config.interface.ts).
 */
export const HUB_CONFIG = 'HUB_CONFIG';

/**
 * Token for the optional outgoing-mail capture hook.
 *
 * `EmailService` injects it with `@Optional() @Inject(HUB_EMAIL_CAPTURE)`. When the Hub mailbox is
 * enabled, `CoreHubModule` binds it to the mailbox service; otherwise it resolves to `undefined` and
 * the mail path stays untouched (zero cost).
 *
 * Injected type: `IHubEmailCapture` (see interfaces/hub-config.interface.ts).
 */
export const HUB_EMAIL_CAPTURE = 'HUB_EMAIL_CAPTURE';

/** Default base path for all Hub routes. */
export const HUB_DEFAULT_PATH = 'hub';

/** Default client poll interval (ms) for JSON sidecars. */
export const HUB_DEFAULT_POLL_INTERVAL_MS = 5000;

/** Lower clamp for the client poll interval (ms) — protects the server from hammering. */
export const HUB_MIN_POLL_INTERVAL_MS = 1000;

/** Default ring-buffer capacity for the log collector. */
export const HUB_DEFAULT_LOG_CAPACITY = 500;

/** Default per-record message cap (characters) for the log collector. */
export const HUB_DEFAULT_LOG_MAX_MESSAGE_LENGTH = 2048;

/** Default ring-buffer capacity for the request-trace collector. */
export const HUB_DEFAULT_TRACE_CAPACITY = 200;

/** Default duration (ms) above which a request trace is flagged slow. */
export const HUB_DEFAULT_TRACE_SLOW_MS = 1000;

/** Default ring-buffer capacity for the query profiler. */
export const HUB_DEFAULT_QUERY_CAPACITY = 500;

/** Default duration (ms) above which a query is classified "warn". */
export const HUB_DEFAULT_QUERY_WARN_MS = 50;

/** Default duration (ms) above which a query is classified "critical". */
export const HUB_DEFAULT_QUERY_CRITICAL_MS = 200;

/** Default command-summary length cap (characters) for the query profiler. */
export const HUB_DEFAULT_QUERY_MAX_SHAPE_LENGTH = 512;

/** Hard cap on the query profiler's in-flight (pending) command map before oldest-first eviction. */
export const HUB_QUERY_PENDING_LIMIT = 1000;

/** Default number of captured mails retained by the mailbox. */
export const HUB_DEFAULT_MAILBOX_CAPACITY = 100;

/** Default per-mail size cap (bytes, html + text) retained by the mailbox. */
export const HUB_DEFAULT_MAILBOX_MAX_MAIL_SIZE = 262144;

/** Default migrations directory (mirrors the migrate CLI default). */
export const HUB_DEFAULT_MIGRATIONS_DIR = './migrations';

/** Default MongoDB collection holding migration state. */
export const HUB_DEFAULT_MIGRATIONS_COLLECTION = 'migrations';
