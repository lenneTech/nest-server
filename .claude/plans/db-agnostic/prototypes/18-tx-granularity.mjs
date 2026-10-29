// Transaction granularity on a tenant-scoped table with RLS (FORCE, non-owner app role, guard function):
//   B  per operation, naive:     BEGIN · set_config($1) · statement · COMMIT        (4 round trips)
//   C  per operation, optimized: "BEGIN; SELECT set_config('…', <literal>, true)" · statement · COMMIT  (3)
//   D  per request (5 ops):      BEGIN+set_config · 5 statements · COMMIT          (7 for 5 ops = 1.4 per op)
//   A  baseline: the bare statement on a table without RLS                            (1)
// Each "operation" is a primary-key read, the most common store call. Sequential latency and throughput with
// 10 concurrent requests on a pool of 10.
import pg from 'pg';

const OWNER = 'postgres://proto_owner:proto@127.0.0.1:5434/proto';
const APP = 'postgres://app_user:app@127.0.0.1:5434/proto';
const owner = new pg.Pool({ connectionString: OWNER, max: 2 });
await owner.query(`
  DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='app_user') THEN DROP OWNED BY app_user; DROP ROLE app_user; END IF; END $$;
  CREATE ROLE app_user LOGIN PASSWORD 'app' NOBYPASSRLS;
  CREATE OR REPLACE FUNCTION app_current_tenant() RETURNS text LANGUAGE plpgsql STABLE AS $f$ DECLARE v text := current_setting('app.tenant_id', true);
    BEGIN IF v IS NULL OR v = '' THEN RAISE EXCEPTION 'tenant context missing' USING ERRCODE = 'insufficient_privilege'; END IF; RETURN v; END $f$;
  DROP TABLE IF EXISTS docs; CREATE TABLE docs (id text PRIMARY KEY, tenant_id text NOT NULL, name text);
  DROP TABLE IF EXISTS plain; CREATE TABLE plain (id text PRIMARY KEY, name text);
  INSERT INTO docs SELECT 'd' || g, CASE WHEN g % 2 = 0 THEN 't1' ELSE 't2' END, 'n' || g FROM generate_series(1, 10000) g;
  INSERT INTO plain SELECT 'd' || g, 'n' || g FROM generate_series(1, 10000) g;
  ALTER TABLE docs ENABLE ROW LEVEL SECURITY; ALTER TABLE docs FORCE ROW LEVEL SECURITY;
  CREATE POLICY ti ON docs USING (tenant_id = (SELECT app_current_tenant()));
  GRANT SELECT ON docs, plain TO app_user;`);
await owner.end();

const pool = new pg.Pool({ connectionString: APP, max: 10 });
const piped = new pg.Pool({ connectionString: APP, max: 10, pipeline: true });
const id = (k) => `d${(k % 5000) * 2 + 2}`; // tenant t1 rows

const modes = {
  'A bare statement, no RLS table': async (k) => { await pool.query('SELECT * FROM plain WHERE id = $1', [id(k)]); },
  'B per operation, naive': async (k) => {
    const c = await pool.connect();
    try { await c.query('BEGIN'); await c.query("SELECT set_config('app.tenant_id', $1, true)", ['t1']); await c.query('SELECT * FROM docs WHERE id = $1', [id(k)]); await c.query('COMMIT'); } finally { c.release(); }
  },
  'C per operation, optimized': async (k) => {
    const c = await pool.connect();
    try { await c.query(`BEGIN; SELECT set_config('app.tenant_id', ${c.escapeLiteral('t1')}, true)`); await c.query('SELECT * FROM docs WHERE id = $1', [id(k)]); await c.query('COMMIT'); } finally { c.release(); }
  },
  'E per operation, pipelined': async (k) => {
    const c = await piped.connect();
    try {
      const steps = [c.query('BEGIN'), c.query("SELECT set_config('app.tenant_id', $1, true)", ['t1']), c.query('SELECT * FROM docs WHERE id = $1', [id(k)]), c.query('COMMIT')];
      const [, , result] = await Promise.all(steps);
      if (!result.rows.length) throw new Error('row not visible');
    } finally { c.release(); }
  },
};
const perRequest = async (k) => {
  const c = await pool.connect();
  try {
    await c.query(`BEGIN; SELECT set_config('app.tenant_id', ${c.escapeLiteral('t1')}, true)`);
    for (let i = 0; i < 5; i++) await c.query('SELECT * FROM docs WHERE id = $1', [id(k * 5 + i)]);
    await c.query('COMMIT');
  } finally { c.release(); }
};

const N = 4000;
const time = async (fn) => { const t = performance.now(); await fn(); return performance.now() - t; };
const conc = async (n, fn) => { let i = 0; await Promise.all(Array.from({ length: 10 }, async () => { while (i < n) { const k = i++; await fn(k); } })); };

const rows = [];
for (const [name, fn] of Object.entries(modes)) {
  for (let w = 0; w < 300; w++) await fn(w); // warm-up
  const seq = await time(async () => { for (let k = 0; k < N; k++) await fn(k); });
  const par = await time(() => conc(N, fn));
  rows.push([name, (seq / N) * 1000, N / (par / 1000)]);
}
for (let w = 0; w < 60; w++) await perRequest(w);
const seqD = await time(async () => { for (let k = 0; k < N / 5; k++) await perRequest(k); });
const parD = await time(() => conc(N / 5, perRequest));
rows.push(['D per request (5 ops)', (seqD / N) * 1000, N / (parD / 1000)]);

console.log('mode                              µs/op (sequential)   ops/s (10 concurrent, pool 10)');
for (const [name, us, ops] of rows) console.log(`${name.padEnd(34)}${us.toFixed(0).padStart(10)}${ops.toFixed(0).padStart(24)}`);
await pool.end();
await piped.end();
