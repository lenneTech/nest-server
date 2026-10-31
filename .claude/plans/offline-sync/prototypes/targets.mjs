/**
 * Target adapters for the cursor lab (PLAN.md §3.4, DEV-3899).
 *
 * One adapter per database / engine / topology, each implementing the same five cursor variants where they apply:
 *
 *   C0   app clock + id keyset            — the archived branch's cursor; NEGATIVE CONTROL, must lose
 *   C1n  plain sequence, no horizon       — NEGATIVE CONTROL for SQL: allocation order is not commit order
 *   C1   counter row bumped in the write's own transaction, row lock held to commit → sequence order = commit order
 *   C1d  the counter is always taken LAST, after the row locks: a single write through the trigger (C1t), a long
 *        transaction writes its row with the sentinel sync_seq = -1 (the trigger skips it) and lets its final statement
 *        before COMMIT take the counter — the lock is held for that statement and the commit only
 *   C1t  like C1, but a BEFORE INSERT/UPDATE trigger takes the counter — one autocommitted statement, every write path
 *   C1x  PostgreSQL only: xid8 of the writing transaction, read below pg_snapshot_xmin() (exact horizon)
 *   C2   database clock (µs) + keyset + low-water mark W behind the run's start
 *
 * SQL goes through the FRAMEWORK's own executors (dist/), so the three PostgreSQL engines and the MySQL / MariaDB
 * adapters run their real transaction paths. MongoDB goes through the `mongodb` driver, as MongooseDataStore does.
 *
 * The credentials are the local test-container defaults from tests/helpers/*-test-db.ts, not secrets.
 */
import { MongoClient } from 'mongodb';
import pg from 'pg';
import { createConnection } from 'mysql2/promise';

import { createSqlExecutor } from '../../../../dist/core/common/persistence/sql/sql-executor.factory.js';

/** One throwaway database per target, so targets on one server can run in parallel. The `test` segment is the drop guard's marker. */
const SUFFIX = process.env.CURSOR_DB_SUFFIX ? `_${process.env.CURSOR_DB_SUFFIX}` : '';
export const sqlDbName = (target) => `nest_server_proto_test_cursor_${target.replace(/-/g, '_')}${SUFFIX}`;
export const mongoDbName = (target) => `nest-server-proto-test-cursor-${target}${SUFFIX.replace(/_/g, '-')}`;

const PG = {
  host: process.env.PG_HOST || '127.0.0.1',
  password: process.env.PG_OWNER_PASSWORD || 'nest-owner-secret',
  port: Number(process.env.PG_PORT || 5440),
  user: process.env.PG_OWNER_USER || 'nest_owner',
};
const MY = {
  password: process.env.MYSQL_OWNER_PASSWORD || 'nest-owner-secret',
  user: process.env.MYSQL_OWNER_USER || 'nest_owner',
};

export const TARGETS = {
  'mongo-standalone': { kind: 'mongo', transactions: false, url: process.env.MONGO_URL || 'mongodb://127.0.0.1:27017' },
  'mongo-rs': {
    kind: 'mongo',
    transactions: true,
    url: process.env.MONGO_RS_URL || 'mongodb://127.0.0.1:27027/?directConnection=true',
  },
  'pg-typeorm': { engine: 'typeorm', kind: 'pg' },
  'pg-kysely': { engine: 'kysely', kind: 'pg' },
  'pg-drizzle': { engine: 'drizzle', kind: 'pg' },
  mysql: { engine: 'typeorm', host: '127.0.0.1', kind: 'mysql', port: Number(process.env.MYSQL_PORT || 3316), scheme: 'mysql' },
  mariadb: {
    engine: 'typeorm',
    host: '127.0.0.1',
    kind: 'mysql',
    port: Number(process.env.MARIADB_PORT || 3317),
    scheme: 'mariadb',
  },
};

export const VARIANTS = {
  mongo: ['C0', 'C1', 'C2'],
  mysql: ['C0', 'C1n', 'C1', 'C1d', 'C1t', 'C2'],
  pg: ['C0', 'C1n', 'C1', 'C1d', 'C1t', 'C1x', 'C2'],
};

