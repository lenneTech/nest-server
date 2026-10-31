import { BadRequestException, Logger } from '@nestjs/common';

import type {
  DataStoreUpdate,
  DeleteOptions,
  FindOptions,
  PushOptions,
  ReadOptions,
  StoreCapabilities,
  StoredRecord,
  UpdateOptions,
  Where,
} from '../../data-store.interface.js';
import type { FieldDescriptor, ModelDescriptor } from '../../model-descriptor.interface.js';
import { isRoleChangeAllowed } from '../../policies/role-guard.policy.js';
import { assertNoSystemRoles } from '../../policies/system-role.policy.js';
import { resolveTenantScope } from '../../policies/tenant.policy.js';
import {
  assertArrayField,
  assertInteger,
  assertNonNegativeInteger,
  assertSampleSize,
  assertSelectFields,
} from '../../store-guards.js';
import { castFilterValue } from '../sql-cast.js';
import { POSTGRES_STORE_CAPABILITIES, SqlDataStore, type SqlDataStoreOptions, type SqlRun } from '../sql-data-store.js';
import { tableName } from '../sql-schema.shared.js';
import { MYSQL_SYNC_COUNTERS } from './mysql-schema.compiler.js';
import { DuplicateKeyError, UnsupportedQueryError } from '../sql-errors.js';
import type { SqlQueryResult, SqlStatement } from '../sql-executor.interface.js';
import { columnName, quoteMysqlIdentifier, SqlParams } from '../sql-naming.js';
import { SCALAR_KINDS, splitPath, toJson } from '../where-shared.js';
import type { MysqlExecutor } from './mysql-executor.js';
import type { MysqlVariant } from './mysql-session.js';
import { compileMysqlUpdate, mysqlArrayOf, mysqlItemText, mysqlPullExpression } from './mysql-update.compiler.js';
import {
  compileMysqlPath,
  compileMysqlWhere,
  mysqlArrayItems,
  mysqlJsonNumber,
  mysqlJsonPath,
  mysqlJsonSortKeys,
  mysqlJsonValue,
} from './mysql-where.compiler.js';

/**
 * What MySQL and MariaDB offer through the SQL store: everything PostgreSQL does except row-level security — neither
 * database has it, so tenant isolation is the store's before-layer and its row check after every read (plan §3.4)
 */
export const MYSQL_STORE_CAPABILITIES: Readonly<StoreCapabilities> = Object.freeze({
  ...POSTGRES_STORE_CAPABILITIES,
  rls: false,
});

/** Error numbers the store answers like MongoDB does */
export const MYSQL_ERRORS = {
  /** A CHECK constraint refused the row: ER_CHECK_CONSTRAINT_VIOLATED on MySQL, ER_CONSTRAINT_FAILED on MariaDB */
  checkFailed: { mariadb: 4025, mysql: 3819 } as Record<MysqlVariant, number>,
  dataTooLong: 1406,
  duplicateEntry: 1062,
} as const;

/** The largest LIMIT, for an OFFSET without one — MySQL has no OFFSET on its own */
const NO_LIMIT = '18446744073709551615';

type Run = <R = Record<string, any>>(statement: SqlStatement) => Promise<SqlQueryResult<R>>;

/**
 * The SQL data store on MySQL 8.4 and MariaDB 11.8 (plan phase 6): the PostgreSQL store's policies and record mapping,
 * with the statements in the MySQL dialect.
 *
 * Neither database has `RETURNING` on every statement, so a write that answers with the record runs in a transaction:
 * the write, then the read of the row it wrote — the row stays locked between the two, so the answer is the state the
 * write produced. `updateOne()` / `deleteOne()` pick their row with `SELECT … FOR UPDATE` in the same transaction, which
 * gives MongoDB's findOneAndUpdate guarantee without a retry.
 */
export class MysqlDataStore<T = Record<string, any>> extends SqlDataStore<T> {
  override readonly driver: string = 'mysql';
  protected override readonly logger = new Logger(MysqlDataStore.name);
  private readonly variant: MysqlVariant;

