/**
 * Story: upgrading a database written by better-auth 1.6 to 1.7
 *
 * As an operator upgrading @lenne.tech/nest-server to 11.37.0,
 * I want every existing password user to keep signing in,
 * So that the upgrade itself does not lock out my entire user base.
 *
 * WHY THIS SUITE EXISTS, AND WHY IT CANNOT BE A UNIT TEST.
 * From better-auth 1.7 an account is keyed by (issuer, accountId) and the sign-in route filters on
 * it verbatim. A credential row written by 1.6 has no `issuer` field at all, so the row is simply
 * not found and the user gets a bare 401. The boot-time backfill in `CoreBetterAuthService` repairs
 * those rows.
 *
 * Every other suite in this repo creates its users through better-auth 1.7, so they always carry
 * the field — the failure is structurally invisible to them. The unit spec
 * (`tests/unit/better-auth-account-issuer-backfill.spec.ts`) drives a collection double, so it can
 * prove the query shapes and the marker, but not that better-auth accepts the repaired row. Only a
 * real database plus better-auth's own sign-in route can show that, which is what this suite does:
 * it takes a genuine 1.7 account and strips the field back to its 1.6 shape.
 *
 * The load-bearing step is the FAILING sign-in in the middle. Without it, the final assertion would
 * pass just as happily if better-auth had never filtered on the issuer at all — the test would
 * prove the backfill writes a field, not that the field is what makes sign-in work. That step pins
 * the upstream behaviour the entire release is predicated on: if better-auth ever relaxes the
 * filter, this suite tells us the backfill has become unnecessary.
 *
 * @regression   11.37.0 — upgrading better-auth 1.6 -> 1.7 locked out every existing password user,
 *   because their `account` rows predate the (issuer, accountId) key and sign-in filters on it.
 * @seen-failing Remove the `await this.backfillAccountIssuers();` call from `onModuleInit()` in
 *   src/core/modules/better-auth/core-better-auth.service.ts — registered as mutation
 *   `account-issuer-backfill-missing` in tests/regression-mutations.json.
 *
 * The two account WRITE sites carry their own evidence, pinned by the suites that already cover
 * them rather than by this one: see tests/stories/bidirectional-auth-sync.e2e-spec.ts and
 * tests/stories/system-setup.e2e-spec.ts.
 */

import { Test, TestingModule } from '@nestjs/testing';
import { PubSub } from 'graphql-subscriptions';
import { Db, MongoClient } from 'mongodb';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { CoreBetterAuthService, HttpExceptionLogFilter, TestHelper } from '../../src';
import {
  ACCOUNT_ISSUER_BACKFILL_ID,
  BACKFILL_MARKER_COLLECTION,
} from '../../src/core/modules/better-auth/core-better-auth.constants';
import envConfig from '../../src/config.env';
import { ServerModule } from '../../src/server/server.module';

/** The value better-auth derives for credential accounts. Hardcoded on purpose: if better-auth ever
 *  changes the format, this suite must fail rather than follow it silently. */
const CREDENTIAL_ISSUER = 'local:credential';

