import type { Where } from '../../data-store.interface.js';
import type { FieldDescriptor, ModelDescriptor } from '../../model-descriptor.interface.js';
import { castFilterValue } from '../sql-cast.js';
import { QueryCastError, UnsupportedQueryError } from '../sql-errors.js';
import { columnName, quoteMysqlIdentifier, type SqlParamSink } from '../sql-naming.js';
import {
  type BsonType,
  bsonType,
  COLUMN_TYPES,
  COMPARISON,
  type ComparisonOperator,
  isOperatorObject,
  isPlainObject,
  itemOf,
  REGEX_KINDS,
  SCALAR_KINDS,
  splitPath,
  toJson,
} from '../where-shared.js';
import type { MysqlVariant } from './mysql-session.js';

/**
 * Compiles the neutral filter (the Mongo-operator subset of plan §3.2) into a MySQL 8.4 / MariaDB 11.8 condition — the
 * counterpart of `postgres-where.compiler.ts`, with the same three rules: identifiers come from the model descriptor
 * (JSON paths are bound as parameters), every value is a parameter cast with Mongoose's rules, and what cannot be
 * expressed is refused, never dropped. MongoDB's semantics are kept where PostgreSQL keeps them: `null` matches a
 * missing value, `$ne`/`$nin` include missing values, a condition on an array matches when any element matches.
 *
 * Two things differ from PostgreSQL's SQL, both measured on both servers (plan phase 6):
 * - **"Any element matches" is `(SELECT COUNT(*) FROM JSON_TABLE(…)) > 0`, never `EXISTS`.** MySQL 8.4 turns an
 *   `EXISTS` over a `JSON_TABLE` that reads the outer row into a semi-join and then finds NOTHING — silently. Counting
 *   is not rewritten.
 * - **JSON values compare as JSON**: MySQL through `CAST(? AS JSON)` and `=`, MariaDB (no JSON type, no such cast)
 *   through `JSON_EQUALS()`. Strings compare byte-wise (`utf8mb4_bin`), as on MongoDB and PostgreSQL (`COLLATE "C"`).
 */

export interface MysqlWhereOptions {
  /** Table alias to qualify columns with */
  alias?: string;
}

/** A value addressed by a filter path */
type Target =
  /** A scalar column */
  | { expr: string; field: FieldDescriptor; kind: 'column'; path: string }
  /** One JSON value; `field` is its declared descriptor, absent for undeclared (Mixed) content */
  | { expr: string; field?: FieldDescriptor; kind: 'json'; path: string }
  /** A JSON array; `element` describes its items, absent for undeclared (Mixed) content */
  | { element?: FieldDescriptor; expr: string; kind: 'array'; path: string }
  /** A path inside the items of a JSON array of objects: matches when any item matches */
  | { arrayExpr: string; inner: (item: string) => Target; kind: 'elements'; path: string };

/** How each JSON type `JSON_TYPE()` reports belongs to a BSON type (both servers report these names) */
const JSON_TYPES: Partial<Record<BsonType, string[]>> = {
  array: ['ARRAY'],
  bool: ['BOOLEAN'],
  null: ['NULL'],
  number: ['DECIMAL', 'DOUBLE', 'INTEGER', 'UNSIGNED INTEGER'],
  object: ['OBJECT'],
  string: ['STRING'],
};
const NUMBER_TYPES = `('DECIMAL', 'DOUBLE', 'INTEGER', 'UNSIGNED INTEGER')`;

/** The SQL that turns a bound JSON text into a JSON value on each server */
export function mysqlJsonValue(variant: MysqlVariant, placeholder: string): string {
  return variant === 'mysql' ? `CAST(${placeholder} AS JSON)` : `JSON_EXTRACT(${placeholder}, '$')`;
}

/** JSON equality on each server — object key order does not matter, numbers compare by value */
export function mysqlJsonEquals(variant: MysqlVariant, left: string, rightJsonText: string): string {
  return variant === 'mysql'
    ? `${left} = ${mysqlJsonValue(variant, rightJsonText)}`
    : `JSON_EQUALS(${left}, ${rightJsonText})`;
}

