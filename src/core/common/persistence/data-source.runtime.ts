import { Logger } from '@nestjs/common';

import { ConfigService } from '../services/config.service.js';
import { RequestContext } from '../services/request-context.service.js';
import type { DataStore } from './data-store.interface.js';
import { expiredRecordsFilter } from './expiry-sweep.js';
import type { LockStore } from './lock-store.interface.js';
import {
  redactUrl,
  type ResolvedDataSource,
  type ResolvedDataSources,
  resolveModelSource,
} from './data-source.config.js';
import type { ModelDescriptor } from './model-descriptor.interface.js';
import { getModelDescriptor } from './model-metadata.registry.js';
import { MongooseDataStore } from './mongoose-data-store.js';
import {
  getPersistedModels,
  type IamSqlStorage,
  type PersistenceOverview,
  type PersistenceRuntime,
} from './persistence-runtime.registry.js';
import { grantStatement } from './sql/postgres/postgres-schema.compiler.js';
import { assertSafeApplicationRole, SCHEMA_LOCK_SQL } from './sql/postgres/postgres-schema.migrator.js';
import { type SqlDialect, sqlDialect } from './sql/sql-dialect.js';
import { createSqlExecutor } from './sql/sql-executor.factory.js';
import type { SqlExecutor } from './sql/sql-executor.interface.js';
import { LOCK_MODEL, type SchemaChange, tableName } from './sql/sql-schema.shared.js';

/**
 * Routes every model registered with `CorePersistenceModule.forFeature()` to its data source (plan §3.9: the
 * configuration, then `@PersistedModel`, then the default). A SQL source is connected once, as the application role;
 * each model's table is brought up to date when its store is created — as the owner, or only verified without
 * `ownerUrl` — and the application role is checked against it: a role row-level security cannot bind stops the boot.
 * Per model, not per registry: the registry is process-wide, the stores Nest creates belong to THIS application.
 * What differs between PostgreSQL and MySQL / MariaDB is the source's `SqlDialect`.
 * Installed by `CoreModule.forRoot()` only when a SQL source is configured.
 */
export class DataSourceRuntime implements PersistenceRuntime {
  protected readonly logger = new Logger('DataSources');
  private bootReleased = false;
  private readonly dialects = new Map<string, SqlDialect>();
  private readonly executors = new Map<string, Promise<SqlExecutor>>();
  /** Sources whose application-only tenant isolation was reported */
  private readonly isolationReported = new Set<string>();
  private lockStore?: Promise<LockStore | undefined>;
  private readonly owners = new Map<string, Promise<SqlExecutor>>();
  private readonly stores = new Map<string, Promise<DataStore<any>>>();

  constructor(protected readonly resolved: ResolvedDataSources) {}

  async close(): Promise<void> {
    const executors = [...this.executors.values()];
    this.executors.clear();
    this.lockStore = undefined;
    this.stores.clear();
    await Promise.all([this.releaseBootConnections(), ...executors.map(closeExecutor)]);
  }

  /**
   * The framework's own leases (system-setup claim, cron, migrations) live in the default source. Opened once — as the
   * owner it brings the lease table up to date, which a model of the default source would otherwise have done
   */
  defaultLockStore(): Promise<LockStore | undefined> {
    this.lockStore ??= this.openLockStore();
    return this.lockStore;
  }

  async releaseBootConnections(): Promise<void> {
    this.bootReleased = true;
    const owners = [...this.owners.values()];
    this.owners.clear();
    await Promise.all(owners.map(closeExecutor));
  }

  async resolveStore(name: string, mongoModel: unknown): Promise<DataStore<any>> {
    const source = this.sourceOf(name);
    if (!source || source.driver === 'mongodb') {
      return new MongooseDataStore(mongoModel as any);
    }
    let store = this.stores.get(name);
    if (!store) {
      store = this.openStore(source, name);
      this.stores.set(name, store);
    }
    return store;
  }

  defaultSqlSource(): undefined | { engine?: string; ownerUrl?: string; url: string } {
    const name = this.resolved.defaultSource;
    const source = name ? this.resolved.sources[name] : undefined;
    return source && source.driver !== 'mongodb'
      ? { engine: source.sqlEngine, ownerUrl: source.ownerUrl, url: source.url }
      : undefined;
  }

  describe(): PersistenceOverview {
    return {
      defaultSource: this.resolved.defaultSource,
      models: getPersistedModels().map((model) => ({
        name: model.name,
        source: resolveModelSource(this.resolved, model.name, model.declaredSource),
      })),
      sources: Object.values(this.resolved.sources).map((source) => ({
        driver: source.driver,
        engine: source.sqlEngine,
        host: redactUrl(source.url),
        name: source.name,
        ownerConfigured: !!source.ownerUrl,
      })),
    };
  }

