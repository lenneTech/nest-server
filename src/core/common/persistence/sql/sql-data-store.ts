import { BadRequestException, ForbiddenException, Logger } from '@nestjs/common';

import { ConfigService } from '../../services/config.service.js';
import type {
  DataStore,
  DataStoreUpdate,
  FindOptions,
  PushOptions,
  StoreCapabilities,
  StoredRecord,
  UpdateOptions,
  Where,
} from '../data-store.interface.js';
import { generateId, isWellFormedId } from '../id-format.js';
import type { FieldDescriptor, ModelDescriptor } from '../model-descriptor.interface.js';
import { resolveAuditActorId, stampAuditOnUpdate, stampAuditOnWrite } from '../policies/audit.policy.js';
import { hashPassword, hashUpdatePassword } from '../policies/password.policy.js';
import { isRoleChangeAllowed, stripRoleChanges, updateChangesRoles } from '../policies/role-guard.policy.js';
import { assertNoSystemRoles, assertUpdateHasNoSystemRoles } from '../policies/system-role.policy.js';
import {
  assertOwnTenant,
  assertRowsInTenantScope,
  resolveSingleTenantId,
  resolveTenantFilter,
  resolveTenantScope,
} from '../policies/tenant.policy.js';
import { assertAccessReason, assertArrayField, assertProjection, assertSelectFields } from '../store-guards.js';
import { tableName } from './postgres/postgres-schema.compiler.js';
import { compilePostgresUpdate, pullExpression } from './postgres/postgres-update.compiler.js';
import { compilePostgresPath, compilePostgresWhere } from './postgres/postgres-where.compiler.js';
import { castFilterValue } from './sql-cast.js';
import { DuplicateKeyError, UnsupportedQueryError } from './sql-errors.js';
import type { SqlExecutor, SqlStatement } from './sql-executor.interface.js';
import { columnName, quoteIdentifier, SqlParams } from './sql-naming.js';

/** What PostgreSQL offers through the SQL store (plan §3.6) */
export const POSTGRES_STORE_CAPABILITIES: Readonly<StoreCapabilities> = Object.freeze({
  aggregatePipeline: false,
  changeFeed: false,
  gridfs: false,
  idType: 'objectId',
  mongoosePopulate: false,
  rawFilterArm: false,
  rls: true,
  textSearch: false,
  transactions: true,
});

export interface SqlDataStoreOptions {
  /**
   * The model's Mongoose schema, when there is one: computes the defaults a descriptor cannot carry (functions such
   * as `Date.now`). Literal defaults come from the column defaults.
   */
  schema?: { path(name: string): any };
}

const SCALAR_KINDS = new Set([
  'bigint',
  'boolean',
  'buffer',
  'date',
  'decimal',
  'enum',
  'id',
  'number',
  'ref',
  'string',
  'uuid',
]);

/**
 * How often `updateOne` tries again when its chosen row stopped matching before the write while another one still
 * matches. The locking sub-select already skips such rows, so a retry is the rare case; the bound keeps a filter that
 * concurrent writers keep invalidating from looping forever.
 */
const UPDATE_ONE_ATTEMPTS = 3;

/**
 * The SQL data store: the neutral port over one table (plan §3.1).
 *
 * The same three layers as on MongoDB (§3.4) — the policies the Mongoose plugins call run here BEFORE every statement
 * (tenant filter and stamping, foreign-tenant refusal and safety net, audit fields, password hashing, role guard,
 * system roles), row-level security binds the statement in the database, and the tenant row check runs AFTER every
 * read. Statements are compiled by the framework and executed per operation in their own transaction with the
 * request's tenant scope (§3.8), so the engine behind the executor cannot change what an operation does.
 *
 * Records look like the MongoDB store's: the id as a string under `id`, no `_id`, and a field that is NULL in the
 * table is absent from the record — SQL cannot tell a stored null from an absent value.
 */
export class SqlDataStore<T = Record<string, any>> implements DataStore<T> {
  readonly capabilities = POSTGRES_STORE_CAPABILITIES;
  readonly driver = 'postgres';
  protected readonly logger = new Logger(SqlDataStore.name);
  protected readonly table: string;
  /** column → field */
  protected readonly fields = new Map<string, FieldDescriptor>();
  private collationWarned = false;