  constructor(executor: MysqlExecutor, model: ModelDescriptor, options: SqlDataStoreOptions = {}) {
    super(executor, model, options);
    this.variant = executor.variant;
    this.driver = executor.variant;
  }

  protected override baseCapabilities(): Readonly<StoreCapabilities> {
    return MYSQL_STORE_CAPABILITIES;
  }

  /**
   * Every store write of a synchronized model takes its change number last: `FOR UPDATE` locks index gaps here, and an
   * insert waits for them after its BEFORE INSERT trigger ran — a trigger holding the counter meanwhile would deadlock
   * with a multi-row write that locked those gaps and now asks for the counter (measured, DEV-3900 review)
   */
  protected override numbersLast(): boolean {
    return true;
  }

  /** A single-column write (pullFromArray, a one-stage push) — in a transaction, so a synchronized row is numbered */
  protected override async updateColumn(id: string, column: string, value: string, params: SqlParams): Promise<void> {
    if (!this.model.sync) {
      return super.updateColumn(id, column, value, params);
    }
    const { $setOnInsert: _insertOnly, ...stamped } = await this.beforeUpdate({});
    const assignments = [`${column} = ${value}`, ...this.compileUpdate(stamped, params)];
    await this.transaction(async (run) => {
      const { rowCount } = await run({
        params: params.values,
        text: `UPDATE ${this.table} SET ${assignments.join(', ')} WHERE ${this.where({ id } as Where<T>, params)}`,
      });
      if (rowCount) {
        await this.numberPending(run, [id]);
      }
    });
  }

  // -- reads ----------------------------------------------------------------------------------------------

  override async count(where?: Where<T>, options: ReadOptions = {}): Promise<number> {
    const params = new SqlParams();
    const { rows } = await this.run<{ n: number | string }>({
      params: params.values,
      text: `SELECT COUNT(*) AS n FROM ${this.table} WHERE ${this.where(where, params, options)}`,
    });
    return Number(rows[0].n);
  }

  override async sum(field: string, where?: Where<T>): Promise<{ count: number; sum: number }> {
    assertSelectFields([field]);
    const params = new SqlParams();
    const path = compileMysqlPath(this.variant, this.model, field, params);
    if (path.kind === 'array') {
      throw new UnsupportedQueryError(`sum() needs a single value, "${field}" is an array`);
    }
    // A JSON value counts only when it is a number, as MongoDB's $sum ignores other types
    const value = path.kind === 'column' ? path.expr : mysqlJsonNumber(path.expr);
    const { rows } = await this.run<{ n: number | string; total: number | string }>({
      params: params.values,
      text: `SELECT COUNT(*) AS n, COALESCE(SUM(${value}), 0) AS total FROM ${this.table} WHERE ${this.where(where, params)}`,
    });
    return { count: Number(rows[0].n), sum: Number(rows[0].total) };
  }

  override async distinct(field: string, where?: Where<T>, options: ReadOptions = {}): Promise<unknown[]> {
    const params = new SqlParams();
    const path = compileMysqlPath(this.variant, this.model, field, params);
    const condition = this.where(where, params, options);
    if (path.kind === 'array') {
      const { rows } = await this.run<{ v: unknown }>({
        params: params.values,
        text: `SELECT d.v AS v FROM ${this.table}, ${mysqlArrayItems(path.expr, 'd')} WHERE ${condition}`,
      });
      // MariaDB answers a JSON_TABLE item as JSON text; values are compared as JSON, not as their spelling
      return unique(rows.map((row) => (this.variant === 'mariadb' ? parseJsonText(row.v) : (row.v ?? null))));
    }
    const { rows } = await this.run<{ v: unknown }>({
      params: params.values,
      text: `SELECT DISTINCT ${path.expr} AS v FROM ${this.table} WHERE ${condition} AND ${path.expr} IS NOT NULL`,
    });
    return path.kind === 'column' && path.field
      ? rows.map((row) => this.fromColumn(path.field!, row.v))
      : unique(rows.map((row) => row.v));
  }

