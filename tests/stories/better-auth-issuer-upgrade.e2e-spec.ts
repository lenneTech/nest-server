/**
 * Story: leaving better-auth's short-lived issuer schema (1.7.0–1.7.2) for 1.7.3+
 *
 * As an operator upgrading @lenne.tech/nest-server from 11.37–11.41.7 (better-auth 1.7.1) to 11.41.8+
 * (better-auth 1.7.7),
 * I want every existing user to keep signing in and new accounts to keep being created,
 * So that the security upgrade cannot lock anybody out.
 *
 * WHAT HAPPENED UPSTREAM. better-auth 1.7.0 keyed accounts by `(issuer, accountId)`; this framework
 * followed (issuer on every write, a boot-time backfill for older rows). 1.7.3 restored the 1.6
 * schema — accounts keyed by `(providerId, accountId)` — and no longer reads or writes `issuer`. Two
 * things are left behind in every database that ran the issuer versions, and this suite checks both
 * against a real database and better-auth's own sign-in route:
 *
 *   1. `issuer` values on account rows. They must be INERT: a row that still carries one signs in.
 *   2. The unique `(issuer, accountId)` index the MongoDB adapter created lazily. With the field no
 *      longer written it would treat every new account as having the same, missing issuer and refuse
 *      a second provider with the same account ID. The boot drops it
 *      (`CoreBetterAuthService.dropLegacyAccountIssuerIndex()`).
 *
 * The index cases run against a collection of their own, named through the same
 * `betterAuth.options.account.modelName` a consumer can set — a unique index on the shared `account`
 * collection would interfere with every suite running in parallel. That also exercises the
 * renamed-schema path, which is where a hardcoded collection name would silently do nothing.
 *
 * The legacy line itself (a project still on better-auth 1.7.0–1.7.2: issuer written, backfill run)
 * cannot be reached here — this repository installs 1.7.7. It is pinned by unit specs that simulate
 * it: tests/unit/better-auth-account-issuer-backfill.spec.ts and
 * tests/unit/better-auth-account-issuer-writes.spec.ts.
 *
 * @regression   11.41.8 — on better-auth 1.7.3+ the unique (issuer, accountId) index left behind by
 *   1.7.0–1.7.2 refuses a second account whose ID another provider already uses.
 * @seen-failing Make the index filter in `dropLegacyAccountIssuerIndex()` never match, in
 *   src/core/modules/better-auth/core-better-auth.service.ts — registered as mutation
 *   `legacy-issuer-index-never-dropped` in tests/regression-mutations.json.
 */

import { Test, TestingModule } from '@nestjs/testing';
import { PubSub } from 'graphql-subscriptions';
import { Db, MongoClient } from 'mongodb';
import mongoose, { Connection } from 'mongoose';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { CoreBetterAuthService, HttpExceptionLogFilter, TestHelper } from '../../src';
import {
  ACCOUNT_ISSUER_BACKFILL_ID,
  BACKFILL_MARKER_COLLECTION,
} from '../../src/core/modules/better-auth/core-better-auth.constants';
import envConfig from '../../src/config.env';
import { ServerModule } from '../../src/server/server.module';

/** The value better-auth 1.7.0–1.7.2 stored on credential accounts. */
const LEGACY_CREDENTIAL_ISSUER = 'local:credential';