  constructor(
    protected readonly executor: SqlExecutor,
    protected readonly model: ModelDescriptor,
    protected readonly options: SqlDataStoreOptions = {},
  ) {
    this.table = quoteIdentifier(tableName(model));
    for (const field of Object.values(model.fields)) {
      this.fields.set(columnName(field.name), field);
    }
  }

  get modelName(): string {
    return this.model.name;
  }

  // -- reads ----------------------------------------------------------------------------------------------

  async count(where?: Where<T>): Promise<number> {
    const params = new SqlParams();
    const { rows } = await this.run<{ n: number }>({
      params: params.values,
      text: `SELECT count(*)::int AS n FROM ${this.table} WHERE ${this.where(where, params)}`,
    });
    return rows[0].n;
  }

  async sum(field: string, where?: Where<T>): Promise<{ count: number; sum: number }> {
    assertSelectFields([field]);
    const params = new SqlParams();
    const path = compilePostgresPath(this.model, field, params);
    if (path.kind === 'array') {
      throw new UnsupportedQueryError(`sum() needs a single value, "${field}" is an array`);
    }
    // A JSON value counts only when it is a number, as MongoDB's $sum ignores other types
    const value =
      path.kind === 'column'
        ? path.expr
        : `CASE WHEN jsonb_typeof(${path.expr}) = 'number' THEN (${path.expr})::numeric END`;
    const { rows } = await this.run<{ n: number; total: number | string }>({
      params: params.values,
      text: `SELECT count(*)::int AS n, COALESCE(sum(${value}), 0)::float8 AS total FROM ${this.table} WHERE ${this.where(where, params)}`,
    });
    return { count: rows[0].n, sum: Number(rows[0].total) };
  }

  async distinct(field: string, where?: Where<T>): Promise<unknown[]> {
    const params = new SqlParams();
    const path = compilePostgresPath(this.model, field, params);
    const condition = this.where(where, params);
    const text =
      path.kind === 'array'
        ? `SELECT DISTINCT d.v AS v FROM ${this.table}, jsonb_array_elements(CASE WHEN jsonb_typeof(${path.expr}) = 'array' THEN ${path.expr} ELSE '[]'::jsonb END) AS d(v) WHERE ${condition}`
        : `SELECT DISTINCT ${path.expr} AS v FROM ${this.table} WHERE ${condition} AND ${path.expr} IS NOT NULL`;
    const { rows } = await this.run<{ v: unknown }>({ params: params.values, text });
    return rows.map((row) => (path.kind === 'column' && path.field ? this.fromColumn(path.field, row.v) : row.v));
  }

  async find(where?: Where<T>, options: FindOptions = {}): Promise<StoredRecord<T>[]> {
    const params = new SqlParams();
    let text = `SELECT ${this.selectList(options.select, options.exclude)} FROM ${this.table} WHERE ${this.where(where, params)}`;
    text += this.orderBy(options, params);
    if (options.limit !== undefined) {
      text += ` LIMIT ${params.add(nonNegativeInteger(options.limit, 'limit'))}`;
    }
    if (options.skip !== undefined) {
      text += ` OFFSET ${params.add(nonNegativeInteger(options.skip, 'skip'))}`;
    }
    const { rows } = await this.run({ params: params.values, text });
    return this.toRecords(rows, options.select);
  }

  async findById(id: string, options: Pick<FindOptions, 'exclude' | 'select'> = {}): Promise<null | StoredRecord<T>> {
    return this.findOne({ id } as Where<T>, options);
  }

  async findOne(where: Where<T>, options: Omit<FindOptions, 'limit' | 'skip'> = {}): Promise<null | StoredRecord<T>> {
    const [record] = await this.find(where, { ...options, limit: 1 });
    return record ?? null;
  }

  // -- writes ---------------------------------------------------------------------------------------------

  async insert(record: Partial<T>): Promise<StoredRecord<T>> {
    const doc = await this.beforeInsert({ ...(record as Record<string, any>) });
    const params = new SqlParams();
    const columns: string[] = [];
    const values: string[] = [];
    const supplied = doc.id ?? doc._id;
    columns.push('"id"');
    values.push(
      params.add(
        supplied !== undefined && isWellFormedId(String(supplied)) ? String(supplied).toLowerCase() : generateId(),
      ),
    );
    for (const [key, value] of Object.entries(doc)) {
      const field = key === 'id' || key === '_id' ? undefined : this.model.fields[key];
      if (!field || value === undefined) {
        // Like Mongoose in strict mode: a key the model does not declare is not stored
        continue;
      }
      columns.push(quoteIdentifier(columnName(key)));
      values.push(this.toColumn(field, key, value, params));
    }
    const { rows } = await this.run({
      params: params.values,
      text: `INSERT INTO ${this.table} (${columns.join(', ')}) VALUES (${values.join(', ')}) RETURNING ${this.selectList()}`,
    });
    return this.toRecords(rows)[0];
  }