  override async find(where?: Where<T>, options: FindOptions = {}): Promise<StoredRecord<T>[]> {
    const sample = options.sample === undefined ? undefined : assertSampleSize(options.sample);
    const params = new SqlParams();
    let text = `SELECT ${this.selectList(options.select, options.exclude)} FROM ${this.table} WHERE ${this.where(where, params, options)}`;
    text += this.orderBy(options, params);
    if (options.limit !== undefined) {
      text += ` LIMIT ${params.add(assertNonNegativeInteger(options.limit, 'limit'))}`;
    }
    if (options.skip !== undefined) {
      text += `${options.limit === undefined ? ` LIMIT ${NO_LIMIT}` : ''} OFFSET ${params.add(assertNonNegativeInteger(options.skip, 'skip'))}`;
    }
    if (sample !== undefined) {
      // The page first, then the draw — MongoDB's `$sample` after `$sort`, `$skip` and `$limit`
      text = `SELECT * FROM (${text}) AS \`page\` ORDER BY RAND() LIMIT ${params.add(sample)}`;
    }
    const { rows } = await this.run({ params: params.values, text });
    return this.toRecords(rows, options.select);
  }

  // -- writes ---------------------------------------------------------------------------------------------

  override async insert(record: Partial<T>): Promise<StoredRecord<T>> {
    const doc = await this.beforeInsert({ ...(record as Record<string, any>) });
    return this.withServerId(doc, (prepared) => {
      const params = new SqlParams();
      const { columns, id, values } = this.insertValues(prepared, params);
      return this.transaction(async (run) => {
        await run({
          params: params.values,
          text: `INSERT INTO ${this.table} (${columns.join(', ')}) VALUES (${values.join(', ')})`,
        });
        await this.numberPending(run, [id]);
        return (await this.readById(run, id))!;
      });
    });
  }

  override async updateById(
    id: string,
    update: DataStoreUpdate<T>,
    options: UpdateOptions = {},
  ): Promise<null | StoredRecord<T>> {
    const patch = await this.preparePatch(update, options);
    const params = new SqlParams();
    const assignments = this.compileUpdate(patch, params);
    if (!assignments.length) {
      return this.findById(id, options);
    }
    const condition = this.where({ id } as Where<T>, params, options);
    return this.transaction(async (run) => {
      const { rowCount } = await run({
        params: params.values,
        text: `UPDATE ${this.table} SET ${assignments.join(', ')} WHERE ${condition}`,
      });
      // The driver counts MATCHED rows (CLIENT_FOUND_ROWS), so an update that changes nothing still finds its record
      if (!rowCount) {
        return null;
      }
      await this.numberPending(run, [id]);
      return this.readById(run, id);
    });
  }

  override async updateOne(
    where: Where<T>,
    update: DataStoreUpdate<T>,
    options: UpdateOptions = {},
  ): Promise<null | StoredRecord<T>> {
    const patch = await this.preparePatch(update, options);
    const params = new SqlParams();
    const assignments = this.compileUpdate(patch, params);
    if (!assignments.length) {
      return this.findOne(where, options);
    }
    return this.transaction(async (run) => {
      const id = await this.lockFirst(run, where, options);
      if (id === undefined) {
        return null;
      }
      await run({
        params: params.values,
        text: `UPDATE ${this.table} SET ${assignments.join(', ')} WHERE \`id\` = ${params.add(id)}`,
      });
      await this.numberPending(run, [id]);
      return this.readById(run, id);
    });
  }

  override async deleteById(id: string, options: DeleteOptions = {}): Promise<null | StoredRecord<T>> {
    return this.model.sync && !options.hardDelete
      ? super.deleteById(id, options)
      : this.deleteFirst({ id } as Where<T>, options);
  }

  override async deleteOne(where: Where<T>, options: DeleteOptions = {}): Promise<null | StoredRecord<T>> {
    return this.model.sync && !options.hardDelete ? super.deleteOne(where, options) : this.deleteFirst(where, options);
  }

