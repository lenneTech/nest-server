import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { MysqlVariant } from '../src/core/common/persistence/sql/mysql/mysql-session';
import { createSqlExecutor } from '../src/core/common/persistence/sql/sql-executor.factory';
import type { SqlExecutor, SqlTenantScope } from '../src/core/common/persistence/sql/sql-executor.interface';
import { createMysqlTestDatabase, type MysqlTestDatabase } from './helpers/mysql-test-db';

/**
 * The MySQL / MariaDB executor (plan phase 6) on every engine: all three run on one `mysql2` pool the framework creates,
 * so each connection carries the framework's session — strict, backslash escapes ON (the driver escapes with them), UTC
 * — whichever API sends the statement, and an engine's error wrapper never hides the driver's error number.
 */
const SYSTEM: SqlTenantScope = { kind: 'system' };
/** Ends a string literal if the server read a backslash literally, and carries both placeholder spellings */
const CRAFTED = 'a\\\' OR 1=1 -- $1 ? "x" \\\\ end';

for (const variant of ['mysql', 'mariadb'] as MysqlVariant[]) {
  describe(`${variant} executor (e2e)`, () => {
    let database: MysqlTestDatabase;

    beforeAll(async () => {
      database = await createMysqlTestDatabase(variant, 'mysql-executor');
      const owner = await createSqlExecutor({ engine: 'typeorm', maxConnections: 1, url: database.ownerUrl });
      try {
        await owner.run(
          { params: [], text: 'CREATE TABLE probe (id varchar(24) PRIMARY KEY, v longtext) COLLATE utf8mb4_bin' },
          SYSTEM,
        );
      } finally {
        await owner.close();
      }
    });

    afterAll(async () => {
      await database?.drop();
    });

    for (const engine of ['typeorm', 'kysely', 'drizzle'] as const) {
      describe(engine, () => {
        let executor: SqlExecutor;
        const id = (suffix: string) => `${engine}-${suffix}`;

        beforeAll(async () => {
          executor = await createSqlExecutor({ engine, maxConnections: 2, url: database.appUrl });
        });

        afterAll(async () => {
          await executor?.close();
        });

        it('runs every statement in the framework session, in a transaction too', async () => {
          const text = 'SELECT @@SESSION.sql_mode AS mode, @@SESSION.time_zone AS tz';
          const outside = (await executor.run<{ mode: string; tz: string }>({ params: [], text }, SYSTEM)).rows[0];
          const inside = await executor.transaction(
            async (tx) => (await tx.run<any>({ params: [], text }, SYSTEM)).rows[0],
          );
          for (const session of [outside, inside]) {
            expect(session.mode).toMatch(/STRICT_ALL_TABLES/);
            expect(session.mode).not.toMatch(/NO_BACKSLASH_ESCAPES/);
            expect(session.tz).toBe('+00:00');
          }
        });

        /**
         * @regression   DEV-3848 (db-agnostic phase 6) — the driver escapes a quote in a value with a backslash; a
         *   session with NO_BACKSLASH_ESCAPES reads that backslash literally, the quote ends the string and the rest of
         *   the value becomes SQL.
         * @seen-failing Add NO_BACKSLASH_ESCAPES to MYSQL_SESSION_SQL in
         *   src/core/common/persistence/sql/mysql/mysql-session.ts — registered as mutation
         *   `mysql-session-backslash-escapes` in tests/regression-mutations.json.
         */
        it('binds a crafted value as a value, outside and inside a transaction', async () => {
          await executor.run(
            { params: [id('crafted'), CRAFTED], text: 'INSERT INTO probe (id, v) VALUES ($1, $2)' },
            SYSTEM,
          );
          const back = await executor.transaction(async (tx) => {
            await tx.run(
              { params: [id('crafted-tx'), CRAFTED], text: 'INSERT INTO probe (id, v) VALUES ($1, $2)' },
              SYSTEM,
            );
            return tx.run<{ v: string }>(
              { params: [id('crafted'), id('crafted-tx')], text: 'SELECT v FROM probe WHERE id IN ($1, $2)' },
              SYSTEM,
            );
          });
          expect(back.rows.map((row) => row.v)).toEqual([CRAFTED, CRAFTED]);
        });

        it('rolls a failed transaction back and commits a successful one', async () => {
          await expect(
            executor.transaction(async (tx) => {
              await tx.run({ params: [id('rolled-back')], text: "INSERT INTO probe (id, v) VALUES ($1, 'x')" }, SYSTEM);
              throw new Error('abort');
            }),
          ).rejects.toThrow('abort');
          await executor.transaction((tx) =>
            tx.run({ params: [id('committed')], text: "INSERT INTO probe (id, v) VALUES ($1, 'x')" }, SYSTEM),
          );
          const { rows } = await executor.run<{ id: string }>(
            { params: [id('rolled-back'), id('committed')], text: 'SELECT id FROM probe WHERE id IN ($1, $2)' },
            SYSTEM,
          );
          expect(rows.map((row) => row.id)).toEqual([id('committed')]);
        });

        /**
         * @regression   DEV-3848 (db-agnostic phase 6) — TypeORM and Drizzle wrap the driver's error; the store maps
         *   duplicate keys, too-long values and failed checks by the driver's error NUMBER, which a wrapper hides.
         * @seen-failing Return the error unchanged from driverErrorOf() in
         *   src/core/common/persistence/sql/mysql/mysql-executor.ts — registered as mutation
         *   `mysql-engine-error-wrapped` in tests/regression-mutations.json.
         */
        it('fails with the driver error on every path, its number intact', async () => {
          await executor.run({ params: [id('twice')], text: "INSERT INTO probe (id, v) VALUES ($1, 'x')" }, SYSTEM);
          const insert = { params: [id('twice')], text: "INSERT INTO probe (id, v) VALUES ($1, 'x')" };
          const outside = await executor.run(insert, SYSTEM).catch((error) => error);
          const inside = await executor.transaction((tx) => tx.run(insert, SYSTEM)).catch((error) => error);
          for (const error of [outside, inside]) {
            expect(error.errno).toBe(1062);
          }
        });

        it('counts a matched row as updated also when nothing changes', async () => {
          await executor.run({ params: [id('same')], text: "INSERT INTO probe (id, v) VALUES ($1, 'x')" }, SYSTEM);
          const update = { params: [id('same')], text: "UPDATE probe SET v = 'x' WHERE id = $1" };
          expect((await executor.run(update, SYSTEM)).rowCount).toBe(1);
          expect((await executor.transaction((tx) => tx.run(update, SYSTEM))).rowCount).toBe(1);
        });
      });
    }
  });
}