  async updateById(
    id: string,
    update: DataStoreUpdate<T>,
    options: UpdateOptions = {},
  ): Promise<null | StoredRecord<T>> {
    const patch = await this.preparePatch(update, options);
    const params = new SqlParams();
    const assignments = compilePostgresUpdate(this.model, patch, params);
    if (!assignments.length) {
      return this.findById(id);
    }
    const { rows } = await this.run({
      params: params.values,
      text: `UPDATE ${this.table} SET ${assignments.join(', ')} WHERE ${this.where({ id } as Where<T>, params)} RETURNING ${this.selectList()}`,
    });
    return this.toRecords(rows)[0] ?? null;
  }

  async updateOne(where: Where<T>, update: DataStoreUpdate<T>): Promise<null | StoredRecord<T>> {
    const patch = await this.preparePatch(update);
    for (let attempt = 1; ; attempt++) {
      const params = new SqlParams();
      const assignments = compilePostgresUpdate(this.model, patch, params);
      if (!assignments.length) {
        return this.findOne(where);
      }
      // The sub-select locks the row it picks, and a row a concurrent caller changed meanwhile is re-checked and
      // skipped for the next match; the condition is repeated outside so the row provably still matches when it is
      // written — the guarantee of MongoDB's findOneAndUpdate
      const match = this.where(where, params);
      const recheck = this.where(where, params);
      const { rows } = await this.run({
        params: params.values,
        text: `UPDATE ${this.table} SET ${assignments.join(', ')} WHERE "id" = (SELECT "id" FROM ${this.table} WHERE ${match} LIMIT 1 FOR UPDATE) AND ${recheck} RETURNING ${this.selectList()}`,
      });
      if (rows.length) {
        return this.toRecords(rows)[0];
      }
      // Nothing written: nothing matches any more — or the chosen row stopped matching between the pick and the write
      // while another one still does. Only the second is retried
      if (attempt >= UPDATE_ONE_ATTEMPTS || !(await this.exists(where))) {
        return null;
      }
    }
  }

  async deleteById(id: string): Promise<null | StoredRecord<T>> {
    const params = new SqlParams();
    const { rows } = await this.run({
      params: params.values,
      text: `DELETE FROM ${this.table} WHERE ${this.where({ id } as Where<T>, params)} RETURNING ${this.selectList()}`,
    });
    return this.toRecords(rows)[0] ?? null;
  }

  async deleteMany(where: Where<T>): Promise<number> {
    const params = new SqlParams();
    const { rowCount } = await this.run({
      params: params.values,
      text: `DELETE FROM ${this.table} WHERE ${this.where(where, params)}`,
    });
    return rowCount;
  }

  async deleteOne(where: Where<T>): Promise<null | StoredRecord<T>> {
    // Picks and locks one match, and re-checks it at the write — the same guarantee as updateOne()
    const params = new SqlParams();
    const match = this.where(where, params);
    const recheck = this.where(where, params);
    const { rows } = await this.run({
      params: params.values,
      text: `DELETE FROM ${this.table} WHERE "id" = (SELECT "id" FROM ${this.table} WHERE ${match} LIMIT 1 FOR UPDATE) AND ${recheck} RETURNING ${this.selectList()}`,
    });
    return this.toRecords(rows)[0] ?? null;
  }

  async updateMany(where: Where<T>, update: DataStoreUpdate<T>): Promise<number> {
    const patch = await this.preparePatch(update);
    const params = new SqlParams();
    const assignments = compilePostgresUpdate(this.model, patch, params);
    if (!assignments.length) {
      return this.count(where);
    }
    const { rowCount } = await this.run({
      params: params.values,
      text: `UPDATE ${this.table} SET ${assignments.join(', ')} WHERE ${this.where(where, params)}`,
    });
    return rowCount;
  }

