/**
 * Why C2 (database clock + window W) lost changes on MySQL: which instant does each database clock function stamp
 * when the writing statement first WAITS for a row lock?
 *
 *   node commit-lag-probe.mjs
 *
 * T1 locks a row and holds it for 3 s; T2 updates the same row, stamping it with each clock function, and commits right
 * after the lock is released. Printed: stamp − T2's statement start and commit − stamp, in ms. A function that stamps
 * the statement START puts the lock wait into the commit lag — a write that waits longer than W lands behind a cursor.
 */
import { createConnection } from 'mysql2/promise';
import pg from 'pg';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const HOLD_MS = 3000;

async function postgres() {
  const cfg = { host: '127.0.0.1', password: 'nest-owner-secret', port: 5440, user: 'nest_owner' };
  const db = 'nest_server_proto_test_lag';
  const admin = new pg.Client({ ...cfg, database: 'postgres' });
  await admin.connect();
  await admin.query(`DROP DATABASE IF EXISTS "${db}" WITH (FORCE)`);
  await admin.query(`CREATE DATABASE "${db}"`);
  const [t1, t2] = [new pg.Client({ ...cfg, database: db }), new pg.Client({ ...cfg, database: db })];
  await t1.connect();
  await t2.connect();
  await t1.query(`CREATE TABLE r (id int PRIMARY KEY, a bigint, b bigint)`);
  await t1.query(`INSERT INTO r VALUES (1, 0, 0)`);
  const us = (expr) => `(extract(epoch from ${expr}) * 1000000)::bigint`;
  await t1.query('BEGIN');
  await t1.query('UPDATE r SET a = 0 WHERE id = 1');
  const started = Date.now();
  await t2.query('BEGIN');
  const update = t2.query(`UPDATE r SET a = ${us('clock_timestamp()')}, b = ${us('now()')} WHERE id = 1`);
  await sleep(HOLD_MS);
  await t1.query('COMMIT');
  await update;
  await t2.query('COMMIT');
  const committed = Date.now();
  const { rows } = await t2.query('SELECT a, b FROM r WHERE id = 1');
  const out = {
    'clock_timestamp()': Number(BigInt(rows[0].a) / 1000n),
    'now()': Number(BigInt(rows[0].b) / 1000n),
  };
  await t1.end();
  await t2.end();
  await admin.query(`DROP DATABASE IF EXISTS "${db}" WITH (FORCE)`);
  await admin.end();
  return report('postgres', out, started, committed);
}

async function mysql(name, port) {
  const cfg = { host: '127.0.0.1', password: 'nest-owner-secret', port, user: 'nest_owner' };
  const db = 'nest_server_proto_test_lag';
  const [t1, t2] = [await createConnection(cfg), await createConnection(cfg)];
  await t1.query(`DROP DATABASE IF EXISTS \`${db}\``);
  await t1.query(`CREATE DATABASE \`${db}\``);
  await t1.query(`USE \`${db}\``);
  await t2.query(`USE \`${db}\``);
  await t1.query(`CREATE TABLE r (id int PRIMARY KEY, a bigint, b bigint) ENGINE=InnoDB`);
  await t1.query(`INSERT INTO r VALUES (1, 0, 0)`);
  const us = (expr) => `CAST(UNIX_TIMESTAMP(${expr}) * 1000000 AS SIGNED)`;
  await t1.query('BEGIN');
  await t1.query('UPDATE r SET a = 0 WHERE id = 1');
  const started = Date.now();
  await t2.query('BEGIN');
  const update = t2.query(`UPDATE r SET a = ${us('NOW(6)')}, b = ${us('SYSDATE(6)')} WHERE id = 1`);
  await sleep(HOLD_MS);
  await t1.query('COMMIT');
  await update;
  await t2.query('COMMIT');
  const committed = Date.now();
  const [rows] = await t2.query('SELECT a, b FROM r WHERE id = 1');
  const out = { 'NOW(6)': Math.floor(Number(rows[0].a) / 1000), 'SYSDATE(6)': Math.floor(Number(rows[0].b) / 1000) };
  await t1.query(`DROP DATABASE IF EXISTS \`${db}\``);
  await t1.end();
  await t2.end();
  return report(name, out, started, committed);
}

function report(target, stamps, started, committed) {
  // The containers' clocks and the host's agree to a few ms; the 3 s lock wait dominates either way
  return Object.entries(stamps).map(
    ([fn, at]) => `${target} ${fn}: stamp − statement start ${at - started} ms, commit − stamp ${committed - at} ms`,
  );
}

for (const line of [...(await postgres()), ...(await mysql('mysql', 3316)), ...(await mysql('mariadb', 3317))]) {
  console.log(line);
}
