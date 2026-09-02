/**
 * Story: A password reset lands in BOTH credential stores
 *
 * As an operator running Legacy Auth and IAM next to each other,
 * I want every password reset to reach both credential stores,
 * So that the new password works on every sign-in path and the old one on none.
 *
 * WHY THIS IS ONE MATRIX AND NOT FOUR SUITES
 *
 * The same contract has four implementations — two reset endpoints times two wire
 * formats — and the defect it was written for survived for exactly that reason: each
 * combination had been thought about on its own, so the one nobody exercised was the
 * one that shipped. `resetPassword` skipped the IAM sync whenever the incoming value
 * was already sha256, and the lt auth client hashes in the browser (`ltSha256`, seven
 * call sites in nuxt-extensions), so the skipped branch was the ONLY branch a real
 * frontend ever took. The plaintext case — the one the existing e2e test covered —
 * worked throughout.
 *
 * WHY THE STORE-LEVEL ASSERTIONS ARE NOT REDUNDANT
 *
 * `CoreAuthService.signIn` DELEGATES to IAM as soon as the user carries an `iamId`
 * (core-auth.service.ts, "authenticated via IAM (already migrated)"). For a migrated
 * user both endpoints therefore answer from the IAM credential, and a legacy bcrypt
 * hash left behind on the OLD password cannot be observed through either API. It
 * becomes observable the moment IAM is switched off for that deployment — which is the
 * one moment nobody is watching. Asserting through the API alone would let the
 * IAM→legacy half of the contract rot silently, so each cell also reads both stores.
 *
 * @regression   11.38.0 — a password reset updated one credential store and left the
 *   other on the OLD password, while the endpoint reported success. Two halves:
 *   `CoreUserService.resetPassword`/`update` skipped the legacy→IAM sync for an
 *   already-sha256 password, and nothing at all synced an IAM reset back to legacy.
 * @seen-failing Four registered mutations in tests/regression-mutations.json, each turning a
 *   different half red:
 *     reset-skips-iam-sync-for-hashed-password  restores the 64-hex guard in resetPassword()
 *     update-skips-iam-sync-for-hashed-password the same guard on the update() path
 *     iam-reset-does-not-sync-to-legacy         drops the legacy mirror from onPasswordReset
 *     iam-reset-password-not-normalized         stops normalizing the native reset routes
 */

import { Test, TestingModule } from '@nestjs/testing';
import bcrypt = require('bcrypt');
import { PubSub } from 'graphql-subscriptions';
import { sha256 } from 'js-sha256';
import { Db, MongoClient } from 'mongodb';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { nativeScryptVerify } from '../../src/core/modules/better-auth/better-auth.config';
import {
  CoreBetterAuthService,
  CoreBetterAuthUserMapper,
  HttpExceptionLogFilter,
  TestGraphQLType,
  TestHelper,
} from '../../src';
import envConfig from '../../src/config.env';
import { ServerModule } from '../../src/server/server.module';

/**
 * How the browser puts the password on the wire.
 *
 * Both are legitimate and both must survive a reset: the lt auth client hashes
 * client-side, a plain `fetch` against the same endpoint does not, and the server
 * normalizes either into the same value. A reset that only works for one of them is
 * the defect this file exists for.
 */
const WIRE_FORMATS = [
  { encode: (password: string): string => password, name: 'plaintext' },
  { encode: (password: string): string => sha256(password), name: 'sha256' },
] as const;