/** A JSON value as a number when it is one, NULL for any other type — the cast never runs on another type */
export function mysqlJsonNumber(expr: string): string {
  return `(CASE WHEN JSON_TYPE(${expr}) IN ${NUMBER_TYPES} THEN CAST(JSON_UNQUOTE(${expr}) AS DOUBLE) END)`;
}

/**
 * ORDER BY keys for a JSON value: by type in MongoDB's order (missing or null, numbers, strings, objects, arrays,
 * booleans), then numbers by value and strings byte-wise. Sorting the JSON value itself would compare MariaDB's JSON
 * text as text (`"10"` before `"9"`), and MySQL's JSON order puts strings before numbers.
 */
export function mysqlJsonSortKeys(expr: string, direction: 'ASC' | 'DESC'): string[] {
  const type = `JSON_TYPE(${expr})`;
  return [
    `CASE WHEN ${expr} IS NULL OR ${type} = 'NULL' THEN 0 WHEN ${type} IN ${NUMBER_TYPES} THEN 1 WHEN ${type} = 'STRING' THEN 2 WHEN ${type} = 'OBJECT' THEN 3 WHEN ${type} = 'ARRAY' THEN 4 WHEN ${type} = 'BOOLEAN' THEN 5 ELSE 6 END ${direction}`,
    `${mysqlJsonNumber(expr)} ${direction}`,
    `CASE WHEN ${type} IN ('STRING', 'BOOLEAN') THEN JSON_UNQUOTE(${expr}) END COLLATE utf8mb4_bin ${direction}`,
  ];
}

/** The JSON path of validated segments, as a bound parameter: `$."a"."b"` */
export function mysqlJsonPath(segments: string[]): string {
  return `$${segments.map((segment) => `."${segment}"`).join('')}`;
}

/**
 * The items of a JSON array as a derived table (`<alias>.v`, `<alias>.<alias>_n` = position from 1). Anything that is
 * not an array has none; `isArray` skips that test for an expression that is one by construction. MySQL reports a JSON
 * `null` item as SQL NULL in `v`; the conditions treat both alike.
 */
export function mysqlArrayItems(arrayExpr: string, alias: string, isArray = false): string {
  const array = isArray
    ? arrayExpr
    : `CASE WHEN JSON_TYPE(${arrayExpr}) = 'ARRAY' THEN ${arrayExpr} ELSE JSON_ARRAY() END`;
  return `JSON_TABLE(${array}, '$[*]' COLUMNS (${alias}_n FOR ORDINALITY, v JSON PATH '$')) AS ${alias}`;
}

export function compileMysqlWhere(
  variant: MysqlVariant,
  model: ModelDescriptor,
  where: undefined | Where,
  params: SqlParamSink,
  options: MysqlWhereOptions = {},
): string {
  return new MysqlWhereCompiler(variant, model, params, options.alias).compile(where);
}

/** The SQL expression of a field path, for ORDER BY and DISTINCT: a column, or a JSON value inside one */
export function compileMysqlPath(
  variant: MysqlVariant,
  model: ModelDescriptor,
  path: string,
  params: SqlParamSink,
  options: MysqlWhereOptions = {},
): { expr: string; field?: FieldDescriptor; kind: 'array' | 'column' | 'json' } {
  const target = new MysqlWhereCompiler(variant, model, params, options.alias).target(path);
  switch (target.kind) {
    case 'array':
      return { expr: target.expr, field: target.element, kind: 'array' };
    case 'column':
    case 'json':
      return { expr: target.expr, field: target.field, kind: target.kind };
    default:
      throw new UnsupportedQueryError(`"${path}" addresses the items of an array`);
  }
}

/**
 * The condition `condition` sets for ONE item (`item`, a JSON expression) of the array field `field`, with `$pull`
 * semantics: an operator object applies to the item, a plain object is a query on an object item's fields, anything
 * else (a scalar, a RegExp) is equality.
 */
export function compileMysqlItemCondition(
  variant: MysqlVariant,
  model: ModelDescriptor,
  field: string,
  condition: unknown,
  params: SqlParamSink,
  item: string,
): string {
  return new MysqlWhereCompiler(variant, model, params).itemCondition(field, condition, item);
}

class MysqlWhereCompiler {
  private items = 0;

