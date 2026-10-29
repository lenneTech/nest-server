import { Kysely, PostgresDialect, sql } from 'kysely';
import pg from 'pg';
const db = new Kysely({ dialect: new PostgresDialect({ pool: new pg.Pool({ connectionString: 'postgres://proto_owner:proto@127.0.0.1:5434/proto', max: 1 }) }) });
const rows = (await sql`SELECT email, roles FROM users WHERE email LIKE 'x-%@test.com'`.execute(db)).rows;
const ok = rows.length > 0 && rows.every((r) => Array.isArray(r.roles) && r.roles.length === 0);
console.log(`${ok ? 'PASS' : 'FAIL'}  sign-up with roles:['admin'] stored roles = ${JSON.stringify(rows.map((r) => r.roles))}`);
await db.destroy();
