/**
 * Unit Tests: the account this package writes itself follows the INSTALLED better-auth's schema.
 *
 * `CoreBetterAuthUserMapper.migrateAccountToIam()` inserts the credential account of a legacy user
 * directly. better-auth 1.7.0–1.7.2 key accounts by `(issuer, accountId)`: a row without the issuer
 * is not found, and the migrated user gets a 401 on the very sign-in that triggered the migration.
 * 1.7.3+ went back to `(providerId, accountId)` and knows no issuer. A project that has not raised
 * its better-auth pin must keep working, so the write follows whichever line is installed — decided
 * by `core-better-auth-account-issuer.helper.ts`, mocked here to drive both.
 *
 * The 1.7.0–1.7.2 half cannot be shown end to end in this repository, which installs 1.7.7.
 * `CoreSystemSetupService.createInitialAdmin()` writes its account through the same helper, with the
 * same conditional spread.
 *
 * @regression   11.37.0 — the legacy->IAM migration wrote the credential account WITHOUT an issuer on
 *   better-auth 1.7, so the migrated user's sign-in answered 401. Kept for projects still on
 *   1.7.0–1.7.2 after the issuer write became conditional in 11.41.8.
 * @seen-failing Drop the conditional `issuer` spread from the `insertOne` in `migrateAccountToIam()`
 *   in src/core/modules/better-auth/core-better-auth-user.mapper.ts — registered as mutation
 *   `account-issuer-missing-on-migrate` in tests/regression-mutations.json.
 */
import * as bcrypt from 'bcrypt';
import { ObjectId } from 'mongodb';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const line = vi.hoisted(() => ({ legacy: false }));
vi.mock('../../src/core/modules/better-auth/core-better-auth-account-issuer.helper', () => ({
  legacyCredentialAccountIssuer: () => (line.legacy ? 'local:credential' : undefined),
  usesLegacyAccountIssuer: () => line.legacy,
}));

import { CoreBetterAuthUserMapper } from '../../src/core/modules/better-auth/core-better-auth-user.mapper';

const PASSWORD = 'Legacy-Password-1';
let legacyHash: string;

beforeAll(async () => {
  legacyHash = await bcrypt.hash(PASSWORD, 4);
});

function mapperWithLegacyUser() {
  const userId = new ObjectId();
  const insertOne = vi.fn(async (_doc: Record<string, unknown>) => ({ insertedId: new ObjectId() }));
  const users = {
    findOne: vi.fn(async () => ({ _id: userId, email: 'legacy@example.com', password: legacyHash })),
    updateOne: vi.fn(async () => ({ modifiedCount: 1 })),
  };
  const accounts = { findOne: vi.fn(async () => null), insertOne };
  const connection = { collection: (name: string) => (name === 'users' ? users : accounts) };
  const mapper = new CoreBetterAuthUserMapper(connection as never);
  return { insertOne, mapper };
}

describe('migrateAccountToIam(): the credential account it writes', () => {
  beforeEach(() => {
    line.legacy = false;
  });

  it('carries the credential issuer while better-auth keys accounts by issuer (1.7.0–1.7.2)', async () => {
    line.legacy = true;
    const { insertOne, mapper } = mapperWithLegacyUser();

    expect(await mapper.migrateAccountToIam('legacy@example.com', PASSWORD)).toBe(true);

    expect(insertOne).toHaveBeenCalledTimes(1);
    expect(insertOne.mock.calls[0][0]).toMatchObject({ issuer: 'local:credential', providerId: 'credential' });
  });

  it('paired control: carries NO issuer on better-auth 1.7.3+', async () => {
    const { insertOne, mapper } = mapperWithLegacyUser();

    expect(await mapper.migrateAccountToIam('legacy@example.com', PASSWORD)).toBe(true);

    expect(insertOne.mock.calls[0][0]).toMatchObject({ providerId: 'credential' });
    expect(insertOne.mock.calls[0][0]).not.toHaveProperty('issuer');
  });
});
