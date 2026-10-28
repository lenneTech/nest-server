import type {
  DatabaseSqlEngine,
  IDatabaseConfig,
  IDatabaseSourceConfig,
} from '../interfaces/server-options.interface.js';

/**
 * Resolution of the `database` configuration into named data sources, and of a model to its source.
 *
 * Pure functions: no connection is opened here. `CoreModule.forRoot()` resolves once at boot and refuses,
 * before anything connects, what the running version cannot wire (`assertDataSourcesSupported`).
 */

export type DatabaseDriver = 'mariadb' | 'mongodb' | 'mysql' | 'postgres';

export interface ResolvedDataSource {
  driver: DatabaseDriver;
  name: string;
  /** Present on SQL sources that configure the owner connection */
  ownerUrl?: string;
  /** Present on SQL sources only */
  sqlEngine?: DatabaseSqlEngine;
  url: string;
}

export interface ResolvedDataSources {
  /** Name of the default source; `undefined` when no database is configured */
  defaultSource: string | undefined;
  /** `database: false` — the project runs without any database */
  disabled: boolean;
  /** Configured exceptions: model name → source name */
  modelSources: Record<string, string>;
  sources: Record<string, ResolvedDataSource>;
}

export interface ResolveDataSourcesInput {
  database?: false | IDatabaseConfig | string;
  /** Whether the PROJECT configured `mongoose` — the framework's own fallback URI does not count */
  explicitMongoose?: boolean;
  /** The effective mongoose URI (project value or framework fallback) */
  mongooseUri?: string;
}

/** A configuration this version cannot resolve or cannot wire. Thrown at boot, never at request time. */
export class DataSourceConfigError extends Error {
  constructor(message: string) {
    super(`[database] ${message}`);
    this.name = 'DataSourceConfigError';
  }
}

export const DEFAULT_SOURCE = 'default';
/** Source name an explicitly configured `mongoose` gets when `database` sets the default */
export const MONGOOSE_SOURCE = 'mongoose';
export const DEFAULT_SQL_ENGINE: DatabaseSqlEngine = 'typeorm';

const SQL_ENGINES: readonly DatabaseSqlEngine[] = ['drizzle', 'kysely', 'typeorm'];
const SOURCE_NAME = /^[A-Za-z][\w-]*$/;
const DRIVERS: Record<string, DatabaseDriver> = {
  'mariadb:': 'mariadb',
  'mongodb+srv:': 'mongodb',
  'mongodb:': 'mongodb',
  'mysql:': 'mysql',
  'postgres:': 'postgres',
  'postgresql:': 'postgres',
};

/**
 * The database a URL points at, taken from its scheme.
 */
export function driverFromUrl(url: string): DatabaseDriver {
  const scheme = /^[a-z][a-z0-9+.-]*:/i.exec(url)?.[0]?.toLowerCase();
  const driver = scheme ? DRIVERS[scheme] : undefined;
  if (!driver) {
    throw new DataSourceConfigError(
      `Unsupported connection URL ${redactUrl(url)} — use mongodb://, mongodb+srv://, postgres://, postgresql://, mysql:// or mariadb://`,
    );
  }
  return driver;
}

/**
 * A connection URL reduced to scheme and host, so an error message or a log line never carries
 * credentials, a path or query options (which may hold a password too).
 */
