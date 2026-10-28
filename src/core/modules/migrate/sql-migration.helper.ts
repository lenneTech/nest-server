import type { DatabaseSqlEngine } from '../../common/interfaces/server-options.interface.js';
import { SCHEMA_LOCK_SQL } from '../../common/persistence/sql/postgres/postgres-schema.migrator.js';
import { createSqlExecutor } from '../../common/persistence/sql/sql-executor.factory.js';

/**
 * Run the reviewed statements of a SQL migration (`migrate create <name> --sql`) as the table OWNER: one transaction,
 * under the lock the boot's schema migration takes, so a replica booting meanwhile waits and then sees the result.
 * Either every statement applies or none does.
 *
 * The statements are the ones a refused boot suggested (`SchemaMigrationRequiredError`) — after review: a narrowed
 * type, a new unique index or a rename collision can reject or rewrite stored rows, which is why the framework never
 * runs them on its own (plan §3.12).
 */
export async function runSqlMigration(
  ownerUrl: string,
  statements: readonly string[],
  options: { engine?: DatabaseSqlEngine } = {},
): Promise<void> {
  if (!ownerUrl) {
    throw new Error('runSqlMigration() needs the connection URL of the table owner (database.ownerUrl)');
  }
  const executor = await createSqlExecutor({
    applicationName: 'nest-server-migration',
    engine: options.engine ?? 'typeorm',
    maxConnections: 1,
    url: ownerUrl,
  });
  try {
    await executor.transaction(async (tx) => {
      await tx.run({ params: [], text: SCHEMA_LOCK_SQL }, { kind: 'system' });
      for (const text of statements) {
        await tx.run({ params: [], text }, { kind: 'system' });
      }
    });
  } finally {
    await executor.close();
  }
}
