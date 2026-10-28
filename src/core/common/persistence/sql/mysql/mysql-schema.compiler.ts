import type { FieldDescriptor, IndexDescriptor, ModelDescriptor } from '../../model-descriptor.interface.js';
import { UnsupportedQueryError } from '../sql-errors.js';
import { columnName, quoteMysqlIdentifier } from '../sql-naming.js';
import { schemaHash, shortName, tableName } from '../sql-schema.shared.js';
import type { MysqlVariant } from './mysql-session.js';

/**
 * The MySQL 8.4 / MariaDB 11.8 schema a model descriptor asks for (plan phase 6) — pure, no database; the counterpart
 * of `postgres-schema.compiler.ts`. The migrator (`mysql-schema.migrator.ts`) compares it with the catalog.
 *
 * Mapping, chosen so the same data answers alike on every database:
 * - table and `id` as on PostgreSQL; every column but `id` nullable — validation enforces `required`, not the database
 * - strings compare byte-wise (`utf8mb4_bin`), as MongoDB compares them. A string that is part of an index is
 *   `varchar(255)` — MySQL indexes no unbounded text — and a longer value is refused (400), never cut; any other
 *   string is `longtext`. Ids and references are indexed strings
 * - arrays, embedded objects and undeclared content → `json` (MariaDB: `longtext` with a JSON check)
 * - a unique index treats a missing value as a value, as a non-sparse MongoDB unique index does: a virtual column
 *   `IFNULL(column, CHAR(0))` carries the index for a string column. MySQL and MariaDB have no `NULLS NOT DISTINCT`
 * - no row-level security: neither database has it. Tenant isolation is the store's (plan §3.4)
 * - a `roles` column refuses system roles with a CHECK on its JSON text, the store's storage rule as a database floor
 */

export interface MysqlDesiredColumn {
  /** SQL default (a literal, or an expression in parentheses) */
  default?: string;
  /** Generation expression of a virtual column */
  generated?: string;
  /** Holds JSON: declared as `json` (MariaDB: an alias of longtext with a validity check) */
  json?: boolean;
  name: string;
  primaryKey: boolean;
  /** Column name the field had before (`renamedFrom`) */
  renamedFrom?: string;
  /** Type as the catalog reports it, normalised (`mysqlCatalogType()`) — `utf8mb4_bin` for every text type */
  type: string;
}

export interface MysqlDesiredIndex {
  create: string;
  name: string;
  /** The virtual null-sentinel columns a unique index reads — added together with the index */
  sentinels?: string[];
  unique: boolean;
}

export interface MysqlDesiredCheck {
  expression: string;
  name: string;
}

export interface MysqlDesiredTable {
  checks: MysqlDesiredCheck[];
  columns: MysqlDesiredColumn[];
  indexes: MysqlDesiredIndex[];
  model: ModelDescriptor;
  name: string;
  /** What the model declares but the table cannot carry, reported once */
  notices: string[];
}

/** Text types whose collation is `utf8mb4_bin` */
const TEXT_TYPES = new Set(['char(36)', 'longtext', 'varchar(255)']);
/** Kinds stored as strings — the null sentinel of a unique index is a string */
const STRING_KINDS = new Set(['enum', 'id', 'ref', 'string', 'uuid']);
/** Prefix of the virtual columns that carry a unique index's null sentinel */
export const NULL_SENTINEL_PREFIX = 'lt_nn_';
/** InnoDB's limit for the columns of one index, in bytes (utf8mb4: four per character) */
const MAX_INDEX_BYTES = 3072;
const INDEX_BYTES: Record<string, number> = {
  bigint: 8,
  'char(36)': 144,
  'datetime(3)': 8,
  'decimal(65,30)': 30,
  double: 8,
  'tinyint(1)': 1,
  'varchar(255)': 1020,
};

/**
 * A role value that starts with `s_` after leading whitespace, case-insensitive, in the JSON text of the column:
 * an item starts after `"`, and leading whitespace may be raw or a JSON escape. A value containing `\"s_` is refused
 * too — a false refusal is fixed by renaming, a false acceptance is a silent authorization hole.
 */
const SYSTEM_ROLE_PATTERN =
  '"([[:space:]\\x{a0}\\x{1680}\\x{2000}-\\x{200a}\\x{2028}\\x{2029}\\x{202f}\\x{205f}\\x{3000}\\x{feff}]|\\\\[tnrfbv]|\\\\u[0-9a-f]{4})*s_';

