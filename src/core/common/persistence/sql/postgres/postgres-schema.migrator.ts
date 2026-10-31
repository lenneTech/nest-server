import type { ModelDescriptor } from '../../model-descriptor.interface.js';
import { isForeignColumn } from '../../persistence-runtime.registry.js';
import type { SqlExecutor, SqlQueryResult, SqlStatement, SqlTenantScope } from '../sql-executor.interface.js';
import { quoteIdentifier } from '../sql-naming.js';
import {
  LOCK_MODEL,
  type SchemaChange,
  SchemaMigrationRequiredError,
  SchemaOutOfDateError,
  UnsafeDatabaseRoleError,
} from '../sql-schema.shared.js';
import {
  addCheckStatement,
  columnDefinition,
  createTableStatement,
  type DesiredTable,
  desiredTable,
  grantStatement,
  type PostgresSchemaOptions,
  RLS_VERSION,
  SYNC_STAMP_FUNCTION,
  SYNC_TRIGGER,
  SYNC_TRIGGER_VERSION,
  syncFunctionStatements,
  syncTableStatements,
  TENANT_FILTER_FUNCTION,
  TENANT_POLICY,
  tenantFilterFunctionStatements,
  tenantPolicyStatements,
} from './postgres-schema.compiler.js';

/**
 * Safe, framework-owned schema evolution (plan §3.12): read the catalog with plain SQL, compare it with what the
 * models ask for, and sort every difference into one of three kinds.
 *
 * | Kind        | Examples                                                                 | At boot              |
 * |-------------|--------------------------------------------------------------------------|----------------------|
 * | `automatic` | new table, new column, declared rename, new non-unique index, RLS, grants | applied, logged      |
 * | `migration` | changed column type, new unique index, rename collision, RLS to remove    | boot refused         |
 * | `notice`    | column or index no longer declared (kept), index type Postgres lacks      | logged once          |
 *
 * Nothing is ever dropped or narrowed automatically. The whole run is one transaction under an advisory lock, so
 * replicas booting together apply it once and the others find nothing left to do.
 */

export {
  type SchemaChange,
  type SchemaChangeKind,
  SchemaMigrationRequiredError,
  SchemaOutOfDateError,
  UnsafeDatabaseRoleError,
} from '../sql-schema.shared.js';

/** Lowest supported server: `NULLS NOT DISTINCT` (15) */
export const MIN_POSTGRES_VERSION = 150000;
/** The lock every schema change takes — the boot's migration and `runSqlMigration()` alike */
export const SCHEMA_LOCK_SQL = "SELECT pg_advisory_xact_lock(hashtext('lenne.tech:schema'))";
const SYSTEM: SqlTenantScope = { kind: 'system' };

type Run = (statement: SqlStatement) => Promise<SqlQueryResult<any>>;

interface CatalogTable {
  columns: Map<string, { collation: null | string; type: string }>;
  forced: boolean;
  /** framework-named index → unique */
  indexes: Map<string, boolean>;
  constraints: Set<string>;
  granted: boolean;
  policyVersion: null | string;
  rls: boolean;
  /** Change-order triggers (`lt_sync_*`) on the table */
  syncTriggers: Set<string>;
}

interface Catalog {
  functionVersion: null | string;
  /** Sequences of synchronized tables → whether the application role may use them */
  sequences: Map<string, boolean>;
  syncFunctionVersion: null | string;
  schema: string;
  /** Whether the application role may use the schema */
  schemaUsage: boolean;
  tables: Map<string, CatalogTable>;
}

/** Apply every automatic change in one locked transaction, as the OWNER role; refuse when a migration is needed. */
export async function applyPostgresSchema(
  owner: SqlExecutor,
  models: ModelDescriptor[],
  options: PostgresSchemaOptions,
): Promise<SchemaChange[]> {
  return owner.transaction(async (tx) => {
    const run: Run = (statement) => tx.run(statement, SYSTEM);
    await run({ params: [], text: SCHEMA_LOCK_SQL });
    const changes = await planPostgresSchema(run, models, options);
    const migrations = changes.filter((change) => change.kind === 'migration');
    if (migrations.length) {
      throw new SchemaMigrationRequiredError(migrations);
    }
    for (const change of changes) {
      if (change.kind === 'automatic') {
        for (const text of change.statements) {
          await run({ params: [], text });
        }
      }
    }
    return changes;
  });
}

