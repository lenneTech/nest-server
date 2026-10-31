/**
 * P2-4 (protocol §15, PLAN.md §3.6 / E3): does a unique index ignore tombstones on every target, with MongoDB's
 * semantics for a live NULL?
 *
 *   node partial-unique.mjs
 *
 * Per target, one table/collection with a unique index on `email` that covers live records only:
 *   MongoDB          { email: 1 }, partialFilterExpression { deletedAt: { $type: 'null' } }
 *   PostgreSQL       UNIQUE (email) NULLS NOT DISTINCT WHERE deleted_at IS NULL — and, for comparison, without
 *                    NULLS NOT DISTINCT (what the framework's compiler emits today for any partial unique index)
 *   MySQL / MariaDB  VIRTUAL live_email = IF(deleted_at IS NULL, IFNULL(email, CHAR(0)), NULL), UNIQUE (live_email)
 *
 * Expected on every target (MongoDB's answer is the reference):
 *   1 live 'a'                         → ok
 *   2 second live 'a'                  → refused
 *   3 tombstone the first, live 'a'    → ok
 *   4 a second tombstone 'a'           → ok
 *   5 live NULL, second live NULL      → refused (a non-sparse MongoDB unique index treats null as a value)
 *   6 MongoDB only: live without the `deletedAt` field → NOT in the index, a duplicate passes (why live records
 *     must carry `deletedAt: null`)
 *   7 MongoDB only: which query uses the index — `$type: 'null'` vs `null`
 */
import { randomBytes } from 'node:crypto';

import { MongoClient } from 'mongodb';
import { createConnection } from 'mysql2/promise';
import pg from 'pg';

const id = () => randomBytes(12).toString('hex');
const DB = 'nest_server_proto_test_unique';
const results = [];

async function attempt(label, fn) {
  try {
    await fn();
    return `${label}: ok`;
  } catch (error) {
    return `${label}: refused (${error.code ?? error.errno ?? error.codeName ?? 'error'})`;
  }
}

async function mongo(name, url) {
  const client = await new MongoClient(url).connect();
  const db = client.db(`nest-server-proto-test-unique-${name}`);
  const c = db.collection('people');
  await c.drop().catch(() => undefined);
  const out = [];
  out.push(
    await attempt('index { deletedAt: null }', () =>
      db.collection('probe_null').createIndex({ email: 1 }, { partialFilterExpression: { deletedAt: null }, unique: true }),
    ),
  );
  await c.createIndex({ email: 1 }, { partialFilterExpression: { deletedAt: { $type: 'null' } }, unique: true });
  const first = id();
  out.push(await attempt('1 live a', () => c.insertOne({ _id: first, deletedAt: null, email: 'a' })));
  out.push(await attempt('2 second live a', () => c.insertOne({ _id: id(), deletedAt: null, email: 'a' })));
  await c.updateOne({ _id: first }, { $set: { deletedAt: new Date() } });
  out.push(await attempt('3 live a after tombstone', () => c.insertOne({ _id: id(), deletedAt: null, email: 'a' })));
  out.push(await attempt('4 second tombstone a', () => c.insertOne({ _id: id(), deletedAt: new Date(), email: 'a' })));
  out.push(await attempt('5a live null', () => c.insertOne({ _id: id(), deletedAt: null, email: null })));
  out.push(await attempt('5b second live null', () => c.insertOne({ _id: id(), deletedAt: null, email: null })));
  out.push(await attempt('6 live a WITHOUT deletedAt field', () => c.insertOne({ _id: id(), email: 'a' })));
  for (let i = 0; i < 2000; i++) await c.insertOne({ _id: id(), deletedAt: null, email: `u${i}` });
  for (const [label, filter] of [
    ['$type null', { deletedAt: { $type: 'null' }, email: 'u7' }],
    ['null', { deletedAt: null, email: 'u7' }],
  ]) {
    const plan = await c.find(filter).explain('queryPlanner');
    const stage = JSON.stringify(plan.queryPlanner.winningPlan).match(/"stage":"(IXSCAN|COLLSCAN)"/)?.[1];
    out.push(`7 query { email, deletedAt: ${label} }: ${stage}`);
  }
  // 9: the equality form `{ deletedAt: null }` as the partial filter — does it cover a MISSING field, and which
  // query uses it? (It would spare the backfill of `deletedAt: null` when a model becomes syncable.)
  const eq = db.collection('people_eq');
  await eq.createIndex({ email: 1 }, { partialFilterExpression: { deletedAt: null }, unique: true });
  out.push(await attempt('9a eq-filter: missing a', () => eq.insertOne({ _id: id(), email: 'a' })));
  out.push(await attempt('9b eq-filter: missing a again', () => eq.insertOne({ _id: id(), email: 'a' })));
  out.push(await attempt('9c eq-filter: null a beside missing a', () => eq.insertOne({ _id: id(), deletedAt: null, email: 'a' })));
  out.push(await attempt('9d eq-filter: tombstone a', () => eq.insertOne({ _id: id(), deletedAt: new Date(), email: 'a' })));
  for (let i = 0; i < 2000; i++) await eq.insertOne({ _id: id(), deletedAt: null, email: `u${i}` });
  for (const [label, filter] of [
    ['null', { deletedAt: null, email: 'u7' }],
    ['$type null', { deletedAt: { $type: 'null' }, email: 'u7' }],
  ]) {
    const plan = await eq.find(filter).explain('queryPlanner');
    const stage = JSON.stringify(plan.queryPlanner.winningPlan).match(/"stage":"(IXSCAN|COLLSCAN)"/)?.[1];
    out.push(`9e eq-filter, query { email, deletedAt: ${label} }: ${stage}`);
  }
  const stored = (await eq.indexes()).find((index) => index.name === 'email_1');
  out.push(`9f eq-filter as stored: ${JSON.stringify(stored.partialFilterExpression)}`);
  await db.dropDatabase();
  await client.close();
  return out;
}