  override async pushToArray(
    id: string,
    field: string,
    items: readonly unknown[],
    options: PushOptions = {},
  ): Promise<void> {
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
    const variant = this.variant;
    const column = this.quote(columnName(field));
    const json = toJson(items.map((item) => this.castItem(descriptor, field, item)));
    const position = options.position === undefined ? undefined : assertInteger(options.position, 'position');
    const slice = options.slice === undefined ? undefined : assertInteger(options.slice, 'slice');

    // MongoDB order: insert at the position, then sort, then slice. Each stage reads the array `source` holds
    type Stage = (params: SqlParams, source: string) => string;
    const stages: Stage[] = [
      (params, source) => {
        const existing = `COALESCE(${source}, JSON_ARRAY())`;
        const added = mysqlJsonValue(variant, params.add(json));
        if (position === undefined) {
          return `JSON_MERGE_PRESERVE(${existing}, ${added})`;
        }
        const at =
          position < 0 ? `GREATEST(JSON_LENGTH(${existing}) + ${params.add(position)}, 0)` : params.add(position);
        // The items before the position, the new ones, the rest — three arrays rather than one ordered union:
        // MariaDB refuses a derived table that reads the row being updated
        const part = (alias: string, keep: string) =>
          mysqlArrayOf(
            variant,
            mysqlItemText(variant, `${alias}.v`),
            `${alias}.${alias}_n`,
            `${mysqlArrayItems(existing, alias, true)} WHERE ${alias}.${alias}_n ${keep} ${at}`,
          );
        return `JSON_MERGE_PRESERVE(${part('h', '<=')}, ${added}, ${part('t', '>')})`;
      },
    ];
    if (options.sort) {
      const sort = options.sort;
      stages.push((params, source) =>
        mysqlArrayOf(
          variant,
          mysqlItemText(variant, 's.v'),
          this.itemOrder(sort, params),
          mysqlArrayItems(source, 's', true),
        ),
      );
    }
    if (slice !== undefined) {
      stages.push((params, source) =>
        mysqlArrayOf(
          variant,
          mysqlItemText(variant, 'l.v'),
          'l.l_n',
          `${mysqlArrayItems(source, 'l', true)} WHERE ${slice < 0 ? `l.l_n > JSON_LENGTH(${source}) - ${params.add(-slice)}` : `l.l_n <= ${params.add(slice)}`}`,
        ),
      );
    }

    if (stages.length === 1) {
      const params = new SqlParams();
      const value = stages.reduce((source, stage) => stage(params, source), column);
      await this.updateColumn(id, column, value, params);
      return;
    }
    // Several stages: one statement each, in one transaction, every stage reading the column the previous one wrote.
    // Nested into one expression, a stage's JSON_TABLE argument would hold a subquery reading the row being updated —
    // MySQL 8.4 refuses that ("Unknown column … in 'a table function argument'")
    const { $setOnInsert: _insertOnly, ...stamped } = await this.beforeUpdate({});
    await this.transaction(async (run) => {
      for (const [index, stage] of stages.entries()) {
        const params = new SqlParams();
        const assignments = [
          `${column} = ${stage(params, column)}`,
          ...(index === stages.length - 1 ? this.compileUpdate(stamped, params) : []),
        ];
        const { rowCount } = await run({
          params: params.values,
          text: `UPDATE ${this.table} SET ${assignments.join(', ')} WHERE ${this.where({ id } as Where<T>, params)}`,
        });
        if (!rowCount) {
          return;
        }
      }
      await this.numberPending(run, [id]);
    });
  }

  override async pullFromArray(id: string, field: string, condition: unknown): Promise<void> {
    assertArrayField(field, 'pullFromArray');
    this.arrayField(field, 'pullFromArray');
    if (field === 'roles' && this.roleGuardEnabled() && !isRoleChangeAllowed()) {
      return;
    }
    const params = new SqlParams();
    const column = this.quote(columnName(field));
    await this.updateColumn(
      id,
      column,
      mysqlPullExpression(this.variant, this.model, field, column, condition, params),
      params,
    );
  }

  // -- statements -----------------------------------------------------------------------------------------

  protected override quote(name: string): string {
    return quoteMysqlIdentifier(name);
  }

  protected override compileWhere(where: Where, params: SqlParams): string {
    return compileMysqlWhere(this.variant, this.model, where, params);
  }

