/**
 * Unit Tests: the `account.issuer` backfill that keeps an upgrade to better-auth 1.7 from
 * locking every existing password user out.
 *
 * WHY THIS EXISTS.
 * Up to better-auth 1.6 a credential account was identified by `providerId` + `userId`. From
 * 1.7 an account is keyed by (issuer, accountId), and the sign-in route filters on it verbatim:
 *
 *   account.providerId === 'credential' && account.issuer === credentialIssuer && ...
 *
 * A row written by 1.6 has no `issuer` field at all, so `undefined === 'local:credential'` is
 * false and the account is simply not found. The user gets a 401 — not "wrong password", not a
 * migration hint, just a failed login — and nothing in the server log explains it. That failure
 * is invisible in this repo: our own suites create their users through 1.7, so they always carry
 * the field. Only a database written by an older version reproduces it, which is exactly what
 * these tests fake.
 *
 * The end-to-end property (a 1.6-shaped row can sign in after the upgrade) cannot be shown here,
 * because the collection is a double — it lives in
 * `tests/stories/better-auth-issuer-upgrade.e2e-spec.ts`, against a real database and better-auth's
 * own sign-in route. These tests cover the query shapes, the completion marker and the failure
 * modes around them.
 *
 * WHY IT IS SCOPED TO CREDENTIAL ACCOUNTS.
 * `local:credential` is derivable — it is a pure function of the provider id. An OAuth account's
 * issuer is not: it is either the provider's real OIDC issuer or the synthetic
 * `local:oauth:<providerId>` fallback, decided per provider. Guessing there would not fail
 * loudly; it would write a key that looks valid and silently produce a SECOND account on the
 * next social sign-in. So those rows are reported and never rewritten — one test pins that
 * boundary, because "we backfill accounts" is exactly the kind of summary that invites someone to
 * widen the filter later.
 *
 * @regression   11.37.0 — better-auth 1.7 keys accounts by (issuer, accountId) and filters on it
 *   verbatim at sign-in. Every credential row written by 1.6 lacks the field, so the upgrade
 *   itself locked out every existing password user with a bare 401 and no log line.
 * @seen-failing Remove the `await this.backfillAccountIssuers();` call from `onModuleInit()` in
 *   src/core/modules/better-auth/core-better-auth.service.ts — registered as mutation
 *   `account-issuer-backfill-missing` in tests/regression-mutations.json.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  ACCOUNT_ISSUER_BACKFILL_ID,
  BACKFILL_MARKER_COLLECTION,
} from '../../src/core/modules/better-auth/core-better-auth.constants';
import { CoreBetterAuthService } from '../../src/core/modules/better-auth/core-better-auth.service';

/** The value better-auth derives for credential accounts (`local:` + encoded provider id). */
const CREDENTIAL_ISSUER = 'local:credential';

interface BuildOptions {
  /** Rows still missing the issuer, as returned by the pending lookup. */
  pending?: { _id: string }[];
  /** How many of those the bulk write actually modified — lower than `pending` means a partial failure. */
  modifiedCount?: number;
  /** A marker document, i.e. the backfill already completed on an earlier boot. */
  markerExists?: boolean;
  /** A non-credential row still missing the issuer, which must be reported but never written. */
  staleOther?: boolean;
  /** better-auth instance options, for the renamed-schema case. */
  accountOptions?: Record<string, unknown>;
  /** Passed verbatim as the injected better-auth instance; `null` disables the service. */
  authInstance?: unknown;
  /** Config object; `{ enabled: false }` disables the service with an instance present. */
  config?: Record<string, unknown>;
  /** Omit the database entirely (GraphQL-only / DB-less boot). */
  withoutDb?: boolean;
}

function buildService(options: BuildOptions = {}) {
  const pending = options.pending ?? [];

  const bulkWrite = vi.fn().mockResolvedValue({ modifiedCount: options.modifiedCount ?? pending.length });
  const toArray = vi.fn().mockResolvedValue(pending);
  const find = vi.fn().mockReturnValue({ toArray });
  const accountFindOne = vi.fn().mockResolvedValue(options.staleOther ? { _id: 'oauth-row' } : null);
  const createIndex = vi.fn().mockResolvedValue('ok');

  const markerFindOne = vi.fn().mockResolvedValue(options.markerExists ? { _id: ACCOUNT_ISSUER_BACKFILL_ID } : null);
  const markerUpdateOne = vi.fn().mockResolvedValue({ upsertedCount: 1 });

  const accountCollection = { bulkWrite, createIndex, find, findOne: accountFindOne };
  const markerCollection = { createIndex, findOne: markerFindOne, updateOne: markerUpdateOne };

  const collection = vi.fn((name: string) =>
    name === BACKFILL_MARKER_COLLECTION ? markerCollection : accountCollection,
  );

  const connection = options.withoutDb ? {} : { db: { collection } };

  const authInstance =
    'authInstance' in options ? options.authInstance : { options: { account: options.accountOptions } };

  const service = new CoreBetterAuthService(
    authInstance as never,
    connection as never,
    (options.config ?? { enabled: true }) as never,
  );

  const logger = {
    debug: vi.spyOn((service as any).logger, 'debug').mockImplementation(() => undefined),
    error: vi.spyOn((service as any).logger, 'error').mockImplementation(() => undefined),
    log: vi.spyOn((service as any).logger, 'log').mockImplementation(() => undefined),
    warn: vi.spyOn((service as any).logger, 'warn').mockImplementation(() => undefined),
  };

  return { accountFindOne, bulkWrite, collection, find, logger, markerFindOne, markerUpdateOne, service };
}

