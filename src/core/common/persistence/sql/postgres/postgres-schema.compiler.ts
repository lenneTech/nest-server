import { defaultCollectionName } from '../../mongo/collection-name.js';
import type { FieldDescriptor, IndexDescriptor, ModelDescriptor } from '../../model-descriptor.interface.js';
import { UnsupportedQueryError } from '../sql-errors.js';
import { columnName, quoteIdentifier, SqlLiterals, sqlLiteral } from '../sql-naming.js';
import { compilePostgresWhere } from './postgres-where.compiler.js';

/**
 * The PostgreSQL schema a model descriptor asks for (plan §3.3, §3.4, §3.12) — pure, no database. The migrator
 * (`postgres-schema.migrator.ts`) compares it with the catalog and decides what may change automatically.
 *
 * Mapping, chosen so a MongoDB project's data moves 1:1 and both databases answer alike:
 * - table = the MongoDB collection name in snake_case; `id` = the ObjectId hex as `text` primary key (plan §3.5)
 * - scalars → typed columns, strings with `COLLATE "C"` (MongoDB compares strings byte-wise); arrays, embedded
 *   objects and undeclared content → `jsonb`; references → indexed `text`, no foreign key (core modules stay swappable)
 * - every column but `id` is nullable: like MongoDB, the database does not enforce `required` — validation does —
 *   so adding a required field never needs a migration
 * - unique indexes treat NULL as a value (`NULLS NOT DISTINCT`), as a non-sparse MongoDB unique index does
 * - tenant-isolated tables get row-level security that fails closed (§3.4); `roles` columns refuse system roles
 */

/** Any string item that starts with `s_` after leading whitespace, case-insensitive (`looksLikeSystemRole`) */
const SYSTEM_ROLE_PATH = '$[*] ? (@.type() == "string" && @ like_regex "^\\\\s*s_" flag "i")';

/** Bumped whenever the generated guard function or policies change, so the migrator replaces them */
export const RLS_VERSION = 'lt:tenant:v1';
export const TENANT_FILTER_FUNCTION = 'lt_tenant_filter';
export const TENANT_POLICY = 'lt_tenant_isolation';

const lockField = (name: string, kind: 'date' | 'id' | 'string'): FieldDescriptor => ({
  hasDefault: false,
  index: false,
  isArray: false,
  kind,
  lowercase: false,
  name,
  required: false,
  select: true,
  sparse: false,
  trim: false,
  unique: false,
});

/** The framework's lease table (`PostgresLockStore`), created with every SQL schema */
export const LOCK_MODEL: ModelDescriptor = Object.freeze({
  collection: 'lt_locks',
  fields: {
    _id: lockField('_id', 'id'),
    acquiredAt: lockField('acquiredAt', 'date'),
    expiresAt: lockField('expiresAt', 'date'),
    owner: lockField('owner', 'string'),
  },
  indexes: [],
  name: 'LtLock',
  tenantScoped: false,
  timestamps: false,
});

export interface DesiredColumn {
  /** SQL default expression */
  default?: string;
  /** Postgres type as `format_type()` prints it */
  type: string;
  /** Collation for text columns */
  collation?: 'C';
  name: string;
  primaryKey: boolean;
  /** Column name the field had before (`renamedFrom`) */
  renamedFrom?: string;
}

export interface DesiredIndex {
  /** The CREATE statement */
  create: string;
  name: string;
  unique: boolean;
}

export interface DesiredCheck {
  expression: string;
  name: string;
}

export interface DesiredTable {
  checks: DesiredCheck[];
  columns: DesiredColumn[];
  indexes: DesiredIndex[];
  model: ModelDescriptor;
  name: string;
  /** What the model declares but the table cannot carry (text indexes, …), reported once */
  notices: string[];
  /** Row-level security on `tenant_id` */
  tenantIsolated: boolean;
}

export interface PostgresSchemaOptions {
  /** The application role: receives SELECT, INSERT, UPDATE, DELETE — never ownership */
  appRole: string;
  /** Whether a model's table is tenant-isolated (tenant-scoped, multi-tenancy on, not in `excludeSchemas`) */
  isTenantIsolated: (model: ModelDescriptor) => boolean;
}

