import type { DataStoreUpdate } from '../../data-store.interface.js';
import type { FieldDescriptor, ModelDescriptor } from '../../model-descriptor.interface.js';
import { castFilterValue } from '../sql-cast.js';
import { UnsupportedQueryError } from '../sql-errors.js';
import { columnName, isPathSegment, quoteIdentifier, type SqlParamSink } from '../sql-naming.js';
import { compilePostgresItemCondition, compilePostgresPath } from './postgres-where.compiler.js';

/**
 * Compiles the neutral update (plan §3.2: a partial record, or `$set $unset $inc $push $addToSet $pull`) into the
 * assignments of an `UPDATE … SET`. Paths are resolved against the model descriptor like filter paths, values are
 * cast like Mongoose casts them and bound as parameters, and an operator or modifier that cannot be expressed is
 * refused — never skipped.
 *
 * Several operators on one column chain into one expression, in the order they are written.
 */
export function compilePostgresUpdate(model: ModelDescriptor, update: DataStoreUpdate, params: SqlParamSink): string[] {
  return new UpdateCompiler(model, params).compile(update);
}

const IGNORED_OPERATORS = new Set(['$setOnInsert']);
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

class UpdateCompiler {
  private readonly assignments = new Map<string, string>();
  private bindings = 0;

  constructor(
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
    return [...this.assignments].map(([column, expression]) => `${quoteIdentifier(column)} = ${expression}`);
  }

  // -- paths ----------------------------------------------------------------------------------------------

  /** The top-level field of `path` and the segments below it */
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
      compilePostgresPath(this.model, path, { add: () => '$0' });
    }
    return { column, field, rest };
  }

  private current(column: string): string {
    return this.assignments.get(column) ?? quoteIdentifier(column);
  }

  /**
   * `build` applied to `expr` evaluated ONCE. A running expression that is referenced twice must be bound: inlining it
   * at every reference doubled the statement per nested path and per chained operator — 20 `$inc` on one embedded
   * object produced a statement of 2^20 copies
   */
  private bind(expr: string, build: (value: string) => string): string {
    // One alias per binding: a nested binding reads the enclosing one, which an equal name would hide
    const alias = `b${++this.bindings}`;
    return `(SELECT ${build(`${alias}.v`)} FROM (SELECT ${expr} AS v) AS ${alias})`;
  }

  /** `expr` with every object on the way to `rest` present, as `$set` / `$inc` on a path create them */
  private withParents(expr: string, rest: string[]): string {
    let result = `COALESCE(${expr}, '{}'::jsonb)`;
    for (let depth = 1; depth < rest.length; depth++) {
      const prefix = this.params.add(rest.slice(0, depth));
      result = this.bind(
        result,
        (value) => `jsonb_set(${value}, ${prefix}::text[], COALESCE(${value} #> ${prefix}::text[], '{}'::jsonb), true)`,
      );
    }
    return result;
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

  /** A value for a top-level column: typed, or jsonb for arrays, objects and undeclared content */
  private columnValue(field: FieldDescriptor, path: string, value: unknown): string {
    if (value === null || value === undefined) {
      return 'NULL';
    }
    if (field.isArray) {
      if (!Array.isArray(value)) {
        throw new UnsupportedQueryError(`"${path}" is an array field`);
      }
      return this.json(value.map((item) => this.cast({ ...field, isArray: false }, path, item)));
    }
    if (SCALAR_KINDS.has(field.kind)) {
      return this.params.add(castFilterValue(field, path, value));
    }
    return this.json(value);
  }

  private cast(field: FieldDescriptor | undefined, path: string, value: unknown): unknown {
    return field && !field.isArray && SCALAR_KINDS.has(field.kind) ? castFilterValue(field, path, value) : value;
  }

  private json(value: unknown): string {
    return `${this.params.add(
      JSON.stringify(value, (_key, item) => (typeof item === 'bigint' ? item.toString() : item)),
    )}::jsonb`;
  }

  // -- operators ------------------------------------------------------------------------------------------

  private set(path: string, value: unknown): void {
    const { column, field, rest } = this.split(path);
    if (!rest.length) {
      this.assignments.set(column, this.columnValue(field, path, value));
      return;
    }
    const cast = this.cast(this.nestedField(field, rest), path, value);
    const target = this.params.add(rest);
    this.assignments.set(
      column,
      `jsonb_set(${this.withParents(this.current(column), rest)}, ${target}::text[], ${this.json(cast ?? null)}, true)`,
    );
  }

  private unset(path: string): void {
    const { column, rest } = this.split(path);
    this.assignments.set(
      column,
      rest.length ? `(${this.current(column)} #- ${this.params.add(rest)}::text[])` : 'NULL',
    );
  }

  private inc(path: string, value: unknown): void {
    const { column, field, rest } = this.split(path);
    const amount = castFilterValue({ ...field, enumBase: undefined, isArray: false, kind: 'number' }, path, value);
    if (typeof amount !== 'number') {
      throw new UnsupportedQueryError(`$inc needs a number at "${path}"`);
    }
    const current = this.current(column);
    if (!rest.length) {
      if (field.isArray || !['bigint', 'decimal', 'number'].includes(field.kind)) {
        throw new UnsupportedQueryError(`$inc on the non-numeric field "${path}"`);
      }
      this.assignments.set(column, `(COALESCE(${current}, 0) + ${this.params.add(amount)})`);
      return;
    }
    const target = this.params.add(rest);
    const increment = this.params.add(amount);
    this.assignments.set(
      column,
      this.bind(
        current,
        (bound) =>
          `jsonb_set(${this.withParents(bound, rest)}, ${target}::text[], to_jsonb(COALESCE((${bound} #>> ${target}::text[])::numeric, 0) + ${increment}), true)`,
      ),
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
    this.assignments.set(column, `(COALESCE(${this.current(column)}, '[]'::jsonb) || ${this.json(items)})`);
  }

  private addToSet(path: string, value: unknown): void {
    const { column, field } = this.arrayField('$addToSet', path);
    const seen = new Set<string>();
    const items = this.items('$addToSet', path, field, value).filter((item) => {
      const key = JSON.stringify(item);
      return seen.has(key) ? false : (seen.add(key), true);
    });
    const added = this.json(items);
    this.assignments.set(
      column,
      this.bind(
        `COALESCE(${this.current(column)}, '[]'::jsonb)`,
        (current) =>
          `(${current} || (SELECT COALESCE(jsonb_agg(a.v ORDER BY a.n), '[]'::jsonb) FROM jsonb_array_elements(${added}) WITH ORDINALITY AS a(v, n) WHERE NOT EXISTS (SELECT 1 FROM jsonb_array_elements(${current}) AS e(v) WHERE e.v = a.v)))`,
      ),
    );
  }

  private pull(path: string, condition: unknown): void {
    const { column } = this.arrayField('$pull', path);
    this.assignments.set(column, pullExpression(this.model, path, this.current(column), condition, this.params));
  }
}

/** The array `current` without the items matching `condition` (`$pull` semantics), order kept */
export function pullExpression(
  model: ModelDescriptor,
  field: string,
  current: string,
  condition: unknown,
  params: SqlParamSink,
): string {
  const matches = compilePostgresItemCondition(model, field, condition, params, 'p.v');
  return `(SELECT COALESCE(jsonb_agg(p.v ORDER BY p.n), '[]'::jsonb) FROM jsonb_array_elements(COALESCE(${current}, '[]'::jsonb)) WITH ORDINALITY AS p(v, n) WHERE NOT COALESCE(${matches}, FALSE))`;
}