describe('Story: better-auth 1.6 -> 1.7 issuer upgrade', () => {
  let app;
  let testHelper: TestHelper;
  let mongoClient: MongoClient;
  let db: Db;
  let betterAuthService: CoreBetterAuthService;
  let isBetterAuthEnabled: boolean;

  const testEmails: string[] = [];
  const testIamUserIds: string[] = [];

  const generateTestEmail = (prefix: string): string => {
    const email = `issuer-${prefix}-${Date.now()}-${Math.random().toString(36).substring(2, 8)}@test.com`;
    testEmails.push(email);
    return email;
  };

  /** Runs the backfill the way a boot would, but without a marker in the way. */
  const runBackfill = async (): Promise<void> => {
    await db.collection(BACKFILL_MARKER_COLLECTION).deleteOne({ _id: ACCOUNT_ISSUER_BACKFILL_ID as any });
    await (betterAuthService as any).backfillAccountIssuers();
  };

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

    betterAuthService = moduleFixture.get(CoreBetterAuthService);
    isBetterAuthEnabled = betterAuthService.isEnabled();

    mongoClient = await MongoClient.connect(envConfig.mongoose.uri);
    db = mongoClient.db();
  });

  afterAll(async () => {
    if (db) {
      for (const email of testEmails) {
        const user = await db.collection('users').findOne({ email });
        if (user) {
          const userIds: any[] = [user._id, user._id.toString()];
          if (user.iamId) userIds.push(user.iamId);
          await db.collection('users').deleteOne({ _id: user._id });
          await db.collection('account').deleteMany({ userId: { $in: userIds } });
          await db.collection('session').deleteMany({ userId: { $in: userIds } });
        }
      }
      for (const iamId of testIamUserIds) {
        await db.collection('users').deleteOne({ id: iamId });
        await db.collection('account').deleteMany({ userId: iamId });
        await db.collection('session').deleteMany({ userId: iamId });
      }
    }

    if (mongoClient) {
      await mongoClient.close();
    }

    if (app) {
      await app.close();
    }
  });

  it('restores sign-in for a credential account written before better-auth 1.7', async () => {
    if (!isBetterAuthEnabled) {
      console.warn('Better-Auth is disabled — skipping');
      return;
    }

    const email = generateTestEmail('legacy-row');
    const password = 'IssuerUpgrade123!';

    // 1. A genuine 1.7 account.
    const signUp = await testHelper.rest('/iam/sign-up/email', {
      method: 'POST',
      payload: { email, name: 'Issuer Upgrade', password, termsAndPrivacyAccepted: true },
      statusCode: 201,
    });
    expect(signUp.user?.id).toBeDefined();
    testIamUserIds.push(signUp.user.id);

    // better-auth stores `userId` as an ObjectId but returns a string id, so filter on `accountId` —
    // which is a string and is the half of better-auth's own (issuer, accountId) key.
    const accountFilter = { accountId: signUp.user.id, providerId: 'credential' };
    expect(await db.collection('account').findOne(accountFilter)).toMatchObject({ issuer: CREDENTIAL_ISSUER });

    // 2. Strip it back to the shape better-auth 1.6 wrote.
    const stripped = await db.collection('account').updateOne(accountFilter, { $unset: { issuer: '' } });
    expect(stripped.modifiedCount).toBe(1);

    // 3. THE LOAD-BEARING STEP: sign-in must now fail. This is what proves the field is the reason
    //    sign-in works, rather than the backfill merely writing something harmless.
    const brokenSignIn = await testHelper.rest('/iam/sign-in/email', {
      method: 'POST',
      payload: { email, password },
      statusCode: 401,
    });
    expect(brokenSignIn?.success).not.toBe(true);

    // 4. The upgrade boot.
    await runBackfill();

    // 5. The row is repaired...
    expect(await db.collection('account').findOne(accountFilter)).toMatchObject({ issuer: CREDENTIAL_ISSUER });

    // ...and better-auth accepts it again.
    const repairedSignIn = await testHelper.rest('/iam/sign-in/email', {
      method: 'POST',
      payload: { email, password },
    });
    expect(repairedSignIn.success).toBe(true);
    expect(repairedSignIn.user.email).toBe(email);
  });

  it('leaves a non-credential account untouched and records the completion marker', async () => {
    if (!isBetterAuthEnabled) {
      console.warn('Better-Auth is disabled — skipping');
      return;
    }

    const email = generateTestEmail('oauth-row');
    const signUp = await testHelper.rest('/iam/sign-up/email', {
      method: 'POST',
      payload: { email, name: 'Oauth Shape', password: 'IssuerUpgrade123!', termsAndPrivacyAccepted: true },
      statusCode: 201,
    });
    testIamUserIds.push(signUp.user.id);

    // A social row from a 1.6 database: no issuer, and a provider whose issuer we cannot derive.
    const oauthRow = {
      accountId: `google-${signUp.user.id}`,
      createdAt: new Date(),
      providerId: 'google',
      updatedAt: new Date(),
      userId: signUp.user.id,
    };
    await db.collection('account').insertOne(oauthRow as any);

    await runBackfill();

    // Guessing an OAuth issuer would not fail loudly — it would create a second account on the
    // user's next social sign-in. So the row stays exactly as it was.
    const after = await db.collection('account').findOne({ accountId: oauthRow.accountId });
    expect(after).toBeTruthy();
    expect(after!.issuer).toBeUndefined();

    // A completed run records its marker, which is what keeps every later boot from re-scanning.
    const marker = await db.collection(BACKFILL_MARKER_COLLECTION).findOne({ _id: ACCOUNT_ISSUER_BACKFILL_ID as any });
    expect(marker).toBeTruthy();

    await db.collection('account').deleteOne({ accountId: oauthRow.accountId });
  });

  it('is idempotent — a second run changes nothing', async () => {
    if (!isBetterAuthEnabled) {
      console.warn('Better-Auth is disabled — skipping');
      return;
    }

    const email = generateTestEmail('idempotent');
    const signUp = await testHelper.rest('/iam/sign-up/email', {
      method: 'POST',
      payload: { email, name: 'Idempotent', password: 'IssuerUpgrade123!', termsAndPrivacyAccepted: true },
      statusCode: 201,
    });
    testIamUserIds.push(signUp.user.id);

    // better-auth stores `userId` as an ObjectId but returns a string id, so filter on `accountId` —
    // which is a string and is the half of better-auth's own (issuer, accountId) key.
    const accountFilter = { accountId: signUp.user.id, providerId: 'credential' };

    await runBackfill();
    const first = await db.collection('account').findOne(accountFilter);

    await runBackfill();
    const second = await db.collection('account').findOne(accountFilter);

    expect(second!.issuer).toBe(CREDENTIAL_ISSUER);
    expect(second!.updatedAt).toEqual(first!.updatedAt);
  });
});
