/**
 * PostgreSQL: the per-model counter row against an advisory lock plus a sequence, with and without a snapshot held
 * open elsewhere (PLAN.md §3.4, "PostgreSQL keeps a version per counter update" — handed to phase 3, DEV-3900).
 *
 *   node pg-counter-snapshot.mjs [seconds per run, default 20] [writers, default 8]
 *
 * Both variants stamp `sync_seq` in a BEFORE INSERT OR UPDATE row trigger, so a write takes its row first and the
 * order last (C1d's single-row path):
 *
 *   row       UPDATE lt_sync_counters SET seq = seq + 1 … RETURNING seq — one dead row version per write
 *   advisory  pg_advisory_xact_lock(<model>) + nextval(<sequence>) — no row version; the lock is released only after
 *             the commit is visible, so allocation order is commit order as with the row lock
 *
 * A held snapshot (REPEATABLE READ, one SELECT, then idle) keeps every dead version alive; the row variant then walks
 * a growing version chain on each write. The run reports writes/s per 5 s bucket so a decline is visible, and checks
 * that sync_seq is gap-free and unique at the end (both variants number in commit order).
 *
 * The credentials are the local test-container defaults, not secrets. The database carries the drop guard's `test`
 * segment and is dropped at the end.
 */
import pg from 'pg';

const SECONDS = Number(process.argv[2] || 20);
const WRITERS = Number(process.argv[3] || 8);
const HOST = process.env.PG_HOST || '127.0.0.1';
const PORT = Number(process.env.PG_PORT || 5440);
const USER = process.env.PG_OWNER_USER || 'nest_owner';
const PASSWORD = process.env.PG_OWNER_PASSWORD || 'nest-owner-secret';
const DB = `nest_server_proto_test_counter_${process.pid}`;

const url = (db) => `postgres://${USER}:${PASSWORD}@${HOST}:${PORT}/${db}`;

const TRIGGERS = {
  advisory: `
    CREATE SEQUENCE t_sync_seq;
    CREATE FUNCTION stamp() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      IF TG_OP = 'INSERT' OR NEW.sync_seq IS NOT DISTINCT FROM OLD.sync_seq THEN
        PERFORM pg_advisory_xact_lock(hashtext('t'));
        NEW.sync_seq := nextval('t_sync_seq');
      END IF;
      RETURN NEW;
    END $$;`,
  row: `
    CREATE TABLE lt_sync_counters (model text PRIMARY KEY, seq bigint NOT NULL);
    INSERT INTO lt_sync_counters VALUES ('t', 0);
    CREATE FUNCTION stamp() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      IF TG_OP = 'INSERT' OR NEW.sync_seq IS NOT DISTINCT FROM OLD.sync_seq THEN
        UPDATE lt_sync_counters SET seq = seq + 1 WHERE model = 't' RETURNING seq INTO NEW.sync_seq;
      END IF;
      RETURN NEW;
    END $$;`,
};

async function run(variant, holdSnapshot) {
  const admin = new pg.Client({ connectionString: url('postgres') });
  await admin.connect();
  await admin.query(`CREATE DATABASE ${DB}`);
  const setup = new pg.Client({ connectionString: url(DB) });
  await setup.connect();
  await setup.query(`CREATE TABLE t (id serial PRIMARY KEY, v int NOT NULL DEFAULT 0, sync_seq bigint)`);
  await setup.query(TRIGGERS[variant]);
  await setup.query(`CREATE TRIGGER stamp BEFORE INSERT OR UPDATE ON t FOR EACH ROW EXECUTE FUNCTION stamp()`);
  await setup.query(`INSERT INTO t (v) SELECT 0 FROM generate_series(1, 1000)`);

  let snapshot;
  if (holdSnapshot) {
    snapshot = new pg.Client({ connectionString: url(DB) });
    await snapshot.connect();
    await snapshot.query('BEGIN ISOLATION LEVEL REPEATABLE READ');
    await snapshot.query('SELECT count(*) FROM t');
  }

  const buckets = [];
  const start = Date.now();
  const end = start + SECONDS * 1000;
  let errors = 0;
  const writers = await Promise.all(
    Array.from({ length: WRITERS }, async () => {
      const client = new pg.Client({ connectionString: url(DB) });
      await client.connect();
      return client;
    }),
  );
  await Promise.all(
    writers.map(async (client) => {
      while (Date.now() < end) {
        try {
          if (Math.random() < 0.3) {
            await client.query('INSERT INTO t (v) VALUES (1)');
          } else {
            await client.query('UPDATE t SET v = v + 1 WHERE id = $1', [1 + Math.floor(Math.random() * 1000)]);
          }
          const bucket = Math.floor((Date.now() - start) / 5000);
          buckets[bucket] = (buckets[bucket] ?? 0) + 1;
        } catch {
          errors++;
        }
      }
    }),
  );
  await Promise.all(writers.map((client) => client.end()));
  if (snapshot) {
    await snapshot.query('ROLLBACK');
    await snapshot.end();
  }

  const { rows } = await setup.query(
    `SELECT count(*)::int AS n, count(DISTINCT sync_seq)::int AS distinct_seq, min(sync_seq)::text AS min, max(sync_seq)::text AS max FROM t`,
  );
  await setup.end();
  await admin.query(`DROP DATABASE ${DB}`);
  await admin.end();

  const total = buckets.reduce((sum, count) => sum + (count ?? 0), 0);
  const perBucket = buckets.map((count) => Math.round((count ?? 0) / 5)).join(' / ');
  console.log(
    `${variant.padEnd(8)} snapshot=${holdSnapshot ? 'held' : 'none'} — ${Math.round(total / SECONDS)} writes/s ` +
      `(per 5 s: ${perBucket}), errors ${errors}, rows ${rows[0].n}, distinct sync_seq ${rows[0].distinct_seq}, ` +
      `range ${rows[0].min}…${rows[0].max}`,
  );
}

for (const holdSnapshot of [false, true]) {
  for (const variant of ['row', 'advisory']) {
    await run(variant, holdSnapshot);
  }
}
