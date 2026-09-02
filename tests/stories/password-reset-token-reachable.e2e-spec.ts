/**
 * Story: the code that builds the reset mail can actually get at the token
 *
 * As the author of a project that sends its own reset mail,
 * I want the method that CREATES the token to hand it to me,
 * So that the link in the mail contains a token instead of the word `undefined`.
 *
 * WHY THIS FILE EXISTS
 *
 * `setPasswordResetTokenForEmail` writes the token and returns the user — through `process()`,
 * whose security interceptor strips `passwordResetToken` on the way out. That stripping is
 * correct and must stay: a reset token in a response body is a reset token in a log, a proxy
 * cache, and a browser history.
 *
 * But it left every caller of that method in an impossible position. The name promises the token;
 * the return value cannot carry it, by design. A project read `user.passwordResetToken` from the
 * result, got `undefined`, appended it to the configured base, and mailed
 * `…/auth/reset-password/undefined` to a real person — who by definition had no second way in.
 *
 * Every test in that project stayed green, because each one checked a piece: the config spec
 * asserted the base, the story test read the token from the DATABASE, the enumeration spec
 * asserted status and timing. Nothing asserted the one value the caller actually receives, which
 * is what this file does.
 *
 * `createPasswordResetToken` therefore returns the token ALONGSIDE the user, generated outside
 * `process()`. The user object stays scrubbed — that is asserted here too, because a "fix" that
 * simply exempted the field from the interceptor would satisfy the first assertion while
 * reopening a much worse hole.
 *
 * @regression 11.38.0 — `setPasswordResetTokenForEmail` was the only way to mint a token, and it
 *   could not return one. Callers had no correct option.
 * @seen-failing Three registered mutations in tests/regression-mutations.json:
 *     password-reset-token-lost-in-process       the token is read back off the scrubbed result
 *     reference-impl-rebuilds-reset-link         the framework's own consumer hand-builds the link
 *     reset-password-accepts-nosql-operator      the string guard is dropped, re-opening the
 *                                                confirmed account-takeover primitive
 */

import { Test, TestingModule } from '@nestjs/testing';
import { PubSub } from 'graphql-subscriptions';
import { Db, MongoClient } from 'mongodb';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { EmailService, HttpExceptionLogFilter, TestHelper } from '../../src';
import envConfig from '../../src/config.env';
import { ServerModule } from '../../src/server/server.module';
import { UserService } from '../../src/server/modules/user/user.service';