  constructor(
    private readonly variant: MysqlVariant,
    private readonly model: ModelDescriptor,
    private readonly params: SqlParamSink,
    private readonly alias?: string,
  ) {}

  compile(where: undefined | Where): string {
    return this.conditions(where, (path) => this.resolveField(path));
  }

  target(path: string): Target {
    return this.resolveField(path);
  }

  itemCondition(field: string, condition: unknown, item: string): string {
    const target = this.resolveField(field);
    if (target.kind !== 'array') {
      throw new UnsupportedQueryError(`"${field}" is not an array field of ${this.model.name}`);
    }
    if (isOperatorObject(condition)) {
      return this.field(this.itemTarget(target, item), condition);
    }
    const element = target.element;
    if (isPlainObject(condition) && (!element || element.kind === 'object' || element.kind === 'json')) {
      return this.conditions(condition as Where, (path) =>
        this.descend(
          item,
          [],
          element ? { ...element, isArray: false } : undefined,
          splitPath(path),
          `${field}.${path}`,
        ),
      );
    }
    return this.eq(this.itemTarget(target, item), condition);
  }

  // -- structure ----------------------------------------------------------------------------------------

  private conditions(where: undefined | Where, resolve: (path: string) => Target): string {
    if (where === undefined || where === null) {
      return 'TRUE';
    }
    if (!isPlainObject(where)) {
      throw new UnsupportedQueryError('A filter must be an object');
    }
    const parts: string[] = [];
    for (const [key, value] of Object.entries(where)) {
      if (key === '$and' || key === '$or' || key === '$nor') {
        if (!Array.isArray(value) || !value.length) {
          throw new UnsupportedQueryError(`${key} needs a non-empty array`);
        }
        const inner = value.map((item) => `(${this.conditions(item, resolve)})`);
        const joined = inner.join(key === '$and' ? ' AND ' : ' OR ');
        parts.push(key === '$nor' ? `NOT COALESCE((${joined}), FALSE)` : `(${joined})`);
      } else if (key === '$comment') {
        continue;
      } else if (key.startsWith('$')) {
        throw new UnsupportedQueryError(`${key} is not supported on SQL`);
      } else {
        parts.push(this.field(resolve(key), value));
      }
    }
    return parts.length ? parts.join(' AND ') : 'TRUE';
  }

  private field(target: Target, condition: unknown): string {
    if (!isOperatorObject(condition)) {
      return this.eq(target, condition);
    }
    const parts: string[] = [];
    const operators = condition as Record<string, unknown>;
    for (const [operator, value] of Object.entries(operators)) {
      switch (operator) {
        case '$all':
          parts.push(this.all(target, value));
          break;
        case '$elemMatch':
          parts.push(this.elemMatch(target, value));
          break;
        case '$eq':
          if (value instanceof RegExp) {
            throw new UnsupportedQueryError(`$eq with a regular expression at "${target.path}"`);
          }
          parts.push(this.eq(target, value));
          break;
        case '$exists':
          parts.push(this.exists(target, !!value));
          break;
        case '$gt':
        case '$gte':
        case '$lt':
        case '$lte':
          parts.push(this.compare(target, operator, value));
          break;
        case '$in':
          parts.push(this.in(target, value));
          break;
        case '$ne':
          if (value instanceof RegExp) {
            throw new UnsupportedQueryError(`$ne with a regular expression at "${target.path}"`);
          }
          parts.push(`NOT COALESCE(${this.eq(target, value)}, FALSE)`);
          break;
        case '$nin':
          parts.push(`NOT COALESCE(${this.in(target, value)}, FALSE)`);
          break;
        case '$not':
          if (!(value instanceof RegExp) && !isOperatorObject(value)) {
            throw new UnsupportedQueryError(
              `$not needs a regular expression or an operator object at "${target.path}"`,
            );
          }
          parts.push(`NOT COALESCE(${this.field(target, value)}, FALSE)`);
          break;
        case '$options':
          if (!('$regex' in operators)) {
            throw new UnsupportedQueryError(`$options without $regex at "${target.path}"`);
          }
          break;
        case '$regex': {
          if (operators.$options !== undefined && typeof operators.$options !== 'string') {
            throw new UnsupportedQueryError(`$options must be a string at "${target.path}"`);
          }
          const options = operators.$options as string | undefined;
          if (value instanceof RegExp) {
            parts.push(this.regex(target, value.source, options ?? value.flags));
          } else if (typeof value === 'string') {
            parts.push(this.regex(target, value, options ?? ''));
          } else {
            throw new UnsupportedQueryError(`$regex needs a string or a regular expression at "${target.path}"`);
          }
          break;
        }
        case '$size':
          parts.push(this.size(target, value));
          break;
        case '$type':
          parts.push(this.type(target, value));
          break;
        default:
          throw new UnsupportedQueryError(`${operator} is not supported on SQL`);
      }
    }
    return parts.length === 1 ? parts[0] : `(${parts.join(' AND ')})`;
  }