const SYSTEM = { kind: 'system' };
export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Initial cursor position per variant — before every record. */
export const isSeq = (variant) => ['C1', 'C1d', 'C1n', 'C1t'].includes(variant);
/** Variants with a counter row */
const counterVariant = (variant) => ['C1', 'C1d', 'C1t'].includes(variant);
/** Variants whose counter is taken by a trigger */
const triggerVariant = (variant) => variant === 'C1d' || variant === 'C1t';
/** In a statement list: where a late transaction waits */
const PAUSE = { pause: true };

export function initialPos(variant) {
  if (isSeq(variant)) return { k: '-1' };
  if (variant === 'C1x') return { id: '', k: '0' };
  return { id: '', k: '-1' };
}

/** Create the throwaway database (orchestrator only). */
export async function createDatabase(name) {
  const t = TARGETS[name];
  const DB_NAME_SQL = sqlDbName(name);
  const DB_NAME_MONGO = mongoDbName(name);
  if (t.kind === 'pg') {
    const c = new pg.Client({ ...PG, database: 'postgres' });
    await c.connect();
    await c.query(`DROP DATABASE IF EXISTS "${DB_NAME_SQL}" WITH (FORCE)`);
    await c.query(`CREATE DATABASE "${DB_NAME_SQL}"`);
    await c.end();
  } else if (t.kind === 'mysql') {
    const c = await createConnection({ host: t.host, port: t.port, ...MY });
    await c.query(`DROP DATABASE IF EXISTS \`${DB_NAME_SQL}\``);
    await c.query(`CREATE DATABASE \`${DB_NAME_SQL}\``);
    await c.end();
  } else {
    const client = await new MongoClient(t.url).connect();
    await client.db(DB_NAME_MONGO).dropDatabase();
    await client.close();
  }
}

export async function dropDatabase(name) {
  const t = TARGETS[name];
  const DB_NAME_SQL = sqlDbName(name);
  const DB_NAME_MONGO = mongoDbName(name);
  if (t.kind === 'pg') {
    const c = new pg.Client({ ...PG, database: 'postgres' });
    await c.connect();
    await c.query(`DROP DATABASE IF EXISTS "${DB_NAME_SQL}" WITH (FORCE)`);
    await c.end();
  } else if (t.kind === 'mysql') {
    const c = await createConnection({ host: t.host, port: t.port, ...MY });
    await c.query(`DROP DATABASE IF EXISTS \`${DB_NAME_SQL}\``);
    await c.end();
  } else {
    const client = await new MongoClient(t.url).connect();
    await client.db(DB_NAME_MONGO).dropDatabase();
    await client.close();
  }
}

export async function openTarget(name, { maxConnections = 12 } = {}) {
  const t = TARGETS[name];
  if (!t) throw new Error(`Unknown target ${name}`);
  if (t.kind === 'mongo') return openMongo(t, mongoDbName(name));
  const DB_NAME_SQL = sqlDbName(name);
  if (t.kind === 'pg') {
    const url = `postgres://${PG.user}:${PG.password}@${PG.host}:${PG.port}/${DB_NAME_SQL}`;
    return openSql(t, await createSqlExecutor({ engine: t.engine, maxConnections, url }), pgDialect);
  }
  const url = `${t.scheme}://${MY.user}:${MY.password}@${t.host}:${t.port}/${DB_NAME_SQL}`;
  return openSql(t, await createSqlExecutor({ engine: t.engine, maxConnections, url }), mysqlDialect);
}

// ---------------------------------------------------------------------------------------------
// SQL
// ---------------------------------------------------------------------------------------------

function builder() {
  const params = [];
  return { p: (value) => (params.push(value), `$${params.length}`), params };
}