describe('Story: the reset token reaches the code that mails it', () => {
  let app: any;
  let testHelper: TestHelper;
  let userService: UserService;
  let mongoClient: MongoClient;
  let db: Db;

  const email = `reset-token-reach-${Date.now()}@test.com`.toLowerCase();

  /** Everything the mailer was asked to send, in order — the only view of what a recipient sees. */
  const sent: { config: Record<string, unknown>; subject: string; to: string }[] = [];

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [ServerModule],
      providers: [{ provide: 'PUB_SUB', useValue: new PubSub() }],
    })
      // The only way to read the link a recipient would get without sending anything.
      .overrideProvider(EmailService)
      .useValue({
        sendMail: async (to: string, subject: string, config: Record<string, unknown>) => {
          sent.push({ config, subject, to });
          return { accepted: [to] };
        },
      })
      .compile();

    app = moduleFixture.createNestApplication();
    app.useGlobalFilters(new HttpExceptionLogFilter());
    app.setBaseViewsDir(envConfig.templates.path);
    app.setViewEngine(envConfig.templates.engine);
    await app.init();
    testHelper = new TestHelper(app);
    userService = moduleFixture.get(UserService);

    mongoClient = await MongoClient.connect(envConfig.mongoose.uri);
    db = mongoClient.db();

    // `logError` on purpose: this call fell over once under a full 34-worker run, and the bare
    // status assertion reported only "expected X to be 201" — which says nothing about whether it
    // was a timeout, a duplicate, or a real rejection. Not reproducible since, so the useful move
    // is to make the NEXT failure diagnosable rather than to paper over it with retries.
    await testHelper.rest('/iam/sign-up/email', {
      logError: true,
      method: 'POST',
      payload: { email, name: 'Reset Reach', password: 'ReachProof123!', termsAndPrivacyAccepted: true },
      statusCode: 201,
    });
  });

  afterAll(async () => {
    if (db) {
      const user = await db.collection('users').findOne({ email });
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

  it('hands the token back, and it is the one that was stored', async () => {
    const result = await userService.createPasswordResetToken(email);

    expect(result).not.toBeNull();
    expect(result!.token).toMatch(/^[a-f0-9]{64}$/);

    // The assertion that was missing everywhere: not merely a well-shaped token, but THE token —
    // a value that does not match the database unlocks nothing.
    const stored = await db.collection('users').findOne({ email });
    expect(result!.token).toBe(stored?.passwordResetToken);
  });

  it('still keeps the token off the returned user object', async () => {
    const result = await userService.createPasswordResetToken(email);

    // The interceptor must keep doing its job. A fix that exempted `passwordResetToken` from
    // scrubbing would make the first test pass too — and put reset tokens into response bodies,
    // which is a far worse bug than the one being fixed.
    expect((result!.user as unknown as Record<string, unknown>).passwordResetToken).toBeUndefined();
  });

  it('builds a link from that token that a person can click', async () => {
    const result = await userService.createPasswordResetToken(email);
    const link = userService.buildPasswordResetLink(result!.token);

    expect(link).not.toBeNull();
    expect(link).not.toContain('undefined');
    expect(link!.endsWith(result!.token)).toBe(true);
  });

  it('returns null for an address without an account instead of throwing', async () => {
    // The unknown-address path must stay quiet: a throw here is what made the endpoint answer 404
    // for unknown and 201 for known — a working account oracle. See password-reset-enumeration.
    await expect(userService.createPasswordResetToken(`nobody-${Date.now()}@test.com`)).resolves.toBeNull();
  });

  /**
   * The three cases above assert the BUILDING BLOCKS. These assert what the reference
   * implementation actually mails — and that distinction is the entire lesson of this incident.
   *
   * `src/server/modules/user/user.service.ts` is not an example in a comment: CLAUDE.md points
   * projects at it as the shape to copy, and the CLI generates from the starter that mirrors it.
   * It kept `setPasswordResetTokenForEmail` plus a hand-built base after the tools to do better
   * existed — so `email.passwordResetLink` (never set in this repo's config) and the stripped
   * token concatenated to the literal string `undefined/undefined`. Both production incidents,
   * reproduced verbatim in the repository that fixed them, with every block-level test green.
   */
  async function requestResetAndCaptureLink(target: string): Promise<string | undefined> {
    sent.length = 0;

    await testHelper.rest('/users/password/reset-request', {
      method: 'POST',
      payload: { email: target },
      statusCode: 201,
    });

    // The send is detached so it cannot leak timing, so it may not have happened yet.
    for (let attempt = 0; attempt < 40 && sent.length === 0; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }

    return sent.length ? String((sent[0].config.templateData as { link?: string })?.link ?? '') : undefined;
  }

  it('mails a link containing the real token, not the word undefined', async () => {
    const link = await requestResetAndCaptureLink(email);

    expect(link).toBeDefined();
    // Both halves of the production failure in one assertion: `undefined` as the host, and
    // `undefined` as the token.
    expect(link).not.toContain('undefined');

    // THE token, not merely a well-shaped one — a value that does not match unlocks nothing.
    const stored = await db.collection('users').findOne({ email });
    expect(link!.endsWith(String(stored?.passwordResetToken))).toBe(true);
  });

  it('refuses an EXPIRED token at the real endpoint, and burns it', async () => {
    // The helpers are unit-tested; this asserts the property through the route a person actually
    // reaches, which is the distinction this whole area exists to teach.
    const created = await userService.createPasswordResetToken(email);
    expect(created).not.toBeNull();

    // Backdate the stored expiry rather than waiting an hour.
    await db
      .collection('users')
      .updateOne({ email }, { $set: { passwordResetTokenExpiresAt: new Date(Date.now() - 60_000) } });

    // 404, exactly as for a token that never existed. Distinguishing the two would tell somebody
    // holding a stale token that it was once real and belongs to a live account.
    await testHelper.rest('/users/password/reset', {
      method: 'POST',
      payload: { password: 'BrandNewPass123!', token: created!.token },
      statusCode: 404,
    });

    // Burned on sight: a rejected token must not stay in the row waiting for a later change to
    // start honouring it again.
    const after = await db.collection('users').findOne({ email });
    expect(after?.passwordResetToken ?? null).toBeNull();
  });

  it('still accepts a token that has NOT expired', async () => {
    // The paired permissive case. Without it, a change that rejected every token would satisfy the
    // assertion above and look like a pass.
    const created = await userService.createPasswordResetToken(email);

    await testHelper.rest('/users/password/reset', {
      method: 'POST',
      payload: { password: 'BrandNewPass456!', token: created!.token },
      statusCode: 201,
    });
  });

  it('refuses a NoSQL operator where a token string belongs', async () => {
    // Confirmed exploitable before the guard: `@Body('token') token: string` has
    // `metatype === String`, and MapAndValidatePipe returns basic-type values verbatim — the
    // declared type is erased at runtime. `findOne({ passwordResetToken: { $ne: null } })` then
    // selected the first user holding ANY live token and reset THAT account, with the attacker
    // never seeing the mail.
    const created = await userService.createPasswordResetToken(email);
    const before = await db.collection('users').findOne({ email });

    await testHelper.rest('/users/password/reset', {
      method: 'POST',
      payload: { password: 'b'.repeat(64), token: { $ne: null } },
      statusCode: 404,
    });

    // The victim's credential is untouched and their legitimate token still works.
    const after = await db.collection('users').findOne({ email });
    expect(after?.password).toBe(before?.password);
    expect(after?.passwordResetToken).toBe(created!.token);
  });

  it('refuses null, which MongoDB would match against MISSING fields', async () => {
    // The quieter variant: `{ passwordResetToken: null }` selects a user who never requested a
    // reset at all. Same answer as an unknown token.
    await testHelper.rest('/users/password/reset', {
      method: 'POST',
      payload: { password: 'c'.repeat(64), token: null },
      statusCode: 404,
    });
  });

  it('mails nothing for an unknown address, and answers it identically', async () => {
    // Same status code as the known address above, asserted by `statusCode: 201` in the helper.
    // Otherwise this endpoint also sends billable mail to any address a stranger names.
    const link = await requestResetAndCaptureLink(`nobody-${Date.now()}@test.com`);

    expect(link).toBeUndefined();
  });
});
