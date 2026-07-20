import { RoleEnum } from '../../common/enums/role.enum';
import { getVersion } from '../../common/helpers/meta.helper';

import {
  HUB_DEFAULT_LOG_CAPACITY,
  HUB_DEFAULT_LOG_MAX_MESSAGE_LENGTH,
  HUB_DEFAULT_MAILBOX_CAPACITY,
  HUB_DEFAULT_MAILBOX_MAX_MAIL_SIZE,
  HUB_DEFAULT_MIGRATIONS_COLLECTION,
  HUB_DEFAULT_MIGRATIONS_DIR,
  HUB_DEFAULT_PATH,
  HUB_DEFAULT_POLL_INTERVAL_MS,
  HUB_DEFAULT_QUERY_CAPACITY,
  HUB_DEFAULT_QUERY_CRITICAL_MS,
  HUB_DEFAULT_QUERY_MAX_SHAPE_LENGTH,
  HUB_DEFAULT_QUERY_WARN_MS,
  HUB_DEFAULT_TRACE_CAPACITY,
  HUB_DEFAULT_TRACE_SLOW_MS,
  HUB_MIN_POLL_INTERVAL_MS,
} from './hub.constants';
import {
  IHubConfig,
  IHubLogsConfig,
  IHubMailboxConfig,
  IHubQueriesConfig,
  IHubTracesConfig,
  ResolvedHubConfig,
} from './interfaces/hub-config.interface';

/** Context needed to resolve environment-dependent defaults (env badge, links, mailbox guard). */
export interface HubConfigContext {
  env: string;
  graphQlEnabled?: boolean;
  permissionsPath?: string;
  version: string;
}

/**
 * Environments treated as NON-reachable (local dev / test / CI). These are the ONLY envs where a
 * public Hub (`roles: false`) or mailbox `capture` mode are allowed without an explicit acknowledgment.
 * Everything else is treated as reachable — fail-safe by design, so a custom prod-like env name
 * (`prod`, `live`, `preprod`, `production-eu`, `staging-2`, …) cannot bypass the startup guards.
 */
const NON_REACHABLE_ENVS = new Set(['ci', 'development', 'e2e', 'local', 'test']);

/** True when `env` is a reachable/deployed environment (anything not in the known non-reachable set). */
export function isReachableEnv(env: string | undefined): boolean {
  return !NON_REACHABLE_ENVS.has((env ?? '').toLowerCase());
}

/** True when the Hub should be registered (presence implies enabled, unless `{ enabled: false }`). */
export function isHubEnabled(config: boolean | IHubConfig | undefined): boolean {
  if (config === true) {
    return true;
  }
  if (config === false || config === undefined || config === null) {
    return false;
  }
  return config.enabled !== false;
}

/** True when the query profiler is active — gates the `monitorCommands` opt-in in core.module.ts. */
export function isHubQueriesEnabled(config: boolean | IHubConfig | undefined): boolean {
  if (!isHubEnabled(config) || typeof config !== 'object') {
    return false;
  }
  return isCollectorEnabled(config.collectors?.queries);
}

/**
 * Resolve `boolean | IHubConfig` into a fully-defaulted {@link ResolvedHubConfig}.
 * The result is bound to the `HUB_CONFIG` token and injected throughout the module.
 */
export function normalizeHubConfig(config: boolean | IHubConfig, ctx: HubConfigContext): ResolvedHubConfig {
  const cfg: IHubConfig = typeof config === 'object' && config !== null ? config : {};

  return {
    actions: cfg.actions !== false,
    allowPublicAccessInProduction: cfg.allowPublicAccessInProduction === true,
    collectors: {
      logs: resolveLogsCollector(cfg.collectors?.logs, true),
      queries: resolveQueriesCollector(cfg.collectors?.queries, false),
      traces: resolveTracesCollector(cfg.collectors?.traces, true),
    },
    db:
      cfg.db === false
        ? false
        : { includeIndexes: typeof cfg.db === 'object' ? cfg.db.includeIndexes === true : false },
    emailPreview: cfg.emailPreview !== false,
    env: ctx.env,
    links: resolveLinks(cfg.links, ctx),
    loginEndpoint: cfg.loginEndpoint ?? '/iam/sign-in/email',
    logoutEndpoint: cfg.logoutEndpoint ?? '/iam/sign-out',
    mailbox: resolveMailbox(cfg.mailbox),
    migrations: resolveMigrations(cfg.migrations),
    path: sanitizePath(cfg.path) || HUB_DEFAULT_PATH,
    pollIntervalMs: Math.max(HUB_MIN_POLL_INTERVAL_MS, cfg.pollIntervalMs ?? HUB_DEFAULT_POLL_INTERVAL_MS),
    roles: resolveRoles(cfg.roles),
    // Prefer an explicit version; otherwise read it from package.json (same source as getBuildInfo).
    version: ctx.version && ctx.version !== 'unknown' ? ctx.version : getVersion(),
  };
}