  // -- paths ----------------------------------------------------------------------------------------------

  private resolveField(path: string): Target {
    const segments = splitPath(path);
    const [head, ...rest] = segments;
    const name = head === 'id' ? '_id' : head;
    const field = Object.prototype.hasOwnProperty.call(this.model.fields, name) ? this.model.fields[name] : undefined;
    if (!field) {
      throw new UnsupportedQueryError(`Unknown field "${head}" on ${this.model.name}`);
    }
    const column = this.alias
      ? `${quoteMysqlIdentifier(this.alias)}.${quoteMysqlIdentifier(columnName(name))}`
      : quoteMysqlIdentifier(columnName(name));
    if (!rest.length && !field.isArray && SCALAR_KINDS.has(field.kind)) {
      return { expr: column, field, kind: 'column', path };
    }
    return this.descend(column, [], field, rest, path);
  }

  private descend(
    base: string,
    consumed: string[],
    field: FieldDescriptor | undefined,
    rest: string[],
    path: string,
  ): Target {
    if (!field || field.kind === 'json') {
      if (field?.isArray && rest.length) {
        return this.elements(this.jsonPath(base, consumed), undefined, rest, path);
      }
      if (field?.isArray) {
        return { element: undefined, expr: this.jsonPath(base, consumed), kind: 'array', path };
      }
      return { expr: this.jsonPath(base, [...consumed, ...rest]), kind: 'json', path };
    }
    if (field.isArray) {
      if (!rest.length) {
        return { element: itemOf(field), expr: this.jsonPath(base, consumed), kind: 'array', path };
      }
      if (field.kind !== 'object') {
        throw new UnsupportedQueryError(`"${path}": the items of "${field.name}" have no fields`);
      }
      return this.elements(this.jsonPath(base, consumed), itemOf(field), rest, path);
    }
    if (!rest.length) {
      return { expr: this.jsonPath(base, consumed), field, kind: 'json', path };
    }
    if (field.kind !== 'object') {
      throw new UnsupportedQueryError(`"${path}": "${field.name}" has no fields`);
    }
    const [next, ...more] = rest;
    const nested =
      field.nested && Object.prototype.hasOwnProperty.call(field.nested, next) ? field.nested[next] : undefined;
    if (!nested) {
      throw new UnsupportedQueryError(`Unknown field "${path}" on ${this.model.name}`);
    }
    return this.descend(base, [...consumed, next], nested, more, path);
  }

  private elements(arrayExpr: string, item: FieldDescriptor | undefined, rest: string[], path: string): Target {
    return {
      arrayExpr,
      inner: (itemExpr) => this.descend(itemExpr, [], item, rest, path),
      kind: 'elements',
      path,
    };
  }

  /** `base` at `segments`, the path bound as a parameter */
  private jsonPath(base: string, segments: string[]): string {
    return segments.length ? `JSON_EXTRACT(${base}, ${this.params.add(mysqlJsonPath(segments))})` : base;
  }

  /** Whether ANY item of a JSON array satisfies `condition` — counted, see the file comment on EXISTS */
  private anyItem(arrayExpr: string, condition: (item: string) => string): string {
    const alias = `i${++this.items}`;
    return `((SELECT COUNT(*) FROM ${mysqlArrayItems(arrayExpr, alias)} WHERE ${condition(`${alias}.v`)}) > 0)`;
  }

