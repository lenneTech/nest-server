/**
 * Story: the password-reset request does not say whether an account exists
 *
 * As an operator of a multi-tenant product,
 * I want `POST /users/password/reset-request` to answer identically for a known and an unknown
 *   address,
 * So that nobody can test who has an account — which, for a B2B product, also answers who works
 *   at which customer.
 *
 * WHY THE TIMING ASSERTION IS THE POINT OF THIS FILE
 *
 * Equalising the status code is the obvious half and the smaller one. The response TIME
 * distinguishes the two cases far more loudly: the known path writes a token and sends mail, the
 * unknown path returns immediately. A mail send is a network round trip — tens to hundreds of
 * milliseconds — against microseconds for everything else in the request. So a fix that only
 * changed 404 to 201 would have given up the "unknown address" hint in the UI and kept the oracle
 * fully intact, which is a strictly worse position than before: the same exposure, less usable.
 *
 * That is exactly the objection this file exists to answer, so it is asserted rather than argued.
 *
 * MEASURING IT REQUIRES A SLOW MAILER, AND THAT IS NOT A DETAIL
 *
 * The e2e environment sends mail through nodemailer's `jsonTransport` (`config.env.ts`), which
 * discards the message in-process. There is no network round trip, so an awaited send costs
 * essentially nothing and a wall-clock comparison sees no difference at all. The first version of
 * this test measured exactly that and passed with the defect fully restored — the mutation gate
 * caught it as vacuous, which is the whole reason that gate exists.
 *
 * So the mail service is replaced here by one that deliberately takes {@link MAIL_LATENCY_MS}.
 * That is not an artificial obstacle: it is the only way to reproduce, deterministically, what a
 * real SMTP or Brevo call costs. With the send awaited the known path pays that latency and the
 * unknown one does not; without it, neither does.
 *
 * @regression   11.38.0 — `setPasswordResetTokenForEmail` threw NotFoundException for an unknown
 *   address, so the endpoint answered 404 for unknown and 201 for known: a working account oracle.
 *   The framework already answered this correctly on the IAM path, so the two halves of one
 *   framework disagreed about the same question.
 * @seen-failing Three registered mutations in tests/regression-mutations.json, one per channel —
 *   and it took all three, because the first two fixes left the third wide open:
 *     reset-request-reveals-unknown-email       restores the throw (the STATUS channel)
 *     reset-request-awaits-mail-send            restores the awaited send (the TIME channel)
 *     reset-request-body-reveals-unknown-email  restores `!!user` (the BODY channel)
 *   Each turns a different assertion red, which is what shows they are independent rather than
 *   three descriptions of one thing.
 */

import { Test, TestingModule } from '@nestjs/testing';
import { PubSub } from 'graphql-subscriptions';
import { Db, MongoClient } from 'mongodb';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { EmailService, HttpExceptionLogFilter, TestHelper } from '../../src';
import envConfig from '../../src/config.env';
import { ServerModule } from '../../src/server/server.module';

/**
 * What a real mail send costs, standing in for SMTP/Brevo.
 *
 * Chosen high enough to dwarf request handling and low enough to keep the suite quick. The
 * assertion below compares orders of magnitude, so the exact value is not load-bearing — only that
 * it is unmistakably above the rest of the request.
 */
const MAIL_LATENCY_MS = 250;