/** PostgreSQL statements per variant. */
const pgDialect = {
  name: 'pg',
  nowUs: `(extract(epoch from clock_timestamp()) * 1000000)::bigint`,
  ddl(variant, table) {
    const stmts = [
      `CREATE TABLE ${table} (id text PRIMARY KEY, version int NOT NULL, deleted_at timestamptz, payload text,
        upd_ms bigint, sync_seq bigint, sync_xid xid8, sync_us bigint)`,
    ];
    if (variant === 'C0') stmts.push(`CREATE INDEX ON ${table} (upd_ms, id)`);
    if (isSeq(variant)) stmts.push(`CREATE INDEX ON ${table} (sync_seq)`);
    if (variant === 'C1x') stmts.push(`CREATE INDEX ON ${table} (sync_xid, id)`);
    if (variant === 'C2') stmts.push(`CREATE INDEX ON ${table} (sync_us, id)`);
    if (variant === 'C1n') stmts.push(`CREATE SEQUENCE ${table}_seq`);
    if (counterVariant(variant)) {
      stmts.push(`CREATE TABLE IF NOT EXISTS sync_counter (name text PRIMARY KEY, seq bigint NOT NULL)`);
      stmts.push(`INSERT INTO sync_counter (name, seq) VALUES ('${table}', 0)`);
    }
    if (triggerVariant(variant)) {
      // A BEFORE ROW trigger runs after the row is locked: row first, counter last. -1 = "deferred to the final statement"
      stmts.push(`CREATE OR REPLACE FUNCTION sync_seq_trigger() RETURNS trigger LANGUAGE plpgsql AS $fn$
        BEGIN IF NEW.sync_seq IS DISTINCT FROM -1 THEN
          UPDATE sync_counter SET seq = seq + 1 WHERE name = TG_ARGV[0] RETURNING seq INTO NEW.sync_seq;
        END IF; RETURN NEW; END $fn$`);
      stmts.push(`CREATE TRIGGER ${table}_seq BEFORE INSERT OR UPDATE ON ${table} FOR EACH ROW EXECUTE FUNCTION sync_seq_trigger('${table}')`);
    }
    return stmts;
  },
  /** One write as a list of statements run in ONE transaction (a single statement → the per-operation path). */
  write(variant, table, op) {
    if (variant === 'C1d' && op.lateMs) return deferredWrite(this, table, op);
    if (variant === 'C1d') variant = 'C1t';
    const { p, params } = builder();
    const syncSet = {
      C0: () => ['upd_ms', p(op.appMs)],
      C1defer: () => ['sync_seq', '-1'],
      C1n: () => ['sync_seq', `nextval('${table}_seq')`],
      C1x: () => ['sync_xid', 'pg_current_xact_id()'],
      C2: () => ['sync_us', this.nowUs],
    };
    if (op.type === 'insert') {
      const cols = ['id', 'version', 'deleted_at', 'payload'];
      const vals = [p(op.id), '1', 'NULL', p(op.payload)];
      if (variant === 'C1') {
        const name = p(table);
        return [
          {
            params,
            text: `WITH s AS (UPDATE sync_counter SET seq = seq + 1 WHERE name = ${name} RETURNING seq)
              INSERT INTO ${table} (${cols.join(', ')}, sync_seq) SELECT ${vals.join(', ')}, s.seq FROM s`,
          },
        ];
      }
      // C1t: the trigger sets the sequence
      const [col, val] = syncSet[variant]?.() ?? [];
      if (col) cols.push(col), vals.push(val);
      return [{ params, text: `INSERT INTO ${table} (${cols.join(', ')}) VALUES (${vals.join(', ')})` }];
    }
    const sets = ['version = version + 1'];
    if (op.type === 'update') sets.push(`payload = ${p(op.payload)}`);
    else sets.push('payload = NULL', 'deleted_at = clock_timestamp()');
    if (variant === 'C1') {
      const name = p(table);
      const id = p(op.id);
      return [
        {
          params,
          text: `WITH s AS (UPDATE sync_counter SET seq = seq + 1 WHERE name = ${name} RETURNING seq)
            UPDATE ${table} SET ${sets.join(', ')}, sync_seq = s.seq FROM s WHERE ${table}.id = ${id}`,
        },
      ];
    }
    const [col, val] = syncSet[variant]?.() ?? [];
    if (col) sets.push(`${col} = ${val}`);
    return [{ params, text: `UPDATE ${table} SET ${sets.join(', ')} WHERE id = ${p(op.id)}` }];
  },
  page(variant, table, pos, limit) {
    const { p, params } = builder();
    const base = `SELECT id, version, deleted_at IS NOT NULL AS deleted`;
    if (isSeq(variant)) {
      return {
        params,
        text: `${base}, sync_seq::text AS k FROM ${table} WHERE sync_seq > ${p(pos.k)}::bigint ORDER BY sync_seq LIMIT ${p(limit)}`,
      };
    }
    if (variant === 'C1x') {
      return {
        params,
        text: `${base}, sync_xid::text AS k FROM ${table}
          WHERE (sync_xid, id) > (${p(pos.k)}::xid8, ${p(pos.id)}) AND sync_xid < pg_snapshot_xmin(pg_current_snapshot())
          ORDER BY sync_xid, id LIMIT ${p(limit)}`,
      };
    }
    const col = variant === 'C0' ? 'upd_ms' : 'sync_us';
    return {
      params,
      text: `${base}, ${col}::text AS k FROM ${table} WHERE (${col}, id) > (${p(pos.k)}::bigint, ${p(pos.id)})
        ORDER BY ${col}, id LIMIT ${p(limit)}`,
    };
  },
  /** `n` rows in ONE statement with one identical sync key (C1: one counter bump, consecutive values). */
  backfill(variant, table, n, salt, appMs) {
    if (variant === 'C1d') variant = 'C1t';
    const { p, params } = builder();
    const id = `substr(md5(${p(salt)} || g::text), 1, 24)`;
    if (variant === 'C1') {
      const name = p(table);
      const count = p(n);
      return [
        {
          params,
          text: `WITH s AS (UPDATE sync_counter SET seq = seq + ${count}::bigint WHERE name = ${name} RETURNING seq - ${count}::bigint AS base)
            INSERT INTO ${table} (id, version, payload, sync_seq) SELECT ${id}, 1, 'b', s.base + g FROM s, generate_series(1, ${count}::int) g`,
        },
      ];
    }
    // Lazy, so only the chosen variant numbers a placeholder
    const [col, val] = {
      C0: () => ['upd_ms', p(appMs)],
      C1n: () => ['sync_seq', `nextval('${table}_seq')`],
      C1t: () => [],
      C1x: () => ['sync_xid', 'pg_current_xact_id()'],
      C2: () => ['sync_us', `(extract(epoch from now()) * 1000000)::bigint`],
    }[variant]();
    return [
      {
        params,
        text: `INSERT INTO ${table} (id, version, payload${col ? `, ${col}` : ''}) SELECT ${id}, 1, 'b'${col ? `, ${val}` : ''} FROM generate_series(1, ${p(n)}::int) g`,
      },
    ];
  },
  retryable: (error) => ['40P01', '40001'].includes(error?.code),
};