  private itemTarget(target: { element?: FieldDescriptor; path: string }, item: string): Target {
    return { expr: item, field: target.element, kind: 'json', path: target.path };
  }

  // -- operators -------------------------------------------------------------------------------------------

  private eq(target: Target, value: unknown): string {
    if (value instanceof RegExp) {
      return this.regex(target, value.source, value.flags);
    }
    switch (target.kind) {
      case 'column': {
        const cast = castFilterValue(target.field, target.path, value);
        return cast === null ? `${target.expr} IS NULL` : `${target.expr} = ${this.params.add(cast)}`;
      }
      case 'json': {
        if (value === null || value === undefined) {
          return `(${target.expr} IS NULL OR JSON_TYPE(${target.expr}) = 'NULL')`;
        }
        const equal = this.jsonEquals(target.expr, this.jsonText(target.field, target.path, value));
        if (target.field) {
          return equal;
        }
        // Undeclared content may hold an array, which MongoDB matches by any item
        const item = this.params.add(toJson([this.cast(target.field, target.path, value)]));
        return `(${equal} OR (JSON_TYPE(${target.expr}) = 'ARRAY' AND JSON_CONTAINS(${target.expr}, ${item})))`;
      }
      case 'array': {
        if (value === null || value === undefined) {
          return `(${target.expr} IS NULL OR JSON_TYPE(${target.expr}) = 'NULL' OR JSON_CONTAINS(${target.expr}, 'null'))`;
        }
        if (Array.isArray(value)) {
          const items = value.map((item) => (target.element ? this.castJson(target.element, target.path, item) : item));
          return this.jsonEquals(target.expr, this.params.add(toJson(items)));
        }
        if (isPlainObject(value)) {
          return this.anyItem(target.expr, (item) => this.eq(this.itemTarget(target, item), value));
        }
        const item = target.element ? this.castJson(target.element, target.path, value) : value;
        return `JSON_CONTAINS(${target.expr}, ${this.params.add(toJson([item]))})`;
      }
      case 'elements':
        if (value === null || value === undefined) {
          return `(${target.arrayExpr} IS NULL OR ${this.anyItem(target.arrayExpr, (item) => this.eq(target.inner(item), null))})`;
        }
        return this.anyItem(target.arrayExpr, (item) => this.eq(target.inner(item), value));
    }
  }

  private compare(target: Target, operator: ComparisonOperator, value: unknown): string {
    if (value === null || value === undefined) {
      throw new UnsupportedQueryError(`${operator} needs a value at "${target.path}"`);
    }
    const sqlOperator = COMPARISON[operator];
    switch (target.kind) {
      case 'column':
        return `${target.expr} ${sqlOperator} ${this.params.add(castFilterValue(target.field, target.path, value))}`;
      case 'json': {
        const cast =
          target.field && SCALAR_KINDS.has(target.field.kind)
            ? castFilterValue(target.field, target.path, value)
            : value;
        // MongoDB compares within one type only; a value of another type never matches. CASE keeps the cast from
        // running on another type — strict mode turns a failed cast in a write's condition into an error
        if (typeof cast === 'number') {
          return `${mysqlJsonNumber(target.expr)} ${sqlOperator} ${this.params.add(cast)}`;
        }
        const text = cast instanceof Date ? cast.toISOString() : cast;
        if (typeof text === 'string') {
          return `(${this.jsonString(target.expr)}) ${sqlOperator} ${this.params.add(text)}`;
        }
        throw new UnsupportedQueryError(`${operator} on "${target.path}" needs a number, a string or a date`);
      }
      case 'array':
        return this.anyItem(target.expr, (item) => this.compare(this.itemTarget(target, item), operator, value));
      case 'elements':
        return this.anyItem(target.arrayExpr, (item) => this.compare(target.inner(item), operator, value));
    }
  }