describe('Story: the password-reset request reveals nothing', () => {
  let app: any;
  let testHelper: TestHelper;
  let mongoClient: MongoClient;
  let db: Db;

  const knownEmail = `reset-enum-known-${Date.now()}@test.com`.toLowerCase();
  const unknownEmail = `reset-enum-unknown-${Date.now()}-nobody@test.com`.toLowerCase();

  /** Requests a reset and returns the wall-clock duration in milliseconds. */
  const timeResetRequest = async (email: string, statusCode = 201): Promise<number> => {
    const started = process.hrtime.bigint();
    await testHelper.rest('/users/password/reset-request', { method: 'POST', payload: { email }, statusCode });
    return Number(process.hrtime.bigint() - started) / 1_000_000;
  };

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [ServerModule],
      providers: [{ provide: 'PUB_SUB', useValue: new PubSub() }],
    })
      // Stand in for a real mail provider. See the header note: with `jsonTransport` the send is
      // free, and a timing assertion against it measures nothing.
      .overrideProvider(EmailService)
      .useValue({
        sendMail: async () => {
          await new Promise((resolve) => setTimeout(resolve, MAIL_LATENCY_MS));
          return true;
        },
      })
      .compile();

    app = moduleFixture.createNestApplication();
    app.useGlobalFilters(new HttpExceptionLogFilter());
    app.setBaseViewsDir(envConfig.templates.path);
    app.setViewEngine(envConfig.templates.engine);
    await app.init();
    testHelper = new TestHelper(app);

    mongoClient = await MongoClient.connect(envConfig.mongoose.uri);
    db = mongoClient.db();

    await testHelper.rest('/iam/sign-up/email', {
      method: 'POST',
      payload: { email: knownEmail, name: 'Reset Enum', password: 'EnumProof123!', termsAndPrivacyAccepted: true },
      statusCode: 201,
    });
  });

  afterAll(async () => {
    if (db) {
      const user = await db.collection('users').findOne({ email: knownEmail });
      if (user) {
        const ids: any[] = [user._id, user._id.toString(), user.iamId, user.id].filter(Boolean);
        await db.collection('users').deleteOne({ _id: user._id });
        await db.collection('account').deleteMany({ userId: { $in: ids } });
        await db.collection('session').deleteMany({ userId: { $in: ids } });
      }
    }
    await mongoClient?.close();
    await app?.close();
  });

  it('answers with the same status for a known and an unknown address', async () => {
    // `testHelper.rest` asserts the status internally, so passing 201 for BOTH is the assertion.
    // Before 11.38.0 the second call answered 404.
    await timeResetRequest(knownEmail);
    await timeResetRequest(unknownEmail);
  });

  it('returns the same BODY for both, not just the same status', async () => {
    // Found by this suite during development: the resolver returned `!!user`, so the status codes
    // matched while the body said `false` for unknown and `true` for known. Equalising the status
    // and forwarding the distinction one layer up rebuilds the oracle exactly where nobody looks
    // for it — the fix has to reach the value the caller actually reads.
    const request = (await import('supertest')).default;

    const known = await request(app.getHttpServer())
      .post('/users/password/reset-request')
      .send({ email: knownEmail });
    const unknown = await request(app.getHttpServer())
      .post('/users/password/reset-request')
      .send({ email: unknownEmail });

    expect(known.status).toBe(unknown.status);
    expect(known.text, 'the response body must not distinguish the two cases either').toBe(unknown.text);
  });

  it('still issues a real token for the known address', async () => {
    // The equalisation must not be achieved by breaking the feature — a reset request that stops
    // working would also answer identically, and would pass a status-only assertion.
    await timeResetRequest(knownEmail);

    const user = await db.collection('users').findOne({ email: knownEmail });
    expect(user?.passwordResetToken, 'the known address must still get a usable reset token').toBeTruthy();
    expect(String(user!.passwordResetToken)).toMatch(/^[a-f0-9]{64}$/);
  });

  it('writes no token for the unknown address', async () => {
    await timeResetRequest(unknownEmail);

    const ghost = await db.collection('users').findOne({ email: unknownEmail });
    expect(ghost, 'answering identically must not mean creating the account').toBeNull();
  });

  it('does not separate the two cases by response time either', async () => {
    // THE assertion this file exists for. Warm both paths first, so the comparison is not against
    // one-time module/connection setup.
    await timeResetRequest(knownEmail);
    await timeResetRequest(unknownEmail);

    const knownRuns: number[] = [];
    const unknownRuns: number[] = [];
    for (let i = 0; i < 5; i++) {
      knownRuns.push(await timeResetRequest(knownEmail));
      unknownRuns.push(await timeResetRequest(unknownEmail));
    }

    // Median rather than mean: one scheduling hiccup should not decide the verdict.
    const median = (values: number[]): number => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];
    const knownMedian = median(knownRuns);
    const unknownMedian = median(unknownRuns);

    // The known path must not carry the mail latency. Half of it is a generous margin: awaited it
    // pays the full MAIL_LATENCY_MS, un-awaited it pays none, so anything in between is noise
    // rather than a verdict — and the test does not flake on a loaded machine.
    expect(
      knownMedian,
      `the known path took ${knownMedian.toFixed(1)}ms against ${unknownMedian.toFixed(1)}ms for the ` +
        `unknown one, with a mail send costing ${MAIL_LATENCY_MS}ms. That gap makes the status-code ` +
        'equalisation pointless: the account is still identifiable by latency. The cause is an ' +
        'awaited mail send in sendPasswordResetMail().',
    ).toBeLessThan(MAIL_LATENCY_MS / 2);

    // And state the comparison too, so a future change that slows BOTH paths equally does not
    // quietly satisfy the bound above while re-opening the gap.
    expect(knownMedian - unknownMedian).toBeLessThan(MAIL_LATENCY_MS / 2);
  });
});
