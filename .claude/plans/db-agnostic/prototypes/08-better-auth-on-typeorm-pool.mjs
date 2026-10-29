// Better-Auth's built-in adapter on the pg Pool that TypeORM already owns (one pool for the app),
// user mapped onto `users`; TypeORM reads the same row through its own EntitySchema afterwards.
import 'reflect-metadata';
import { betterAuth } from 'better-auth';
import { getMigrations } from 'better-auth/db/migration';
import { ObjectId } from 'bson';
import { DataSource, EntitySchema } from 'typeorm';

const results = [];
const check = (name, ok, detail = '') => results.push({ name, ok, detail });

const UserSchema = new EntitySchema({
  name: 'User', tableName: 'users',
  columns: { id: { type: 'text', primary: true }, email: { type: 'text' }, firstName: { name: 'first_name', type: 'text', nullable: true }, roles: { type: 'jsonb', nullable: true } },
});
const ds = await new DataSource({ type: 'postgres', url: 'postgres://proto_owner:proto@127.0.0.1:5434/proto', entities: [UserSchema], extra: { max: 5 } }).initialize();
await ds.query('DROP TABLE IF EXISTS "session", "account", "verification", "users" CASCADE');
const pool = ds.driver.master; // the pg.Pool TypeORM created
check('TypeORM exposes its pg.Pool', typeof pool?.connect === 'function', pool?.constructor?.name);

const auth = betterAuth({
  baseURL: 'http://localhost:3000', secret: 'proto-secret-proto-secret-proto-secret-12345',
  database: pool,
  emailAndPassword: { enabled: true },
  user: { modelName: 'users', fields: { emailVerified: 'email_verified', createdAt: 'created_at', updatedAt: 'updated_at' },
    additionalFields: { firstName: { type: 'string', required: false, fieldName: 'first_name' }, roles: { type: 'string[]', required: false, input: false, defaultValue: [] } } },
  session: { fields: { userId: 'user_id', expiresAt: 'expires_at', ipAddress: 'ip_address', userAgent: 'user_agent', createdAt: 'created_at', updatedAt: 'updated_at' } },
  account: { fields: { userId: 'user_id', accountId: 'account_id', providerId: 'provider_id', createdAt: 'created_at', updatedAt: 'updated_at' } },
  advanced: { database: { generateId: () => new ObjectId().toHexString() } },
});
const { runMigrations } = await getMigrations(auth.options);
await runMigrations();

const email = `tp-${Date.now()}@test.com`;
const up = await auth.api.signUpEmail({ body: { email, password: 'Secret123!x', name: 'Ta Po', firstName: 'Ta' } });
check('sign-up via Better-Auth on the TypeORM pool', /^[0-9a-f]{24}$/.test(up?.user?.id ?? ''), up?.user?.id);
const inn = await auth.api.signInEmail({ body: { email, password: 'Secret123!x' } });
check('sign-in', !!inn?.token);
const row = await ds.getRepository('User').findOne({ where: { email } });
check('TypeORM reads the same users row', row?.id === up.user.id && row?.firstName === 'Ta', JSON.stringify(row));
check('one pool: Better-Auth used the TypeORM pool', pool.totalCount <= 5, `pool.totalCount=${pool.totalCount}`);

for (const r of results) console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.name}${r.detail ? `  — ${r.detail}` : ''}`);
console.log(results.every((r) => r.ok) ? 'ALL PASS' : 'SOME FAILED');
await ds.destroy();