export function desiredMysqlTable(model: ModelDescriptor, variant: MysqlVariant): MysqlDesiredTable {
  const name = tableName(model);
  const notices: string[] = [];
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

  const indexes = [...model.indexes];
  if (model.tenantScoped && model.fields.tenantId && !indexes.some((index) => 'tenantId' in index.fields)) {
    // The predicate the store adds to every query needs an index, as the tenant plugin's does on MongoDB
    indexes.push({ fields: { tenantId: 1 }, options: {} });
  }
  // Only an index that is created bounds a string column: a text index or a path inside an object never becomes one
  const indexed = new Set<string>();
  for (const index of indexes) {
    const entries = Object.entries(index.fields);
    if (entries.every(([path, direction]) => typeof direction === 'number' && !path.includes('.'))) {
      for (const [path] of entries) {
        indexed.add(path);
      }
    }
  }

  const columns: MysqlDesiredColumn[] = Object.values(model.fields).map((field) =>
    desiredColumn(field, variant, indexed.has(field.name)),
  );
  if (!columns.some((column) => column.primaryKey)) {
    columns.unshift({ name: 'id', primaryKey: true, type: 'varchar(255)' });
  }

  const checks: MysqlDesiredCheck[] = [];
  const roles = model.fields.roles;
  if (roles?.isArray && (roles.kind === 'string' || roles.kind === 'enum')) {
    checks.push({
      expression: `\`roles\` IS NULL OR NOT (LOWER(\`roles\`) REGEXP ${mysqlLiteral(SYSTEM_ROLE_PATTERN)})`,
      name: shortName('ck', name, ['roles', 'no_system_roles']),
    });
  }

  const tableIndexes: MysqlDesiredIndex[] = [];
  for (const index of indexes) {
    const result = desiredIndexes(model, name, index, columns);
    if (typeof result === 'string') {
      notices.push(
        `${model.name}: index ${JSON.stringify(index.fields)} is not created on ${variantLabel(variant)} (${result})`,
      );
    } else {
      tableIndexes.push(...result);
    }
  }
  return { checks, columns, indexes: tableIndexes, model, name, notices };
}

export function variantLabel(variant: MysqlVariant): string {
  return variant === 'mysql' ? 'MySQL' : 'MariaDB';
}

function desiredColumn(field: FieldDescriptor, variant: MysqlVariant, indexed: boolean): MysqlDesiredColumn {
  const name = columnName(field.name);
  if (name === 'id') {
    return { name, primaryKey: true, type: 'varchar(255)' };
  }
  const type = columnType(field, indexed);
  const column: MysqlDesiredColumn =
    type === 'json'
      ? { json: true, name, primaryKey: false, type: variant === 'mysql' ? 'json' : 'longtext' }
      : { name, primaryKey: false, type };
  const fallback = field.isArray ? [] : undefined;
  const value = 'default' in field ? field.default : fallback;
  if (value !== undefined) {
    column.default = defaultValue(column, variant, value);
  }
  if (field.renamedFrom) {
    column.renamedFrom = columnName(field.renamedFrom);
  }
  return column;
}

/** The column type; `json` for JSON content on both servers (`desiredColumn()` maps it to MariaDB's longtext) */
function columnType(field: FieldDescriptor, indexed: boolean): string {
  if (field.isArray) {
    return 'json';
  }
  const text = indexed ? 'varchar(255)' : 'longtext';
  switch (field.kind) {
    case 'bigint':
      return 'bigint';
    case 'boolean':
      return 'tinyint(1)';
    case 'buffer':
      return 'longblob';
    case 'date':
      return 'datetime(3)';
    case 'decimal':
      return 'decimal(65,30)';
    case 'enum':
      return field.enumBase === 'number' ? 'double' : text;
    case 'id':
    case 'ref':
      return 'varchar(255)';
    case 'number':
      return 'double';
    case 'string':
      return text;
    case 'uuid':
      return 'char(36)';
    default:
      return 'json';
  }
}