/** Without an owner connection: only check, as the APPLICATION role, and refuse to start on any pending change. */
export async function verifyPostgresSchema(
  app: SqlExecutor,
  models: ModelDescriptor[],
  options: PostgresSchemaOptions,
): Promise<SchemaChange[]> {
  const changes = await planPostgresSchema((statement) => app.run(statement, SYSTEM), models, options);
  const pending = changes.filter((change) => change.kind !== 'notice');
  if (pending.length) {
    throw new SchemaOutOfDateError(pending);
  }
  return changes;
}

export async function planPostgresSchema(
  run: Run,
  models: ModelDescriptor[],
  options: PostgresSchemaOptions,
): Promise<SchemaChange[]> {
  // The lease table travels with every schema: locks are how replicas agree, whatever the models are
  const all = models.some((model) => model.name === LOCK_MODEL.name) ? models : [...models, LOCK_MODEL];
  const tables = all.map((model) => desiredTable(model, options));
  const catalog = await readCatalog(
    run,
    tables.map((table) => table.name),
    options.appRole,
    tables.flatMap((table) => (table.sync ? [table.sync.sequence] : [])),
  );
  const changes: SchemaChange[] = [];

  if (tables.some((table) => table.sync) && catalog.syncFunctionVersion !== SYNC_TRIGGER_VERSION) {
    changes.push({
      description: `${catalog.syncFunctionVersion ? 'update' : 'create'} the change-order function ${SYNC_STAMP_FUNCTION}()`,
      kind: 'automatic',
      statements: syncFunctionStatements(),
    });
  }

  if (tables.some((table) => table.tenantIsolated) && catalog.functionVersion !== RLS_VERSION) {
    changes.push({
      description: `${catalog.functionVersion ? 'update' : 'create'} the tenant guard function ${TENANT_FILTER_FUNCTION}()`,
      kind: 'automatic',
      statements: tenantFilterFunctionStatements(),
    });
  }
  if (tables.length && !catalog.schemaUsage) {
    changes.push({
      description: `let ${options.appRole} use schema ${catalog.schema}`,
      kind: 'automatic',
      statements: [`GRANT USAGE ON SCHEMA ${quoteIdentifier(catalog.schema)} TO ${quoteIdentifier(options.appRole)}`],
    });
  }
  for (const table of tables) {
    for (const notice of table.notices) {
      changes.push({ description: notice, kind: 'notice', statements: [], table: table.name });
    }
    const existing = catalog.tables.get(table.name);
    changes.push(
      ...(existing ? planExistingTable(table, existing, catalog.sequences, options) : planNewTable(table, options)),
    );
  }
  return changes;
}

function planNewTable(table: DesiredTable, options: PostgresSchemaOptions): SchemaChange[] {
  return [
    {
      description: `create table ${table.name} (${table.model.name})`,
      kind: 'automatic',
      statements: [
        createTableStatement(table),
        ...table.indexes.map((index) => index.create),
        ...(table.tenantIsolated ? tenantPolicyStatements(table.name) : []),
        grantStatement(table.name, options.appRole),
        ...(table.sync ? syncTableStatements(table.name, table.sync, options.appRole) : []),
      ],
      table: table.name,
    },
  ];
}