describe('better-auth account.issuer backfill', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('sets the credential issuer on rows that predate better-auth 1.7', async () => {
    const { bulkWrite, find, logger, service } = buildService({ pending: [{ _id: 'a' }, { _id: 'b' }, { _id: 'c' }] });

    await service.onModuleInit();

    // Only rows still missing the field, so a second boot is a no-op.
    expect(find).toHaveBeenCalledWith(
      { issuer: { $exists: false }, providerId: 'credential' },
      { projection: { _id: 1 } },
    );

    const [ops, opts] = bulkWrite.mock.calls[0];
    expect(ops).toHaveLength(3);
    expect(ops[0].updateOne.update).toEqual({ $set: { issuer: CREDENTIAL_ISSUER } });

    // `ordered: false` is the difference between one bad row costing itself and one bad row
    // locking out every user after it.
    expect(opts).toEqual({ ordered: false });

    expect(logger.log).toHaveBeenCalledWith(expect.stringContaining('3 credential account(s)'));
  });

  it('never rewrites accounts that already carry an issuer', async () => {
    const { find, service } = buildService({ pending: [{ _id: 'a' }] });

    await service.onModuleInit();

    // Without `$exists: false` the update would also hit rows better-auth wrote itself —
    // including OAuth rows whose issuer is NOT the credential one.
    const [filter] = find.mock.calls[0];
    expect(filter.issuer).toEqual({ $exists: false });
  });

  it('leaves non-credential accounts to the project instead of guessing their issuer', async () => {
    const { accountFindOne, bulkWrite, logger, service } = buildService({
      pending: [{ _id: 'a' }],
      staleOther: true,
    });

    await service.onModuleInit();

    // Reported...
    expect(accountFindOne).toHaveBeenCalledWith(
      { issuer: { $exists: false }, providerId: { $ne: 'credential' } },
      { projection: { _id: 1 } },
    );

    // ...and the warning has to describe what actually happens, because an operator acts on it:
    // better-auth does NOT simply refuse such a sign-in, it implicitly links a second row.
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('implicitly links a SECOND account row'));

    // ...but never written: the only write is the credential-scoped one.
    expect(bulkWrite).toHaveBeenCalledTimes(1);
    expect(bulkWrite.mock.calls[0][0][0].updateOne.update).toEqual({ $set: { issuer: CREDENTIAL_ISSUER } });
  });

  it('skips the scan entirely once the completion marker exists', async () => {
    const { bulkWrite, find, markerFindOne, service } = buildService({ markerExists: true });

    await service.onModuleInit();

    expect(markerFindOne).toHaveBeenCalledWith({ _id: ACCOUNT_ISSUER_BACKFILL_ID });

    // The whole point of the marker: neither of the two unindexable queries runs again. Without
    // this, every boot of every replica pays a full pass over the account collection, forever.
    expect(find).not.toHaveBeenCalled();
    expect(bulkWrite).not.toHaveBeenCalled();
  });

  it('writes the marker after a complete run', async () => {
    const { markerUpdateOne, service } = buildService({ pending: [{ _id: 'a' }] });

    await service.onModuleInit();

    expect(markerUpdateOne).toHaveBeenCalledWith(
      { _id: ACCOUNT_ISSUER_BACKFILL_ID },
      { $set: expect.objectContaining({ backfilled: 1, modelName: 'account' }) },
      { upsert: true },
    );
  });

  it('does NOT write the marker when only some rows could be backfilled', async () => {
    const { logger, markerUpdateOne, service } = buildService({
      modifiedCount: 1,
      pending: [{ _id: 'a' }, { _id: 'b' }, { _id: 'c' }],
    });

    await service.onModuleInit();

    // Marking a partial run complete would strand the remaining users permanently — the next
    // boot has to retry them.
    expect(markerUpdateOne).not.toHaveBeenCalled();
    expect(logger.error).toHaveBeenCalledWith(expect.stringContaining('2 user(s) CANNOT sign in'));
  });

  it('follows a renamed account model and issuer field instead of silently doing nothing', async () => {
    const { collection, find, logger, service } = buildService({
      accountOptions: { fields: { issuer: 'issuerUrl' }, modelName: 'accounts' },
      pending: [{ _id: 'a' }],
    });

    await service.onModuleInit();

    expect(collection).toHaveBeenCalledWith('accounts');
    expect(find.mock.calls[0][0]).toEqual({ issuerUrl: { $exists: false }, providerId: 'credential' });
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('customised schema'));
  });

  it('does not stop the boot when the backfill itself fails, and says so loudly', async () => {
    const { bulkWrite, logger, service } = buildService({ pending: [{ _id: 'a' }] });
    bulkWrite.mockRejectedValue(new Error('replica set stepped down'));

    // A server that starts with a loud error beats one that will not start at all — but "loud"
    // is half the contract, so assert the log, not just the resolution.
    await expect(service.onModuleInit()).resolves.toBeUndefined();
    expect(logger.error).toHaveBeenCalledWith(expect.stringContaining('replica set stepped down'));
  });

  it('stays idle when better-auth is present but disabled by config', async () => {
    const { find, markerFindOne, service } = buildService({
      authInstance: { options: {} },
      config: { enabled: false },
    });

    await service.onModuleInit();

    // The instance exists, so this exercises the config flag rather than the null-instance guard.
    expect(markerFindOne).not.toHaveBeenCalled();
    expect(find).not.toHaveBeenCalled();
  });

  it('stays idle when no database connection is available', async () => {
    const { collection, service } = buildService({ pending: [{ _id: 'a' }], withoutDb: true });

    await expect(service.onModuleInit()).resolves.toBeUndefined();
    expect(collection).not.toHaveBeenCalled();
  });
});