  async pushToArray(id: string, field: string, items: readonly unknown[], options: PushOptions = {}): Promise<void> {
    assertArrayField(field, 'pushToArray');
    if (!items.length) {
      return;
    }
    const descriptor = this.arrayField(field, 'pushToArray');
    if (field === 'roles') {
      if (this.roleGuardEnabled() && !isRoleChangeAllowed()) {
        return;
      }
      assertNoSystemRoles(items);
    }
    const params = new SqlParams();
    const column = quoteIdentifier(columnName(field));
    const existing = `COALESCE(${column}, '[]'::jsonb)`;
    const added = `${params.add(JSON.stringify(items.map((item) => this.castItem(descriptor, field, item))))}::jsonb`;

    // MongoDB order: insert at the position, then sort, then slice
    let value = `(${existing} || ${added})`;
    if (options.position !== undefined) {
      const position = integer(options.position, 'position');
      const at = `(CASE WHEN ${params.add(position)}::int < 0 THEN GREATEST(jsonb_array_length(${existing}) + ${params.add(position)}::int, 0) ELSE ${params.add(position)}::int END)`;
      value = `(SELECT COALESCE(jsonb_agg(x.v ORDER BY x.g, x.n), '[]'::jsonb) FROM (SELECT o.v, o.n, CASE WHEN o.n <= ${at} THEN 0 ELSE 2 END AS g FROM jsonb_array_elements(${existing}) WITH ORDINALITY AS o(v, n) UNION ALL SELECT a.v, a.n, 1 FROM jsonb_array_elements(${added}) WITH ORDINALITY AS a(v, n)) AS x)`;
    }
    if (options.sort) {
      value = `(SELECT COALESCE(jsonb_agg(s.v ORDER BY ${this.itemOrder(options.sort, params)}), '[]'::jsonb) FROM jsonb_array_elements(${value}) WITH ORDINALITY AS s(v, n))`;
    }
    if (options.slice !== undefined) {
      const slice = integer(options.slice, 'slice');
      const keep =
        slice < 0
          ? `l.n > jsonb_array_length(${value}) - ${params.add(-slice)}::int`
          : `l.n <= ${params.add(slice)}::int`;
      value = `(SELECT COALESCE(jsonb_agg(l.v ORDER BY l.n), '[]'::jsonb) FROM jsonb_array_elements(${value}) WITH ORDINALITY AS l(v, n) WHERE ${keep})`;
    }
    await this.updateColumn(id, column, value, params);
  }

  async pullFromArray(id: string, field: string, condition: unknown): Promise<void> {
    assertArrayField(field, 'pullFromArray');
    this.arrayField(field, 'pullFromArray');
    if (field === 'roles' && this.roleGuardEnabled() && !isRoleChangeAllowed()) {
      return;
    }
    const params = new SqlParams();
    const column = quoteIdentifier(columnName(field));
    await this.updateColumn(id, column, pullExpression(this.model, field, column, condition, params), params);
  }

  // -- native access --------------------------------------------------------------------------------------

  native<N = unknown>(reason: string): N {
    assertAccessReason(reason, 'native');
    this.logger.debug(`Native engine access: ${reason} (Model: ${this.modelName}, engine: ${this.executor.engine})`);
    return this.executor.native<N>();
  }

  raw<N = unknown>(reason: string): N {
    assertAccessReason(reason, 'raw');
    this.logger.warn(`[SECURITY] Raw driver access: ${reason} (Model: ${this.modelName})`);
    return this.executor.driverPool as N;
  }

  // -- before-layer ---------------------------------------------------------------------------------------

  /** The policies the Mongoose plugins apply to `save()`, in their registration order */
  protected async beforeInsert(doc: Record<string, any>): Promise<Record<string, any>> {
    if (this.model.tenantScoped) {
      const tenantId = resolveSingleTenantId(this.modelName);
      if (tenantId) {
        if (doc.tenantId) {
          assertOwnTenant(doc.tenantId, tenantId, true);
        } else {
          doc.tenantId = tenantId;
        }
      }
    }
    this.applyFunctionDefaults(doc);
    if (this.model.fields.password && this.passwordEnabled() && doc.password) {
      doc.password = await hashPassword(doc.password);
    }
    if (this.model.fields.roles && doc.roles !== undefined) {
      if (this.roleGuardEnabled() && !isRoleChangeAllowed()) {
        doc.roles = [];
      }
      assertNoSystemRoles(doc.roles);
    }
    const actor = this.auditEnabled() ? resolveAuditActorId() : undefined;
    if (actor) {
      stampAuditOnWrite(doc, actor, this.auditFields(), true);
    }
    const { createdAt, updatedAt } = this.timestampFields();
    const now = new Date();
    if (createdAt && doc[createdAt] === undefined) {
      doc[createdAt] = now;
    }
    if (updatedAt) {
      doc[updatedAt] = now;
    }
    return doc;
  }