async function postgres() {
  const cfg = { host: '127.0.0.1', password: 'nest-owner-secret', port: 5440, user: 'nest_owner' };
  const admin = new pg.Client({ ...cfg, database: 'postgres' });
  await admin.connect();
  await admin.query(`DROP DATABASE IF EXISTS "${DB}" WITH (FORCE)`);
  await admin.query(`CREATE DATABASE "${DB}"`);
  const c = new pg.Client({ ...cfg, database: DB });
  await c.connect();
  const out = [];
  for (const [label, nulls] of [
    ['NULLS NOT DISTINCT', ' NULLS NOT DISTINCT'],
    ['default (NULLs distinct)', ''],
  ]) {
    const t = nulls ? 'people_nnd' : 'people';
    await c.query(`CREATE TABLE ${t} (id text PRIMARY KEY, email text, deleted_at timestamptz)`);
    await c.query(`CREATE UNIQUE INDEX ON ${t} (email)${nulls} WHERE deleted_at IS NULL`);
    const ins = (email, deleted = false) =>
      c.query(`INSERT INTO ${t} (id, email, deleted_at) VALUES ($1, $2, ${deleted ? 'now()' : 'NULL'})`, [id(), email]);
    const first = id();
    out.push(`[${label}]`);
    out.push(await attempt('1 live a', () => c.query(`INSERT INTO ${t} (id, email) VALUES ($1, 'a')`, [first])));
    out.push(await attempt('2 second live a', () => ins('a')));
    await c.query(`UPDATE ${t} SET deleted_at = now() WHERE id = $1`, [first]);
    out.push(await attempt('3 live a after tombstone', () => ins('a')));
    out.push(await attempt('4 second tombstone a', () => ins('a', true)));
    out.push(await attempt('5a live null', () => ins(null)));
    out.push(await attempt('5b second live null', () => ins(null)));
  }
  await c.end();
  await admin.query(`DROP DATABASE IF EXISTS "${DB}" WITH (FORCE)`);
  await admin.end();
  return out;
}

async function mysql(port) {
  const c = await createConnection({ host: '127.0.0.1', password: 'nest-owner-secret', port, user: 'nest_owner' });
  await c.query(`DROP DATABASE IF EXISTS \`${DB}\``);
  await c.query(`CREATE DATABASE \`${DB}\``);
  await c.query(`USE \`${DB}\``);
  await c.query(`CREATE TABLE people (id varchar(32) PRIMARY KEY, email varchar(255) COLLATE utf8mb4_bin, deleted_at datetime(6) NULL,
    live_email varchar(255) COLLATE utf8mb4_bin GENERATED ALWAYS AS (IF(deleted_at IS NULL, IFNULL(email, CHAR(0)), NULL)) VIRTUAL,
    UNIQUE KEY live_email_unique (live_email)) ENGINE=InnoDB`);
  const ins = (email, deleted = false) =>
    c.query(`INSERT INTO people (id, email, deleted_at) VALUES (?, ?, ${deleted ? 'NOW(6)' : 'NULL'})`, [id(), email]);
  const out = [];
  const first = id();
  out.push(await attempt('1 live a', () => c.query(`INSERT INTO people (id, email) VALUES (?, 'a')`, [first])));
  out.push(await attempt('2 second live a', () => ins('a')));
  await c.query(`UPDATE people SET deleted_at = NOW(6) WHERE id = ?`, [first]);
  out.push(await attempt('3 live a after tombstone', () => ins('a')));
  out.push(await attempt('4 second tombstone a', () => ins('a', true)));
  out.push(await attempt('5a live null', () => ins(null)));
  out.push(await attempt('5b second live null', () => ins(null)));
  // Reviving a tombstone whose value is live again must be refused, not slip through
  out.push(await attempt('8 revive the first tombstone', () => c.query(`UPDATE people SET deleted_at = NULL WHERE id = ?`, [first])));
  await c.query(`DROP DATABASE IF EXISTS \`${DB}\``);
  await c.end();
  return out;
}

results.push(['mongo-standalone (8.2)', await mongo('standalone', 'mongodb://127.0.0.1:27017')]);
results.push(['mongo-rs (7.0)', await mongo('rs', 'mongodb://127.0.0.1:27027/?directConnection=true')]);
// Optional: an older server, e.g. `docker run -d -p 27028:27017 mongo:5` and MONGO_OLD_URL=mongodb://127.0.0.1:27028
if (process.env.MONGO_OLD_URL) results.push(['mongo-old', await mongo('old', process.env.MONGO_OLD_URL)]);
results.push(['postgres (18)', await postgres()]);
results.push(['mysql (8.4)', await mysql(3316)]);
results.push(['mariadb (11.8)', await mysql(3317)]);
for (const [target, lines] of results) {
  console.log(`\n${target}`);
  for (const line of lines) console.log(`  ${line}`);
}