function planExistingTable(
  table: DesiredTable,
  existing: CatalogTable,
  sequences: Map<string, boolean>,
  options: PostgresSchemaOptions,
): SchemaChange[] {
  const changes: SchemaChange[] = [];
  const name = table.name;
  const quoted = quoteIdentifier(name);
  const declared = new Set<string>();

  for (const column of table.columns) {
    declared.add(column.name);
    const current = existing.columns.get(column.name);
    if (!current) {
      const previous = column.renamedFrom ? existing.columns.get(column.renamedFrom) : undefined;
      if (previous) {
        declared.add(column.renamedFrom);
        changes.push({
          description: `rename ${name}.${column.renamedFrom} to ${column.name} (declared renamedFrom)`,
          kind: 'automatic',
          statements: [
            `ALTER TABLE ${quoted} RENAME COLUMN ${quoteIdentifier(column.renamedFrom)} TO ${quoteIdentifier(column.name)}`,
          ],
          table: name,
        });
        if (!sameType(column, previous)) {
          changes.push(typeChange(name, column, previous));
        }
        continue;
      }
      changes.push({
        description: `add column ${name}.${column.name}`,
        kind: 'automatic',
        statements: [`ALTER TABLE ${quoted} ADD COLUMN ${columnDefinition({ ...column, primaryKey: false })}`],
        table: name,
      });
      continue;
    }
    if (column.renamedFrom && existing.columns.has(column.renamedFrom)) {
      declared.add(column.renamedFrom);
      changes.push({
        description: `${name}.${column.name} is declared as renamed from ${column.renamedFrom}, but both columns exist — move the data and drop the old column in a migration`,
        kind: 'migration',
        statements: [],
        table: name,
      });
    }
    if (!sameType(column, current)) {
      changes.push(typeChange(name, column, current));
    }
  }
  for (const column of existing.columns.keys()) {
    if (!declared.has(column) && !isForeignColumn(name, column)) {
      changes.push({
        description: `${name}.${column} is no longer declared; the column is kept until a migration drops it`,
        kind: 'notice',
        statements: [],
        table: name,
      });
    }
  }

  for (const check of table.checks) {
    if (!existing.constraints.has(check.name)) {
      changes.push({
        description: `add check ${check.name} on ${name}`,
        kind: 'automatic',
        statements: [addCheckStatement(name, check)],
        table: name,
      });
    }
  }

  const wanted = new Set(table.indexes.map((index) => index.name));
  for (const index of table.indexes) {
    if (existing.indexes.has(index.name)) {
      continue;
    }
    changes.push({
      description: `create ${index.unique ? 'unique ' : ''}index ${index.name} on ${name}`,
      // A unique index can fail on the rows already stored, and it changes what may be written: a reviewed decision
      kind: index.unique ? 'migration' : 'automatic',
      statements: [index.create],
      table: name,
    });
  }
  for (const [index] of existing.indexes) {
    if (!wanted.has(index)) {
      changes.push({
        description: `index ${index} on ${name} is no longer declared; it is kept until a migration drops it`,
        kind: 'notice',
        statements: [],
        table: name,
      });
    }
  }

  if (table.tenantIsolated && (!existing.rls || !existing.forced || existing.policyVersion !== RLS_VERSION)) {
    changes.push({
      description: `apply row-level security to ${name}`,
      kind: 'automatic',
      statements: tenantPolicyStatements(name),
      table: name,
    });
  }
  if (!table.tenantIsolated && existing.policyVersion) {
    // Never removed on its own: a configuration slip (multi-tenancy dropped, a model added to excludeSchemas) must
    // not switch database-level isolation off. Until a reviewed migration does, the boot stops
    changes.push({
      description: `${name} is no longer tenant-isolated, but its row-level security is still in place — remove it in a migration if that is intended`,
      kind: 'migration',
      statements: [
        `DROP POLICY IF EXISTS ${quoteIdentifier(TENANT_POLICY)} ON ${quoted}`,
        `ALTER TABLE ${quoted} NO FORCE ROW LEVEL SECURITY`,
        `ALTER TABLE ${quoted} DISABLE ROW LEVEL SECURITY`,
      ],
      table: name,
    });
  }
  if (!existing.granted) {
    changes.push({
      description: `grant ${options.appRole} access to ${name}`,
      kind: 'automatic',
      statements: [grantStatement(name, options.appRole)],
      table: name,
    });
  }
  changes.push(...planSync(table, existing, sequences, options));
  return changes;
}

/**
 * A synchronized table's change order: the trigger of the current version, its sequence and the application role's
 * use of it. A trigger of an earlier version is replaced; a table that is no longer synchronized keeps its trigger
 * (and its numbering) until a migration removes it
 */
function planSync(
  table: DesiredTable,
  existing: CatalogTable,
  sequences: Map<string, boolean>,
  options: PostgresSchemaOptions,
): SchemaChange[] {
  const name = table.name;
  const quoted = quoteIdentifier(name);
  if (!table.sync) {
    return existing.syncTriggers.size
      ? [
          {
            description: `${name} is no longer synchronized; its change-order trigger is kept until a migration drops it`,
            kind: 'notice',
            statements: [],
            table: name,
          },
        ]
      : [];
  }
  if (!existing.syncTriggers.has(SYNC_TRIGGER)) {
    const outdated = [...existing.syncTriggers].map(
      (trigger) => `DROP TRIGGER IF EXISTS ${quoteIdentifier(trigger)} ON ${quoted}`,
    );
    return [
      {
        description: `${outdated.length ? 'replace' : 'add'} the change-order trigger of ${name}`,
        kind: 'automatic',
        statements: [...outdated, ...syncTableStatements(name, table.sync, options.appRole)],
        table: name,
      },
    ];
  }
  if (!sequences.get(table.sync.sequence)) {
    return [
      {
        description: `let ${options.appRole} use the change-order sequence of ${name}`,
        kind: 'automatic',
        statements: syncTableStatements(name, table.sync, options.appRole).slice(0, 2),
        table: name,
      },
    ];
  }
  return [];
}

