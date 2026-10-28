import type { Where } from '../../data-store.interface.js';
import type { FieldDescriptor, ModelDescriptor } from '../../model-descriptor.interface.js';
import { castFilterValue } from '../sql-cast.js';
import { QueryCastError, UnsupportedQueryError } from '../sql-errors.js';
import { columnName, quoteIdentifier, type SqlParamSink } from '../sql-naming.js';
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

/**
 * Compiles the neutral filter (the Mongo-operator subset of plan §3.2) into a PostgreSQL condition.
 *
 * Three rules make it safe to feed with a request's filter:
 * - **Identifiers come from the model descriptor, never from the filter.** A path is resolved field by field against
 *   the descriptor; an unknown field, a segment that is not an identifier, or a path into a field without sub-fields is
 *   refused. JSON paths are bound as `text[]` parameters, so not even a validated segment is written into the SQL.
 * - **Every value is a parameter**, cast to the field's type with Mongoose's query-casting rules (`sql-cast.ts`).
 * - **What cannot be expressed is refused** (`UnsupportedQueryError`), never dropped: a dropped condition widens the
 *   query.
 *
 * Semantics follow MongoDB where SQL can express them — `null` matches a missing value, `$ne`/`$nin` include missing
 * values, a scalar condition on an array matches when ANY element matches, a dot path into an array of objects
 * matches when any element matches. Deliberate differences (the parity matrix asserts them): `$exists` on a column
 * reads NULL as absent; an unknown field is refused instead of matching nothing; JSON object equality ignores key
 * order; regular expressions run on Postgres' ARE engine.
 */