  /** The policies the Mongoose plugins apply to `findOneAndUpdate()` */
  protected async beforeUpdate(update: Record<string, any>, options: UpdateOptions = {}): Promise<Record<string, any>> {
    if (this.model.tenantScoped) {
      const single = resolveSingleTenantId(this.modelName);
      if (single) {
        for (const candidate of [update.tenantId, update.$set?.tenantId, update.$setOnInsert?.tenantId]) {
          if (candidate !== undefined) {
            assertOwnTenant(candidate, single, false);
          }
        }
      }
    }
    if (this.model.fields.password && this.passwordEnabled()) {
      await hashUpdatePassword(update);
    }
    if (this.model.fields.roles) {
      if (this.roleGuardEnabled() && updateChangesRoles(update) && !isRoleChangeAllowed()) {
        stripRoleChanges(update);
      }
      assertUpdateHasNoSystemRoles(update);
    }
    const actor = this.auditEnabled() ? resolveAuditActorId() : undefined;
    if (actor) {
      stampAuditOnUpdate(update, actor, this.auditFields());
    }
    const { updatedAt } = this.timestampFields();
    if (updatedAt && options.timestamps !== false && !hasOperator(update, updatedAt)) {
      update.$set = { ...update.$set, [updatedAt]: new Date() };
    }
    return update;
  }

  /** The update as the store writes it: the caller's object untouched, the policies applied, undeclared paths dropped */
  private async preparePatch(update: DataStoreUpdate<T>, options: UpdateOptions = {}): Promise<Record<string, any>> {
    return this.dropUndeclared(await this.beforeUpdate(clone(update), options));
  }

  /**
   * Like Mongoose in strict mode: an update path whose field the model does not declare is not written. CrudService
   * merges `updatedBy` into every update with a current user, also for a model without that field
   */

  private dropUndeclared(update: Record<string, any>): Record<string, any> {
    const declared = (path: string) => {
      const head = path.split('.', 1)[0];
      // The id stays, so the compiler refuses changing it instead of the update ignoring it
      return head === 'id' || Object.prototype.hasOwnProperty.call(this.model.fields, head);
    };
    for (const [key, value] of Object.entries(update)) {
      if (!key.startsWith('$')) {
        if (!declared(key)) {
          delete update[key];
        }
      } else if (value && typeof value === 'object' && !Array.isArray(value)) {
        for (const path of Object.keys(value)) {
          if (!declared(path)) {
            delete value[path];
          }
        }
      }
    }
    return update;
  }

  // -- statements -----------------------------------------------------------------------------------------

  /** The caller's filter AND the tenant filter; throws the safety net's 403 before any statement runs */
  protected where(where: undefined | Where<T>, params: SqlParams): string {
    const tenantFilter = this.model.tenantScoped ? resolveTenantFilter(this.modelName) : undefined;
    const combined =
      tenantFilter && Object.keys(tenantFilter).length ? { $and: [where ?? {}, tenantFilter] } : (where ?? {});
    return compilePostgresWhere(this.model, combined as Where, params);
  }

  private async exists(where: undefined | Where<T>): Promise<boolean> {
    const params = new SqlParams();
    const { rows } = await this.run<{ found: boolean }>({
      params: params.values,
      text: `SELECT EXISTS (SELECT 1 FROM ${this.table} WHERE ${this.where(where, params)}) AS found`,
    });
    return rows[0].found;
  }

  protected async run<R = Record<string, any>>(statement: SqlStatement): Promise<{ rowCount: number; rows: R[] }> {
    try {
      return await this.executor.run<R>(statement, resolveTenantScope());
    } catch (error) {
      throw this.mapError(error);
    }
  }

  private async updateColumn(id: string, column: string, value: string, params: SqlParams): Promise<void> {
    // The audit and timestamp fields the update hooks stamp, flat or under `$set` — the compiler reads both
    const { $setOnInsert: _insertOnly, ...stamped } = await this.beforeUpdate({});
    const assignments = [`${column} = ${value}`, ...compilePostgresUpdate(this.model, stamped, params)];
    await this.run({
      params: params.values,
      text: `UPDATE ${this.table} SET ${assignments.join(', ')} WHERE ${this.where({ id } as Where<T>, params)}`,
    });
  }