function sameType(
  column: DesiredTable['columns'][number],
  current: { collation: null | string; type: string },
): boolean {
  return column.type === current.type && (column.collation ?? null) === current.collation;
}

function typeChange(
  table: string,
  column: DesiredTable['columns'][number],
  current: { collation: null | string; type: string },
): SchemaChange {
  const wanted = `${column.type}${column.collation ? ` COLLATE "${column.collation}"` : ''}`;
  const found = `${current.type}${current.collation ? ` COLLATE "${current.collation}"` : ''}`;
  return {
    description: `${table}.${column.name} is ${found}, the model asks for ${wanted}`,
    kind: 'migration',
    statements: [
      `ALTER TABLE ${quoteIdentifier(table)} ALTER COLUMN ${quoteIdentifier(column.name)} TYPE ${wanted} USING ${quoteIdentifier(column.name)}::${column.type}`,
    ],
    table,
  };
}

async function readCatalog(run: Run, tables: string[], appRole: string, sequences: string[]): Promise<Catalog> {
  // One query after the other: inside the migration transaction they share a single connection
  const schemaResult = await run({
    params: [appRole],
    text: "SELECT current_schema() AS schema, has_schema_privilege($1, current_schema(), 'USAGE') AS usage",
  });
  const tableResult = await run({
    params: [tables, appRole],
    text: `SELECT c.relname AS name, c.relrowsecurity AS rls, c.relforcerowsecurity AS forced,
        has_table_privilege($2, c.oid, 'SELECT') AND has_table_privilege($2, c.oid, 'INSERT')
          AND has_table_privilege($2, c.oid, 'UPDATE') AND has_table_privilege($2, c.oid, 'DELETE') AS granted,
        (SELECT d.description FROM pg_policy p JOIN pg_description d ON d.objoid = p.oid AND d.classoid = 'pg_policy'::regclass
          WHERE p.polrelid = c.oid AND p.polname = '${TENANT_POLICY}') AS policy_version
      FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = current_schema() AND c.relkind IN ('r', 'p') AND c.relname = ANY($1)`,
  });
  const columnResult = await run({
    params: [tables],
    text: `SELECT c.relname AS table, a.attname AS name, format_type(a.atttypid, a.atttypmod) AS type,
        CASE WHEN a.attcollation <> 0 AND a.attcollation <> t.typcollation THEN co.collname END AS collation
      FROM pg_attribute a JOIN pg_class c ON c.oid = a.attrelid JOIN pg_namespace n ON n.oid = c.relnamespace
        JOIN pg_type t ON t.oid = a.atttypid LEFT JOIN pg_collation co ON co.oid = a.attcollation
      WHERE n.nspname = current_schema() AND c.relname = ANY($1) AND a.attnum > 0 AND NOT a.attisdropped`,
  });
  const indexResult = await run({
    params: [tables],
    text: `SELECT t.relname AS table, i.relname AS name, x.indisunique AS unique
      FROM pg_index x JOIN pg_class i ON i.oid = x.indexrelid JOIN pg_class t ON t.oid = x.indrelid
        JOIN pg_namespace n ON n.oid = t.relnamespace
      WHERE n.nspname = current_schema() AND t.relname = ANY($1) AND (i.relname LIKE 'ix\\_%' OR i.relname LIKE 'ux\\_%')`,
  });
  const constraintResult = await run({
    params: [tables],
    text: `SELECT c.relname AS table, k.conname AS name
      FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = current_schema() AND c.relname = ANY($1) AND k.contype = 'c'`,
  });
  const functionResult = await run({
    params: [[TENANT_FILTER_FUNCTION, SYNC_STAMP_FUNCTION]],
    text: `SELECT p.proname AS name, obj_description(p.oid, 'pg_proc') AS version
      FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = current_schema() AND p.proname = ANY($1) AND p.pronargs = 0`,
  });
  const triggerResult = await run({
    params: [tables],
    text: `SELECT c.relname AS table, t.tgname AS name
      FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = current_schema() AND c.relname = ANY($1) AND NOT t.tgisinternal AND t.tgname LIKE 'lt\\_sync\\_%'`,
  });
  const sequenceResult = sequences.length
    ? await run({
        params: [sequences, appRole],
        text: `SELECT c.relname AS name, has_sequence_privilege($2, c.oid, 'USAGE') AS usage
          FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
          WHERE n.nspname = current_schema() AND c.relkind = 'S' AND c.relname = ANY($1)`,
      })
    : { rowCount: 0, rows: [] };
  const versionOf = (fn: string) => functionResult.rows.find((row) => row.name === fn)?.version ?? null;

  const catalog: Catalog = {
    functionVersion: versionOf(TENANT_FILTER_FUNCTION),
    sequences: new Map(sequenceResult.rows.map((row: { name: string; usage: boolean }) => [row.name, row.usage])),
    syncFunctionVersion: versionOf(SYNC_STAMP_FUNCTION),
    schema: schemaResult.rows[0].schema,
    schemaUsage: schemaResult.rows[0].usage,
    tables: new Map(),
  };
  for (const row of tableResult.rows) {
    catalog.tables.set(row.name, {
      columns: new Map(),
      constraints: new Set(),
      forced: row.forced,
      granted: row.granted,
      indexes: new Map(),
      policyVersion: row.policy_version ?? null,
      rls: row.rls,
      syncTriggers: new Set(),
    });
  }
  for (const row of triggerResult.rows) {
    catalog.tables.get(row.table)?.syncTriggers.add(row.name);
  }
  for (const row of columnResult.rows) {
    catalog.tables.get(row.table)?.columns.set(row.name, { collation: row.collation ?? null, type: row.type });
  }
  for (const row of indexResult.rows) {
    catalog.tables.get(row.table)?.indexes.set(row.name, row.unique);
  }
  for (const row of constraintResult.rows) {
    catalog.tables.get(row.table)?.constraints.add(row.name);
  }
  return catalog;
}

