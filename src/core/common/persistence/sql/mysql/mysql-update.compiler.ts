import type { DataStoreUpdate } from '../../data-store.interface.js';
import type { FieldDescriptor, ModelDescriptor } from '../../model-descriptor.interface.js';
import { castFilterValue } from '../sql-cast.js';
import { UnsupportedQueryError } from '../sql-errors.js';
import { columnName, isPathSegment, quoteMysqlIdentifier, type SqlParamSink } from '../sql-naming.js';
import { SCALAR_KINDS, toJson } from '../where-shared.js';
import type { MysqlVariant } from './mysql-session.js';
import {
  compileMysqlItemCondition,
  compileMysqlPath,
  mysqlArrayItems,
  mysqlJsonPath,
  mysqlJsonValue,
} from './mysql-where.compiler.js';

/**
 * Compiles the neutral update (plan §3.2: a partial record, or `$set $unset $inc $push $addToSet $pull`) into the
 * assignments of a MySQL / MariaDB `UPDATE … SET` — the counterpart of `postgres-update.compiler.ts`, with the same
 * rules: paths resolved against the model descriptor, values cast like Mongoose casts them and bound as parameters, an
 * operator or modifier that cannot be expressed refused, never skipped.
 *
 * One difference, MongoDB's own rule: two operators on one path, or on a path and a path inside it, are refused ("would
 * create a conflict"). PostgreSQL chains them; MySQL would need the column's running value twice per operator, and
 * MongoDB answers such an update with an error anyway. So every column gets ONE expression that reads the stored value:
 * a top-level operator, or one `JSON_SET` / `JSON_REMOVE` over all nested paths of that column.
 */
export function compileMysqlUpdate(
  variant: MysqlVariant,
  model: ModelDescriptor,
  update: DataStoreUpdate,
  params: SqlParamSink,
): string[] {
  return new MysqlUpdateCompiler(variant, model, params).compile(update);
}

/**
 * A JSON array item as the text of a JSON array element: MySQL reads a JSON `null` item of `JSON_TABLE` as SQL NULL,
 * which `GROUP_CONCAT` would drop; MariaDB's items are JSON text already.
 */
export function mysqlItemText(variant: MysqlVariant, item: string): string {
  return variant === 'mysql' ? `IFNULL(CAST(${item} AS CHAR), 'null')` : `IFNULL(${item}, 'null')`;
}

/** The JSON array of the rows `items` (JSON text each) in `order`, `[]` when there are none */
export function mysqlArrayOf(variant: MysqlVariant, items: string, order: string, from: string): string {
  return mysqlJsonValue(
    variant,
    `(SELECT CONCAT('[', COALESCE(GROUP_CONCAT(${items} ORDER BY ${order} SEPARATOR ','), ''), ']') FROM ${from})`,
  );
}

/** Whether two JSON values (items of `JSON_TABLE`) are the same value — object key order does not matter */
export function mysqlSameJson(variant: MysqlVariant, left: string, right: string): string {
  return variant === 'mysql' ? `(${left} <=> ${right})` : `JSON_EQUALS(${left}, ${right})`;
}

/** The array `current` without the items matching `condition` (`$pull` semantics), order kept */
export function mysqlPullExpression(
  variant: MysqlVariant,
  model: ModelDescriptor,
  field: string,
  current: string,
  condition: unknown,
  params: SqlParamSink,
): string {
  const matches = compileMysqlItemCondition(variant, model, field, condition, params, 'p.v');
  return mysqlArrayOf(
    variant,
    mysqlItemText(variant, 'p.v'),
    'p.p_n',
    `${mysqlArrayItems(current, 'p')} WHERE NOT COALESCE(${matches}, FALSE)`,
  );
}

const IGNORED_OPERATORS = new Set(['$setOnInsert']);

/** The nested writes of one JSON column, applied together */
interface NestedWrites {
  /** Paths below the column whose parent objects must exist, as a merge-patch skeleton */
  parents: Record<string, any>;
  removes: string[];
  /** `JSON_SET` pairs: path, value */
  sets: string[];
}

class MysqlUpdateCompiler {
  private readonly assignments = new Map<string, string>();
  private readonly nested = new Map<string, NestedWrites>();
  /** column → the paths written in it, to refuse two writes on one path */
  private readonly touched = new Map<string, string[]>();

  constructor(
    private readonly variant: MysqlVariant,
    private readonly model: ModelDescriptor,
    private readonly params: SqlParamSink,
  ) {}

  compile(update: DataStoreUpdate): string[] {
    if (!update || typeof update !== 'object' || Array.isArray(update)) {
      throw new UnsupportedQueryError('An update must be an object');
    }
    // Mongoose treats plain keys next to operators as `$set`
    const operators: Record<string, Record<string, unknown>> = {};
    const plain: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(update)) {
      if (key.startsWith('$')) {
        operators[key] = value as Record<string, unknown>;
      } else {
        plain[key] = value;
      }
    }
    if (Object.keys(plain).length) {
      operators.$set = { ...plain, ...operators.$set };
    }