/**
 * The table of a model: the collection MongoDB would use, in snake_case. A hyphen becomes an underscore (`s3-files` →
 * `s3_files`): MongoDB allows it in a collection name, SQL not in an unquoted identifier
 */
export function tableName(model: ModelDescriptor): string {
  const collection = model.collection ?? defaultCollectionName(model.name);
  return columnName(collection.replace(/-/g, '_'));
}

export function desiredTable(model: ModelDescriptor, options: PostgresSchemaOptions): DesiredTable {
  const name = tableName(model);
  const notices: string[] = [];
  const columns: DesiredColumn[] = Object.values(model.fields).map((field) => desiredColumn(field));
  if (!columns.some((column) => column.primaryKey)) {
    columns.unshift({ name: 'id', primaryKey: true, type: 'text' });
  }
  const seen = new Map<string, string>();
  for (const field of Object.values(model.fields)) {
    const column = columnName(field.name);
    if (seen.has(column)) {
      throw new UnsupportedQueryError(
        `${model.name}: "${seen.get(column)}" and "${field.name}" map to one column "${column}"`,
      );
    }
    seen.set(column, field.name);
  }

  const checks: DesiredCheck[] = [];
  const roles = model.fields.roles;
  if (roles?.isArray && (roles.kind === 'string' || roles.kind === 'enum')) {
    // The storage rule of the system-role policy: no value starting with `s_`, trimmed, case-insensitive
    checks.push({
      expression: `"roles" IS NULL OR NOT jsonb_path_exists("roles", ${sqlLiteral(SYSTEM_ROLE_PATH)}::jsonpath)`,
      name: shortName('ck', name, ['roles', 'no_system_roles']),
    });
  }

  const tenantIsolated = options.isTenantIsolated(model);
  if (tenantIsolated && !model.fields.tenantId) {
    throw new UnsupportedQueryError(`${model.name} is tenant-isolated but has no tenantId field`);
  }

  const indexes: DesiredIndex[] = [];
  for (const index of model.indexes) {
    const result = desiredIndex(model, name, index);
    if (typeof result === 'string') {
      notices.push(`${model.name}: index ${JSON.stringify(index.fields)} is not created on PostgreSQL (${result})`);
    } else {
      indexes.push(result);
    }
  }
  if (tenantIsolated && !indexes.some((index) => /\("tenant_id"/.test(index.create))) {
    // The predicate the store adds to every query needs an index, as the tenant plugin's does on MongoDB
    indexes.push(desiredIndex(model, name, { fields: { tenantId: 1 }, options: {} }) as DesiredIndex);
  }

  return { checks, columns, indexes, model, name, notices, tenantIsolated };
}

function desiredColumn(field: FieldDescriptor): DesiredColumn {
  const name = columnName(field.name);
  if (name === 'id') {
    return { name, primaryKey: true, type: 'text' };
  }
  const column: DesiredColumn = { ...columnType(field), name, primaryKey: false };
  const fallback = field.isArray ? [] : undefined;
  const value = 'default' in field ? field.default : fallback;
  if (value !== undefined) {
    column.default = defaultLiteral(column.type, value);
  }
  if (field.renamedFrom) {
    column.renamedFrom = columnName(field.renamedFrom);
  }
  return column;
}

function columnType(field: FieldDescriptor): Pick<DesiredColumn, 'collation' | 'type'> {
  if (field.isArray) {
    return { type: 'jsonb' };
  }
  switch (field.kind) {
    case 'bigint':
      return { type: 'bigint' };
    case 'boolean':
      return { type: 'boolean' };
    case 'buffer':
      return { type: 'bytea' };
    case 'date':
      return { type: 'timestamp with time zone' };
    case 'decimal':
      return { type: 'numeric' };
    case 'enum':
      return field.enumBase === 'number' ? { type: 'double precision' } : { collation: 'C', type: 'text' };
    case 'id':
    case 'ref':
      return { collation: 'C', type: 'text' };
    case 'number':
      return { type: 'double precision' };
    case 'string':
      return { collation: 'C', type: 'text' };
    case 'uuid':
      return { type: 'uuid' };
    default:
      return { type: 'jsonb' };
  }
}

function defaultLiteral(type: string, value: unknown): string | undefined {
  if (value === null) {
    return undefined;
  }
  if (type === 'jsonb') {
    return `${sqlLiteral(JSON.stringify(value))}::jsonb`;
  }
  if (type === 'timestamp with time zone') {
    return value instanceof Date ? `${sqlLiteral(value)}::timestamptz` : undefined;
  }
  if (
    typeof value === 'string' ||
    typeof value === 'number' ||
    typeof value === 'boolean' ||
    typeof value === 'bigint'
  ) {
    return sqlLiteral(value);
  }
  // Anything else (an ObjectId, a class instance) is applied by the store when it writes
  return undefined;
}

/** A `CREATE INDEX` for a declared index, or the reason it cannot be one */
function desiredIndex(model: ModelDescriptor, table: string, index: IndexDescriptor): DesiredIndex | string {
  const entries = Object.entries(index.fields);
  const special = entries.find(([, direction]) => typeof direction !== 'number');
  if (special) {
    return `${String(special[1])} indexes have no PostgreSQL counterpart`;
  }
  const unique = index.options.unique === true;
  const sparse = index.options.sparse === true;
  const partial = index.options.partialFilterExpression as Record<string, unknown> | undefined;

  const parts = entries.map(([path, direction]) => indexPart(model, path, direction as number));
  const gin = parts.filter((part) => part.gin);
  if (gin.length && (entries.length > 1 || unique)) {
    return 'a unique or compound index over an array or JSON field';
  }

  const name = shortName(unique ? 'ux' : 'ix', table, [
    ...entries.map(([path]) => path.replace(/\./g, '_')),
    hash(JSON.stringify({ fields: index.fields, partial, sparse, unique })),
  ]);
  const conditions: string[] = [];
  if (sparse) {
    conditions.push(...parts.map((part) => `${part.expression} IS NOT NULL`));
  }
  if (partial) {
    conditions.push(`(${compilePostgresWhere(model, partial, new SqlLiterals())})`);
  }
  const using = gin.length
    ? ` USING gin (${gin[0].expression} jsonb_path_ops)`
    : ` (${parts.map((part) => part.sql).join(', ')})`;
  const nulls = unique && !conditions.length ? ' NULLS NOT DISTINCT' : '';
  const where = conditions.length ? ` WHERE ${conditions.join(' AND ')}` : '';
  return {
    create: `CREATE ${unique ? 'UNIQUE ' : ''}INDEX ${quoteIdentifier(name)} ON ${quoteIdentifier(table)}${using}${nulls}${where}`,
    name,
    unique,
  };
}

function indexPart(
  model: ModelDescriptor,
  path: string,
  direction: number,
): { expression: string; gin: boolean; sql: string } {
  const [head, ...rest] = path.split('.');
  const field = model.fields[head === 'id' ? '_id' : head];
  if (!field) {
    throw new UnsupportedQueryError(`${model.name}: index on unknown field "${path}"`);
  }
  const column = quoteIdentifier(columnName(field.name));
  const order = direction < 0 ? ' DESC' : '';
  if (rest.length) {
    // A path into an embedded object: index its text form, the form the compiler compares nested strings in
    const expression = `(${column} #>> ${sqlLiteral(rest)})`;
    return { expression, gin: false, sql: `${expression}${order}` };
  }
  const json = columnType(field).type === 'jsonb';
  return { expression: column, gin: json, sql: `${column}${order}` };
}

/** `prefix_table__parts`, shortened with a hash when it would exceed Postgres' 63-character identifier limit */
export function shortName(prefix: string, table: string, parts: string[]): string {
  const full = `${prefix}_${table}__${parts.join('_')}`;
  return full.length <= 63 ? full : `${full.slice(0, 54)}_${hash(full)}`;
}

/** FNV-1a, 8 hex characters: a stable short name for a definition */
function hash(text: string): string {
  let value = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    value ^= text.charCodeAt(i);
    value = Math.imul(value, 0x01000193) >>> 0;
  }
  return value.toString(16).padStart(8, '0');
}

