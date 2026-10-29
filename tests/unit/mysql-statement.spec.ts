import { describe, expect, it } from 'vitest';

import {
  MYSQL_SESSION_SQL,
  mysqlResult,
  mysqlStatementParts,
  toMysqlStatement,
} from '../../src/core/common/persistence/sql/mysql/mysql-session';

/**
 * The compilers write PostgreSQL's positional placeholders (`$1`), shared by every SQL database; the MySQL / MariaDB
 * executor turns them into the driver's `?` (phase 6). What decides whether a value is bound or becomes SQL text lives
 * here, so it is pinned without a server.
 */
describe('MySQL statement conversion', () => {
  it('binds the values in the order the placeholders appear, a repeated one twice', () => {
    expect(toMysqlStatement({ params: ['a', 'b'], text: 'SELECT $2, $1, $2' })).toEqual({
      sql: 'SELECT ?, ?, ?',
      values: ['b', 'a', 'b'],
    });
    const params = Array.from({ length: 12 }, (_value, index) => index + 1);
    expect(toMysqlStatement({ params, text: 'SELECT $12, $1' }).values).toEqual([12, 1]);
  });

  /**
   * @regression   DEV-3848 (db-agnostic phase 6) — the compilers write JSON path literals (`'$[*]'`) and a native
   *   caller may quote any text; a placeholder inside a literal must stay text, or a value is bound where the
   *   statement says a constant.
   * @seen-failing Treat quotes as ordinary characters in mysqlStatementParts() of
   *   src/core/common/persistence/sql/mysql/mysql-session.ts — registered as mutation
   *   `mysql-placeholders-inside-literals` in tests/regression-mutations.json.
   */
  it('leaves a placeholder inside quoted text alone, also after an escaped or doubled quote', () => {
    expect(
      toMysqlStatement({
        params: ['x'],
        text: "SELECT '$1', 'it''s $1', 'a\\'$1', \"$1\", `c$1`, $1 FROM t, JSON_TABLE(j, '$[*]' COLUMNS (v JSON PATH '$'))",
      }),
    ).toEqual({
      sql: "SELECT '$1', 'it''s $1', 'a\\'$1', \"$1\", `c$1`, ? FROM t, JSON_TABLE(j, '$[*]' COLUMNS (v JSON PATH '$'))",
      values: ['x'],
    });
  });

  it('splits at the placeholders for an engine that binds between text fragments', () => {
    expect(mysqlStatementParts({ params: [1, 2], text: 'a $1 b $2 c' })).toEqual({
      parts: ['a ', ' b ', ' c'],
      values: [1, 2],
    });
  });

  it('refuses a placeholder without a value, and a value the driver would expand', () => {
    expect(() => toMysqlStatement({ params: [], text: 'SELECT $1' })).toThrow(/only 0 were bound/);
    expect(() => toMysqlStatement({ params: [['a', 'b']], text: 'SELECT $1' })).toThrow(/bind JSON as text/);
    expect(() => toMysqlStatement({ params: [{ a: 1 }], text: 'SELECT $1' })).toThrow(/bind JSON as text/);
  });

  it('passes scalars, dates and buffers through, a bigint as text, undefined as NULL', () => {
    const date = new Date('2026-10-28T10:00:00.000Z');
    const buffer = Buffer.from('x');
    expect(
      toMysqlStatement({
        params: ['s', 1, true, null, undefined, 9007199254740993n, date, buffer],
        text: '$1 $2 $3 $4 $5 $6 $7 $8',
      }).values,
    ).toEqual(['s', 1, true, null, null, '9007199254740993', date, buffer]);
  });

  it('answers rows for a query and the matched-row count for a write', () => {
    expect(mysqlResult([{ a: 1 }, { a: 2 }])).toEqual({ rowCount: 2, rows: [{ a: 1 }, { a: 2 }] });
    expect(mysqlResult({ affectedRows: 3 })).toEqual({ rowCount: 3, rows: [] });
  });

  it('sets a strict session that keeps backslash escapes, in UTC', () => {
    expect(MYSQL_SESSION_SQL).toMatch(/STRICT_ALL_TABLES/);
    expect(MYSQL_SESSION_SQL).not.toMatch(/NO_BACKSLASH_ESCAPES|ANSI_QUOTES|PIPES_AS_CONCAT/);
    expect(MYSQL_SESSION_SQL).toMatch(/time_zone = '\+00:00'/);
  });
});