  protected override compileUpdate(update: DataStoreUpdate, params: SqlParams): string[] {
    return compileMysqlUpdate(this.variant, this.model, update, params);
  }

  /** NULL sorts first ascending and last descending on both servers — MongoDB's order for a missing value */
  protected override orderBy(options: FindOptions, params: SqlParams): string {
    if (options.collation && !this.collationWarned) {
      this.collationWarned = true;
      this.logger.warn(`${this.modelName}: a collation is not applied on MySQL / MariaDB; strings compare byte-wise`);
    }
    const parts: string[] = [];
    for (const [path, direction] of Object.entries(options.sort ?? {})) {
      if (direction !== 1 && direction !== -1) {
        throw new UnsupportedQueryError(`sort direction for "${path}" must be 1 or -1`);
      }
      const { expr, kind } = compileMysqlPath(this.variant, this.model, path, params);
      if (kind === 'array') {
        throw new UnsupportedQueryError(`sort by the array field "${path}"`);
      }
      const order = direction === 1 ? 'ASC' : 'DESC';
      parts.push(...(kind === 'column' ? [`${expr} ${order}`] : mysqlJsonSortKeys(expr, order)));
    }
    if (!parts.length && options.skip === undefined && options.limit === undefined) {
      return '';
    }
    if (!Object.keys(options.sort ?? {}).some((path) => path === 'id' || path === '_id')) {
      parts.push('`id` ASC');
    }
    return ` ORDER BY ${parts.join(', ')}`;
  }

  protected override itemOrder(sort: Record<string, -1 | 1> | number, params: SqlParams): string {
    if (typeof sort === 'number') {
      return [...mysqlJsonSortKeys('s.v', sort === -1 ? 'DESC' : 'ASC'), 's.s_n'].join(', ');
    }
    return [
      ...Object.entries(sort).flatMap(([path, direction]) =>
        mysqlJsonSortKeys(
          `JSON_EXTRACT(s.v, ${params.add(mysqlJsonPath(splitPath(path)))})`,
          direction === -1 ? 'DESC' : 'ASC',
        ),
      ),
      's.s_n',
    ].join(', ');
  }

  // -- values ---------------------------------------------------------------------------------------------

  /** A value bound for a column: typed, or JSON text for arrays, objects and undeclared content */
  protected override toColumn(field: FieldDescriptor, path: string, value: unknown, params: SqlParams): string {
    if (value === null || value === undefined) {
      return 'NULL';
    }
    if (field.isArray) {
      const items = Array.isArray(value) ? value : [value];
      return params.add(toJson(items.map((item) => this.castItem(field, path, item))));
    }
    if (SCALAR_KINDS.has(field.kind)) {
      return params.add(castFilterValue(field, path, value));
    }
    return params.add(toJson(value));
  }

  protected override fromColumn(field: FieldDescriptor, value: unknown): unknown {
    if (value === null || value === undefined) {
      return undefined;
    }
    if (!field.isArray && field.kind === 'boolean') {
      // tinyint(1)
      return value === true || Number(value) === 1;
    }
    if (!field.isArray && field.kind === 'date' && typeof value === 'string') {
      // Drizzle's session reads DATETIME as text; the column holds UTC wall-clock time (`mysql-session.ts`)
      return new Date(`${value.replace(' ', 'T')}Z`);
    }
    if ((field.isArray || field.kind === 'object') && typeof value === 'string') {
      // JSON text the driver did not parse — an array or an object field never holds a string
      return JSON.parse(value);
    }
    return super.fromColumn(field, value);
  }

  /**
   * The counter row of this table (plan §3.4, C1d — MySQL and MariaDB update it in place, so a long snapshot costs no
   * versions): raised by `count` at once, its row lock held until the transaction ends
   */
  protected override async takeChangeNumbers(run: SqlRun, count: number): Promise<string[]> {
    const params = new SqlParams();
    const key = tableName(this.model);
    await run({
      params: params.values,
      text: `UPDATE ${this.quote(MYSQL_SYNC_COUNTERS)} SET \`seq\` = \`seq\` + ${params.add(count)} WHERE \`model\` = ${params.add(key)}`,
    });
    const read = new SqlParams();
    const { rows } = await run<{ seq: number | string }>({
      params: read.values,
      text: `SELECT \`seq\` FROM ${this.quote(MYSQL_SYNC_COUNTERS)} WHERE \`model\` = ${read.add(key)}`,
    });
    const last = BigInt(rows[0].seq);
    return Array.from({ length: count }, (_, index) => (last - BigInt(count - 1 - index)).toString());
  }