function isCollectorEnabled(value: boolean | { enabled?: boolean } | undefined, defaultOn = false): boolean {
  if (value === undefined) {
    return defaultOn;
  }
  if (typeof value === 'boolean') {
    return value;
  }
  return value.enabled !== false;
}

function resolveLinks(links: IHubConfig['links'], ctx: HubConfigContext): ResolvedHubConfig['links'] {
  const out: ResolvedHubConfig['links'] = {};

  const swagger = links?.swagger;
  if (swagger !== false) {
    out.swagger = typeof swagger === 'string' ? swagger : '/swagger';
  }

  const graphql = links?.graphql;
  if (graphql === false) {
    // explicitly hidden
  } else if (typeof graphql === 'string') {
    out.graphql = graphql;
  } else if (ctx.graphQlEnabled !== false) {
    out.graphql = '/graphql';
  }

  const permissions = links?.permissions;
  if (permissions === false) {
    // explicitly hidden
  } else if (typeof permissions === 'string') {
    out.permissions = permissions;
  } else if (ctx.permissionsPath) {
    out.permissions = '/' + ctx.permissionsPath.replace(/^\/+/, '');
  }

  if (links?.mailpit) {
    out.mailpit = links.mailpit;
  }

  return out;
}

function resolveLogsCollector(
  value: boolean | IHubLogsConfig | undefined,
  defaultOn: boolean,
): ResolvedHubConfig['collectors']['logs'] {
  if (!isCollectorEnabled(value, defaultOn)) {
    return false;
  }
  const obj: IHubLogsConfig = typeof value === 'object' ? value : {};
  return {
    capacity: obj.capacity ?? HUB_DEFAULT_LOG_CAPACITY,
    excludeContexts: obj.excludeContexts ?? [],
    levels: obj.levels ?? ['log', 'warn', 'error', 'fatal'],
    maxMessageLength: obj.maxMessageLength ?? HUB_DEFAULT_LOG_MAX_MESSAGE_LENGTH,
  };
}

function resolveMailbox(value: boolean | IHubMailboxConfig | undefined): ResolvedHubConfig['mailbox'] {
  if (!isCollectorEnabled(value, false)) {
    return false;
  }
  const obj: IHubMailboxConfig = typeof value === 'object' ? value : {};
  return {
    capacity: obj.capacity ?? HUB_DEFAULT_MAILBOX_CAPACITY,
    maxMailSize: obj.maxMailSize ?? HUB_DEFAULT_MAILBOX_MAX_MAIL_SIZE,
    mode: obj.mode === 'copy' ? 'copy' : 'capture',
  };
}

function resolveMigrations(value: false | IHubConfig['migrations']): ResolvedHubConfig['migrations'] {
  if (value === false) {
    return false;
  }
  const obj = typeof value === 'object' && value ? value : {};
  return {
    collectionName: obj.collectionName ?? HUB_DEFAULT_MIGRATIONS_COLLECTION,
    dir: obj.dir ?? HUB_DEFAULT_MIGRATIONS_DIR,
    lockCollectionName: obj.lockCollectionName,
  };
}

function resolveQueriesCollector(
  value: boolean | IHubQueriesConfig | undefined,
  defaultOn: boolean,
): ResolvedHubConfig['collectors']['queries'] {
  if (!isCollectorEnabled(value, defaultOn)) {
    return false;
  }
  const obj: IHubQueriesConfig = typeof value === 'object' ? value : {};
  return {
    capacity: obj.capacity ?? HUB_DEFAULT_QUERY_CAPACITY,
    criticalMs: obj.criticalMs ?? HUB_DEFAULT_QUERY_CRITICAL_MS,
    ignoreCommands: obj.ignoreCommands,
    maxShapeLength: obj.maxShapeLength ?? HUB_DEFAULT_QUERY_MAX_SHAPE_LENGTH,
    warnMs: obj.warnMs ?? HUB_DEFAULT_QUERY_WARN_MS,
  };
}

function resolveRoles(roles: IHubConfig['roles']): false | string[] {
  if (roles === false) {
    return false;
  }
  if (roles === undefined) {
    return [RoleEnum.ADMIN];
  }
  return Array.isArray(roles) ? roles : [roles];
}

function resolveTracesCollector(
  value: boolean | IHubTracesConfig | undefined,
  defaultOn: boolean,
): ResolvedHubConfig['collectors']['traces'] {
  if (!isCollectorEnabled(value, defaultOn)) {
    return false;
  }
  const obj: IHubTracesConfig = typeof value === 'object' ? value : {};
  return {
    capacity: obj.capacity ?? HUB_DEFAULT_TRACE_CAPACITY,
    captureGraphQlOperation: obj.captureGraphQlOperation !== false,
    excludePaths: obj.excludePaths ?? ['/hub'],
    slowMs: obj.slowMs ?? HUB_DEFAULT_TRACE_SLOW_MS,
  };
}

/** Strip leading/trailing slashes so the path composes cleanly with `Reflect.defineMetadata`. */
function sanitizePath(path: string | undefined): string {
  return (path ?? '').replace(/^\/+|\/+$/g, '');
}