// -- statements ---------------------------------------------------------------------------------------------

export function createTableStatement(table: DesiredTable): string {
  const definitions = table.columns.map(columnDefinition);
  for (const check of table.checks) {
    definitions.push(`CONSTRAINT ${quoteIdentifier(check.name)} CHECK (${check.expression})`);
  }
  return `CREATE TABLE ${quoteIdentifier(table.name)} (\n  ${definitions.join(',\n  ')}\n)`;
}

export function columnDefinition(column: DesiredColumn): string {
  const collation = column.collation ? ` COLLATE "${column.collation}"` : '';
  const key = column.primaryKey ? ' NOT NULL PRIMARY KEY' : '';
  const fallback = column.default ? ` DEFAULT ${column.default}` : '';
  return `${quoteIdentifier(column.name)} ${column.type}${collation}${key}${fallback}`;
}

export function addCheckStatement(table: string, check: DesiredCheck): string {
  // NOT VALID: enforced on every new and changed row without scanning — a table that already holds a system role
  // keeps booting, and its owner fixes the row
  return `ALTER TABLE ${quoteIdentifier(table)} ADD CONSTRAINT ${quoteIdentifier(check.name)} CHECK (${check.expression}) NOT VALID`;
}

export function grantStatement(table: string, appRole: string): string {
  return `GRANT SELECT, INSERT, UPDATE, DELETE ON ${quoteIdentifier(table)} TO ${quoteIdentifier(appRole)}`;
}