export interface PostgresWhereOptions {
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

export function compilePostgresWhere(
  model: ModelDescriptor,
  where: undefined | Where,
  params: SqlParamSink,
  options: PostgresWhereOptions = {},
): string {
  return new WhereCompiler(model, params, options.alias).compile(where);
}

/** The SQL expression of a field path, for ORDER BY and DISTINCT: a column, or a jsonb value inside one */
export function compilePostgresPath(
  model: ModelDescriptor,
  path: string,
  params: SqlParamSink,
  options: PostgresWhereOptions = {},
): { expr: string; field?: FieldDescriptor; kind: 'array' | 'column' | 'json' } {
  const target = new WhereCompiler(model, params, options.alias).target(path);
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
 * The condition `condition` sets for ONE item (`item`, a jsonb expression) of the array field `field`, with `$pull`
 * semantics: an operator object applies to the item, a plain object is a query on an object item's fields, anything
 * else (a scalar, a RegExp) is equality.
 */
export function compilePostgresItemCondition(
  model: ModelDescriptor,
  field: string,
  condition: unknown,
  params: SqlParamSink,
  item: string,
): string {
  return new WhereCompiler(model, params).itemCondition(field, condition, item);
}

class WhereCompiler {
  private items = 0;

  constructor(
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

  /** A filter object: fields and `$and` / `$or` / `$nor`, every entry ANDed; `resolve` maps a path to its target. */
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

  /** The condition for one path: implicit equality, or an object of operators (all ANDed). */
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
      ? `${quoteIdentifier(this.alias)}.${quoteIdentifier(columnName(name))}`
      : quoteIdentifier(columnName(name));
    if (!rest.length && !field.isArray && SCALAR_KINDS.has(field.kind)) {
      return { expr: column, field, kind: 'column', path };
    }
    return this.descend(column, [], field, rest, path);
  }

  /**
   * Walk `rest` from a JSON value `base` (a jsonb column or an array item) described by `field` (absent: undeclared
   * content). `consumed` are the segments already walked inside `base`.
   */
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
      // Undeclared content: any path is allowed (it is a bound parameter), nothing is cast
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
    return segments.length ? `(${base} #> ${this.params.add(segments)}::text[])` : base;
  }

  /** EXISTS over the items of a JSON array (anything that is not an array has none) */
  private anyItem(arrayExpr: string, condition: (item: string) => string): string {
    const item = `i${++this.items}`;
    const items = `jsonb_array_elements(CASE WHEN jsonb_typeof(${arrayExpr}) = 'array' THEN ${arrayExpr} ELSE '[]'::jsonb END)`;
    return `EXISTS (SELECT 1 FROM ${items} AS ${item}(v) WHERE ${condition(`${item}.v`)})`;
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
          return `(${target.expr} IS NULL OR ${target.expr} = 'null'::jsonb)`;
        }
        const json = this.json(target.field, target.path, value);
        if (target.field) {
          return `${target.expr} = ${json}`;
        }
        // Undeclared content may hold an array, which MongoDB matches by any item
        return `(${target.expr} = ${json} OR (jsonb_typeof(${target.expr}) = 'array' AND ${target.expr} @> jsonb_build_array(${json})))`;
      }
      case 'array': {
        if (value === null || value === undefined) {
          return `(${target.expr} IS NULL OR ${target.expr} = 'null'::jsonb OR ${target.expr} @> '[null]'::jsonb)`;
        }
        if (Array.isArray(value)) {
          const items = value.map((item) => (target.element ? this.castJson(target.element, target.path, item) : item));
          return `${target.expr} = ${this.params.add(toJson(items))}::jsonb`;
        }
        if (isPlainObject(value)) {
          return this.anyItem(target.expr, (item) => this.eq(this.itemTarget(target, item), value));
        }
        const item = target.element ? this.castJson(target.element, target.path, value) : value;
        return `${target.expr} @> ${this.params.add(toJson([item]))}::jsonb`;
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
        // MongoDB compares within one type only; a value of another type never matches. Both sides stay jsonb:
        // Postgres does not promise to evaluate the type test first, and a `::numeric` cast of a string would throw.
        if (typeof cast === 'number') {
          return `(jsonb_typeof(${target.expr}) = 'number' AND ${target.expr} ${sqlOperator} ${this.params.add(toJson(cast))}::jsonb)`;
        }
        const text = cast instanceof Date ? cast.toISOString() : cast;
        if (typeof text === 'string') {
          return `(jsonb_typeof(${target.expr}) = 'string' AND (${target.expr} #>> '{}') COLLATE "C" ${sqlOperator} ${this.params.add(text)})`;
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
    const pattern = () => this.params.add(`${aremOptions(target.path, flags)}${source}`);
    switch (target.kind) {
      case 'column':
        if (
          !REGEX_KINDS.has(target.field.kind) ||
          (target.field.kind === 'enum' && target.field.enumBase === 'number')
        ) {
          throw new UnsupportedQueryError(`$regex on the ${target.field.kind} field "${target.path}"`);
        }
        return `${target.expr} ~ ${pattern()}`;
      case 'json': {
        const text = `(jsonb_typeof(${target.expr}) = 'string' AND (${target.expr} #>> '{}') ~ ${pattern()})`;
        if (target.field) {
          return text;
        }
        return `(${text} OR ${this.anyItem(target.expr, (item) => `(jsonb_typeof(${item}) = 'string' AND (${item} #>> '{}') ~ ${pattern()})`)})`;
      }
      case 'array':
        return this.anyItem(target.expr, (item) => this.regex(this.itemTarget(target, item), source, flags));
      case 'elements':
        return this.anyItem(target.arrayExpr, (item) => this.regex(target.inner(item), source, flags));
    }
  }

  /** On a column, NULL reads as absent — DIFFERENT-BY-DESIGN from MongoDB's present-but-null */
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
    const plain: unknown[] = [];
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
        plain.push(cast);
      }
    }
    if (plain.length) {
      parts.unshift(`${target.expr} = ANY(${this.params.add(plain)})`);
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
    return `(CASE WHEN jsonb_typeof(${target.expr}) = 'array' THEN jsonb_array_length(${target.expr}) END) = ${this.params.add(size)}`;
  }

  /**
   * `$type` by alias or number. On a column the column's kind decides — and `null` reads as absent, as for
   * `$exists`; on JSON it is the value's JSON type.
   */
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
            ? `jsonb_typeof(${target.expr}) = 'array'`
            : this.anyItem(target.expr, (item) => this.jsonType(item, type, false));
        case 'elements':
          return this.anyItem(target.arrayExpr, (item) => this.type(target.inner(item), type));
      }
    });
    return conditions.length === 1 ? conditions[0] : `(${conditions.join(' OR ')})`;
  }

  /** A JSON value's type; `anyItem`: a JSON array also matches by any item, as in MongoDB */
  private jsonType(expr: string, type: BsonType, anyItem: boolean): string {
    const json = JSON_TYPES[type];
    if (!json) {
      throw new UnsupportedQueryError(`$type "${type}" inside JSON`);
    }
    const own = `jsonb_typeof(${expr}) = '${json}'`;
    if (!anyItem || type === 'array') {
      return own;
    }
    return `(${own} OR ${this.anyItem(expr, (item) => `jsonb_typeof(${item}) = '${json}'`)})`;
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

  /** A value as a jsonb parameter, cast first when its field is a declared scalar */
  private json(field: FieldDescriptor | undefined, path: string, value: unknown): string {
    const cast = field ? this.castJson(field, path, value) : value;
    return `${this.params.add(toJson(cast))}::jsonb`;
  }

  private castJson(field: FieldDescriptor, path: string, value: unknown): unknown {
    return SCALAR_KINDS.has(field.kind) ? castFilterValue({ ...field, isArray: false }, path, value) : value;
  }
}

/** The JSON type a BSON type is stored as (dates and ids are strings in JSON, so they cannot be told apart there) */
const JSON_TYPES: Partial<Record<BsonType, string>> = {
  array: 'array',
  bool: 'boolean',
  null: 'null',
  number: 'number',
  object: 'object',
  string: 'string',
};

/**
 * Regular-expression flags as embedded ARE options. MongoDB (PCRE) and JavaScript keep `.` from matching a newline
 * unless `s` is set and anchor `^`/`$` at line breaks only with `m`; Postgres' default is the opposite, so the mode is
 * always written: `p` (neither), `n` (`m`), `s` (`s`), `w` (both). `i` and `x` carry over; `g`, `u`, `y` and `d` do
 * not change whether a string matches.
 */
function aremOptions(path: string, flags: string): string {
  let multiline = false;
  let dotAll = false;
  let options = '';
  for (const flag of flags) {
    switch (flag) {
      case 'i':
      case 'x':
        options += flag;
        break;
      case 'm':
        multiline = true;
        break;
      case 's':
        dotAll = true;
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
  const mode = multiline ? (dotAll ? 'w' : 'n') : dotAll ? 's' : 'p';
  return `(?${mode}${options})`;
}