  async iamStorage(): Promise<IamSqlStorage | undefined> {
    const registration = getPersistedModels().find((model) => {
      const descriptor = getModelDescriptor(model.name);
      return !!descriptor && tableName(descriptor) === USERS_TABLE;
    });
    const source = registration ? this.sourceOf(registration.name) : undefined;
    if (!registration || !source || source.driver === 'mongodb') {
      return undefined;
    }
    if (source.driver !== 'postgres') {
      throw new Error(
        `Better-Auth cannot run on ${this.dialect(source).label} yet: the user model (table ${USERS_TABLE}) is routed to ` +
          `the source "${source.name}". Keep the user model on PostgreSQL or MongoDB (database.models), or switch Better-Auth off.`,
      );
    }
    // Opening the store brings `users` up to date first: Better-Auth only adds its columns to the table the user model
    // defines, never the other way round
    const users = await this.resolveStore(registration.name, undefined);
    const app = await this.executor(source);
    return {
      applySchema: (migrate, tables) => this.applyForeignSchema(source, app, migrate, tables),
      pool: app.driverPool,
      source: source.name,
      users,
    };
  }

  async sweepExpired(now = new Date()): Promise<{ deleted: number; model: string }[]> {
    const swept: { deleted: number; model: string }[] = [];
    const failed: string[] = [];
    for (const [name, pending] of this.stores) {
      const descriptor = getModelDescriptor(name);
      const expired = descriptor ? expiredRecordsFilter(descriptor, now) : undefined;
      if (!expired) {
        continue;
      }
      try {
        const store = await pending;
        // System work across every tenant, as the TTL monitor is: row-level security admits the system scope
        const deleted = await RequestContext.runWithBypassTenantGuard(() => store.deleteMany(expired as any));
        swept.push({ deleted, model: name });
      } catch (error) {
        // One table that cannot be swept must not keep the others full
        failed.push(`${name}: ${(error as Error)?.message ?? error}`);
      }
    }
    if (failed.length) {
      throw new Error(failed.join('; '));
    }
    return swept;
  }

  sqlSources(): { name: string; ping: () => Promise<void> }[] {
    return Object.values(this.resolved.sources)
      .filter((source) => source.driver !== 'mongodb')
      .map((source) => ({
        name: source.name,
        ping: async () => {
          await (await this.executor(source)).run({ params: [], text: 'SELECT 1' }, { kind: 'system' });
        },
      }));
  }

  /**
   * Whether a model's rows are tenant-isolated: tenant-scoped, multi-tenancy on, not excluded. On PostgreSQL the table
   * carries row-level security; MySQL / MariaDB have none, and the store alone isolates
   */
  isTenantIsolated(model: ModelDescriptor): boolean {
    const multiTenancy = ConfigService.configFastButReadOnly?.multiTenancy;
    return (
      !!multiTenancy &&
      multiTenancy.enabled !== false &&
      model.tenantScoped &&
      !multiTenancy.excludeSchemas?.includes(model.name)
    );
  }

  protected sourceOf(name: string): ResolvedDataSource | undefined {
    const registration = getPersistedModels().find((model) => model.name === name);
    const source = resolveModelSource(this.resolved, name, registration?.declaredSource);
    return source ? this.resolved.sources[source] : undefined;
  }

  private async openStore(source: ResolvedDataSource, name: string): Promise<DataStore<any>> {
    const model = getModelDescriptor(name);
    if (!model) {
      throw new Error(`No descriptor for model "${name}" — register it with CorePersistenceModule.forFeature()`);
    }
    const app = await this.executor(source);
    const dialect = this.dialect(source);
    let changes: SchemaChange[];
    if (source.ownerUrl) {
      changes = await dialect.applySchema(await this.owner(source), app, [model]);
    } else {
      changes = await dialect.verifySchema(app, [model]);
    }
    for (const change of changes) {
      if (change.kind === 'automatic') {
        this.logger.log(`[${source.name}] ${change.description}`);
      } else if (change.kind === 'notice') {
        this.logger.warn(`[${source.name}] ${change.description}`);
      }
    }
    await dialect.assertSafeApplication(app, [tableName(model), tableName(LOCK_MODEL)]);
    const isolated = this.isTenantIsolated(model);
    if (isolated && source.driver !== 'postgres' && !this.isolationReported.has(source.name)) {
      this.isolationReported.add(source.name);
      this.logger.warn(
        `[${source.name}] ${dialect.label} has no row-level security: tenant isolation of ${source.name} is enforced by ` +
          'the application only. A query on a tenant table through store.native(), store.raw() or a connection of your ' +
          'own must filter by tenantId itself — nothing in the database stops it.',
      );
    }
    this.logger.log(
      `${name} → ${source.name} → ${source.driver} ${redactUrl(source.url)} → ${source.sqlEngine}${dialect.isolation(isolated)}`,
    );
    const registration = getPersistedModels().find((entry) => entry.name === name);
    return dialect.createStore(app, model, { schema: registration?.schema as any });
  }