  /** Columns to read: the selected fields (`select: false` fields only when named), the id, and `tenant_id` for the row check */
  protected selectList(select?: readonly string[], exclude?: readonly string[]): string {
    assertProjection({ exclude, select });
    const wanted = new Set(select?.map((name) => (name === '_id' ? 'id' : name)));
    const left = new Set(exclude);
    const columns = new Set<string>(['id']);
    for (const field of Object.values(this.model.fields)) {
      const column = columnName(field.name);
      if (select ? wanted.has(field.name) : field.select !== false && !left.has(field.name)) {
        columns.add(column);
      }
    }
    for (const name of exclude ?? []) {
      if (!this.model.fields[name]) {
        throw new UnsupportedQueryError(`Unknown field "${name}" on ${this.modelName}`);
      }
    }
    if (select) {
      for (const name of wanted) {
        if (name !== 'id' && !this.model.fields[name]) {
          throw new UnsupportedQueryError(`Unknown field "${name}" on ${this.modelName}`);
        }
      }
    }
    if (this.model.tenantScoped) {
      columns.add('tenant_id');
    }
    return [...columns].map(quoteIdentifier).join(', ');
  }

  /** MongoDB sorts a missing value first ascending and last descending; the id breaks ties so paging is stable */
  private orderBy(options: FindOptions, params: SqlParams): string {
    if (options.collation && !this.collationWarned) {
      this.collationWarned = true;
      this.logger.warn(`${this.modelName}: a collation is not applied on PostgreSQL; strings compare byte-wise`);
    }
    const parts: string[] = [];
    for (const [path, direction] of Object.entries(options.sort ?? {})) {
      if (direction !== 1 && direction !== -1) {
        throw new UnsupportedQueryError(`sort direction for "${path}" must be 1 or -1`);
      }
      const { expr, kind } = compilePostgresPath(this.model, path, params);
      if (kind === 'array') {
        throw new UnsupportedQueryError(`sort by the array field "${path}"`);
      }
      parts.push(`${expr} ${direction === 1 ? 'ASC NULLS FIRST' : 'DESC NULLS LAST'}`);
    }
    if (!parts.length && options.skip === undefined && options.limit === undefined) {
      return '';
    }
    if (!Object.keys(options.sort ?? {}).some((path) => path === 'id' || path === '_id')) {
      parts.push('"id" ASC');
    }
    return ` ORDER BY ${parts.join(', ')}`;
  }

  private itemOrder(sort: Record<string, -1 | 1> | number, params: SqlParams): string {
    if (typeof sort === 'number') {
      return `s.v ${sort === -1 ? 'DESC' : 'ASC'}, s.n`;
    }
    return [
      ...Object.entries(sort).map(([path, direction]) => {
        const segments = path.split('.');
        return `(s.v #> ${params.add(segments)}::text[]) ${direction === -1 ? 'DESC' : 'ASC'}`;
      }),
      's.n',
    ].join(', ');
  }

  // -- values ---------------------------------------------------------------------------------------------

  /** A value bound for a column: typed, or jsonb for arrays, objects and undeclared content */
  private toColumn(field: FieldDescriptor, path: string, value: unknown, params: SqlParams): string {
    if (value === null || value === undefined) {
      return 'NULL';
    }
    if (field.isArray) {
      const items = Array.isArray(value) ? value : [value];
      return `${params.add(JSON.stringify(items.map((item) => this.castItem(field, path, item))))}::jsonb`;
    }
    if (SCALAR_KINDS.has(field.kind)) {
      return params.add(castFilterValue(field, path, value));
    }
    return `${params.add(JSON.stringify(value))}::jsonb`;
  }

  private castItem(field: FieldDescriptor, path: string, item: unknown): unknown {
    const element = { ...field, isArray: false };
    return SCALAR_KINDS.has(element.kind) ? castFilterValue(element, path, item) : item;
  }

  private fromColumn(field: FieldDescriptor, value: unknown): unknown {
    if (value === null || value === undefined) {
      return undefined;
    }
    if (!field.isArray && field.kind === 'bigint') {
      return BigInt(value as string);
    }
    return value;
  }

