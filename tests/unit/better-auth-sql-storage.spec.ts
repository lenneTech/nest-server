import { getAuthTables } from 'better-auth/db';
import { describe, expect, it } from 'vitest';

import { buildBetterAuthOptions } from '../../src/core/modules/better-auth/better-auth.config';

const VALID_SECRET = 'sql-storage-secret-sql-storage-secret-0123';
/** Never connected: constructing the instance must not touch the database */
const pool = {
  connect: () => Promise.reject(new Error('a unit test has no database')),
  end: () => Promise.resolve(),
  query: () => Promise.reject(new Error('a unit test has no database')),
};
const fakeDb = { collection: () => ({}) };

function instanceOptions(sqlPool?: unknown, config: Record<string, unknown> = {}) {
  const result = buildBetterAuthOptions({
    config: {
      baseUrl: 'http://localhost:3000',
      enabled: true,
      jwt: true,
      passkey: true,
      secret: VALID_SECRET,
      twoFactor: true,
      ...config,
    } as any,
    db: fakeDb,
    sqlPool,
  });
  return result!.options as Record<string, any>;
}

/** Physical name of every field of every table, as Better-Auth's adapters resolve it */
function physicalNames(
  options: Record<string, any>,
): Record<string, { fields: Record<string, string>; table: string }> {
  const tables = getAuthTables(options as any) as Record<string, any>;
  return Object.fromEntries(
    Object.entries(tables).map(([model, table]) => [
      model,
      {
        fields: Object.fromEntries(
          Object.entries(table.fields as Record<string, any>).map(([key, field]) => [key, field.fieldName ?? key]),
        ),
        table: table.modelName,
      },
    ]),
  );
}

describe('Better-Auth on a SQL data source', () => {
  it('runs its own adapter on the given pool, with ids in the framework format', () => {
    const options = instanceOptions(pool);
    expect(options.database).toBe(pool);
    expect(options.advanced.database.generateId()).toMatch(/^[0-9a-f]{24}$/);
  });

  /**
   * @regression   DEV-3831 (db-agnostic phase 3) — Better-Auth addressed its own camelCase names on SQL: a second
   *   `firstName` column next to the framework's `first_name` would have split one value of the shared user row in two.
   * @seen-failing Leave the stored name as it is in withSqlStorage() in
   *   src/core/modules/better-auth/better-auth-sql.helper.ts — registered as mutation `better-auth-sql-camel-columns` in
   *   tests/regression-mutations.json.
   */
  it('addresses the columns the framework creates for the user model in the shared users table', () => {
    const { user } = physicalNames(instanceOptions(pool));
    expect(user.table).toBe('users');
    expect(user.fields).toMatchObject({
      createdAt: 'created_at',
      email: 'email',
      emailVerified: 'email_verified',
      firstName: 'first_name',
      iamId: 'iam_id',
      lastName: 'last_name',
      roles: 'roles',
      termsAndPrivacyAcceptedAt: 'terms_and_privacy_accepted_at',
      twoFactorEnabled: 'two_factor_enabled',
      updatedAt: 'updated_at',
      verifiedAt: 'verified_at',
    });
  });

  it("names Better-Auth's own tables and its plugins' tables like the framework's", () => {
    const names = physicalNames(instanceOptions(pool));
    expect(names.session.fields).toMatchObject({ expiresAt: 'expires_at', ipAddress: 'ip_address', userId: 'user_id' });
    expect(names.account.fields).toMatchObject({
      accountId: 'account_id',
      providerId: 'provider_id',
      userId: 'user_id',
    });
    expect(names.verification.fields).toMatchObject({ expiresAt: 'expires_at', identifier: 'identifier' });
    expect(names.twoFactor).toMatchObject({
      fields: { backupCodes: 'backup_codes', userId: 'user_id' },
      table: 'two_factor',
    });
    expect(names.passkey.fields).toMatchObject({ credentialID: 'credential_id', publicKey: 'public_key' });
    expect(names.jwks.fields).toMatchObject({ privateKey: 'private_key', publicKey: 'public_key' });
  });

  it('maps a project field by the name it is stored under, so a field renamed onto a column stays on it', () => {
    const { user } = physicalNames(instanceOptions(pool, { additionalUserFields: { jobTitle: { type: 'string' } } }));
    expect(user.fields.jobTitle).toBe('job_title');
  });

  it('changes nothing on MongoDB: the stored names stay as they are', () => {
    const options = instanceOptions(undefined);
    const names = physicalNames(options);
    expect(options.database).not.toBe(pool);
    expect(options.advanced?.database?.generateId).toBeUndefined();
    expect(names.user.fields.emailVerified).toBe('emailVerified');
    expect(names.session.fields.userId).toBe('userId');
    expect(names.twoFactor.table).toBe('twoFactor');
  });

  it('copies the plugins it renames, so an instance on MongoDB in the same process keeps its names', () => {
    const plugin = { id: 'shared-plugin', schema: { sharedThing: { fields: { ownerId: { type: 'string' } } } } };
    const sql = physicalNames(instanceOptions(pool, { plugins: [plugin] }));
    const mongo = physicalNames(instanceOptions(undefined, { plugins: [plugin] }));
    expect(sql.sharedThing).toEqual({ fields: { ownerId: 'owner_id' }, table: 'shared_thing' });
    expect(mongo.sharedThing).toEqual({ fields: { ownerId: 'ownerId' }, table: 'sharedThing' });
  });
});