function defaultValue(column: MysqlDesiredColumn, variant: MysqlVariant, value: unknown): string | undefined {
  const type = column.type;
  if (value === null) {
    return undefined;
  }
  if (column.json) {
    // MySQL allows a JSON column only an expression default
    return variant === 'mysql'
      ? `(CAST(${mysqlLiteral(JSON.stringify(value))} AS JSON))`
      : mysqlLiteral(JSON.stringify(value));
  }
  if (type === 'datetime(3)') {
    return value instanceof Date ? mysqlLiteral(value) : undefined;
  }
  if (
    typeof value === 'string' ||
    typeof value === 'number' ||
    typeof value === 'boolean' ||
    typeof value === 'bigint'
  ) {
    // A literal default on a TEXT column is an expression on MySQL
    return type === 'longtext' && variant === 'mysql' ? `(${mysqlLiteral(value)})` : mysqlLiteral(value);
  }
  // Anything else (an ObjectId, a class instance) is applied by the store when it writes
  return undefined;
}

/** A `CREATE INDEX` for a declared index, or the reason it cannot be one */
/**
 * The `CREATE INDEX` statements for a declared index, or the reason it cannot be one. A unique index that reads null
 * sentinels comes with a lookup index over the plain columns: a filter compares the column, never `IFNULL(column, …)`,
 * so without it every lookup by that field scans — and `updateOne()` / `deleteOne()` lock — the whole table
 */
function desiredIndexes(
  model: ModelDescriptor,
  table: string,
  index: IndexDescriptor,
  columns: MysqlDesiredColumn[],
): MysqlDesiredIndex[] | string {
  const entries = Object.entries(index.fields);
  const special = entries.find(([, direction]) => typeof direction !== 'number');
  if (special) {
    return `${String(special[1])} indexes have no counterpart`;
  }
  const unique = index.options.unique === true;
  const sparse = index.options.sparse === true;
  const partial = index.options.partialFilterExpression as Record<string, unknown> | undefined;
  if (unique && partial) {
    return 'a partial unique index has no counterpart — uniqueness is checked nowhere, enforce it in the service';
  }

  const parts: { base: string; bytes: number; column: string; order: string; text: boolean }[] = [];
  for (const [path, direction] of entries) {
    if (path.includes('.')) {
      return 'an index on a path inside an embedded object';
    }
    const field = model.fields[path === 'id' ? '_id' : path];
    if (!field) {
      throw new UnsupportedQueryError(`${model.name}: index on unknown field "${path}"`);
    }
    const column = columns.find((candidate) => candidate.name === columnName(field.name))!;
    if (column.json || column.type === 'longtext' || column.type === 'longblob') {
      // An indexed string is varchar(255) by construction; what is left is JSON (MariaDB: longtext) or binary
      return 'an index over an array, JSON or binary field';
    }
    let target = column.name;
    if (unique && !sparse && !column.primaryKey && STRING_KINDS.has(field.kind) && !field.isArray) {
      // A missing value is a value of its own, as in MongoDB: the index reads it from a virtual column
      target = nullSentinelColumn(column, columns);
    }
    parts.push({
      base: column.name,
      bytes: INDEX_BYTES[column.type] ?? 1020,
      column: target,
      order: (direction as number) < 0 ? ' DESC' : '',
      text: column.type === 'varchar(255)',
    });
  }
  // Over InnoDB's key limit (four text fields and more): a lookup index indexes a prefix of each text column — it
  // finds the same rows, only less selectively. A unique index cannot: on a prefix it would refuse distinct values
  const total = parts.reduce((sum, part) => sum + part.bytes, 0);
  let prefix = '';
  if (total > MAX_INDEX_BYTES) {
    const textParts = parts.filter((part) => part.text);
    if (unique || !textParts.length) {
      throw new UnsupportedQueryError(
        `${model.name}: the ${unique ? 'unique ' : ''}index ${JSON.stringify(index.fields)} needs ${total} bytes, more than ` +
          `the ${MAX_INDEX_BYTES} MySQL and MariaDB allow for one index — index fewer text fields together`,
      );
    }
    const fixed = parts.filter((part) => !part.text).reduce((sum, part) => sum + part.bytes, 0);
    prefix = `(${Math.floor((MAX_INDEX_BYTES - fixed) / (4 * textParts.length))})`;
  }
  // A sparse or partial index includes rows without a value — harmless for a non-unique index, and for a sparse
  // unique one MySQL's own NULL handling is MongoDB's sparse behaviour
  const name = shortName(unique ? 'ux' : 'ix', table, [
    ...entries.map(([path]) => path.replace(/\./g, '_')),
    schemaHash(JSON.stringify({ fields: index.fields, partial, sparse, unique })),
  ]);
  const columnsSql = (column: 'base' | 'column') =>
    parts.map((part) => `${quoteMysqlIdentifier(part[column])}${part.text ? prefix : ''}${part.order}`).join(', ');
  const sentinels = parts.filter((part) => part.column !== part.base).map((part) => part.column);
  const result: MysqlDesiredIndex[] = [
    {
      create: `CREATE ${unique ? 'UNIQUE ' : ''}INDEX ${quoteMysqlIdentifier(name)} ON ${quoteMysqlIdentifier(table)} (${columnsSql('column')})`,
      name,
      ...(sentinels.length ? { sentinels } : {}),
      unique,
    },
  ];
  if (sentinels.length) {
    const lookup = shortName('ix', table, [
      ...entries.map(([path]) => path),
      schemaHash(JSON.stringify({ fields: index.fields, lookup: true })),
    ]);
    result.push({
      create: `CREATE INDEX ${quoteMysqlIdentifier(lookup)} ON ${quoteMysqlIdentifier(table)} (${columnsSql('base')})`,
      name: lookup,
      unique: false,
    });
  }
  return result;
}