/**
 * The boot check of the APPLICATION connection (plan §3.9): row-level security only binds a role that is neither
 * superuser nor `BYPASSRLS`, owns none of the tables (directly or through a role it inherits), and cannot `TRUNCATE`
 * them — `TRUNCATE` ignores row-level security altogether. Also refuses a server older than PostgreSQL 15.
 */
export async function assertSafeApplicationRole(app: SqlExecutor, tables: string[]): Promise<void> {
  const { rows } = await app.run<{
    bypassrls: boolean;
    owned: null | string[];
    role: string;
    superuser: boolean;
    truncate: null | string[];
    version: number;
  }>(
    {
      params: [tables],
      text: `SELECT current_user AS role, r.rolsuper AS superuser, r.rolbypassrls AS bypassrls,
          current_setting('server_version_num')::int AS version,
          (SELECT array_agg(c.relname::text ORDER BY c.relname) FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
            WHERE n.nspname = current_schema() AND c.relname = ANY($1) AND pg_has_role(current_user, c.relowner, 'USAGE')) AS owned,
          (SELECT array_agg(c.relname::text ORDER BY c.relname) FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
            WHERE n.nspname = current_schema() AND c.relname = ANY($1) AND has_table_privilege(c.oid, 'TRUNCATE')) AS truncate
        FROM pg_roles r WHERE r.rolname = current_user`,
    },
    SYSTEM,
  );
  const role = rows[0];
  if (role.version < MIN_POSTGRES_VERSION) {
    throw new UnsafeDatabaseRoleError(
      `PostgreSQL ${Math.floor(role.version / 10000)} is not supported; version 15 or newer is required`,
    );
  }
  const problems: string[] = [];
  if (role.superuser) {
    problems.push('is a superuser');
  }
  if (role.bypassrls) {
    problems.push('has BYPASSRLS');
  }
  if (role.owned?.length) {
    problems.push(`owns (or inherits the owner of) ${role.owned.join(', ')}`);
  }
  if (role.truncate?.length) {
    problems.push(`may TRUNCATE ${role.truncate.join(', ')}`);
  }
  if (problems.length) {
    throw new UnsafeDatabaseRoleError(
      `The application role "${role.role}" ${problems.join(', ')}. Row-level security cannot protect tenant data from ` +
        'such a role. Connect `database.url` as a role that owns nothing, and give the owner role to `database.ownerUrl`.',
    );
  }
}