  private toRecords(rows: Record<string, any>[], select?: readonly string[]): StoredRecord<T>[] {
    if (this.model.tenantScoped) {
      assertRowsInTenantScope(
        this.modelName,
        rows.map((row) => ({ tenantId: row.tenant_id })),
      );
    }
    const keepTenant = !select || select.includes('tenantId');
    return rows.map((row) => {
      const record: Record<string, any> = { id: row.id };
      for (const [column, value] of Object.entries(row)) {
        const field = this.fields.get(column);
        if (!field || column === 'id' || (column === 'tenant_id' && !keepTenant)) {
          continue;
        }
        const mapped = this.fromColumn(field, value);
        if (mapped !== undefined) {
          record[field.name] = mapped;
        }
      }
      return record as StoredRecord<T>;
    });
  }

  // -- helpers --------------------------------------------------------------------------------------------

  private arrayField(field: string, method: string): FieldDescriptor {
    const descriptor = this.model.fields[field];
    if (!descriptor?.isArray) {
      throw new UnsupportedQueryError(`${method}: "${field}" is not an array field of ${this.modelName}`);
    }
    return descriptor;
  }

  private applyFunctionDefaults(doc: Record<string, any>): void {
    const schema = this.options.schema;
    if (!schema) {
      return;
    }
    for (const field of Object.values(this.model.fields)) {
      // Arrays default to [] through their column default; Mongoose's array default needs a document to run in
      if (
        field.hasDefault &&
        !field.isArray &&
        !('default' in field) &&
        doc[field.name] === undefined &&
        field.name !== '_id'
      ) {
        const value = schema.path(field.name)?.getDefault?.(doc);
        if (value !== undefined) {
          doc[field.name] = value;
        }
      }
    }
  }

  private auditFields(): { createdBy: boolean; updatedBy: boolean } {
    return { createdBy: !!this.model.fields.createdBy, updatedBy: !!this.model.fields.updatedBy };
  }

  private timestampFields(): { createdAt?: string; updatedAt?: string } {
    const timestamps = this.model.timestamps;
    if (!timestamps) {
      return {};
    }
    if (timestamps === true) {
      return { createdAt: 'createdAt', updatedAt: 'updatedAt' };
    }
    return {
      createdAt: timestamps.createdAt || undefined,
      updatedAt: timestamps.updatedAt || undefined,
    };
  }

  private passwordEnabled(): boolean {
    return ConfigService.configFastButReadOnly?.security?.mongoosePasswordPlugin !== false;
  }

  private roleGuardEnabled(): boolean {
    return ConfigService.configFastButReadOnly?.security?.mongooseRoleGuardPlugin !== false;
  }

  private auditEnabled(): boolean {
    return ConfigService.configFastButReadOnly?.security?.mongooseAuditFieldsPlugin !== false;
  }

  /** Postgres errors as the answers the MongoDB path gives for the same situation */
  protected mapError(error: unknown): unknown {
    const code = (error as { code?: unknown })?.code;
    switch (code) {
      case '23505':
        return new DuplicateKeyError(this.modelName);
      case '23514':
        // The roles CHECK is the only check constraint the framework creates
        return new BadRequestException(`${this.modelName}: the value is not allowed`);
      case '42501':
        return new ForbiddenException(
          'Tenant isolation: this data is tenant-scoped and outside the caller’s tenant context',
        );
      default:
        return error;
    }
  }
}

/**
 * Copies the containers the update policies write into (plain objects, arrays) and keeps every other object as it is.
 * `structuredClone` turned an ObjectId (or any class instance) into a plain object, which the cast then refused
 */
function clone<V>(value: V): V {
  if (Array.isArray(value)) {
    return value.map((item) => clone(item)) as V;
  }
  if (value && typeof value === 'object') {
    const proto = Object.getPrototypeOf(value);
    if (proto === Object.prototype || proto === null) {
      return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, clone(item)])) as V;
    }
  }
  return value;
}

function hasOperator(update: Record<string, any>, field: string): boolean {
  return Object.values(update).some((part) => part && typeof part === 'object' && field in part) || field in update;
}

function integer(value: unknown, name: string): number {
  if (typeof value !== 'number' || !Number.isInteger(value)) {
    throw new UnsupportedQueryError(`${name} must be an integer`);
  }
  return value;
}

function nonNegativeInteger(value: unknown, name: string): number {
  const result = integer(value, name);
  if (result < 0) {
    throw new UnsupportedQueryError(`${name} must not be negative`);
  }
  return result;
}