  protected override bigintParam(params: SqlParams, value: string): string {
    return params.add(value);
  }

  /**
   * MySQL / MariaDB errors as the answers the MongoDB path gives for the same situation. Matched by error NUMBER and
   * server: the driver names numbers from MySQL's list, and MariaDB's 4025 (a failed CHECK) is another error there
   */
  protected override mapError(error: unknown): unknown {
    const errno = Number((error as { errno?: unknown })?.errno);
    if (errno === MYSQL_ERRORS.duplicateEntry) {
      const message = String((error as { message?: unknown })?.message ?? '');
      return new DuplicateKeyError(this.modelName, /for key '(?:[^']*\.)?PRIMARY'/.test(message));
    }
    if (errno === MYSQL_ERRORS.dataTooLong) {
      return new BadRequestException(`${this.modelName}: a value is longer than its column allows`);
    }
    if (errno === MYSQL_ERRORS.checkFailed[this.variant]) {
      // The roles CHECK is the only check constraint the framework creates
      return new BadRequestException(`${this.modelName}: the value is not allowed`);
    }
    return error;
  }

  // -- helpers --------------------------------------------------------------------------------------------

  /** Run `fn` in one transaction on one connection; a failure rolls everything back and is mapped like `run()` */
  private async transaction<R>(fn: (run: Run) => Promise<R>): Promise<R> {
    const scope = resolveTenantScope();
    try {
      return await this.executor.transaction((tx) => fn((statement) => tx.run(statement, scope)));
    } catch (error) {
      throw this.mapError(error);
    }
  }

  /** The record with this id as stored, without the tenant filter — the caller wrote or locked it in its scope */
  private async readById(run: Run, id: string): Promise<null | StoredRecord<T>> {
    const params = new SqlParams();
    const { rows } = await run({
      params: params.values,
      text: `SELECT ${this.selectList()} FROM ${this.table} WHERE \`id\` = ${params.add(id)}`,
    });
    return this.toRecords(rows)[0] ?? null;
  }

  /** The id of the first match, its row locked until the transaction ends */
  private async lockFirst(
    run: Run,
    where: Where<T>,
    options: { includeTombstones?: boolean } = {},
  ): Promise<string | undefined> {
    const params = new SqlParams();
    const { rows } = await run<{ id: string }>({
      params: params.values,
      text: `SELECT \`id\` FROM ${this.table} WHERE ${this.where(where, params, options)} LIMIT 1 FOR UPDATE`,
    });
    return rows[0]?.id;
  }

  private async deleteFirst(where: Where<T>, options: DeleteOptions = {}): Promise<null | StoredRecord<T>> {
    return this.transaction(async (run) => {
      const params = new SqlParams();
      const { rows } = await run({
        params: params.values,
        text: `SELECT ${this.selectList()} FROM ${this.table} WHERE ${this.where(where, params, options)} LIMIT 1 FOR UPDATE`,
      });
      if (!rows.length) {
        return null;
      }
      // Mapped before the delete: a row outside the tenant scope fails the row check and nothing is deleted
      const [record] = this.toRecords(rows);
      const remove = new SqlParams();
      await run({ params: remove.values, text: `DELETE FROM ${this.table} WHERE \`id\` = ${remove.add(rows[0].id)}` });
      return record;
    });
  }
}

/** JSON text as its value; a value the driver already parsed stays as it is */
function parseJsonText(value: unknown): unknown {
  return typeof value === 'string' ? JSON.parse(value) : (value ?? null);
}

/** Each value once, compared as JSON */
function unique(values: unknown[]): unknown[] {
  const seen = new Set<string>();
  return values.filter((value) => {
    const key = toJson(value);
    return seen.has(key) ? false : (seen.add(key), true);
  });
}