/** MySQL / MariaDB statements per variant (no RETURNING on UPDATE, no xid8). */
const mysqlDialect = {
  name: 'mysql',
  nowUs: `CAST(UNIX_TIMESTAMP(NOW(6)) * 1000000 AS SIGNED)`,
  ddl(variant, table) {
    const index = { C0: '(upd_ms, id)', C1: '(sync_seq)', C1d: '(sync_seq)', C1n: '(sync_seq)', C1t: '(sync_seq)', C2: '(sync_us, id)' }[variant];
    const stmts = [
      `CREATE TABLE ${table} (id varchar(32) PRIMARY KEY, version int NOT NULL, deleted_at datetime(6) NULL,
        payload text, upd_ms bigint, sync_seq bigint, sync_us bigint, INDEX k ${index}) ENGINE=InnoDB`,
    ];
    if (variant === 'C1n') stmts.push(`CREATE TABLE ${table}_seq (n bigint AUTO_INCREMENT PRIMARY KEY) ENGINE=InnoDB`);
    if (counterVariant(variant)) {
      stmts.push(`CREATE TABLE IF NOT EXISTS sync_counter (name varchar(64) PRIMARY KEY, seq bigint NOT NULL) ENGINE=InnoDB`);
      stmts.push(`INSERT INTO sync_counter (name, seq) VALUES ('${table}', 0)`);
    }
    if (triggerVariant(variant)) {
      const body = `BEGIN IF NEW.sync_seq IS NULL OR NEW.sync_seq <> -1 THEN
        UPDATE sync_counter SET seq = seq + 1 WHERE name = '${table}';
        SET NEW.sync_seq = (SELECT seq FROM sync_counter WHERE name = '${table}'); END IF; END`;
      stmts.push(`CREATE TRIGGER ${table}_bi BEFORE INSERT ON ${table} FOR EACH ROW ${body}`);
      stmts.push(`CREATE TRIGGER ${table}_bu BEFORE UPDATE ON ${table} FOR EACH ROW ${body}`);
    }
    return stmts;
  },
  write(variant, table, op) {
    if (variant === 'C1d' && op.lateMs) return deferredWrite(this, table, op);
    if (variant === 'C1d') variant = 'C1t';
    const pre = [];
    if (variant === 'C1') {
      pre.push({ params: [table], text: `UPDATE sync_counter SET seq = LAST_INSERT_ID(seq + 1) WHERE name = $1` });
    }
    if (variant === 'C1n') pre.push({ params: [], text: `INSERT INTO ${table}_seq () VALUES ()` });
    const { p, params } = builder();
    const syncVal = {
      C0: () => ['upd_ms', p(op.appMs)],
      C1: () => ['sync_seq', 'LAST_INSERT_ID()'],
      C1defer: () => ['sync_seq', '-1'],
      C1n: () => ['sync_seq', 'LAST_INSERT_ID()'],
      C1t: () => [],
      C2: () => ['sync_us', this.nowUs],
    }[variant];
    if (op.type === 'insert') {
      const [col, val] = syncVal();
      return [
        ...pre,
        {
          params,
          text: `INSERT INTO ${table} (id, version, deleted_at, payload${col ? `, ${col}` : ''}) VALUES (${p(op.id)}, 1, NULL, ${p(op.payload)}${col ? `, ${val}` : ''})`,
        },
      ];
    }
    const sets = ['version = version + 1'];
    if (op.type === 'update') sets.push(`payload = ${p(op.payload)}`);
    else sets.push('payload = NULL', 'deleted_at = NOW(6)');
    const [col, val] = syncVal();
    if (col) sets.push(`${col} = ${val}`);
    return [...pre, { params, text: `UPDATE ${table} SET ${sets.join(', ')} WHERE id = ${p(op.id)}` }];
  },
  page(variant, table, pos, limit) {
    const { p, params } = builder();
    const base = `SELECT id, version, deleted_at IS NOT NULL AS deleted`;
    if (isSeq(variant)) {
      return {
        params,
        text: `${base}, CAST(sync_seq AS CHAR) AS k FROM ${table} WHERE sync_seq > ${p(pos.k)} ORDER BY sync_seq LIMIT ${p(limit)}`,
      };
    }
    const col = variant === 'C0' ? 'upd_ms' : 'sync_us';
    const k = p(pos.k);
    return {
      params,
      text: `${base}, CAST(${col} AS CHAR) AS k FROM ${table} WHERE ${col} > ${k} OR (${col} = ${k} AND id > ${p(pos.id)})
        ORDER BY ${col}, id LIMIT ${p(limit)}`,
    };
  },
  backfill(variant, table, n, salt, appMs) {
    if (variant === 'C1d') variant = 'C1t';
    const rows = [];
    const { p, params } = builder();
    for (let i = 0; i < n; i++) {
      const id = p(`${salt}${String(i).padStart(8, '0')}`.slice(-24).padStart(24, '0'));
      const val = {
        C0: () => p(appMs),
        C1: () => `LAST_INSERT_ID() - ${n - 1 - i}`,
        C1n: () => 'NULL',
        C1t: () => 'NULL',
        C2: () => this.nowUs,
      }[variant]();
      rows.push(`(${id}, 1, 'b', ${val})`);
    }
    // C1t: the trigger overwrites the NULL
    const col = { C0: 'upd_ms', C1: 'sync_seq', C1n: 'sync_seq', C1t: 'sync_seq', C2: 'sync_us' }[variant];
    const stmts = [];
    if (variant === 'C1') {
      stmts.push({ params: [n, table], text: `UPDATE sync_counter SET seq = LAST_INSERT_ID(seq + $1) WHERE name = $2` });
    }
    stmts.push({ params, text: `INSERT INTO ${table} (id, version, payload, ${col}) VALUES ${rows.join(', ')}` });
    return stmts;
  },
  retryable: (error) => [1213, 1205].includes(error?.errno) || ['ER_LOCK_DEADLOCK', 'ER_LOCK_WAIT_TIMEOUT'].includes(error?.code),
};

