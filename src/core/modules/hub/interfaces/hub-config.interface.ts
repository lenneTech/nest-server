import type { LogLevel } from '@nestjs/common';

/**
 * Configuration for the Hub admin area (operator cockpit).
 *
 * Follows the "presence implies enabled" pattern (see .claude/rules/configurable-features.md):
 * - `true`: enabled with all defaults (admin-only, served at `/hub`)
 * - `{}`: same as `true`
 * - `{ path: 'admin/hub' }`: enabled with a custom base path
 * - `{ enabled: false, ... }`: pre-configured but disabled
 * - `undefined`: disabled — every Hub route answers 404
 *
 * The Hub is NEVER enabled implicitly. It must be switched on per environment (in `config.env.ts`
 * or via `NSC__HUB__*` env vars). No environment inherits it.
 */
export interface IHubConfig {
  /**
   * Master switch for every mutating endpoint (migrations run/down, cron control, buffer clears,
   * file delete, test mail). When `false`, the actions controller is not registered at all, so
   * those routes answer 404.
   *
   * @default true
   */
  actions?: boolean;

  /**
   * Runtime collectors feeding the Logs, Traces and Queries panels.
   * When the Hub is enabled: `logs` and `traces` default on, `queries` defaults off
   * (query profiling opts the MongoDB driver into command monitoring, so it is opt-in).
   */
  collectors?: IHubCollectorsConfig;

  /**
   * MongoDB stats panel (dbStats, per-collection collStats).
   *
   * @default true
   */
  db?: boolean | IHubDbConfig;

  /**
   * Whether the Hub is enabled. Presence of the config object already implies `true`; set to
   * `false` to keep a pre-configured block dormant.
   */
  enabled?: boolean;

  /**
   * Email preview panel (renders EJS templates with sample data).
   *
   * @default true
   */
  emailPreview?: boolean;

  /** External links surfaced on the dashboard and in the navigation. Set a value to `false` to hide it. */
  links?: IHubLinksConfig;

  /**
   * Endpoint the built-in login form POSTs `{ email, password }` to. It must set a session cookie on
   * success (BetterAuth IAM does). Lets an admin log into the Hub directly, without the frontend.
   *
   * @default '/iam/sign-in/email'
   */
  loginEndpoint?: string;

  /**
   * Endpoint the built-in "Sign out" button POSTs to. It must clear the session cookie (BetterAuth
   * IAM's `/iam/sign-out` does). Only used after authentication, so it is delivered in the ADMIN-gated
   * session payload, never in the public shell.
   *
   * @default '/iam/sign-out'
   */
  logoutEndpoint?: string;

  /**
   * Built-in mailbox (a Mailpit-style capture of outgoing mail for local/test use).
   *
   * @default disabled
   */
  mailbox?: boolean | IHubMailboxConfig;

  /**
   * Migrations panel + actions.
   *
   * @default enabled with dir `./migrations`, collection `migrations`
   */
  migrations?: false | IHubMigrationsConfig;

  /**
   * Base path for all Hub routes.
   *
   * @default 'hub'
   */
  path?: string;

  /**
   * Default client poll interval (ms) for JSON sidecars. Clamped to a minimum of 1000 ms.
   *
   * @default 5000
   */
  pollIntervalMs?: number;

  /**
   * Role(s) required to access the Hub.
   * - `undefined`: defaults to `RoleEnum.ADMIN`
   * - `string | string[]`: required role(s), OR semantics
   * - `false`: NO auth check at all — every route becomes public. Only ever use behind a network
   *   boundary you fully control; a public Hub exposes config, logs and destructive actions.
   *   **Forbidden in `production`/`staging` unless {@link allowPublicAccessInProduction} is set** —
   *   see that flag.
   *
   * @default RoleEnum.ADMIN
   */
  roles?: false | string | string[];

  /**
   * Acknowledge, explicitly, that a PUBLIC Hub (`roles: false`, no auth check) may run in a reachable
   * environment. Without this, `roles: false` throws at startup in `production`/`staging`, because it
   * exposes the config viewer, logs and DESTRUCTIVE admin actions (migrations, file delete, cron) to
   * unauthenticated requests. Set to `true` ONLY when the Hub sits behind a fully-controlled network
   * boundary (VPN / IP allow-list / authenticating reverse proxy). Has no effect unless `roles: false`.
   *
   * @default false
   */
  allowPublicAccessInProduction?: boolean;
}

/** Collector toggles (each: boolean shorthand or an options object). */
export interface IHubCollectorsConfig {
  /** Log ring buffer. @default on (capacity 500). */
  logs?: boolean | IHubLogsConfig;
  /** MongoDB query profiler (driver command monitoring). @default off. */
  queries?: boolean | IHubQueriesConfig;
  /** HTTP request traces. @default on (capacity 200). */
  traces?: boolean | IHubTracesConfig;
}

export interface IHubCollectorBaseConfig {
  /** Ring-buffer capacity (entries). */
  capacity?: number;
  /** @default true when the parent object is present. */
  enabled?: boolean;
}