  private async openLockStore(): Promise<LockStore | undefined> {
    const name = this.resolved.defaultSource;
    const source = name ? this.resolved.sources[name] : undefined;
    if (!source || source.driver === 'mongodb') {
      return undefined;
    }
    const app = await this.executor(source);
    const dialect = this.dialect(source);
    if (!source.ownerUrl) {
      await dialect.verifySchema(app, []);
    } else if (this.bootReleased) {
      // First asked after the boot released its owner connections: a connection of its own, closed at once
      const owner = await createSqlExecutor({
        applicationName: 'nest-server-schema',
        engine: source.sqlEngine,
        maxConnections: 1,
        url: source.ownerUrl,
      });
      try {
        await dialect.applySchema(owner, app, []);
      } finally {
        await owner.close();
      }
    } else {
      await dialect.applySchema(await this.owner(source), app, []);
    }
    await dialect.assertSafeApplication(app, [tableName(LOCK_MODEL)]);
    return dialect.createLockStore(app);
  }

  /**
   * Tables another library creates in a SQL source (Better-Auth's): its migration runs as the owner under the schema lock
   * the framework's own evolution takes, so replicas booting together apply it once; the application role is granted
   * and checked as on the framework's tables. Two owner connections: one holds the lock, the library migrates on the
   * other — it brings its own client and cannot run inside the locking transaction.
   */
  private async applyForeignSchema(
    source: ResolvedDataSource,
    app: SqlExecutor,
    migrate: (pool: unknown, asOwner: boolean) => Promise<void>,
    tables: string[],
  ): Promise<void> {
    if (!source.ownerUrl) {
      await migrate(app.driverPool, false);
    } else {
      const connect = (maxConnections: number) =>
        createSqlExecutor({
          applicationName: 'nest-server-schema',
          engine: source.sqlEngine,
          maxConnections,
          url: source.ownerUrl,
        });
      const [lock, migrator] = await Promise.all([connect(1), connect(2)]);
      const appRole = decodeURIComponent(new URL(source.url).username);
      try {
        await lock.transaction(async (tx) => {
          await tx.run({ params: [], text: SCHEMA_LOCK_SQL }, SYSTEM);
          await migrate(migrator.driverPool, true);
          for (const table of tables) {
            await tx.run({ params: [], text: grantStatement(table, appRole) }, SYSTEM);
          }
        });
      } finally {
        await Promise.all([lock.close(), migrator.close()]);
      }
    }
    await assertSafeApplicationRole(app, tables);
  }

  private dialect(source: ResolvedDataSource): SqlDialect {
    let dialect = this.dialects.get(source.name);
    if (!dialect) {
      dialect = sqlDialect({
        appRole: decodeURIComponent(new URL(source.url).username),
        driver: source.driver as 'mariadb' | 'mysql' | 'postgres',
        isTenantIsolated: (candidate) => this.isTenantIsolated(candidate),
      });
      this.dialects.set(source.name, dialect);
    }
    return dialect;
  }

  /**
   * One owner connection per source for the whole boot, released once every store exists: one per model opened and
   * closed a privileged connection for every table, and the stores are created concurrently
   */
  private owner(source: ResolvedDataSource): Promise<SqlExecutor> {
    let pending = this.owners.get(source.name);
    if (!pending) {
      pending = createSqlExecutor({
        applicationName: 'nest-server-schema',
        engine: source.sqlEngine,
        maxConnections: 1,
        url: source.ownerUrl,
      });
      this.owners.set(source.name, pending);
    }
    return pending;
  }

  private executor(source: ResolvedDataSource): Promise<SqlExecutor> {
    let pending = this.executors.get(source.name);
    if (!pending) {
      pending = createSqlExecutor({ applicationName: 'nest-server', engine: source.sqlEngine, url: source.url });
      this.executors.set(source.name, pending);
    }
    return pending;
  }
}

/** The table the user model and Better-Auth share */
const USERS_TABLE = 'users';

const SYSTEM = { kind: 'system' } as const;

async function closeExecutor(pending: Promise<SqlExecutor>): Promise<void> {
  await (await pending.catch(() => undefined))?.close();
}