describe('Story: better-auth 1.7.0–1.7.2 issuer schema -> 1.7.3+', () => {
  let app;
  let testHelper: TestHelper;
  let mongoClient: MongoClient;
  let db: Db;
  let connection: Connection;
  let isBetterAuthEnabled: boolean;

  const runId = `${Date.now()}-${Math.random().toString(36).substring(2, 8)}`;
  const indexCollections: string[] = [];
  const testIamUserIds: string[] = [];

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [ServerModule],
      providers: [{ provide: 'PUB_SUB', useValue: new PubSub() }],
    }).compile();

    app = moduleFixture.createNestApplication();
    app.useGlobalFilters(new HttpExceptionLogFilter());
    app.setBaseViewsDir(envConfig.templates.path);
    app.setViewEngine(envConfig.templates.engine);
    await app.init();
    testHelper = new TestHelper(app);

    isBetterAuthEnabled = moduleFixture.get(CoreBetterAuthService).isEnabled();

    mongoClient = await MongoClient.connect(envConfig.mongoose.uri);
    db = mongoClient.db();
    connection = mongoose.createConnection(envConfig.mongoose.uri);
    await connection.asPromise();
  });

  afterAll(async () => {
    if (db) {
      for (const iamId of testIamUserIds) {
        await db.collection('users').deleteOne({ id: iamId });
        await db.collection('account').deleteMany({ accountId: iamId });
        await db.collection('session').deleteMany({ userId: iamId });
      }
      for (const name of indexCollections) {
        await db
          .collection(name)
          .drop()
          .catch(() => undefined);
      }
    }
    await connection?.close();
    await mongoClient?.close();
    await app?.close();
  });

  /** The service the boot runs, pointed at a collection of this test's own. */
  function serviceFor(modelName: string): CoreBetterAuthService {
    return new CoreBetterAuthService(
      { options: { account: { modelName } } } as never,
      connection as never,
      { enabled: true } as never,
    );
  }

  /** A collection carrying the index better-auth 1.7.0–1.7.2 created, under its default name. */
  async function collectionWithLegacyIndex(label: string): Promise<string> {
    const name = `account_issuer_story_${label}_${runId}`;
    indexCollections.push(name);
    await db.collection(name).createIndex({ accountId: 1, issuer: 1 }, { name: 'unrelated_order', unique: false });
    await db
      .collection(name)
      .createIndex({ issuer: 1, accountId: 1 }, { name: 'account_issuer_accountId_uidx', unique: true });
    return name;
  }

  it('signs in an account that still carries the issuer written by better-auth 1.7.0–1.7.2', async () => {
    if (!isBetterAuthEnabled) {
      console.warn('Better-Auth is disabled — skipping');
      return;
    }

    const email = `issuer-leftover-${runId}@test.com`;
    const password = 'IssuerUpgrade123!';
    const signUp = await testHelper.rest('/iam/sign-up/email', {
      method: 'POST',
      payload: { email, name: 'Issuer Leftover', password, termsAndPrivacyAccepted: true },
      statusCode: 201,
    });
    testIamUserIds.push(signUp.user.id);

    // better-auth 1.7.3+ writes no issuer…
    const accountFilter = { accountId: signUp.user.id, providerId: 'credential' };
    expect((await db.collection('account').findOne(accountFilter))?.issuer).toBeUndefined();

    // …so give the row the shape a 1.7.1 database has, and sign in.
    await db.collection('account').updateOne(accountFilter, { $set: { issuer: LEGACY_CREDENTIAL_ISSUER } });
    const signIn = await testHelper.rest('/iam/sign-in/email', { method: 'POST', payload: { email, password } });
    expect(signIn.success).toBe(true);
    expect(signIn.user.email).toBe(email);
  });

  it('the left-over index refuses a second provider with the same account ID — until the boot drops it', async () => {
    const name = await collectionWithLegacyIndex('refuse');
    const accounts = db.collection(name);
    const row = (providerId: string) => ({ accountId: `shared-${runId}`, providerId, userId: `u-${providerId}` });

    // THE LOAD-BEARING STEP: with the index in place, the second row is refused. Without this the
    // final assertion would pass just as happily if the index had never been a problem.
    await accounts.insertOne(row('github'));
    await expect(accounts.insertOne(row('google'))).rejects.toMatchObject({ code: 11000 });

    await (serviceFor(name) as any).dropLegacyAccountIssuerIndex();

    await expect(accounts.insertOne(row('google'))).resolves.toBeTruthy();
    const names = (await accounts.indexes()).map((index) => index.name);
    expect(names).not.toContain('account_issuer_accountId_uidx');
    // Recognised by shape: the non-unique index over the same fields in another order stays.
    expect(names).toContain('unrelated_order');
  });

  it('is idempotent, and does nothing to a collection that never had the index', async () => {
    const name = await collectionWithLegacyIndex('idempotent');
    const service = serviceFor(name);

    await (service as any).dropLegacyAccountIssuerIndex();
    await (service as any).dropLegacyAccountIssuerIndex();

    const missing = `account_issuer_story_missing_${runId}`;
    await expect((serviceFor(missing) as any).dropLegacyAccountIssuerIndex()).resolves.toBeUndefined();
    expect((await db.collection(name).indexes()).map((index) => index.name)).not.toContain(
      'account_issuer_accountId_uidx',
    );
  });

  it('forgets the backfill marker, so a rollback to a better-auth that needs the issuer backfills again', async () => {
    const name = await collectionWithLegacyIndex('marker');
    await db
      .collection(BACKFILL_MARKER_COLLECTION)
      .updateOne({ _id: ACCOUNT_ISSUER_BACKFILL_ID as any }, { $set: { completedAt: new Date() } }, { upsert: true });

    await (serviceFor(name) as any).dropLegacyAccountIssuerIndex();

    expect(
      await db.collection(BACKFILL_MARKER_COLLECTION).findOne({ _id: ACCOUNT_ISSUER_BACKFILL_ID as any }),
    ).toBeNull();
  });
});