/**
 * The guard every tenant policy calls. It reads the scope the store wrote into the transaction (`sql-session.ts`)
 * and RAISES `42501` without one, so a query on a tenant table outside the framework's context — a forgotten scope,
 * a native or raw query that skipped it — fails instead of returning every tenant's rows.
 * Returns NULL for system work (no restriction), else the visible tenant ids.
 */
export function tenantFilterFunctionStatements(): string[] {
  const fn = quoteIdentifier(TENANT_FILTER_FUNCTION);
  return [
    `CREATE OR REPLACE FUNCTION ${fn}() RETURNS text[]
LANGUAGE plpgsql STABLE PARALLEL SAFE SET search_path = pg_catalog AS $lt$
DECLARE
  scope text := current_setting('app.tenant_scope', true);
BEGIN
  IF scope = 'system' THEN
    RETURN NULL;
  ELSIF scope = 'tenant' THEN
    RETURN ARRAY[current_setting('app.tenant_id', true)];
  ELSIF scope = 'tenants' THEN
    RETURN ARRAY(SELECT jsonb_array_elements_text(current_setting('app.tenant_ids', true)::jsonb));
  END IF;
  RAISE EXCEPTION 'tenant-scoped data accessed without a tenant context' USING ERRCODE = 'insufficient_privilege';
END
$lt$`,
    `COMMENT ON FUNCTION ${fn}() IS ${sqlLiteral(RLS_VERSION)}`,
  ];
}

/**
 * Row-level security for a tenant table: FORCED (the owner is bound too), one policy for reads and writes. The guard
 * runs as an init plan — once per statement, not per row (plan §3.4).
 */
export function tenantPolicyStatements(table: string): string[] {
  const quoted = quoteIdentifier(table);
  const policy = quoteIdentifier(TENANT_POLICY);
  const filter = `(SELECT ${quoteIdentifier(TENANT_FILTER_FUNCTION)}())`;
  // `::text[]` keeps `= ANY (…)` the array form; without it Postgres reads the subquery form, row by row
  const visible = `(${filter} IS NULL OR "tenant_id" = ANY (${filter}::text[]))`;
  return [
    `ALTER TABLE ${quoted} ENABLE ROW LEVEL SECURITY`,
    `ALTER TABLE ${quoted} FORCE ROW LEVEL SECURITY`,
    `DROP POLICY IF EXISTS ${policy} ON ${quoted}`,
    `CREATE POLICY ${policy} ON ${quoted} FOR ALL USING ${visible} WITH CHECK ${visible}`,
    `COMMENT ON POLICY ${policy} ON ${quoted} IS ${sqlLiteral(RLS_VERSION)}`,
  ];
}
