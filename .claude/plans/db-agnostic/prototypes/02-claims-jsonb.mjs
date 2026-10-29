// A4: atomic claim / lease under N parallel workers.  A5: atomic JSONB push (+ slice) and pull.
import { Kysely, PostgresDialect, sql } from 'kysely';
import pg from 'pg';

const db = new Kysely({
  dialect: new PostgresDialect({ pool: new pg.Pool({ connectionString: 'postgres://proto_owner:proto@127.0.0.1:5434/proto', max: 20 }) }),
});
const results = [];
const check = (name, ok, detail = '') => results.push({ name, ok, detail });

await sql.raw(`
  DROP TABLE IF EXISTS locks; DROP TABLE IF EXISTS entity;
  CREATE TABLE locks (key text PRIMARY KEY, owner text NOT NULL, expires_at timestamptz NOT NULL);
  CREATE TABLE entity (id text PRIMARY KEY, logs jsonb NOT NULL DEFAULT '[]'::jsonb, tags jsonb NOT NULL DEFAULT '[]'::jsonb);
`).execute(db);

// --- A4: tryAcquire(key, ttl) -> token | null; stale takeover in the SAME statement ---
const tryAcquire = async (key, owner, ttlMs) => {
  const row = await sql`
    INSERT INTO locks (key, owner, expires_at) VALUES (${key}, ${owner}, now() + ${`${ttlMs} milliseconds`}::interval)
    ON CONFLICT (key) DO UPDATE SET owner = EXCLUDED.owner, expires_at = EXCLUDED.expires_at
      WHERE locks.expires_at < now()
    RETURNING owner`.execute(db);
  return row.rows[0]?.owner === owner ? owner : null;
};
const release = (key, owner) => sql`DELETE FROM locks WHERE key = ${key} AND owner = ${owner}`.execute(db);

for (let round = 0; round < 20; round++) {
  const key = `claim-${round}`;
  const workers = Array.from({ length: 16 }, (_, i) => tryAcquire(key, `w${i}`, 5000));
  const won = (await Promise.all(workers)).filter(Boolean);
  if (won.length !== 1) { check(`round ${round}: exactly one winner`, false, String(won.length)); break; }
}
if (!results.length) check('20 rounds x 16 parallel workers: exactly one winner each', true);

// stale takeover: an expired lease is taken over atomically by exactly one contender
await sql`INSERT INTO locks VALUES ('stale', 'dead', now() - interval '1 second')`.execute(db);
const takeover = (await Promise.all(Array.from({ length: 16 }, (_, i) => tryAcquire('stale', `t${i}`, 5000)))).filter(Boolean);
check('expired lease taken over by exactly one contender', takeover.length === 1, takeover.join(','));
// token-scoped release: a foreign owner cannot release
const r1 = await release('stale', 'not-the-owner');
const still = await sql`SELECT owner FROM locks WHERE key='stale'`.execute(db);
check('foreign owner cannot release', Number(r1.numAffectedRows ?? 0) === 0 && still.rows.length === 1);

// --- A5: atomic JSONB push with slice (keep last N) and pull by condition ---
await sql`INSERT INTO entity (id) VALUES ('e1')`.execute(db);
const push = (id, items, keepLast) =>
  keepLast
    ? sql`UPDATE entity SET logs = (
          SELECT coalesce(jsonb_agg(e ORDER BY ord), '[]'::jsonb) FROM (
            SELECT e, ord FROM jsonb_array_elements(logs || ${JSON.stringify(items)}::jsonb) WITH ORDINALITY AS t(e, ord)
            ORDER BY ord DESC LIMIT ${keepLast}) s)
        WHERE id = ${id}`.execute(db)
    : sql`UPDATE entity SET logs = logs || ${JSON.stringify(items)}::jsonb WHERE id = ${id}`.execute(db);
// 50 concurrent pushes of 1 item each, capped at 30 -> must end with exactly 30 and no lost update
await Promise.all(Array.from({ length: 50 }, (_, i) => push('e1', [{ n: i }], 30)));
const afterPush = await sql`SELECT jsonb_array_length(logs) AS len FROM entity WHERE id='e1'`.execute(db);
check('50 concurrent capped pushes keep exactly 30 (no lost update)', Number(afterPush.rows[0].len) === 30, String(afterPush.rows[0].len));
// uncapped concurrent pushes lose nothing
await sql`UPDATE entity SET tags='[]'::jsonb WHERE id='e1'`.execute(db);
await Promise.all(Array.from({ length: 40 }, (_, i) => sql`UPDATE entity SET tags = tags || ${JSON.stringify([`t${i % 4}`])}::jsonb WHERE id='e1'`.execute(db)));
const tagsLen = await sql`SELECT jsonb_array_length(tags) AS len FROM entity WHERE id='e1'`.execute(db);
check('40 concurrent pushes all land', Number(tagsLen.rows[0].len) === 40, String(tagsLen.rows[0].len));
// pull: remove every element equal to a scalar, and every object matching a condition
await sql`UPDATE entity SET tags = (SELECT coalesce(jsonb_agg(e), '[]'::jsonb) FROM jsonb_array_elements(tags) e WHERE e <> ${JSON.stringify('t1')}::jsonb) WHERE id='e1'`.execute(db);
const pulled = await sql`SELECT tags FROM entity WHERE id='e1'`.execute(db);
check('pull scalar removes all occurrences', !pulled.rows[0].tags.includes('t1') && pulled.rows[0].tags.length === 30, String(pulled.rows[0].tags.length));
await sql`UPDATE entity SET logs = (SELECT coalesce(jsonb_agg(e), '[]'::jsonb) FROM jsonb_array_elements(logs) e WHERE NOT (e @> ${JSON.stringify({ n: 49 })}::jsonb)) WHERE id='e1'`.execute(db);
const pulledObj = await sql`SELECT logs FROM entity WHERE id='e1'`.execute(db);
check('pull by object condition ($pull {n:49})', !pulledObj.rows[0].logs.some((l) => l.n === 49) && pulledObj.rows[0].logs.length === 29);

for (const r of results) console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.name}${r.detail ? `  — ${r.detail}` : ''}`);
console.log(results.every((r) => r.ok) ? 'ALL PASS' : 'SOME FAILED');
await db.destroy();