describe('Story: Password reset parity (Legacy + IAM)', () => {
  let app: any;
  let testHelper: TestHelper;
  let mongoClient: MongoClient;
  let db: Db;
  let userMapper: CoreBetterAuthUserMapper;
  let isBetterAuthEnabled: boolean;

  const testEmails: string[] = [];

  const generateTestEmail = (prefix: string): string => {
    // Lower-cased deliberately: the server stores addresses lower-cased, so an
    // upper-case fragment here would make every db lookup below miss and the cell
    // would assert against `undefined` instead of against the product.
    const email =
      `reset-parity-${prefix}-${Date.now()}-${Math.random().toString(36).substring(2, 8)}@test.com`.toLowerCase();
    testEmails.push(email);
    return email;
  };

  /**
   * The password each user currently signs in with, on the wire.
   *
   * `changeViaSelfUpdate` has to authenticate before it can change anything, and the wire format
   * differs per matrix cell — so the value is recorded when the user is created rather than
   * guessed from the cell.
   */
  const currentPasswordOnWire = new Map<string, string>();
  const passwordOnWireFor = (email: string): string => {
    const password = currentPasswordOnWire.get(email);
    if (!password) {
      throw new Error(`No current password recorded for ${email} — createParallelUser was not used.`);
    }
    return password;
  };

  // =================================================================================================================
  // Store-level probes
  //
  // These read the two credential stores directly, because the sign-in APIs cannot tell
  // them apart for a migrated user (see the header note on IAM delegation).
  // =================================================================================================================

  /** Does the LEGACY bcrypt hash in `users.password` accept this password? */
  const legacyStoreAccepts = async (email: string, password: string): Promise<boolean> => {
    const user = await db.collection('users').findOne({ email });
    if (!user?.password) {
      return false;
    }
    // Legacy accepts both shapes, exactly as CoreAuthService.signIn compares them — but the
    // sha256 form is tried FIRST, because that is what `syncPasswordToLegacy` always writes. On a
    // positive assertion the second bcrypt then never runs; on a negative one both run either way.
    return (await bcrypt.compare(sha256(password), user.password)) || (await bcrypt.compare(password, user.password));
  };

  /** Does the IAM scrypt hash in `account.password` accept this password? */
  const iamStoreAccepts = async (email: string, password: string): Promise<boolean> => {
    const user = await db.collection('users').findOne({ email });
    if (!user) {
      return false;
    }
    const account = await db.collection('account').findOne({
      providerId: 'credential',
      userId: { $in: [user._id, user._id.toString(), user.iamId, user.id].filter(Boolean) },
    });
    if (!account?.password) {
      return false;
    }
    // Asks the PRODUCT, rather than re-declaring the scrypt parameters here. A copy drifts
    // silently — change a parameter in better-auth.config.ts and a hand-rolled probe derives a
    // different key, turning every cell red with a misleading diagnosis, or (if both drift
    // compatibly) green for the wrong reason. `normalizePasswordForIam` is borrowed for the same
    // reason.
    return nativeScryptVerify({
      hash: String(account.password),
      password: userMapper.normalizePasswordForIam(password),
    });
  };

  // =================================================================================================================
  // Flows
  // =================================================================================================================

  /**
   * Create a user that exists in BOTH systems.
   *
   * IAM sign-up is what produces the parallel state: it writes the IAM credential and
   * `syncPasswordToLegacy` mirrors a bcrypt hash into `users.password`.
   */
  const createParallelUser = async (email: string, passwordOnWire: string): Promise<void> => {
    await testHelper.rest('/iam/sign-up/email', {
      method: 'POST',
      payload: { email, name: 'Reset Parity', password: passwordOnWire, termsAndPrivacyAccepted: true },
      statusCode: 201,
    });
    currentPasswordOnWire.set(email, passwordOnWire);
  };

  /** Reset through the LEGACY user endpoint (`CoreUserService.resetPassword`). */
  const resetViaLegacy = async (email: string, newPasswordOnWire: string): Promise<void> => {
    await testHelper.rest('/users/password/reset-request', { method: 'POST', payload: { email }, statusCode: 201 });
    const user = await db.collection('users').findOne({ email });
    expect(user?.passwordResetToken, 'legacy reset request must produce a token').toBeTruthy();
    await testHelper.rest('/users/password/reset', {
      method: 'POST',
      payload: { password: newPasswordOnWire, token: user!.passwordResetToken },
      statusCode: 201,
    });
  };

  /** Reset through the IAM endpoint (Better-Auth `/iam/reset-password`). */
  const resetViaIam = async (email: string, newPasswordOnWire: string): Promise<void> => {
    await testHelper.rest('/iam/request-password-reset', {
      method: 'POST',
      payload: { email, redirectTo: `${envConfig.baseUrl}/reset` },
    });
    const user = await db.collection('users').findOne({ email });
    const verification = await db
      .collection('verification')
      .find({ identifier: /^reset-password:/, value: { $in: [user?.id, user?.iamId, user?._id?.toString()] } })
      .sort({ _id: -1 })
      .limit(1)
      .toArray();
    expect(verification.length, 'IAM reset request must store a verification token').toBe(1);
    const token = String(verification[0].identifier).replace('reset-password:', '');
    await testHelper.rest('/iam/reset-password', {
      method: 'POST',
      payload: { newPassword: newPasswordOnWire, token },
    });
  };

  /** Change the password through `CoreUserService.update()` (the admin/self update path). */
  const changeViaUpdate = async (email: string, newPasswordOnWire: string, token: string): Promise<void> => {
    const user = await db.collection('users').findOne({ email });
    const result = await testHelper.graphQl(
      {
        arguments: { id: user!._id.toString(), input: { password: newPasswordOnWire } },
        fields: ['id'],
        name: 'updateUser',
        type: TestGraphQLType.MUTATION,
      },
      { token },
    );
    // GraphQL answers a rejected mutation with HTTP 200 and an `errors` array, so the status
    // assertion inside `graphQl()` proves nothing here. Without this, a permissions regression
    // would surface as "IAM store must carry the new password" rather than as what it is.
    expect(result?.id, 'updateUser must actually have applied the change').toBeTruthy();
  };

  /**
   * Sets a new password through `CoreUserService.update()` — the admin/self update path.
   *
   * Signs the user in first, so the change runs under S_SELF rather than an admin fixture: a
   * permissive fixture would explain a green just as well as the fix does. The paired refusal
   * case below is what actually rules that explanation out.
   */
  const changeViaSelfUpdate = async (email: string, newPasswordOnWire: string): Promise<void> => {
    const currentUser = await db.collection('users').findOne({ email });
    expect(currentUser, 'the user must exist before changing its password').toBeTruthy();

    const signIn = await testHelper.rest('/iam/sign-in/email', {
      method: 'POST',
      payload: { email, password: passwordOnWireFor(email) },
    });
    const token = signIn?.token || signIn?.data?.token;
    expect(token, 'sign-in must yield a token for the self-update').toBeTruthy();

    await changeViaUpdate(email, newPasswordOnWire, token);
  };

  /**
   * `update()` is a THIRD entry rather than a separate loop below.
   *
   * It is the same contract — "a password change reaches both credential stores" — through a
   * different door, so leaving it out of the matrix would ask the two reset paths a question it
   * declines to ask this one. The repo's own rule is that a cell is EXECUTED, IMPOSSIBLE or
   * DIFFERENT-BY-DESIGN, never merely absent.
   */
  const RESET_PATHS = [
    { name: 'legacy user endpoint', run: resetViaLegacy },
    { name: 'IAM endpoint', run: resetViaIam },
    { name: 'self update', run: changeViaSelfUpdate },
  ] as const;

  // =================================================================================================================
  // Setup and teardown
  // =================================================================================================================

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

    userMapper = moduleFixture.get(CoreBetterAuthUserMapper);
    isBetterAuthEnabled = moduleFixture.get(CoreBetterAuthService).isEnabled();

    mongoClient = await MongoClient.connect(envConfig.mongoose.uri);
    db = mongoClient.db();

    // Once, loudly, instead of five times with two divergent texts. A silently skipped
    // infrastructure test is how an untested path ships, and this story's whole premise is that
    // the parallel Legacy+IAM state exists.
    if (!isBetterAuthEnabled) {
      throw new Error(
        'Better-Auth is disabled in this environment — this story cannot verify the parallel ' +
          'credential contract. Enable `betterAuth` for the e2e config rather than skipping it.',
      );
    }
  });

  afterAll(async () => {
    if (db) {
      for (const email of testEmails) {
        const user = await db.collection('users').findOne({ email });
        if (user) {
          const userIds: any[] = [user._id, user._id.toString()];
          if (user.iamId) userIds.push(user.iamId);
          if (user.id) userIds.push(user.id);
          await db.collection('users').deleteOne({ _id: user._id });
          await db.collection('account').deleteMany({ userId: { $in: userIds } });
          await db.collection('session').deleteMany({ userId: { $in: userIds } });
          await db.collection('verification').deleteMany({ value: { $in: userIds.map(String) } });
        }
      }
    }
    if (mongoClient) {
      await mongoClient.close();
    }
    if (app) {
      await app.close();
    }
  });

  // =================================================================================================================
  // The matrix
  // =================================================================================================================

  for (const path of RESET_PATHS) {
    for (const format of WIRE_FORMATS) {
      describe(`reset via ${path.name}, ${format.name} on the wire`, () => {
        it('leaves the NEW password valid in both stores and the OLD password in neither', async () => {
          const email = generateTestEmail(`${path.name.split(' ')[0]}-${format.name}`);
          const oldPassword = 'OldParity123!';
          const newPassword = 'NewParity456!';

          await createParallelUser(email, format.encode(oldPassword));

          // Precondition: the parallel state actually exists, otherwise the cell proves nothing.
          expect(await iamStoreAccepts(email, oldPassword), 'IAM store must hold the old password').toBe(true);
          expect(await legacyStoreAccepts(email, oldPassword), 'legacy store must hold the old password').toBe(true);

          await path.run(email, format.encode(newPassword));

          // Both stores carry the NEW password …
          expect(await iamStoreAccepts(email, newPassword), 'IAM store must carry the new password').toBe(true);
          expect(await legacyStoreAccepts(email, newPassword), 'legacy store must carry the new password').toBe(true);

          // … and neither carries the OLD one any more. This is the half that a reset
          // performed after a suspected compromise depends on.
          expect(await iamStoreAccepts(email, oldPassword), 'IAM store must drop the old password').toBe(false);
          expect(await legacyStoreAccepts(email, oldPassword), 'legacy store must drop the old password').toBe(false);
        });

        it('signs in with the NEW password and refuses the OLD one on both endpoints', async () => {
          const email = generateTestEmail(`${path.name.split(' ')[0]}-${format.name}-signin`);
          const oldPassword = 'OldSignIn123!';
          const newPassword = 'NewSignIn456!';

          await createParallelUser(email, format.encode(oldPassword));
          await path.run(email, format.encode(newPassword));

          // The NEW password first, on both endpoints. Deliberately BEFORE the refusal
          // checks: a rejected sign-in is an event an auth stack is entitled to react to
          // (rate limiting, lockout counters), so letting one run first would leave a
          // later failure ambiguous between "the reset did not land" and "the previous
          // attempt was held against us".
          await testHelper.rest('/iam/sign-in/email', {
            method: 'POST',
            payload: { email, password: format.encode(newPassword) },
          });
          await testHelper.rest('/auth/signin', {
            method: 'POST',
            payload: { email, password: format.encode(newPassword) },
            statusCode: 201,
          });

          // Then the OLD password, which must now be refused everywhere.
          await testHelper.rest('/iam/sign-in/email', {
            method: 'POST',
            payload: { email, password: format.encode(oldPassword) },
            statusCode: 401,
          });
          await testHelper.rest('/auth/signin', {
            method: 'POST',
            payload: { email, password: format.encode(oldPassword) },
            statusCode: 401,
          });
        });
      });
    }
  }

  // =================================================================================================================
  // The fixture claim, made falsifiable
  // =================================================================================================================

  describe('the self-update fixture is not permissive', () => {
    // The matrix runs `update()` under S_SELF and argues that this rules out "a permissive
    // fixture would explain the green too". That argument is only worth something if something
    // asserts it — otherwise the file makes a claim about its own setup that it never checks.
    it('refuses a password change on somebody else\'s account', async () => {
      const victim = generateTestEmail('victim');
      const attacker = generateTestEmail('attacker');
      const password = 'FixtureProof123!';

      await createParallelUser(victim, password);
      await createParallelUser(attacker, password);

      const signIn = await testHelper.rest('/iam/sign-in/email', {
        method: 'POST',
        payload: { email: attacker, password },
      });
      const attackerToken = signIn?.token || signIn?.data?.token;
      expect(attackerToken).toBeTruthy();

      const victimUser = await db.collection('users').findOne({ email: victim });
      const result = await testHelper.graphQl(
        {
          arguments: { id: victimUser!._id.toString(), input: { password: 'Hijacked456!' } },
          fields: ['id'],
          name: 'updateUser',
          type: TestGraphQLType.MUTATION,
        },
        { logError: false, statusCode: 200, token: attackerToken },
      );

      // GraphQL reports a refused mutation as HTTP 200 with `errors`, so the absence of a
      // returned id is the signal. The store assertion below is the one that matters either way.
      expect(result?.id, 'a foreign user must not be able to set this password').toBeFalsy();
      expect(
        await iamStoreAccepts(victim, 'Hijacked456!'),
        'the victim credential must be untouched',
      ).toBe(false);
      expect(await iamStoreAccepts(victim, password), 'the victim password must still work').toBe(true);
    });
  });
});
