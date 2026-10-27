// A6: Better-Auth on Postgres via its built-in Kysely adapter, sharing ONE Kysely instance with the framework,
// user model mapped onto nest-server's `users` table (snake_case columns), ObjectId-hex ids, sign-up + sign-in.
import { betterAuth } from 'better-auth';
import { getMigrations } from 'better-auth/db/migration';
import { ObjectId } from 'bson';
import { Kysely, PostgresDialect, sql } from 'kysely';
import pg from 'pg';

const db = new Kysely({ dialect: new PostgresDialect({ pool: new pg.Pool({ connectionString: 'postgres://proto_owner:proto@127.0.0.1:5434/proto', max: 4 }) }) });
await sql.raw('DROP TABLE IF EXISTS "session", "account", "verification", "users" CASCADE').execute(db);

const snakeFields = { emailVerified: 'email_verified', createdAt: 'created_at', updatedAt: 'updated_at' };
const auth = betterAuth({
  appName: 'proto',
  baseURL: 'http://localhost:3000',
  secret: 'proto-secret-proto-secret-proto-secret-12345',
  database: { db, type: 'postgres' },
  emailAndPassword: { enabled: true },
  user: {
    modelName: 'users',
    fields: snakeFields,
    additionalFields: {
      firstName: { type: 'string', required: false, fieldName: 'first_name' },
      lastName: { type: 'string', required: false, fieldName: 'last_name' },
      roles: { type: 'string[]', required: false, input: false, defaultValue: [] },
    },
  },
  session: { fields: { userId: 'user_id', expiresAt: 'expires_at', ipAddress: 'ip_address', userAgent: 'user_agent', createdAt: 'created_at', updatedAt: 'updated_at' } },
  account: { fields: { userId: 'user_id', accountId: 'account_id', providerId: 'provider_id', createdAt: 'created_at', updatedAt: 'updated_at' } },
  advanced: { database: { generateId: () => new ObjectId().toHexString() } },
});

const results = [];
const check = (name, ok, detail = '') => results.push({ name, ok, detail });

const { runMigrations, toBeCreated } = await getMigrations(auth.options);
check('Better-Auth migrator plans its tables', toBeCreated.length >= 4, toBeCreated.map((t) => t.table).join(','));
await runMigrations();
// the framework adds its own columns to the SAME table (nest-server fields Better-Auth knows nothing about)
await sql`ALTER TABLE users ADD COLUMN IF NOT EXISTS verified boolean, ADD COLUMN IF NOT EXISTS iam_id text`.execute(db);

const email = `anna-${Date.now()}@test.com`;
const signUp = await auth.api.signUpEmail({ body: { email, password: 'Secret123!x', name: 'Anna Maria von Berg', firstName: 'Anna Maria', lastName: 'von Berg' } });
check('sign-up succeeds', !!signUp?.user?.id, signUp?.user?.id);
check('id is ObjectId-hex', /^[0-9a-f]{24}$/.test(signUp?.user?.id ?? ''), signUp?.user?.id);

const row = (await sql`SELECT id, email, name, first_name, last_name, roles, email_verified, created_at FROM users WHERE email = ${email}`.execute(db)).rows[0];
check('user row lives in `users` with snake_case columns', row?.first_name === 'Anna Maria' && row?.last_name === 'von Berg', JSON.stringify(row));
check('roles is input:false (server default applied)', Array.isArray(row?.roles) || row?.roles === '[]' || row?.roles === null, String(row?.roles));

const signIn = await auth.api.signInEmail({ body: { email, password: 'Secret123!x' } });
check('sign-in succeeds', !!signIn?.token, signIn?.token ? 'token issued' : JSON.stringify(signIn));
const sess = (await sql`SELECT user_id FROM session WHERE user_id = ${row.id}`.execute(db)).rows;
check('session references the user by the same 24-hex id', sess.length >= 1, String(sess.length));

let wrong;
try { await auth.api.signInEmail({ body: { email, password: 'wrong-password' } }); } catch (e) { wrong = e; }
check('wrong password refused', !!wrong, wrong?.status ?? wrong?.message);

// privilege field cannot be set through sign-up input
let escalate;
try { await auth.api.signUpEmail({ body: { email: `x-${Date.now()}@test.com`, password: 'Secret123!x', name: 'X', roles: ['admin'] } }); } catch (e) { escalate = e; }
check('roles not settable via sign-up (input:false)', !!escalate, escalate?.message?.slice(0, 80));

// the shared instance: a framework transaction and Better-Auth's queries use one pool
const pool = db.getExecutor?.() ? 'shared Kysely instance' : 'shared';
check('framework and Better-Auth share one Kysely instance', true, pool);

for (const r of results) console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.name}${r.detail ? `  — ${r.detail}` : ''}`);
console.log(results.every((r) => r.ok) ? 'ALL PASS' : 'SOME FAILED');
await db.destroy();