  private regex(target: Target, source: string, flags: string): string {
    const pattern = () => this.params.add(`${inlineFlags(target.path, flags)}${source}`);
    switch (target.kind) {
      case 'column':
        if (
          !REGEX_KINDS.has(target.field.kind) ||
          (target.field.kind === 'enum' && target.field.enumBase === 'number')
        ) {
          throw new UnsupportedQueryError(`$regex on the ${target.field.kind} field "${target.path}"`);
        }
        // Byte-wise: case-sensitive unless the pattern says (?i), as on MongoDB — whatever the column's collation
        return `${target.expr} COLLATE utf8mb4_bin REGEXP ${pattern()}`;
      case 'json': {
        const text = `(${this.jsonString(target.expr)}) REGEXP ${pattern()}`;
        if (target.field) {
          return text;
        }
        return `(${text} OR ${this.anyItem(target.expr, (item) => `(${this.jsonString(item)}) REGEXP ${pattern()}`)})`;
      }
      case 'array':
        return this.anyItem(target.expr, (item) => this.regex(this.itemTarget(target, item), source, flags));
      case 'elements':
        return this.anyItem(target.arrayExpr, (item) => this.regex(target.inner(item), source, flags));
    }
  }

  /** On a column, NULL reads as absent — DIFFERENT-BY-DESIGN from MongoDB's present-but-null, as on PostgreSQL */
  private exists(target: Target, present: boolean): string {
    if (target.kind === 'elements') {
      const any = this.anyItem(target.arrayExpr, (item) => this.exists(target.inner(item), true));
      return present ? any : `NOT ${any}`;
    }
    return `${target.expr} IS ${present ? 'NOT ' : ''}NULL`;
  }

  private in(target: Target, values: unknown): string {
    if (!Array.isArray(values)) {
      throw new UnsupportedQueryError(`$in / $nin need an array at "${target.path}"`);
    }
    if (!values.length) {
      return 'FALSE';
    }
    if (target.kind !== 'column') {
      return `(${values.map((value) => this.eq(target, value)).join(' OR ')})`;
    }
    const parts: string[] = [];
    const plain: string[] = [];
    let matchesNull = false;
    for (const value of values) {
      if (value instanceof RegExp) {
        parts.push(this.regex(target, value.source, value.flags));
        continue;
      }
      const cast = castFilterValue(target.field, target.path, value);
      if (cast === null) {
        matchesNull = true;
      } else {
        plain.push(this.params.add(cast));
      }
    }
    if (plain.length) {
      parts.unshift(`${target.expr} IN (${plain.join(', ')})`);
    }
    if (matchesNull) {
      parts.push(`${target.expr} IS NULL`);
    }
    return parts.length === 1 ? parts[0] : `(${parts.join(' OR ')})`;
  }

  private all(target: Target, values: unknown): string {
    if (!Array.isArray(values)) {
      throw new UnsupportedQueryError(`$all needs an array at "${target.path}"`);
    }
    if (!values.length) {
      return 'FALSE';
    }
    return `(${values
      .map((value) => {
        if (isOperatorObject(value)) {
          throw new UnsupportedQueryError(`$all with operators at "${target.path}"`);
        }
        return this.eq(target, value);
      })
      .join(' AND ')})`;
  }

  private size(target: Target, value: unknown): string {
    const size = typeof value === 'string' && value.trim() !== '' ? Number(value) : value;
    if (typeof size !== 'number' || !Number.isInteger(size) || size < 0) {
      throw new QueryCastError(target.path, 'non-negative integer');
    }
    if (target.kind === 'column') {
      return 'FALSE';
    }
    if (target.kind === 'elements') {
      throw new UnsupportedQueryError(`$size inside array items at "${target.path}"`);
    }
    return `(CASE WHEN JSON_TYPE(${target.expr}) = 'ARRAY' THEN JSON_LENGTH(${target.expr}) END) = ${this.params.add(size)}`;
  }

  private type(target: Target, value: unknown): string {
    const types = (Array.isArray(value) ? value : [value]).map((item) => bsonType(target.path, item));
    const conditions = types.map((type) => {
      switch (target.kind) {
        case 'column':
          if (type === 'null') {
            return `${target.expr} IS NULL`;
          }
          return COLUMN_TYPES[type]?.(target.field) ? `${target.expr} IS NOT NULL` : 'FALSE';
        case 'json':
          return this.jsonType(target.expr, type, true);
        case 'array':
          return type === 'array'
            ? `JSON_TYPE(${target.expr}) = 'ARRAY'`
            : this.anyItem(target.expr, (item) => this.jsonType(item, type, false));
        case 'elements':
          return this.anyItem(target.arrayExpr, (item) => this.type(target.inner(item), type));
      }
    });
    return conditions.length === 1 ? conditions[0] : `(${conditions.join(' OR ')})`;
  }

