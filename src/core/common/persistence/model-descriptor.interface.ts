/**
 * Database-neutral description of a persisted model.
 *
 * The SQL side builds tables, columns, indexes and value mappings from these descriptors; the
 * parity matrix and the Hub read them too. They describe what is STORED, not what the API exposes:
 * a field without a persistence declaration is not part of a descriptor.
 *
 * Import-free on purpose (types only): every persistence file may depend on it without creating an
 * import cycle — see `.claude/rules/architecture.md` → "DI Token Placement (SWC-Safe)".
 */

/**
 * The storage kind of a field.
 *
 * - `enum`: a value from `enumValues`, stored as `enumBase`
 * - `id`: an identifier of this or another record WITHOUT a declared target model
 * - `ref`: an identifier of a record of the model named in `ref`
 * - `object`: an embedded object whose shape is declared (`nested` holds its fields)
 * - `json`: a value whose shape is NOT declared (Mixed, Map, a plain class without `@Schema`)
 */
export type FieldKind =
  | 'bigint'
  | 'boolean'
  | 'buffer'
  | 'date'
  | 'decimal'
  | 'enum'
  | 'id'
  | 'json'
  | 'number'
  | 'object'
  | 'ref'
  | 'string'
  | 'uuid';

export interface FieldDescriptor {
  /** Literal default value; absent when the default is computed (a function) */
  default?: unknown;
  /** Base type of an enum's values */
  enumBase?: 'number' | 'string';
  /** Allowed values of an enum */
  enumValues?: readonly unknown[];
  /** TTL: the record expires this many seconds after the field's date */
  expiresAfterSeconds?: number;
  /** Whether a default exists at all (literal or computed) */
  hasDefault: boolean;
  /** Whether a single-field index exists on this field (declared, unique or TTL) */
  index: boolean;
  /** Whether the field holds a list of `kind` values */
  isArray: boolean;
  kind: FieldKind;
  /** Values are lowercased before they are stored */
  lowercase: boolean;
  name: string;
  /** Fields of an embedded object (`kind: 'object'`) */
  nested?: Record<string, FieldDescriptor>;
  /** Target model of a reference (`kind: 'ref'`) */
  ref?: string;
  /**
   * The field's previous name: a SQL store renames the column instead of adding a new, empty one. Declared, never
   * guessed (plan §3.12) — MongoDB documents keep the old key until a migration moves it.
   */
  renamedFrom?: string;
  required: boolean;
  /** `false` when the field is excluded from reads unless explicitly selected (`select: false`) */
  select: boolean;
  sparse: boolean;
  /** Values are trimmed before they are stored */
  trim: boolean;
  unique: boolean;
}

export interface IndexDescriptor {
  /** Field → direction or index type (`1`, `-1`, `'text'`, …), in declaration order */
  fields: Record<string, number | string>;
  /** Index options as declared (`unique`, `sparse`, `expireAfterSeconds`, `partialFilterExpression`, …) */
  options: Record<string, unknown>;
}

/** The id format of a synchronized model: one per model, never mixed (offline-sync plan §3.5) */
export type SyncIdFormat = 'objectId' | 'uuidv7';

/** How a model is synchronized to offline clients — see `sync-model.ts` */
export interface SyncDescriptor {
  idFormat: SyncIdFormat;
  /** User-id fields a tombstone keeps besides `tenantId` */
  scope: readonly string[];
}

export interface ModelDescriptor {
  /** Explicit collection / table name, when the model declares one */
  collection?: string;
  fields: Record<string, FieldDescriptor>;
  indexes: IndexDescriptor[];
  name: string;
  /** Present when the model is synchronized (`@PersistedModel({ sync })`); absent for every other model */
  sync?: SyncDescriptor;
  /** Whether the model carries a `tenantId` — the same criterion the tenant plugin uses */
  tenantScoped: boolean;
  /** `createdAt` / `updatedAt` maintenance: `true`, `false`, or the configured field names */
  timestamps: boolean | { createdAt: false | string; updatedAt: false | string };
}
