/**
 * Unit Tests: the boot step for better-auth 1.7.3+ — drop the unique `(issuer, accountId)` index
 * that 1.7.0–1.7.2 left behind, and forget the issuer-backfill marker.
 *
 * better-auth 1.7.3 restored the 1.6 account schema and no longer writes `issuer`. The unique index
 * its MongoDB adapter had created lazily then treats every new account as having the same, missing
 * issuer and refuses a second provider with the same account ID (shown against a real database in
 * tests/stories/better-auth-issuer-upgrade.e2e-spec.ts). The marker is forgotten so that a rollback to
 * a better-auth that still needs the issuer runs the backfill again.
 *
 * Which boot step runs is decided by the INSTALLED better-auth, through
 * `core-better-auth-account-issuer.helper.ts` — mocked here so both lines can be driven.
 *
 * @regression   11.41.8 — the left-over unique (issuer, accountId) index refuses legitimate accounts
 *   on better-auth 1.7.3+.
 * @seen-failing Make `dropLegacyAccountIssuerIndex()` skip the `dropIndex` call in
 *   src/core/modules/better-auth/core-better-auth.service.ts — registered as mutation
 *   `legacy-issuer-index-drop-skipped` in tests/regression-mutations.json.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const line = vi.hoisted(() => ({ legacy: false }));
vi.mock('../../src/core/modules/better-auth/core-better-auth-account-issuer.helper', () => ({
  legacyCredentialAccountIssuer: () => (line.legacy ? 'local:credential' : undefined),
  usesLegacyAccountIssuer: () => line.legacy,
}));

import {
  ACCOUNT_ISSUER_BACKFILL_ID,
  BACKFILL_MARKER_COLLECTION,
} from '../../src/core/modules/better-auth/core-better-auth.constants';
import { CoreBetterAuthService } from '../../src/core/modules/better-auth/core-better-auth.service';

type IndexInfo = { key: Record<string, number>; name: string; unique?: boolean };

const LEGACY_INDEX: IndexInfo = { key: { accountId: 1, issuer: 1 }, name: 'x', unique: true };

function buildService(options: {
  accountOptions?: Record<string, unknown>;
  dropFails?: boolean;
  indexes?: IndexInfo[];
  indexesError?: { code?: number; message: string };
}) {
  const dropIndex = vi.fn(async () => {
    if (options.dropFails) throw new Error('not authorized');
  });
  const indexes = vi.fn(async () => {
    if (options.indexesError) throw Object.assign(new Error(options.indexesError.message), options.indexesError);
    return options.indexes ?? [];
  });
  const deleteOne = vi.fn(async () => ({ deletedCount: 1 }));
  const accountCollections: Record<string, unknown> = {};
  const collection = vi.fn((name: string) => {
    if (name === BACKFILL_MARKER_COLLECTION) return { deleteOne };
    accountCollections[name] ??= {
      // Everything the backfill and ensureIndices would touch, so a wrong route shows up as a call.
      bulkWrite: vi.fn(),
      createIndex: vi.fn(async () => 'ok'),
      dropIndex,
      find: vi.fn(() => ({ toArray: vi.fn(async () => []) })),
      findOne: vi.fn(async () => null),
      indexes,
    };
    return accountCollections[name];
  });

  const service = new CoreBetterAuthService(
    { options: { account: options.accountOptions } } as never,
    { db: { collection } } as never,
    { enabled: true } as never,
  );
  const logger = {
    error: vi.spyOn((service as any).logger, 'error').mockImplementation(() => undefined),
    log: vi.spyOn((service as any).logger, 'log').mockImplementation(() => undefined),
  };
  return { collection, deleteOne, dropIndex, indexes, logger, service };
}

describe('better-auth 1.7.3+: the legacy (issuer, accountId) index', () => {
  beforeEach(() => {
    line.legacy = false;
  });

  it('drops a unique index keyed exactly on (issuer, accountId), whatever its name', async () => {
    const { dropIndex, logger, service } = buildService({
      indexes: [
        { key: { _id: 1 }, name: '_id_' },
        { ...LEGACY_INDEX, key: { issuer: 1, accountId: 1 }, name: 'account_issuer_accountId_uidx' },
      ],
    });

    await (service as any).dropLegacyAccountIssuerIndex();

    expect(dropIndex).toHaveBeenCalledTimes(1);
    expect(dropIndex).toHaveBeenCalledWith('account_issuer_accountId_uidx');
    expect(logger.log).toHaveBeenCalledWith(expect.stringContaining('account_issuer_accountId_uidx'));
  });

  it('paired control: leaves every other index alone — non-unique, other order, other fields', async () => {
    const { dropIndex, service } = buildService({
      indexes: [
        { key: { issuer: 1, accountId: 1 }, name: 'not_unique' },
        { key: { accountId: 1, issuer: 1 }, name: 'other_order', unique: true },
        { key: { providerId: 1, accountId: 1 }, name: 'provider_key', unique: true },
      ],
    });

    await (service as any).dropLegacyAccountIssuerIndex();

    expect(dropIndex).not.toHaveBeenCalled();
  });

  it('follows a renamed collection and renamed fields', async () => {
    const { collection, dropIndex, service } = buildService({
      accountOptions: { fields: { accountId: 'externalId', issuer: 'iss' }, modelName: 'accounts_custom' },
      indexes: [{ key: { iss: 1, externalId: 1 }, name: 'renamed_uidx', unique: true }],
    });

    await (service as any).dropLegacyAccountIssuerIndex();

    expect(collection).toHaveBeenCalledWith('accounts_custom');
    expect(dropIndex).toHaveBeenCalledWith('renamed_uidx');
  });

  /**
   * @regression   11.41.8 — on better-auth 1.7.3+ the issuer-backfill marker must be forgotten: after
   *   a rollback to a better-auth that needs the issuer, a stale marker would skip the backfill and
   *   lock out every account written in the meantime.
   * @seen-failing Drop the marker `deleteOne` from `dropLegacyAccountIssuerIndex()` in
   *   src/core/modules/better-auth/core-better-auth.service.ts — registered as mutation
   *   `issuer-backfill-marker-kept` in tests/regression-mutations.json.
   */
  it('forgets the backfill marker, so a rollback to the issuer line backfills again', async () => {
    const { deleteOne, service } = buildService({});

    await (service as any).dropLegacyAccountIssuerIndex();

    expect(deleteOne).toHaveBeenCalledWith({ _id: ACCOUNT_ISSUER_BACKFILL_ID });
  });

  it('treats a collection that does not exist yet as nothing to do', async () => {
    const { logger, service } = buildService({ indexesError: { code: 26, message: 'ns does not exist' } });

    await (service as any).dropLegacyAccountIssuerIndex();

    expect(logger.error).not.toHaveBeenCalled();
  });

  it('logs an error but never throws when the drop fails', async () => {
    const { logger, service } = buildService({
      dropFails: true,
      indexes: [{ ...LEGACY_INDEX, key: { issuer: 1, accountId: 1 }, name: 'account_issuer_accountId_uidx' }],
    });

    await expect((service as any).dropLegacyAccountIssuerIndex()).resolves.toBeUndefined();
    expect(logger.error).toHaveBeenCalledWith(expect.stringContaining('not authorized'));
  });
});

describe('the boot step follows the INSTALLED better-auth', () => {
  it('on 1.7.3+: drops the legacy index and does not backfill', async () => {
    line.legacy = false;
    const { indexes, service } = buildService({});
    const backfill = vi.spyOn(service as any, 'backfillAccountIssuers');

    await service.onModuleInit();

    expect(indexes).toHaveBeenCalled();
    expect(backfill).not.toHaveBeenCalled();
  });

  it('on 1.7.0–1.7.2: backfills and leaves the index alone', async () => {
    line.legacy = true;
    const { indexes, service } = buildService({});
    const backfill = vi.spyOn(service as any, 'backfillAccountIssuers');

    await service.onModuleInit();

    expect(backfill).toHaveBeenCalled();
    expect(indexes).not.toHaveBeenCalled();
  });
});