  private jsonType(expr: string, type: BsonType, anyItem: boolean): string {
    const json = JSON_TYPES[type];
    if (!json) {
      throw new UnsupportedQueryError(`$type "${type}" inside JSON`);
    }
    const list = `(${json.map((name) => `'${name}'`).join(', ')})`;
    // MySQL reports a JSON null item of JSON_TABLE as SQL NULL
    const own = type === 'null' ? `(${expr} IS NULL OR JSON_TYPE(${expr}) = 'NULL')` : `JSON_TYPE(${expr}) IN ${list}`;
    if (!anyItem || type === 'array') {
      return own;
    }
    return `(${own} OR ${this.anyItem(expr, (item) => (type === 'null' ? `(${item} IS NULL OR JSON_TYPE(${item}) = 'NULL')` : `JSON_TYPE(${item}) IN ${list}`))})`;
  }

  private elemMatch(target: Target, condition: unknown): string {
    if (target.kind !== 'array') {
      throw new UnsupportedQueryError(`$elemMatch needs an array at "${target.path}"`);
    }
    if (!isPlainObject(condition)) {
      throw new UnsupportedQueryError(`$elemMatch needs an object at "${target.path}"`);
    }
    const keys = Object.keys(condition);
    const operatorForm =
      keys.length > 0 && keys.every((key) => key.startsWith('$') && !['$and', '$nor', '$or'].includes(key));
    return this.anyItem(target.expr, (item) => {
      if (operatorForm) {
        return this.field(this.itemTarget(target, item), condition);
      }
      const element = target.element;
      if (element && element.kind !== 'object' && element.kind !== 'json') {
        throw new UnsupportedQueryError(`$elemMatch with fields on the scalar items of "${target.path}"`);
      }
      return this.conditions(condition as Where, (path) =>
        this.descend(
          item,
          [],
          element ? { ...element, isArray: false } : undefined,
          splitPath(path),
          `${target.path}.${path}`,
        ),
      );
    });
  }

  // -- values ----------------------------------------------------------------------------------------------

  /** A JSON value's text when it is a string, compared byte-wise; NULL for any other type */
  private jsonString(expr: string): string {
    return `CASE WHEN JSON_TYPE(${expr}) = 'STRING' THEN JSON_UNQUOTE(${expr}) END COLLATE utf8mb4_bin`;
  }

  private jsonEquals(left: string, rightJsonText: string): string {
    return mysqlJsonEquals(this.variant, left, rightJsonText);
  }

  /** A value as a bound JSON text, cast first when its field is a declared scalar */
  private jsonText(field: FieldDescriptor | undefined, path: string, value: unknown): string {
    return this.params.add(toJson(this.cast(field, path, value)));
  }

  private cast(field: FieldDescriptor | undefined, path: string, value: unknown): unknown {
    return field ? this.castJson(field, path, value) : value;
  }

  private castJson(field: FieldDescriptor, path: string, value: unknown): unknown {
    return SCALAR_KINDS.has(field.kind) ? castFilterValue({ ...field, isArray: false }, path, value) : value;
  }
}

/**
 * Regular-expression flags as inline options, understood by MySQL's ICU engine and MariaDB's PCRE2 alike. Both default
 * to MongoDB's behaviour (`.` stops at a newline, `^`/`$` anchor the whole string), so only the given flags are written.
 * `g`, `u`, `y` and `d` do not change whether a string matches.
 */
function inlineFlags(path: string, flags: string): string {
  let options = '';
  for (const flag of flags) {
    switch (flag) {
      case 'i':
      case 'm':
      case 's':
      case 'x':
        if (!options.includes(flag)) {
          options += flag;
        }
        break;
      case 'd':
      case 'g':
      case 'u':
      case 'y':
        break;
      default:
        throw new UnsupportedQueryError(`Regular-expression option "${flag}" at "${path}"`);
    }
  }
  return options ? `(?${options})` : '';
}