/**
 * C1d in a long transaction: the row with the sentinel (the trigger leaves it alone, the row is locked), the wait, then
 * the final statement before COMMIT, which the trigger turns into the counter bump.
 */
function deferredWrite(dialect, table, op) {
  const [row] = dialect.write('C1defer', table, op);
  return [row, PAUSE, { params: [op.id], text: `UPDATE ${table} SET sync_seq = NULL WHERE id = $1` }];
}

function openSql(target, executor, dialect) {
  async function inTransaction(statements, lateMs) {
    if (statements.length === 1 && !lateMs) {
      // The per-operation path every store write takes (BEGIN, scope, statement, COMMIT pipelined)
      return executor.run(statements[0], SYSTEM);
    }
    return executor.transaction(async (tx) => {
      const paused = statements.includes(PAUSE);
      for (const statement of statements) {
        if (statement === PAUSE) await sleep(lateMs);
        else await tx.run(statement, SYSTEM);
      }
      if (lateMs && !paused) await sleep(lateMs);
    });
  }
  async function withRetry(fn) {
    for (let attempt = 0; ; attempt++) {
      try {
        return { retries: attempt, value: await fn() };
      } catch (error) {
        if (attempt < 8 && dialect.retryable(error)) continue;
        throw error;
      }
    }
  }
  return {
    kind: target.kind,
    async backfill(variant, table, n, salt, appMs) {
      const statements = dialect.backfill(variant, table, n, salt, appMs);
      return statements.length === 1 ? executor.run(statements[0], SYSTEM) : inTransaction(statements, 0);
    },
    close: () => executor.close(),
    async dbNowUs() {
      const { rows } = await executor.run({ params: [], text: `SELECT CAST(${dialect.nowUs} AS CHAR(24)) AS us` }, SYSTEM);
      return BigInt(String(rows[0].us).trim().split('.')[0]);
    },
    async finalState(table) {
      const { rows } = await executor.run({ params: [], text: `SELECT id, version, deleted_at IS NOT NULL AS deleted FROM ${table}` }, SYSTEM);
      return new Map(rows.map((r) => [r.id, { deleted: !!Number(r.deleted) || r.deleted === true, version: Number(r.version) }]));
    },
    async page(variant, table, pos, limit) {
      const { rows } = await executor.run(dialect.page(variant, table, pos, limit), SYSTEM);
      return rows.map((r) => ({
        deleted: r.deleted === true || Number(r.deleted) === 1,
        id: r.id,
        k: String(r.k),
        version: Number(r.version),
      }));
    },
    async setup(variant, table) {
      for (const text of dialect.ddl(variant, table)) await executor.run({ params: [], text }, SYSTEM);
    },
    async write(variant, table, op) {
      return withRetry(() => inTransaction(dialect.write(variant, table, op), op.lateMs));
    },
  };
}