export interface IHubDbConfig {
  enabled?: boolean;
  /** Include index size/definitions per collection (extra collStats work). @default false. */
  includeIndexes?: boolean;
}

export interface IHubLinksConfig {
  /** GraphQL sandbox link. @default '/graphql' when GraphQL is enabled. */
  graphql?: false | string;
  /** Externally hosted Mailpit URL. @default undefined. */
  mailpit?: string;
  /** Permissions cockpit link. @default derived from the permissions module path when enabled. */
  permissions?: false | string;
  /** Swagger UI link. @default '/swagger'. */
  swagger?: false | string;
}

export interface IHubLogsConfig extends IHubCollectorBaseConfig {
  /** Context names never captured (e.g. noisy framework contexts). @default []. */
  excludeContexts?: string[];
  /** Levels captured into the buffer (independent of console output level). @default ['log','warn','error','fatal']. */
  levels?: LogLevel[];
  /** Per-record message cap (characters). @default 2048. */
  maxMessageLength?: number;
}

export interface IHubMailboxConfig {
  /** Number of captured mails retained. @default 100. */
  capacity?: number;
  enabled?: boolean;
  /** Per-field body cap (bytes); the html and text bodies are EACH truncated to this. @default 262144. */
  maxMailSize?: number;
  /**
   * - `capture`: intercept mail and DO NOT send it — for local/test use (a Mailpit replacement).
   *   Throws at startup in `production`/`staging` to prevent silently swallowing real mail.
   * - `copy`: send mail normally AND record a copy in the mailbox.
   *
   * @default 'capture'
   */
  mode?: 'capture' | 'copy';
}

export interface IHubMigrationsConfig {
  /** MongoDB collection holding migration state. @default 'migrations'. */
  collectionName?: string;
  /** Filesystem directory of migration files. @default './migrations'. */
  dir?: string;
  enabled?: boolean;
  /** Collection used for cluster-safe locking during migration actions. @default undefined. */
  lockCollectionName?: string;
}

export interface IHubQueriesConfig extends IHubCollectorBaseConfig {
  /** Duration (ms) above which a query is classified "critical". @default 200. */
  criticalMs?: number;
  /** Command names never recorded (replaces the default admin/heartbeat ignore set when provided). */
  ignoreCommands?: string[];
  /** Command-summary length cap (characters). @default 512. */
  maxShapeLength?: number;
  /** Duration (ms) above which a query is classified "warn". @default 50. */
  warnMs?: number;
}

export interface IHubTracesConfig extends IHubCollectorBaseConfig {
  /** Capture the GraphQL operationName for POST /graphql. @default true. */
  captureGraphQlOperation?: boolean;
  /** Path prefixes never traced. The Hub base path is always added on top. @default ['/hub']. */
  excludePaths?: string[];
  /** Duration (ms) above which a trace is flagged slow. @default 1000. */
  slowMs?: number;
}

/**
 * Fully-resolved Hub configuration (all defaults applied, booleans normalized to objects).
 * This is the shape bound to the `HUB_CONFIG` token and injected everywhere in the module.
 */
export interface ResolvedHubConfig {
  actions: boolean;
  /** Explicit acknowledgment that lets a public (`roles: false`) Hub run in production/staging. */
  allowPublicAccessInProduction: boolean;
  collectors: {
    logs: false | Required<Omit<IHubLogsConfig, 'enabled'>>;
    queries: false | (Required<Omit<IHubQueriesConfig, 'enabled' | 'ignoreCommands'>> & { ignoreCommands?: string[] });
    traces: false | Required<Omit<IHubTracesConfig, 'enabled'>>;
  };
  db: false | { includeIndexes: boolean };
  emailPreview: boolean;
  /** The environment name (from `IServerOptions.env`), used for the production mailbox guard + header badge. */
  env: string;
  links: { graphql?: string; mailpit?: string; permissions?: string; swagger?: string };
  loginEndpoint: string;
  logoutEndpoint: string;
  mailbox: false | { capacity: number; maxMailSize: number; mode: 'capture' | 'copy' };
  migrations: false | { collectionName: string; dir: string; lockCollectionName?: string };
  path: string;
  pollIntervalMs: number;
  roles: false | string[];
  /** The framework/app version (from `IServerOptions.version`), used for the header badge + hub.js cache-busting. */
  version: string;
}

/**
 * The capture hook injected into `EmailService`. Implemented by the mailbox service.
 * Kept minimal so `EmailService` never depends on the Hub module type graph.
 */
export interface IHubEmailCapture {
  /**
   * Record an outgoing mail. Returns `true` when the caller should SKIP the actual transport
   * (mailbox `mode: 'capture'`), `false` when it should send normally (`mode: 'copy'`).
   */
  capture(mail: IHubCapturedMailInput): boolean;
}

export interface IHubCapturedMailInput {
  bcc?: string;
  cc?: string;
  from?: string;
  html?: string;
  subject?: string;
  templateName?: string;
  text?: string;
  to?: string;
}
