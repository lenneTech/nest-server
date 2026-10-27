// Kysely 0.29 on MariaDB 11.8, MySQL 8.4 and Postgres 18 — the checks 12-mysql-mariadb.mjs ran for
// Drizzle and TypeORM, plus two Kysely-specific ones: the schema builder + introspection our own
// schema-evolution engine would build on, and the Migrator's lock under concurrent boots.
import { Kysely, MysqlDialect, PostgresDialect, sql } from 'kysely';
import { Migrator } from 'kysely/migration';
import { createPool } from 'mysql2';
import pg from 'pg';

const out = [];
const check = (who, name, ok, detail = '') => out.push(`${ok ? 'PASS' : 'FAIL'}  ${who.padEnd(22)} ${name}${detail ? `  — ${detail}` : ''}`);

const TARGETS = [
  { name: 'MariaDB 11.8', kind: 'mysql', make: () => new MysqlDialect({ pool: createPool({ uri: 'mysql://root:proto@127.0.0.1:3307/proto', connectionLimit: 20 }) }) },
  { name: 'MySQL 8.4', kind: 'mysql', make: () => new MysqlDialect({ pool: createPool({ uri: 'mysql://root:proto@127.0.0.1:3308/proto', connectionLimit: 20 }) }) },
  { name: 'Postgres 18', kind: 'pg', make: () => new PostgresDialect({ pool: new pg.Pool({ connectionString: 'postgres://proto_owner:proto@127.0.0.1:5434/proto', max: 20 }) }) },
];

const suffix = Date.now().toString(36);
for (const t of TARGETS) {
  const who = `Kysely / ${t.name}`;
  const db = new Kysely({ dialect: t.make() });
  const docs = `docs_k_${suffix}`;
  const jsonType = t.kind === 'pg' ? 'jsonb' : 'json';

  // 1. runtime table via the schema builder + JSON round trip + containment
  await db.schema.createTable(docs).addColumn('id', 'varchar(24)', (c) => c.primaryKey()).addColumn('tags', sql.raw(jsonType)).addColumn('title', 'varchar(200)').execute();
  await db.insertInto(docs).values([{ id: 'a', tags: JSON.stringify(['x', 'y']), title: 'A' }, { id: 'b', tags: JSON.stringify(['y']), title: 'B' }]).execute();
  const contains = t.kind === 'pg' ? sql`tags @> ${JSON.stringify(['x'])}::jsonb` : sql`JSON_CONTAINS(tags, ${JSON.stringify('x')})`;
  const back = await db.selectFrom(docs).selectAll().where(contains).execute();
  const tagsType = back[0] ? (Array.isArray(back[0].tags) ? 'array' : typeof back[0].tags) : 'none';
  check(who, 'runtime table + JSON containment', back.length === 1, `tags come back as ${tagsType}`);

  // 2. transaction rollback
  try {
    await db.transaction().execute(async (tx) => {
      await tx.insertInto(docs).values({ id: 'c', tags: '[]', title: 'C' }).execute();
      throw new Error('rollback');
    });
  } catch { /* expected */ }
  const { n } = await db.selectFrom(docs).select((eb) => eb.fn.countAll().as('n')).executeTakeFirstOrThrow();
  check(who, 'transaction rollback', Number(n) === 2);

  // 3. atomic lease claim, 10 rounds x 16 workers
  const locks = `locks_k_${suffix}`;
  await db.schema.createTable(locks).addColumn('k', 'varchar(64)', (c) => c.primaryKey()).addColumn('owner', 'varchar(64)', (c) => c.notNull())
    .addColumn('expires_at', t.kind === 'pg' ? 'timestamptz' : sql.raw('datetime(3)'), (c) => c.notNull()).execute();
  const claim = async (key, owner) => {
    if (t.kind === 'pg') {
      const r = await sql`INSERT INTO ${sql.table(locks)} (k, owner, expires_at) VALUES (${key}, ${owner}, now() + interval '5 seconds')
        ON CONFLICT (k) DO UPDATE SET owner = excluded.owner, expires_at = excluded.expires_at WHERE ${sql.ref(`${locks}.expires_at`)} < now() RETURNING owner`.execute(db);
      return r.rows.length === 1;
    }
    const ins = await sql`INSERT IGNORE INTO ${sql.table(locks)} (k, owner, expires_at) VALUES (${key}, ${owner}, NOW() + INTERVAL 5 SECOND)`.execute(db);
    if (Number(ins.numAffectedRows) === 1) return true;
    const upd = await sql`UPDATE ${sql.table(locks)} SET owner = ${owner}, expires_at = NOW() + INTERVAL 5 SECOND WHERE k = ${key} AND expires_at < NOW()`.execute(db);
    return Number(upd.numAffectedRows) === 1;
  };
  let one = true;
  for (let r = 0; r < 10; r++) {
    const won = await Promise.all(Array.from({ length: 16 }, (_, i) => claim(`k${r}`, `w${i}`)));
    if (won.filter(Boolean).length !== 1) one = false;
  }
  check(who, 'atomic lease claim (exactly one winner)', one);

  // 4. what an own evolution engine needs: add column, add index, introspect
  await db.schema.alterTable(docs).addColumn('note', 'text').execute();
  await db.schema.createIndex(`${docs}_title_idx`).on(docs).column('title').execute();
  const tables = await db.introspection.getTables();
  const meta = tables.find((x) => x.name === docs);
  const cols = meta?.columns.map((c) => `${c.name}:${c.dataType}${c.isNullable ? '?' : ''}`).join(',');
  const rowsAfter = await db.selectFrom(docs).select(['id', 'note']).orderBy('id').execute();
  check(who, 'add column keeps rows + introspection sees it', rowsAfter.length === 2 && cols?.includes('note'), cols);
  check(who, 'introspection reports indexes', 'indexes' in (meta ?? {}), 'TableMetadata has no index list — an own engine reads them from the catalog');

  // 5. Migrator: 6 concurrent boots, the migration must run exactly once
  const marker = `mig_marker_${suffix}`;
  await db.schema.createTable(marker).addColumn('id', 'integer').execute();
  const provider = { getMigrations: async () => ({ '0001_once': { up: async (kdb) => { await kdb.insertInto(marker).values({ id: 1 }).execute(); await new Promise((r) => setTimeout(r, 300)); } } }) };
  const boots = await Promise.all(Array.from({ length: 6 }, () => {
    const m = new Migrator({ db, provider, migrationTableName: `kysely_mig_${suffix}`, migrationLockTableName: `kysely_mig_lock_${suffix}` });
    return m.migrateToLatest();
  }));
  const ran = boots.flatMap((b) => b.results ?? []).filter((r) => r.status === 'Success').length;
  const errors = boots.filter((b) => b.error).map((b) => String(b.error?.message ?? b.error).slice(0, 80));
  const { m: inserted } = await db.selectFrom(marker).select((eb) => eb.fn.countAll().as('m')).executeTakeFirstOrThrow();
  check(who, 'Migrator lock: 6 concurrent boots, migration runs once', Number(inserted) === 1 && ran === 1 && errors.length === 0, `inserted=${inserted} successes=${ran} errors=${errors.join(' | ') || 0}`);

  for (const tbl of [docs, locks, marker, `kysely_mig_${suffix}`, `kysely_mig_lock_${suffix}`]) await db.schema.dropTable(tbl).ifExists().execute();
  await db.destroy();
}
console.log(out.join('\n'));