export function redactUrl(url: unknown): string {
  if (typeof url !== 'string') {
    return `<${typeof url}>`;
  }
  const scheme = /^([a-z][a-z0-9+.-]*:)\/\//i.exec(url);
  if (!scheme) {
    return '<unparsable URL>';
  }
  // The authority ends at the first `/`, `?` or `#`, and the credentials at the LAST `@` inside it — the WHATWG
  // rule node-postgres parses by, so a password with an unencoded `@` (which it accepts) never reaches the result
  const authority = url.slice(scheme[0].length).split(/[/?#]/, 1)[0];
  return `${scheme[1]}//${authority.slice(authority.lastIndexOf('@') + 1)}`;
}

/**
 * Resolve the `database` configuration (plus the mongoose configuration it extends) into named sources.
 */
export function resolveDataSources(input: ResolveDataSourcesInput): ResolvedDataSources {
  const { database, explicitMongoose, mongooseUri } = input;

  if (database === false) {
    return { defaultSource: undefined, disabled: true, modelSources: {}, sources: {} };
  }

  const config: IDatabaseConfig = typeof database === 'string' ? { url: database } : (database ?? {});
  if (typeof config !== 'object' || Array.isArray(config)) {
    throw new DataSourceConfigError('`database` must be a URL, an object or false');
  }
  if (config.ownerUrl !== undefined && config.url === undefined) {
    // The usual cause: `database` was a URL string and an NSC__DATABASE__* variable (e.g. NSC__DATABASE__OWNER_URL)
    // was merged over it — the environment merge REPLACES a string with an object, so the URL is gone and every
    // model would fall back to MongoDB without a word
    throw new DataSourceConfigError(
      'database.ownerUrl is set but database.url is not. A NSC__DATABASE__* variable replaces a `database` given as a ' +
        'URL string; write `database: { url: … }` in the configuration (or set NSC__DATABASE__URL as well)',
    );
  }
  const topEngine = config.sqlEngine === undefined ? undefined : checkEngine(config.sqlEngine, 'database.sqlEngine');

  const sources: Record<string, ResolvedDataSource> = {};
  if (config.url !== undefined) {
    sources[DEFAULT_SOURCE] = buildSource(
      DEFAULT_SOURCE,
      { ownerUrl: config.ownerUrl, url: config.url },
      topEngine,
      'database.url',
    );
    // A project that keeps its MongoDB next to a new default reaches it as a named source
    if (explicitMongoose && mongooseUri) {
      sources[MONGOOSE_SOURCE] = buildSource(MONGOOSE_SOURCE, { url: mongooseUri }, undefined, 'mongoose.uri');
    }
  } else if (mongooseUri) {
    sources[DEFAULT_SOURCE] = buildSource(DEFAULT_SOURCE, { url: mongooseUri }, undefined, 'mongoose.uri');
  }

  for (const [name, value] of Object.entries(config.sources ?? {})) {
    if (name === DEFAULT_SOURCE || name === MONGOOSE_SOURCE) {
      throw new DataSourceConfigError(`database.sources: the source name "${name}" is reserved`);
    }
    if (!SOURCE_NAME.test(name)) {
      throw new DataSourceConfigError(
        `database.sources: invalid source name "${name}" — use letters, digits, "_" and "-", starting with a letter`,
      );
    }
    const source: IDatabaseSourceConfig = typeof value === 'string' ? { url: value } : value;
    sources[name] = buildSource(name, source, topEngine, `database.sources.${name}`);
  }

  const modelSources: Record<string, string> = {};
  for (const [model, source] of Object.entries(config.models ?? {})) {
    if (typeof source !== 'string' || !sources[source]) {
      throw new DataSourceConfigError(
        `database.models.${model} names the source "${String(source)}", which is not configured (known: ${knownSources(sources)})`,
      );
    }
    modelSources[model] = source;
  }

  return {
    defaultSource: sources[DEFAULT_SOURCE] ? DEFAULT_SOURCE : undefined,
    disabled: false,
    modelSources,
    sources,
  };
}

/**
 * The source a model is stored in: the configuration first, then the class's `@PersistedModel`
 * declaration, then the default source. `undefined` when the project runs without a database.
 */
export function resolveModelSource(
  resolved: ResolvedDataSources,
  modelName: string,
  declaredSource?: string,
): string | undefined {
  if (resolved.disabled) {
    return undefined;
  }
  const configured = resolved.modelSources[modelName];
  if (configured) {
    return configured;
  }
  if (declaredSource !== undefined) {
    if (!resolved.sources[declaredSource]) {
      throw new DataSourceConfigError(
        `@PersistedModel on ${modelName} names the source "${declaredSource}", which is not configured (known: ${knownSources(resolved.sources)})`,
      );
    }
    return declaredSource;
  }
  return resolved.defaultSource;
}

/**
 * Refuse what the running version cannot wire, with a message naming the setting.
 *
 * Phase 1 wires PostgreSQL sources (default or additional) next to the MongoDB connection; MySQL / MariaDB (phase
 * 6), running without a database (phase 5) and a second MongoDB connection are refused. Refusing at boot is the
 * point: a configuration that is accepted and then silently served by the wrong database is the outcome to avoid.
 */
export function assertDataSourcesSupported(resolved: ResolvedDataSources): void {
  if (resolved.disabled) {
    throw new DataSourceConfigError(
      '`database: false` (running without a database) is not supported by this version yet',
    );
  }
  for (const source of Object.values(resolved.sources)) {
    if (source.driver === 'mysql' || source.driver === 'mariadb') {
      throw new DataSourceConfigError(
        `The ${source.driver} source "${source.name}" (${redactUrl(source.url)}) is not supported by this version yet — PostgreSQL and MongoDB only`,
      );
    }
    if (source.driver === 'mongodb' && source.name !== DEFAULT_SOURCE && source.name !== MONGOOSE_SOURCE) {
      throw new DataSourceConfigError(
        `The additional MongoDB source "${source.name}" (${redactUrl(source.url)}) is not supported by this version yet — one MongoDB connection only`,
      );
    }
  }
}

/** Whether any configured source is a SQL database */
export function hasSqlSource(resolved: ResolvedDataSources): boolean {
  return Object.values(resolved.sources).some((source) => source.driver !== 'mongodb');
}

function buildSource(
  name: string,
  source: IDatabaseSourceConfig,
  fallbackEngine: DatabaseSqlEngine | undefined,
  path: string,
): ResolvedDataSource {
  if (!source || typeof source !== 'object' || typeof source.url !== 'string' || !source.url) {
    throw new DataSourceConfigError(`${path}: the url must be a non-empty string`);
  }
  const driver = driverFromUrl(source.url);
  if (driver === 'mongodb') {
    if (source.ownerUrl !== undefined) {
      throw new DataSourceConfigError(`${path}: ownerUrl applies to SQL sources only, not to ${redactUrl(source.url)}`);
    }
    if (source.sqlEngine !== undefined) {
      throw new DataSourceConfigError(
        `${path}: sqlEngine applies to SQL sources only, not to ${redactUrl(source.url)}`,
      );
    }
    return { driver, name, url: source.url };
  }
  const engine =
    source.sqlEngine === undefined
      ? (fallbackEngine ?? DEFAULT_SQL_ENGINE)
      : checkEngine(source.sqlEngine, `${path}.sqlEngine`);
  if (source.ownerUrl !== undefined) {
    if (typeof source.ownerUrl !== 'string' || !source.ownerUrl || driverFromUrl(source.ownerUrl) !== driver) {
      throw new DataSourceConfigError(`${path}: ownerUrl must be a ${driver} URL of the same database`);
    }
    return { driver, name, ownerUrl: source.ownerUrl, sqlEngine: engine, url: source.url };
  }
  return { driver, name, sqlEngine: engine, url: source.url };
}

function checkEngine(value: unknown, path: string): DatabaseSqlEngine {
  if (!SQL_ENGINES.includes(value as DatabaseSqlEngine)) {
    throw new DataSourceConfigError(`${path}: "${String(value)}" is not a known sqlEngine (${SQL_ENGINES.join(', ')})`);
  }
  return value as DatabaseSqlEngine;
}

function knownSources(sources: Record<string, ResolvedDataSource>): string {
  const names = Object.keys(sources);
  return names.length ? names.join(', ') : 'none';
}