/** The virtual column carrying `column`'s null sentinel, added to `columns` once */
function nullSentinelColumn(column: MysqlDesiredColumn, columns: MysqlDesiredColumn[]): string {
  const name = `${NULL_SENTINEL_PREFIX}${column.name}`.slice(0, 63);
  if (!columns.some((candidate) => candidate.name === name)) {
    columns.push({
      generated: `IFNULL(${quoteMysqlIdentifier(column.name)}, CHAR(0 USING utf8mb4))`,
      name,
      primaryKey: false,
      type: column.type,
    });
  }
  return name;
}

// -- statements ---------------------------------------------------------------------------------------------

export function createMysqlTableStatement(table: MysqlDesiredTable): string {
  const definitions = table.columns.map(mysqlColumnDefinition);
  for (const check of table.checks) {
    definitions.push(`CONSTRAINT ${quoteMysqlIdentifier(check.name)} CHECK (${check.expression})`);
  }
  return `CREATE TABLE ${quoteMysqlIdentifier(table.name)} (\n  ${definitions.join(',\n  ')}\n) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin`;
}

export function mysqlColumnDefinition(column: MysqlDesiredColumn): string {
  // MariaDB's json is an alias of longtext with a validity check and a binary collation; MySQL's has no collation
  const type = column.json ? 'json' : column.type;
  const collation = !column.json && TEXT_TYPES.has(column.type) ? ' COLLATE utf8mb4_bin' : '';
  if (column.generated) {
    return `${quoteMysqlIdentifier(column.name)} ${type}${collation} GENERATED ALWAYS AS (${column.generated}) VIRTUAL`;
  }
  const key = column.primaryKey ? ' NOT NULL PRIMARY KEY' : '';
  const fallback = column.default ? ` DEFAULT ${column.default}` : '';
  return `${quoteMysqlIdentifier(column.name)} ${type}${collation}${key}${fallback}`;
}

export function addMysqlCheckStatement(table: string, check: MysqlDesiredCheck): string {
  return `ALTER TABLE ${quoteMysqlIdentifier(table)} ADD CONSTRAINT ${quoteMysqlIdentifier(check.name)} CHECK (${check.expression})`;
}

/**
 * A MySQL string literal. Only values the code declares reach it — schema options, never request data. Backslashes
 * are escaped: the session never sets `NO_BACKSLASH_ESCAPES` (`mysql-session.ts`)
 */
export function mysqlLiteral(value: unknown): string {
  if (value === null || value === undefined) {
    return 'NULL';
  }
  if (typeof value === 'boolean') {
    return value ? '1' : '0';
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw new UnsupportedQueryError('A literal number must be finite');
    }
    return String(value);
  }
  if (typeof value === 'bigint') {
    return value.toString();
  }
  const text = value instanceof Date ? value.toISOString().replace('T', ' ').replace('Z', '') : String(value);
  return `'${[...text].map((char) => MYSQL_ESCAPES[char] ?? char).join('')}'`;
}

const MYSQL_ESCAPES: Record<string, string> = {
  '\0': '\\0',
  '\b': '\\b',
  '\t': '\\t',
  '\n': '\\n',
  '\r': '\\r',
  '\x1a': '\\Z',
  "'": "\\'",
  '\\': '\\\\',
};
