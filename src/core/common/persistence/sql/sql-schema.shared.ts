import { defaultCollectionName } from '../mongo/collection-name.js';
import type { FieldDescriptor, ModelDescriptor } from '../model-descriptor.interface.js';
import { columnName } from './sql-naming.js';

/**
 * The dialect-free half of the SQL schema (plan §3.12): how a model names its table and the framework names its
 * indexes and constraints, the lease table every SQL schema carries, and how a schema change is reported. The
 * PostgreSQL and MySQL / MariaDB compilers share it, so a model has one table name on every SQL database.
 */

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

/**
 * The table of a model: the collection MongoDB would use, in snake_case. A hyphen becomes an underscore (`s3-files` →
 * `s3_files`): MongoDB allows it in a collection name, SQL not in an unquoted identifier
 */
export function tableName(model: ModelDescriptor): string {
  const collection = model.collection ?? defaultCollectionName(model.name);
  return columnName(collection.replace(/-/g, '_'));
}

/** `prefix_table__parts`, shortened with a hash when it would exceed Postgres' 63-character identifier limit */
export function shortName(prefix: string, table: string, parts: string[]): string {
  const full = `${prefix}_${table}__${parts.join('_')}`;
  return full.length <= 63 ? full : `${full.slice(0, 54)}_${schemaHash(full)}`;
}

/** FNV-1a, 8 hex characters: a stable short name for a definition */
export function schemaHash(text: string): string {
  let value = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    value ^= text.charCodeAt(i);
    value = Math.imul(value, 0x01000193) >>> 0;
  }
  return value.toString(16).padStart(8, '0');
}

export type SchemaChangeKind = 'automatic' | 'migration' | 'notice';

export interface SchemaChange {
  description: string;
  kind: SchemaChangeKind;
  /** What would apply it (for `migration`: the suggestion `migrate:create --sql` writes) */
  statements: string[];
  table?: string;
}

export class SchemaMigrationRequiredError extends Error {
  override readonly name = 'SchemaMigrationRequiredError';

  constructor(readonly changes: SchemaChange[]) {
    super(
      `The database schema needs changes that are never applied automatically:\n${changes
        .map(
          (change) =>
            `  - ${change.description}${change.statements.map((statement) => `\n      suggested: ${statement}`).join('')}`,
        )
        .join('\n')}\n` +
        'Write a migration for them (`migrate create <name> --sql`), review the suggested statements — they may ' +
        'rewrite or reject stored rows — and run it before this version starts.',
    );
  }
}

export class SchemaOutOfDateError extends Error {
  override readonly name = 'SchemaOutOfDateError';

  constructor(readonly changes: SchemaChange[]) {
    super(
      `The database schema is not up to date and no owner connection is configured to update it:\n${changes.map((change) => `  - ${change.description}`).join('\n')}\n` +
        'Configure `database.ownerUrl` (the role that owns the tables) or apply the changes with the migration runner.',
    );
  }
}

export class UnsafeDatabaseRoleError extends Error {
  override readonly name = 'UnsafeDatabaseRoleError';
}