// ---------------------------------------------------------------------------------------------
// MongoDB
// ---------------------------------------------------------------------------------------------

async function openMongo(target, dbName) {
  const client = await new MongoClient(target.url, { maxPoolSize: 20 }).connect();
  const db = client.db(dbName);
  const counters = db.collection('sync_counter');
  const keyField = { C0: 'updMs', C1: 'syncSeq', C2: 'syncAt' };

  /** The record write, optionally inside `session`. */
  async function writeDoc(variant, coll, op, seq, session) {
    const options = session ? { session } : {};
    if (variant === 'C2') {
      // The DATABASE clock: `$$NOW` is evaluated by the server, once per operation
      const set =
        op.type === 'insert'
          ? { deletedAt: null, payload: { $literal: op.payload }, syncAt: '$$NOW', version: 1 }
          : op.type === 'update'
            ? { payload: { $literal: op.payload }, syncAt: '$$NOW', version: { $add: ['$version', 1] } }
            : { deletedAt: '$$NOW', syncAt: '$$NOW', version: { $add: ['$version', 1] } };
      const pipeline = [{ $set: set }];
      if (op.type === 'delete') pipeline.push({ $unset: 'payload' });
      return coll.updateOne({ _id: op.id }, pipeline, { ...options, upsert: op.type === 'insert' });
    }
    const key = variant === 'C0' ? { updMs: op.appMs } : { syncSeq: seq };
    if (op.type === 'insert') {
      return coll.insertOne({ _id: op.id, deletedAt: null, payload: op.payload, version: 1, ...key }, options);
    }
    if (op.type === 'update') return coll.updateOne({ _id: op.id }, { $inc: { version: 1 }, $set: { payload: op.payload, ...key } }, options);
    return coll.updateOne({ _id: op.id }, { $inc: { version: 1 }, $set: { deletedAt: new Date(), ...key }, $unset: { payload: '' } }, options);
  }

  async function nextSeq(table, session, by = 1) {
    const doc = await counters.findOneAndUpdate({ _id: table }, { $inc: { seq: by } }, { returnDocument: 'after', session, upsert: true });
    return Number(doc.seq);
  }

  return {
    kind: 'mongo',
    async backfill(variant, table, n, salt, appMs) {
      const coll = db.collection(table);
      const docs = Array.from({ length: n }, (_, i) => ({
        _id: `${salt}${String(i).padStart(8, '0')}`.slice(-24).padStart(24, '0'),
        payload: 'b',
        version: 1,
      }));
      if (variant === 'C0') docs.forEach((d) => (d.updMs = appMs));
      if (variant === 'C1') {
        const top = await nextSeq(table, undefined, n);
        docs.forEach((d, i) => (d.syncSeq = top - n + 1 + i));
      }
      await coll.insertMany(docs, { ordered: false });
      if (variant === 'C2') {
        // One command, one `$$NOW`: every row gets the identical database time
        await coll.updateMany({ _id: { $in: docs.map((d) => d._id) } }, [{ $set: { syncAt: '$$NOW' } }]);
      }
    },
    close: () => client.close(),
    async dbNowUs() {
      const [doc] = await db.aggregate([{ $documents: [{}] }, { $project: { now: '$$NOW' } }]).toArray();
      return BigInt(doc.now.getTime()) * 1000n;
    },
    async finalState(table) {
      const docs = await db.collection(table).find({}, { projection: { deletedAt: 1, version: 1 } }).toArray();
      return new Map(docs.map((d) => [d._id, { deleted: d.deletedAt != null, version: d.version }]));
    },
    async page(variant, table, pos, limit) {
      const field = keyField[variant];
      let filter = {};
      if (variant === 'C1') filter = { syncSeq: { $gt: Number(pos.k) } };
      else if (BigInt(pos.k) >= 0n) {
        const at = variant === 'C2' ? new Date(Number(BigInt(pos.k) / 1000n)) : Number(pos.k);
        filter = { $or: [{ [field]: { $gt: at } }, { [field]: at, _id: { $gt: pos.id } }] };
      }
      const sort = variant === 'C1' ? { syncSeq: 1 } : { [field]: 1, _id: 1 };
      const docs = await db.collection(table).find(filter).sort(sort).limit(limit).toArray();
      return docs.map((d) => ({
        deleted: d.deletedAt != null,
        id: d._id,
        k: variant === 'C2' ? String(BigInt(d.syncAt.getTime()) * 1000n) : String(d[field]),
        version: d.version,
      }));
    },
    async setup(variant, table) {
      const coll = db.collection(table);
      await coll.createIndex(variant === 'C1' ? { syncSeq: 1 } : { [keyField[variant]]: 1, _id: 1 });
      if (variant === 'C1') await counters.updateOne({ _id: table }, { $setOnInsert: { seq: 0 } }, { upsert: true });
    },
    async write(variant, table, op) {
      const coll = db.collection(table);
      if (target.transactions && op.lateMs && process.env.MONGO_TXN_NO_RETRY === '1') {
        // One attempt, no withTransaction retry: a transaction the server expired (transactionLifetimeLimitSeconds)
        // fails its commit and is counted as an error — it never becomes visible
        const session = client.startSession();
        try {
          session.startTransaction();
          const seq = variant === 'C1' ? await nextSeq(table, session) : undefined;
          await writeDoc(variant, coll, op, seq, session);
          await sleep(op.lateMs);
          await session.commitTransaction();
        } catch (error) {
          await session.abortTransaction().catch(() => undefined);
          throw error;
        } finally {
          await session.endSession();
        }
        return { retries: 0 };
      }
      if (target.transactions && (op.lateMs || variant === 'C1')) {
        // Replica set: C1 always writes counter + record in one transaction; a late commit holds it open
        let attempts = 0;
        const session = client.startSession();
        try {
          await session.withTransaction(async () => {
            attempts++;
            const seq = variant === 'C1' ? await nextSeq(table, session) : undefined;
            await writeDoc(variant, coll, op, seq, session);
            if (op.lateMs) await sleep(op.lateMs);
          });
        } finally {
          await session.endSession();
        }
        return { retries: attempts - 1 };
      }
      // Standalone (no transactions): C1 takes the counter, then writes — two operations, the in-flight gap is real.
      // A "late" write is the pause between taking its key and making it visible: for C0 between the app clock and
      // the write, for C1 between the counter and the write. C2 takes its key INSIDE the write, so it has none.
      if (variant === 'C1') {
        const seq = await nextSeq(table);
        if (op.lateMs) await sleep(op.lateMs);
        await writeDoc(variant, coll, op, seq);
      } else {
        if (op.lateMs && variant === 'C0') await sleep(op.lateMs);
        await writeDoc(variant, coll, op);
      }
      return { retries: 0 };
    },
  };
}