    for (const [operator, fields] of Object.entries(operators)) {
      if (IGNORED_OPERATORS.has(operator)) {
        continue;
      }
      if (!fields || typeof fields !== 'object' || Array.isArray(fields)) {
        throw new UnsupportedQueryError(`${operator} needs an object`);
      }
      for (const [path, value] of Object.entries(fields)) {
        // `undefined` means "not given", as Mongoose drops such a key before MongoDB sees it
        if (value === undefined) {
          continue;
        }
        switch (operator) {
          case '$addToSet':
            this.addToSet(path, value);
            break;
          case '$inc':
            this.inc(path, value);
            break;
          case '$pull':
            this.pull(path, value);
            break;
          case '$push':
            this.push(path, value);
            break;
          case '$set':
            this.set(path, value);
            break;
          case '$unset':
            this.unset(path);
            break;
          default:
            throw new UnsupportedQueryError(`${operator} is not supported on SQL`);
        }
      }
    }
    for (const [column, writes] of this.nested) {
      this.assignments.set(column, this.nestedExpression(column, writes));
    }
    return [...this.assignments].map(([column, expression]) => `${quoteMysqlIdentifier(column)} = ${expression}`);
  }

  // -- paths ----------------------------------------------------------------------------------------------

  /** The top-level field of `path` and the segments below it; claims the path for this update */
  private split(path: string): { column: string; field: FieldDescriptor; rest: string[] } {
    const segments = path.split('.');
    if (segments.some((segment) => !isPathSegment(segment))) {
      throw new UnsupportedQueryError(`Invalid path "${path}"`);
    }
    const [head, ...rest] = segments;
    const name = head === 'id' ? '_id' : head;
    const field = Object.prototype.hasOwnProperty.call(this.model.fields, name) ? this.model.fields[name] : undefined;
    if (!field) {
      throw new UnsupportedQueryError(`Unknown field "${head}" on ${this.model.name}`);
    }
    const column = columnName(name);
    if (column === 'id') {
      throw new UnsupportedQueryError('The id of a record cannot be changed');
    }
    if (rest.length) {
      // Validates the path against the descriptor (and refuses one into array items)
      compileMysqlPath(this.variant, this.model, path, { add: () => '?' });
    }
    this.claim(column, [name, ...rest].join('.'));
    return { column, field, rest };
  }

  private claim(column: string, path: string): void {
    const paths = this.touched.get(column) ?? [];
    for (const other of paths) {
      if (other === path || other.startsWith(`${path}.`) || path.startsWith(`${other}.`)) {
        throw new UnsupportedQueryError(`Updating the path "${path}" would create a conflict at "${other}"`);
      }
    }
    paths.push(path);
    this.touched.set(column, paths);
  }

  private writes(column: string): NestedWrites {
    let writes = this.nested.get(column);
    if (!writes) {
      // Without a prototype: the skeleton is built from path segments and must never reach Object.prototype
      writes = { parents: Object.create(null), removes: [], sets: [] };
      this.nested.set(column, writes);
    }
    return writes;
  }

  /** The column's stored value with every nested `$set` / `$inc` / `$unset` applied */
  private nestedExpression(column: string, writes: NestedWrites): string {
    const stored = quoteMysqlIdentifier(column);
    let expr = stored;
    if (writes.sets.length) {
      // A path's parent objects are created like MongoDB creates them; a merge patch of empty objects keeps every
      // existing object as it is
      expr = `COALESCE(${stored}, JSON_OBJECT())`;
      if (Object.keys(writes.parents).length) {
        expr = `JSON_MERGE_PATCH(${expr}, ${mysqlJsonValue(this.variant, this.params.add(toJson(writes.parents)))})`;
      }
      expr = `JSON_SET(${expr}, ${writes.sets.join(', ')})`;
    }
    if (writes.removes.length) {
      expr = `JSON_REMOVE(${expr}, ${writes.removes.join(', ')})`;
    }
    return expr;
  }

  private addParents(writes: NestedWrites, rest: string[]): void {
    let node = writes.parents;
    for (const segment of rest.slice(0, -1)) {
      if (!Object.prototype.hasOwnProperty.call(node, segment)) {
        node[segment] = Object.create(null);
      }
      node = node[segment];
    }
  }

  /** The descriptor of a path below a field, when it is declared */
  private nestedField(field: FieldDescriptor, rest: string[]): FieldDescriptor | undefined {
    let current: FieldDescriptor | undefined = field;
    for (const segment of rest) {
      current = current?.kind === 'object' && !current.isArray ? current.nested?.[segment] : undefined;
    }
    return current;
  }

  // -- values ---------------------------------------------------------------------------------------------

  /** A value for a top-level column: typed, or JSON text for arrays, objects and undeclared content */
  private columnValue(field: FieldDescriptor, path: string, value: unknown): string {
    if (value === null || value === undefined) {
      return 'NULL';
    }
    if (field.isArray) {
      if (!Array.isArray(value)) {
        throw new UnsupportedQueryError(`"${path}" is an array field`);
      }
      return this.params.add(toJson(value.map((item) => this.cast({ ...field, isArray: false }, path, item))));
    }
    if (SCALAR_KINDS.has(field.kind)) {
      return this.params.add(castFilterValue(field, path, value));
    }
    return this.params.add(toJson(value));
  }

  private cast(field: FieldDescriptor | undefined, path: string, value: unknown): unknown {
    return field && !field.isArray && SCALAR_KINDS.has(field.kind) ? castFilterValue(field, path, value) : value;
  }

  private json(value: unknown): string {
    return mysqlJsonValue(this.variant, this.params.add(toJson(value)));
  }

  // -- operators ------------------------------------------------------------------------------------------

  private set(path: string, value: unknown): void {
    const { column, field, rest } = this.split(path);
    if (!rest.length) {
      this.assignments.set(column, this.columnValue(field, path, value));
      return;
    }
    const cast = this.cast(this.nestedField(field, rest), path, value);
    const writes = this.writes(column);
    this.addParents(writes, rest);
    writes.sets.push(this.params.add(mysqlJsonPath(rest)), this.json(cast ?? null));
  }

  private unset(path: string): void {
    const { column, rest } = this.split(path);
    if (!rest.length) {
      this.assignments.set(column, 'NULL');
      return;
    }
    this.writes(column).removes.push(this.params.add(mysqlJsonPath(rest)));
  }

  private inc(path: string, value: unknown): void {
    const { column, field, rest } = this.split(path);
    const amount = castFilterValue({ ...field, enumBase: undefined, isArray: false, kind: 'number' }, path, value);
    if (typeof amount !== 'number') {
      throw new UnsupportedQueryError(`$inc needs a number at "${path}"`);
    }
    const stored = quoteMysqlIdentifier(column);
    if (!rest.length) {
      if (field.isArray || !['bigint', 'decimal', 'number'].includes(field.kind)) {
        throw new UnsupportedQueryError(`$inc on the non-numeric field "${path}"`);
      }
      this.assignments.set(column, `(COALESCE(${stored}, 0) + ${this.params.add(amount)})`);
      return;
    }
    const target = mysqlJsonPath(rest);
    const writes = this.writes(column);
    this.addParents(writes, rest);
    // `+ 0` reads the JSON number as a number on both servers (MariaDB's JSON_EXTRACT answers with text)
    writes.sets.push(
      this.params.add(target),
      `(COALESCE(JSON_EXTRACT(${stored}, ${this.params.add(target)}) + 0, 0) + ${this.params.add(amount)})`,
    );
  }

  /** The items of a `$push` / `$addToSet` value: one item, or the items of `$each` */
  private items(operator: string, path: string, field: FieldDescriptor, value: unknown): unknown[] {
    const isEach =
      value !== null &&
      typeof value === 'object' &&
      !Array.isArray(value) &&
      Object.keys(value).some((key) => key.startsWith('$'));
    if (isEach) {
      const { $each, ...modifiers } = value as Record<string, unknown>;
      if (Object.keys(modifiers).length || !Array.isArray($each)) {
        throw new UnsupportedQueryError(
          `${operator} with modifiers at "${path}" — use pushToArray() for $slice / $position / $sort`,
        );
      }
      return $each.map((item) => this.cast({ ...field, isArray: false }, path, item));
    }
    return [this.cast({ ...field, isArray: false }, path, value)];
  }

  private arrayField(operator: string, path: string): { column: string; field: FieldDescriptor } {
    const { column, field, rest } = this.split(path);
    if (rest.length || !field.isArray) {
      throw new UnsupportedQueryError(`${operator} needs a top-level array field, "${path}" is none`);
    }
    return { column, field };
  }

  private push(path: string, value: unknown): void {
    const { column, field } = this.arrayField('$push', path);
    const items = this.items('$push', path, field, value);
    this.assignments.set(
      column,
      `JSON_MERGE_PRESERVE(COALESCE(${quoteMysqlIdentifier(column)}, JSON_ARRAY()), ${this.json(items)})`,
    );
  }

  private addToSet(path: string, value: unknown): void {
    const { column, field } = this.arrayField('$addToSet', path);
    const seen = new Set<string>();
    const items = this.items('$addToSet', path, field, value).filter((item) => {
      const key = toJson(item);
      return seen.has(key) ? false : (seen.add(key), true);
    });
    const current = `COALESCE(${quoteMysqlIdentifier(column)}, JSON_ARRAY())`;
    // Counted, never EXISTS: see the semi-join note in mysql-where.compiler.ts
    const missing = `(SELECT COUNT(*) FROM ${mysqlArrayItems(current, 'e')} WHERE ${mysqlSameJson(this.variant, 'e.v', 'a.v')}) = 0`;
    const added = mysqlArrayOf(
      this.variant,
      mysqlItemText(this.variant, 'a.v'),
      'a.a_n',
      `${mysqlArrayItems(this.json(items), 'a')} WHERE ${missing}`,
    );
    this.assignments.set(column, `JSON_MERGE_PRESERVE(${current}, ${added})`);
  }

  private pull(path: string, condition: unknown): void {
    const { column } = this.arrayField('$pull', path);
    this.assignments.set(
      column,
      mysqlPullExpression(this.variant, this.model, path, quoteMysqlIdentifier(column), condition, this.params),
    );
  }
}
