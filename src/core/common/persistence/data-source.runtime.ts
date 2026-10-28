import { Logger } from '@nestjs/common';

import { ConfigService } from '../services/config.service.js';
import type { DataStore } from './data-store.interface.js';
import {
  redactUrl,
  type ResolvedDataSource,
  type ResolvedDataSources,
  resolveModelSource,
} from './data-source.config.js';
import type { ModelDescriptor } from './model-descriptor.interface.js';
import { getModelDescriptor } from './model-metadata.registry.js';
import { MongooseDataStore } from './mongoose-data-store.js';
import { getPersistedModels, type PersistenceRuntime } from './persistence-runtime.registry.js';
import { LOCK_MODEL, type PostgresSchemaOptions, tableName } from './sql/postgres/postgres-schema.compiler.js';
import {
  applyPostgresSchema,
  assertSafeApplicationRole,
  type SchemaChange,
  verifyPostgresSchema,
} from './sql/postgres/postgres-schema.migrator.js';
import { SqlDataStore } from './sql/sql-data-store.js';
import { createSqlExecutor } from './sql/sql-executor.factory.js';
import type { SqlExecutor } from './sql/sql-executor.interface.js';

/**
 * Routes every model registered with `CorePersistenceModule.forFeature()` to its data source (plan §3.9: the
 * configuration, then `@PersistedModel`, then the default). A SQL source is connected once, as the application role;
 * each model's table is brought up to date when its store is created — as the owner, or only verified without
 * `ownerUrl` — and the application role is checked against it: a role row-level security cannot bind stops the boot.
 * Per model, not per registry: the registry is process-wide, the stores Nest creates belong to THIS application.
 * Installed by `CoreModule.forRoot()` only when a SQL source is configured.
 */
export class DataSourceRuntime implements PersistenceRuntime {
  protected readonly logger = new Logger('DataSources');
  private readonly executors = new Map<string, Promise<SqlExecutor>>();
  private readonly owners = new Map<string, Promise<SqlExecutor>>();
  private readonly stores = new Map<string, Promise<DataStore<any>>>();

  constructor(protected readonly resolved: ResolvedDataSources) {}

  async close(): Promise<void> {
    const executors = [...this.executors.values()];
    this.executors.clear();
    this.stores.clear();
    await Promise.all([this.releaseBootConnections(), ...executors.map(closeExecutor)]);
  }

  async releaseBootConnections(): Promise<void> {
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

  /** Whether a model's table carries row-level security: tenant-scoped, multi-tenancy on, not excluded */
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
    const options: PostgresSchemaOptions = {
      appRole: decodeURIComponent(new URL(source.url).username),
      isTenantIsolated: (candidate) => this.isTenantIsolated(candidate),
    };
    let changes: SchemaChange[];
    if (source.ownerUrl) {
      changes = await applyPostgresSchema(await this.owner(source), [model], options);
    } else {
      changes = await verifyPostgresSchema(app, [model], options);
    }
    for (const change of changes) {
      if (change.kind === 'automatic') {
        this.logger.log(`[${source.name}] ${change.description}`);
      } else if (change.kind === 'notice') {
        this.logger.warn(`[${source.name}] ${change.description}`);
      }
    }
    await assertSafeApplicationRole(app, [tableName(model), tableName(LOCK_MODEL)]);
    this.logger.log(
      `${name} → ${source.name} → ${source.driver} ${redactUrl(source.url)} → ${source.sqlEngine}${this.isTenantIsolated(model) ? ' (row-level security)' : ''}`,
    );
    const registration = getPersistedModels().find((entry) => entry.name === name);
    return new SqlDataStore<any>(app, model, { schema: registration?.schema as any });
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

async function closeExecutor(pending: Promise<SqlExecutor>): Promise<void> {
  await (await pending.catch(() => undefined))?.close();
}
