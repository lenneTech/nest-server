// Phase 6, decision A5: would a trigger write guard on MySQL / MariaDB tenant tables be worth it?
//
// MySQL and MariaDB have no row-level security. The closest database-side guard: BEFORE INSERT / UPDATE / DELETE
// triggers that refuse a write unless the session carries a tenant scope (user variables the store would set), and a
// write into another tenant than the scope's. Measured here against the store's current path (one autocommitted
// statement per write), on both servers:
//   1. cost: writes per second and latency, baseline vs. guarded (SET scope + write + RESET scope; the reset is
//      required, see 3.)
//   2. what it stops: a native write without a scope, a write into a foreign tenant
//   3. what it does not stop: a native READ of every tenant (triggers do not fire on SELECT), a write on a pooled
//      connection whose scope a previous caller left set, native code that sets the variables itself
//
// A user variable carries the CONNECTION's collation, not the column's: the comparison needs an explicit COLLATE, or the
// trigger fails on every write with "Illegal mix of collations" (found on the first run).
//
// Env: MYSQL_URL / MARIADB_URL (an account that may create tables and triggers); defaults are the README's containers.
import mysql from 'mysql2/promise';

const TARGETS = [
  { name: 'MySQL 8.4', url: process.env.MYSQL_URL ?? 'mysql://root:proto@127.0.0.1:3308/proto' },
  { name: 'MariaDB 11.8', url: process.env.MARIADB_URL ?? 'mysql://root:proto@127.0.0.1:3307/proto' },
];
const WRITES = Number(process.env.WRITES ?? 4000);
const CONCURRENCY = 8;

const percentile = (values, p) => values.sort((a, b) => a - b)[Math.min(values.length - 1, Math.floor(values.length * p))];

async function measure(label, write) {
  const latencies = [];
  let next = 0;
  const started = performance.now();
  await Promise.all(
    Array.from({ length: CONCURRENCY }, async () => {
      while (next < WRITES) {
        const n = next++;
        const t = performance.now();
        await write(n);
        latencies.push(performance.now() - t);
      }
    }),
  );
  const seconds = (performance.now() - started) / 1000;
  return {
    label,
    'writes/s': Math.round(WRITES / seconds),
    'p50 ms': percentile(latencies, 0.5).toFixed(2),
    'p95 ms': percentile(latencies, 0.95).toFixed(2),
  };
}

const refused = (promise) =>
  promise.then(
    () => false,
    (error) => error.sqlState === '42501' || /tenant/i.test(error.message),
  );

for (const target of TARGETS) {
  const pool = mysql.createPool({ connectionLimit: CONCURRENCY, multipleStatements: false, uri: target.url });
  const q = (sql, values) => pool.query(sql, values);
  await q('DROP TABLE IF EXISTS proto_notes');
  await q(
    'CREATE TABLE proto_notes (id varchar(24) PRIMARY KEY, tenant_id varchar(255), body longtext, KEY (tenant_id)) COLLATE utf8mb4_bin',
  );

  // 1a. Baseline: what the store does today — one autocommitted statement per write
  const rows = [];
  rows.push(
    await measure('baseline: INSERT', (n) => q('INSERT INTO proto_notes VALUES (?, ?, ?)', [`b${n}`, `t${n % 4}`, 'x'])),
  );
  rows.push(
    await measure('baseline: UPDATE', (n) =>
      q('UPDATE proto_notes SET body = ? WHERE id = ? AND tenant_id = ?', ['y', `b${n}`, `t${n % 4}`]),
    ),
  );

  // The guard
  for (const event of ['INSERT', 'UPDATE', 'DELETE']) {
    const row = event === 'DELETE' ? 'OLD' : 'NEW';
    await q(`DROP TRIGGER IF EXISTS proto_notes_guard_${event.toLowerCase()}`);
    await q(`CREATE TRIGGER proto_notes_guard_${event.toLowerCase()} BEFORE ${event} ON proto_notes FOR EACH ROW
      BEGIN
        IF @lt_scope IS NULL THEN
          SIGNAL SQLSTATE '42501' SET MESSAGE_TEXT = 'tenant-scoped data written without a tenant context';
        END IF;
        IF @lt_scope = 'tenant' AND ${row}.tenant_id <> CONVERT(@lt_tenant USING utf8mb4) COLLATE utf8mb4_bin THEN
          SIGNAL SQLSTATE '42501' SET MESSAGE_TEXT = 'tenant-scoped data written into another tenant';
        END IF;
      END`);
  }

  // 1b. Guarded: the store would have to pin a connection, set the scope, write, and reset — three round trips
  const guarded = async (sql, values, tenant) => {
    const connection = await pool.getConnection();
    try {
      await connection.query("SET @lt_scope = 'tenant', @lt_tenant = ?", [tenant]);
      await connection.query(sql, values);
    } finally {
      await connection.query('SET @lt_scope = NULL, @lt_tenant = NULL');
      connection.release();
    }
  };
  rows.push(
    await measure('guarded: INSERT', (n) =>
      guarded('INSERT INTO proto_notes VALUES (?, ?, ?)', [`g${n}`, `t${n % 4}`, 'x'], `t${n % 4}`),
    ),
  );
  rows.push(
    await measure('guarded: UPDATE', (n) =>
      guarded('UPDATE proto_notes SET body = ? WHERE id = ? AND tenant_id = ?', ['y', `g${n}`, `t${n % 4}`], `t${n % 4}`),
    ),
  );
  console.log(`\n== ${target.name} (${WRITES} writes, ${CONCURRENCY} concurrent)`);
  console.table(rows);

  // 2. What it stops
  const findings = [];
  findings.push([
    'native INSERT without a scope refused',
    await refused(q("INSERT INTO proto_notes VALUES ('n1', 't0', 'x')")),
  ]);
  findings.push([
    'INSERT into a foreign tenant refused',
    await refused(guarded("INSERT INTO proto_notes VALUES ('n2', 't1', 'x')", [], 't0')),
  ]);

  // 3. What it does not stop
  const [[{ n }]] = await q('SELECT COUNT(DISTINCT tenant_id) AS n FROM proto_notes');
  findings.push(['native SELECT reads every tenant (no guard on reads)', Number(n) === 4]);
  const leaky = await pool.getConnection();
  await leaky.query("SET @lt_scope = 'system'");
  leaky.release();
  // Whichever connection the pool hands out next: with a single idle one left set, a scope-less native write passes
  const reused = await pool.getConnection();
  const [[{ scope }]] = await reused.query('SELECT @lt_scope AS scope');
  let passed = false;
  if (scope === 'system') {
    passed = !(await refused(reused.query("INSERT INTO proto_notes VALUES ('n3', 't2', 'x')")));
  }
  await reused.query('SET @lt_scope = NULL');
  reused.release();
  findings.push(['a scope left on a pooled connection authorizes the next writer', scope === 'system' ? passed : 'n/a (other connection)']);
  const native = await pool.getConnection();
  await native.query("SET @lt_scope = 'system'");
  findings.push([
    'native code that sets the variable itself passes',
    !(await refused(native.query("INSERT INTO proto_notes VALUES ('n4', 't3', 'x')"))),
  ]);
  await native.query('SET @lt_scope = NULL');
  native.release();
  console.table(findings.map(([finding, result]) => ({ finding, result })));

  await q('DROP TABLE proto_notes');
  await pool.end();
}
