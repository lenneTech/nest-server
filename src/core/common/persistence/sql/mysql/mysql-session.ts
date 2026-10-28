import type { SqlQueryResult, SqlStatement } from '../sql-executor.interface.js';

/**
 * Connection-level rules for MySQL 8.4 and MariaDB 11.8, shared by every SQL engine (plan phase 6).
 *
 * Neither database has row-level security, so no tenant scope travels with a statement: the store's before-layer and
 * its row check after every read are the whole tenant isolation there (plan §3.4). What every connection needs instead
 * is a fixed session, set once when the pool opens it and inherited by the engines' native APIs on the same pool.
 */

/** Which of the two servers a source is — they share one dialect and differ in a few functions */
export type MysqlVariant = 'mariadb' | 'mysql';

/**
 * The session every connection gets.
 *
 * - `sql_mode` is set in full, not amended: strict, so a value too long for a column is refused instead of cut, and
 *   WITHOUT `NO_BACKSLASH_ESCAPES` — the driver escapes parameters with backslashes on the client, and a server that
 *   reads a backslash literally would let a crafted value end its string (`ANSI_QUOTES` and `PIPES_AS_CONCAT` stay out
 *   for the same reason: the compilers rely on the default meaning of `"` and `||`)
 * - `time_zone`: UTC, so the server's clock and the stored instants agree with the driver's (`timezone: 'Z'`)
 * - `group_concat_max_len`: the store rebuilds JSON arrays with `GROUP_CONCAT`, which MySQL caps at 1024 bytes
 */
export const MYSQL_SESSION_SQL =
  "SET SESSION sql_mode = 'STRICT_ALL_TABLES,NO_ZERO_IN_DATE,NO_ZERO_DATE,ERROR_FOR_DIVISION_BY_ZERO,NO_ENGINE_SUBSTITUTION,ONLY_FULL_GROUP_BY', " +
  "time_zone = '+00:00', group_concat_max_len = 4294967295";

/** Options the driver needs for the values the store reads back as the descriptor types them */
export function mysqlConnectionOptions(url: string, maxConnections: number): Record<string, unknown> {
  return {
    connectionLimit: maxConnections,
    dateStrings: false,
    // Instants are written and read as UTC; the session's time_zone agrees
    timezone: 'Z',
    uri: url,
    // BIGINT and DECIMAL arrive as strings, never rounded to a double
    bigNumberStrings: true,
    decimalNumbers: false,
    supportBigNumbers: true,
    // One statement per call: a parameter can never smuggle a second one in
    multipleStatements: false,
  };
}

/**
 * Turn the compilers' positional placeholders (`$1`, `$2`, …, shared with PostgreSQL) into the driver's `?`, with the
 * values in the order the placeholders appear — a placeholder may repeat or appear out of order. Text inside quotes
 * (`'…'`, `"…"`, `` `…` ``) is copied as it is: a JSON path literal such as `'$[*]'` is not a placeholder.
 */
export function toMysqlStatement(statement: SqlStatement): { sql: string; values: unknown[] } {
  const { parts, values } = mysqlStatementParts(statement);
  return { sql: parts.join('?'), values };
}

/**
 * The statement split at its placeholders: `parts` has one entry more than `values`, and `parts.join('?')` is the
 * driver's text. For an engine that binds values itself between text fragments (Drizzle).
 */
export function mysqlStatementParts(statement: SqlStatement): { parts: string[]; values: unknown[] } {
  const { params, text } = statement;
  const values: unknown[] = [];
  const parts: string[] = [];
  let sql = '';
  let quote: null | string = null;
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (quote) {
      sql += char;
      if (char === '\\' && quote !== '`' && i + 1 < text.length) {
        sql += text[++i];
      } else if (char === quote) {
        if (text[i + 1] === quote) {
          sql += text[++i];
        } else {
          quote = null;
        }
      }
      continue;
    }
    if (char === "'" || char === '"' || char === '`') {
      quote = char;
      sql += char;
      continue;
    }
    if (char === '$' && /\d/.test(text[i + 1] ?? '')) {
      let digits = '';
      while (/\d/.test(text[i + 1] ?? '')) {
        digits += text[++i];
      }
      const index = Number(digits) - 1;
      if (index < 0 || index >= params.length) {
        throw new Error(`Statement references parameter $${digits}, but only ${params.length} were bound`);
      }
      values.push(driverValue(params[index]));
      parts.push(sql);
      sql = '';
      continue;
    }
    sql += char;
  }
  parts.push(sql);
  return { parts, values };
}

/**
 * A value as the driver must receive it. The driver expands an array into a list and an object into `key = value`
 * pairs — never wanted here: the compilers bind JSON as text. Refusing them keeps a compiler mistake from changing what a
 * statement means.
 */
function driverValue(value: unknown): unknown {
  if (value === undefined) {
    return null;
  }
  if (typeof value === 'bigint') {
    return value.toString();
  }
  if (value === null || typeof value !== 'object' || value instanceof Date || Buffer.isBuffer(value)) {
    return value;
  }
  throw new TypeError('A MySQL statement parameter must be a scalar, a Date or a Buffer — bind JSON as text');
}

/** A driver result as the executor port returns it: rows for a query, the matched-row count for a write */
export function mysqlResult<R>(result: unknown): SqlQueryResult<R> {
  if (Array.isArray(result)) {
    return { rowCount: result.length, rows: result as R[] };
  }
  // A write: `affectedRows` counts MATCHED rows (the driver sets CLIENT_FOUND_ROWS), as PostgreSQL's row count does
  const affected = (result as { affectedRows?: unknown } | undefined)?.affectedRows;
  return { rowCount: typeof affected === 'number' ? affected : 0, rows: [] };
}
