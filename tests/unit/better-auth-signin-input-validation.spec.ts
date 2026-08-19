import { Body, Controller, Post } from '@nestjs/common';
import { APP_PIPE } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { MapAndValidatePipe } from '../../src/core/common/pipes/map-and-validate.pipe';
import { ConfigService } from '../../src/core/common/services/config.service';
import {
  CoreBetterAuthController,
  CoreBetterAuthSignInInput,
  CoreBetterAuthSignUpInput,
} from '../../src/core/modules/better-auth/core-better-auth.controller';

import type { INestApplication } from '@nestjs/common';

/**
 * Malformed sign-in input must be answered as the CLIENT's error, not the server's.
 *
 * THE DEFECT. `/iam/sign-in/email` is the most-probed surface any deployment has, and both DTOs
 * carried `@ApiProperty()` only — documentation, no validation. Every line of the handler then reads
 * `input.email`, so a body that was absent or malformed produced a `TypeError` and reached the
 * client as a **500**. That is wrong in three ways at once: it tells the caller to retry something
 * that can never succeed, it files the caller's mistake in the same bucket as a real outage, and on
 * this particular endpoint it means anyone can fill an alerting channel with noise for free. The
 * legacy sign-in answered the same case with a 400.
 *
 * TWO FIXES, AND BOTH ARE LOAD-BEARING — verified here rather than assumed:
 *
 *  1. class-validator decorators on the DTOs cover a body that is PRESENT but wrong (`{}`, a
 *     malformed address, a missing password).
 *  2. an explicit `if (!input)` guard covers a body that is ABSENT. `MapAndValidatePipe` returns
 *     early on a falsy value (`if (!value || typeof value !== 'object' …) return value`), so it
 *     never validates `undefined` — the decorators alone would leave exactly that case at a 500.
 *
 * Neither one subsumes the other, which is why removing either has its own mutation below.
 *
 * A NOTE ON THE PIPE. These DTOs carry no `@UnifiedField`, and the pipe's whitelist skips classes
 * without one (`if (whitelistedKeys.size === 0) return []`) — so nothing strips `email`/`password`,
 * while `validateWithInheritance` still reads the raw class-validator metadata. That combination is
 * what makes the decorators work here at all, and it is not obvious from either side alone.
 *
 * @regression   11.36.0 — malformed or absent sign-in input answered 500 instead of 400.
 * @seen-failing Remove the `@IsEmail()` / `@IsNotEmpty()` decorators from
 *   `CoreBetterAuthSignInInput` (mutation `betterauth-signin-input-unvalidated`), or drop the
 *   `if (!input)` guard from `signIn()` (mutation `betterauth-signin-missing-body-500`) in
 *   `src/core/modules/better-auth/core-better-auth.controller.ts` — both registered in
 *   `tests/regression-mutations.json`. Each turns its own case red while the other stays green,
 *   which is the split that shows the two fixes cover different inputs.
 */

/** Exercises the DTOs through the real pipe, without booting the IAM module. */
@Controller()
class SignInProbeController {
  @Post('sign-in')
  signIn(@Body() input: CoreBetterAuthSignInInput) {
    return { email: input.email };
  }

  @Post('sign-up')
  signUp(@Body() input: CoreBetterAuthSignUpInput) {
    return { email: input.email };
  }
}

describe('BetterAuth sign-in input validation', () => {
  let app: INestApplication | undefined;

  beforeEach(async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [SignInProbeController],
      providers: [{ provide: APP_PIPE, useClass: MapAndValidatePipe }],
    }).compile();
    app = moduleRef.createNestApplication();
    await app.init();
  });

  afterEach(async () => {
    await app?.close();
    app = undefined;
  });

  it('accepts a well-formed pair', () => {
    // Guards the cases below against passing because EVERY request is refused.
    return request(app!.getHttpServer())
      .post('/sign-in')
      .send({ email: 'user@example.com', password: 'correct horse battery staple' })
      .expect(201)
      .expect(res => expect(res.body.email).toBe('user@example.com'));
  });

  it('answers 400, not 500, on a malformed email', async () => {
    const res = await request(app!.getHttpServer()).post('/sign-in').send({ email: 'not-an-email', password: 'x' });

    expect(res.status).toBe(400);
    expect(JSON.stringify(res.body)).toContain('isEmail');
  });

  it('answers 400 on an empty object, naming both missing fields', async () => {
    const res = await request(app!.getHttpServer()).post('/sign-in').send({});

    expect(res.status).toBe(400);
    expect(JSON.stringify(res.body)).toContain('email');
    expect(JSON.stringify(res.body)).toContain('password');
  });

  it('answers 400 when the password is missing', async () => {
    const res = await request(app!.getHttpServer()).post('/sign-in').send({ email: 'user@example.com' });

    expect(res.status).toBe(400);
  });

  it('validates the sign-up DTO the same way, but leaves name optional', async () => {
    await request(app!.getHttpServer()).post('/sign-up').send({ email: 'nope', password: 'x' }).expect(400);

    return request(app!.getHttpServer())
      .post('/sign-up')
      .send({ email: 'user@example.com', password: 'correct horse battery staple' })
      .expect(201);
  });
});

describe('BetterAuth sign-in with NO body at all', () => {
  /**
   * Driven against the real controller method rather than a probe, because the guard under test
   * lives in the handler — the pipe never sees this case.
   */
  function controllerWithoutBody(): CoreBetterAuthController {
    const betterAuthService: any = {
      getApi: () => ({}),
      getBasePath: () => '/iam',
      getBaseUrl: () => 'http://localhost:3000',
      getConfig: () => ({ secret: 'x'.repeat(40) }),
      getCookieDomain: () => undefined,
      // signUp() runs this service-availability check before the input guard; the ordering is
      // deliberate (an unavailable feature is not the caller's malformed request).
      ensureSignUpEnabled: () => undefined,
      getInstance: () => ({}),
      isEnabled: () => true,
    };
    const userMapper: any = {
      migrateAccountToIam: async () => false,
      normalizePasswordForIam: (password: string) => password,
    };
    return new CoreBetterAuthController(betterAuthService, userMapper, new ConfigService({} as any));
  }

  it('is a 400, not a 500 — the pipe skips a falsy body, so the handler must guard', async () => {
    // Without the guard the first `input.email` read throws a TypeError, which surfaces as a 500:
    // the server reporting its own failure for a request the client sent wrong.
    const controller = controllerWithoutBody();

    await expect(controller.signIn({} as any, {} as any, undefined as any)).rejects.toMatchObject({
      status: 400,
    });
  });

  it('applies the same guard to sign-up', async () => {
    const controller = controllerWithoutBody();

    await expect(controller.signUp({} as any, undefined as any)).rejects.toMatchObject({
      status: 400,
    });
  });
});
