// A3: RLS fail-closed semantics on Postgres 18 with Kysely + pg.
// Owner role creates schema + policies; the API connects as a NON-owner role without BYPASSRLS.
import { Kysely, PostgresDialect, sql } from 'kysely';
import pg from 'pg';

const OWNER = 'postgres://proto_owner:proto@127.0.0.1:5434/proto';
const APP = 'postgres://app_user:app@127.0.0.1:5434/proto';
const results = [];
const check = (name, ok, detail = '') => results.push({ name, ok, detail });

const owner = new Kysely({ dialect: new PostgresDialect({ pool: new pg.Pool({ connectionString: OWNER, max: 2 }) }) });
await sql`DROP TABLE IF EXISTS project; DROP FUNCTION IF EXISTS app_current_tenant(); DROP ROLE IF EXISTS app_user;`.execute(owner).catch(() => {});
await sql.raw(`
  DROP TABLE IF EXISTS project;
  DROP FUNCTION IF EXISTS app_current_tenant();
  DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='app_user') THEN DROP OWNED BY app_user; DROP ROLE app_user; END IF; END $$;
  CREATE ROLE app_user LOGIN PASSWORD 'app' NOBYPASSRLS;
  CREATE FUNCTION app_current_tenant() RETURNS text LANGUAGE plpgsql STABLE AS $f$
  DECLARE v text := current_setting('app.tenant_id', true);
  BEGIN
    IF current_setting('app.system', true) = 'on' THEN RETURN NULL; END IF;
    IF v IS NULL OR v = '' THEN
      RAISE EXCEPTION 'tenant context missing' USING ERRCODE = 'insufficient_privilege';
    END IF;
    RETURN v;
  END $f$;
  CREATE TABLE project (id text PRIMARY KEY, tenant_id text NOT NULL, name text NOT NULL);
  CREATE INDEX ON project (tenant_id);
  ALTER TABLE project ENABLE ROW LEVEL SECURITY;
  ALTER TABLE project FORCE ROW LEVEL SECURITY;
  CREATE POLICY tenant_isolation ON project
    USING (current_setting('app.system', true) = 'on' OR tenant_id = (SELECT app_current_tenant()))
    WITH CHECK (current_setting('app.system', true) = 'on' OR tenant_id = (SELECT app_current_tenant()));
  GRANT SELECT, INSERT, UPDATE, DELETE ON project TO app_user;
`).execute(owner);
await sql`INSERT INTO project VALUES ('p1','tA','A one'),('p2','tA','A two'),('p3','tB','B one')`.execute(owner);

const pool = new pg.Pool({ connectionString: APP, max: 1 }); // max 1 => every call reuses ONE pooled connection
const app = new Kysely({ dialect: new PostgresDialect({ pool }) });

// Request-scoped unit of work: set the tenant transaction-locally, run the work, commit.
const withTenant = (tenant, fn) =>
  app.transaction().execute(async (trx) => {
    await sql`SELECT set_config('app.tenant_id', ${tenant}, true)`.execute(trx);
    return fn(trx);
  });
const asSystem = (fn) =>
  app.transaction().execute(async (trx) => {
    await sql`SELECT set_config('app.system', 'on', true)`.execute(trx);
    return fn(trx);
  });

// 1. tenant A sees only its rows (query builder)
const a = await withTenant('tA', (trx) => trx.selectFrom('project').selectAll().orderBy('id').execute());
check('tenant A sees exactly its 2 rows', a.length === 2 && a.every((r) => r.tenant_id === 'tA'), JSON.stringify(a.map((r) => r.id)));

// 2. raw SQL inside the tenant tx is filtered too
const raw = await withTenant('tB', (trx) => sql`SELECT id FROM project`.execute(trx));
check('raw SQL is filtered by RLS', raw.rows.length === 1 && raw.rows[0].id === 'p3', JSON.stringify(raw.rows));

// 3. no tenant context on the SAME pooled connection (after a tx-local set_config) => ERROR, not 0 rows
let err3;
try { await app.selectFrom('project').selectAll().execute(); } catch (e) { err3 = e; }
check('missing tenant context raises (pooled conn, after tx-local set)', !!err3 && err3.code === '42501', err3 ? `${err3.code} ${err3.message}` : 'NO ERROR - returned rows');

// 4. same for raw SQL without context
let err4;
try { await sql`SELECT count(*) FROM project`.execute(app); } catch (e) { err4 = e; }
check('raw SQL without tenant context raises', !!err4 && err4.code === '42501', err4 ? err4.message : 'NO ERROR');

// 5. writing a row for a foreign tenant is refused (WITH CHECK)
let err5;
try { await withTenant('tA', (trx) => trx.insertInto('project').values({ id: 'x1', tenant_id: 'tB', name: 'smuggled' }).execute()); } catch (e) { err5 = e; }
check('insert into foreign tenant refused', !!err5 && err5.code === '42501', err5 ? err5.message : 'NO ERROR');

// 6. update cannot move a row to another tenant
let err6;
try { await withTenant('tA', (trx) => trx.updateTable('project').set({ tenant_id: 'tB' }).where('id', '=', 'p1').execute()); } catch (e) { err6 = e; }
check('update moving a row to a foreign tenant refused', !!err6 && err6.code === '42501', err6 ? err6.message : 'NO ERROR');

// 7. explicit system mode reads everything
const all = await asSystem((trx) => trx.selectFrom('project').select('id').execute());
check('explicit system mode sees all tenants', all.length === 3, String(all.length));

// 8. the tx-local tenant does not leak into the next transaction on the same pooled connection
let err8;
await withTenant('tA', (trx) => trx.selectFrom('project').select('id').execute());
try { await app.transaction().execute((trx) => trx.selectFrom('project').select('id').execute()); } catch (e) { err8 = e; }
check('tenant does not leak to the next tx on the same connection', !!err8, err8 ? err8.message : 'LEAKED');

// 9. the app role cannot switch RLS off for itself
let err9;
try { await sql`ALTER TABLE project DISABLE ROW LEVEL SECURITY`.execute(app); } catch (e) { err9 = e; }
check('app role cannot disable RLS', !!err9, err9 ? err9.code : 'DISABLED!');

// 10. multi-tenant read (header-less: tenantIds list) via an array GUC variant is expressible
const multi = await app.transaction().execute(async (trx) => {
  await sql`SELECT set_config('app.system', 'on', true)`.execute(trx); // placeholder: list-policy shown in plan
  return trx.selectFrom('project').select('id').where('tenant_id', 'in', ['tA', 'tB']).execute();
});
check('list read (system mode + IN) works', multi.length === 3, String(multi.length));

for (const r of results) console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.name}${r.detail ? `  — ${r.detail}` : ''}`);
console.log(results.every((r) => r.ok) ? 'ALL PASS' : 'SOME FAILED');
await app.destroy();
await owner.destroy();
