import { Schema } from 'mongoose';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { DataSourceRuntime } from '../../src/core/common/persistence/data-source.runtime';
import { registerModelSchema } from '../../src/core/common/persistence/model-metadata.registry';
import { registerPersistedModel } from '../../src/core/common/persistence/persistence-runtime.registry';
import { applyPostgresSchema } from '../../src/core/common/persistence/sql/postgres/postgres-schema.migrator';
import { createSqlExecutor } from '../../src/core/common/persistence/sql/sql-executor.factory';

vi.mock('../../src/core/common/persistence/sql/sql-executor.factory', () => ({
  createSqlExecutor: vi.fn(async (options: { applicationName: string }) => ({
    applicationName: options.applicationName,
    close: vi.fn(async () => undefined),
    engine: 'typeorm',
  })),
}));

vi.mock('../../src/core/common/persistence/sql/postgres/postgres-schema.migrator', () => ({
  applyPostgresSchema: vi.fn(async () => []),
  assertSafeApplicationRole: vi.fn(async () => undefined),
  verifyPostgresSchema: vi.fn(async () => []),
}));

/**
 * The data-source runtime's connection handling, without a database: which connections the boot opens, and when it
 * lets go of them. What the schema work does on a real database is in `tests/persistence-sql-schema.e2e-spec.ts`.
 */
const MODELS = ['RuntimeAlpha', 'RuntimeBeta', 'RuntimeGamma'];
for (const name of MODELS) {
  const schema = new Schema({ label: String });
  registerModelSchema(name, schema);
  registerPersistedModel({ name, schema });
}

function runtime(): DataSourceRuntime {
  return new DataSourceRuntime({
    defaultSource: 'default',
    disabled: false,
    modelSources: {},
    sources: {
      default: {
        driver: 'postgres',
        name: 'default',
        ownerUrl: 'postgres://owner@db.internal/app',
        sqlEngine: 'typeorm',
        url: 'postgres://app@db.internal/app',
      },
    },
  });
}

afterEach(() => {
  vi.clearAllMocks();
});

describe('DataSourceRuntime connections', () => {
  /**
   * @regression   DEV-3829 (db-agnostic phase 1, review) — the schema was migrated through a NEW owner connection
   *   per model, opened while Nest creates the stores concurrently: one privileged connection per table at boot.
   * @seen-failing Create the owner executor per model in DataSourceRuntime.owner() in
   *   src/core/common/persistence/data-source.runtime.ts — registered as mutation `sql-owner-connection-per-model` in
   *   tests/regression-mutations.json.
   */
  it('migrates every model of a source through ONE owner connection, released after the boot', async () => {
    const subject = runtime();
    await Promise.all(MODELS.map((name) => subject.resolveStore(name, undefined)));

    const opened = vi.mocked(createSqlExecutor).mock.calls.map(([options]) => options.applicationName);
    expect(opened.filter((name) => name === 'nest-server-schema')).toHaveLength(1);
    expect(opened.filter((name) => name === 'nest-server')).toHaveLength(1);
    expect(vi.mocked(applyPostgresSchema)).toHaveBeenCalledTimes(MODELS.length);

    const executors: any[] = await Promise.all(vi.mocked(createSqlExecutor).mock.results.map((result) => result.value));
    const schemaConnection = executors.find((executor) => executor.applicationName === 'nest-server-schema');
    const appConnection = executors.find((executor) => executor.applicationName === 'nest-server');

    await subject.releaseBootConnections();
    expect(schemaConnection.close).toHaveBeenCalledTimes(1);
    expect(appConnection.close).not.toHaveBeenCalled();

    await subject.close();
    expect(schemaConnection.close).toHaveBeenCalledTimes(1);
    expect(appConnection.close).toHaveBeenCalledTimes(1);
  });
});
