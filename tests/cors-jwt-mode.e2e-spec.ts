/**
 * Cross-origin sign-in in JWT mode (`cookies: false`), 12.7.0.
 *
 * Until 12.7.0 `buildCorsConfig()` answered `{}` in JWT mode, so `main.ts` fell back to `enableCors()` without
 * credentials (`Access-Control-Allow-Origin: *`). A browser refuses `*` on a credentialed request — and JWT mode makes
 * them: the stack's client sends `credentials: 'include'`, and after a second factor it turns the session cookie
 * Better-Auth set into a JWT through `/iam/token`. A split app/API deployment in JWT mode could not finish a 2FA
 * sign-in in any browser, while every server-side test stayed green (supertest does not enforce CORS).
 *
 * This suite boots the reference server in JWT mode with a configured app origin, builds the CORS layer exactly as
 * `main.ts` does (a testing module never runs `main.ts`), and checks what a browser checks: the preflight and the
 * credentialed sign-in answer the app origin with credentials, a foreign origin gets nothing.
 *
 * @regression   12.7.0 — JWT mode answered every origin with `*` and no credentials, which browsers refuse on the
 *   credentialed requests a JWT-mode client makes.
 * @seen-failing Return `{}` for disabled cookies again in buildCorsConfig() in
 *   src/core/common/helpers/cookies.helper.ts — registered as mutation `cors-jwt-mode-cross-origin-sign-in` in
 *   tests/regression-mutations.json.
 */
import { Test } from '@nestjs/testing';
import { PubSub } from 'graphql-subscriptions';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import envConfig from '../src/config.env';
import { buildCorsConfig, isCookiesEnabled } from '../src/core/common/helpers/cookies.helper';
import { ConfigService } from '../src/core/common/services/config.service';
import { isJwtShaped } from '../src/core/modules/better-auth/core-better-auth-token.helper';
import { type IamTestDb, openIamTestDb } from './helpers/iam-test-db';

const APP = 'http://localhost:3001';
const FOREIGN = 'https://evil.example.net';

describe('CORS in JWT mode: cross-origin sign-in (e2e)', () => {
  let app: any;
  let iamDb: IamTestDb;
  const iamUserIds: string[] = [];
  const email = `cors-jwt-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@test.com`;
  const password = 'Cors-Jwt-Mode-1';

  beforeAll(async () => {
    // JWT mode with a configured app origin and no allowAll — set BEFORE the server module is imported, because
    // CoreModule.forRoot() reads the configuration when the module is evaluated.
    const config = envConfig as any;
    config.cookies = false;
    config.cors = {};
    config.appUrl = APP;

    const { ServerModule } = await import('../src/server/server.module');
    const moduleFixture = await Test.createTestingModule({
      imports: [ServerModule],
      providers: [{ provide: 'PUB_SUB', useValue: new PubSub() }],
    }).compile();
    app = moduleFixture.createNestApplication();

    // What main.ts does: the computed options when origins are resolvable, the wildcard only without any
    const running = ConfigService.configFastButReadOnly;
    expect(isCookiesEnabled(running?.cookies), 'the server runs in JWT mode').toBe(false);
    const corsOptions = buildCorsConfig(running);
    if (Object.keys(corsOptions).length > 0) {
      app.enableCors(corsOptions);
    } else {
      app.enableCors();
    }
    await app.init();

    iamDb = await openIamTestDb(envConfig.mongoose.uri);
  });

  afterAll(async () => {
    if (iamDb) {
      await iamDb.deleteUsers({ email });
      await iamDb.close();
    }
    await app?.close();
  });

  it('answers the preflight of the app origin with credentials', async () => {
    const res = await request(app.getHttpServer())
      .options('/iam/sign-in/email')
      .set('Origin', APP)
      .set('Access-Control-Request-Method', 'POST')
      .set('Access-Control-Request-Headers', 'content-type');

    expect(res.status).toBeLessThan(300);
    expect(res.headers['access-control-allow-origin']).toBe(APP);
    expect(res.headers['access-control-allow-credentials']).toBe('true');
  });

  it('signs in cross-origin with credentials and hands out a JWT', async () => {
    const signUp = await request(app.getHttpServer())
      .post('/iam/sign-up/email')
      .set('Origin', APP)
      .send({ email, name: 'CORS JWT', password, termsAndPrivacyAccepted: true });
    expect(signUp.status, JSON.stringify(signUp.body)).toBe(201);
    if (signUp.body?.user?.id) {
      iamUserIds.push(signUp.body.user.id);
    }

    const signIn = await request(app.getHttpServer())
      .post('/iam/sign-in/email')
      .set('Origin', APP)
      .send({ email, password });

    expect(signIn.status, JSON.stringify(signIn.body)).toBe(200);
    expect(signIn.headers['access-control-allow-origin']).toBe(APP);
    expect(signIn.headers['access-control-allow-credentials']).toBe('true');
    expect(isJwtShaped(signIn.body?.token), 'JWT mode hands out a JWT').toBe(true);
  });

  it('answers a foreign origin with no CORS grant at all', async () => {
    const res = await request(app.getHttpServer())
      .options('/iam/sign-in/email')
      .set('Origin', FOREIGN)
      .set('Access-Control-Request-Method', 'POST')
      .set('Access-Control-Request-Headers', 'content-type');

    expect(res.headers['access-control-allow-origin']).toBeUndefined();
    expect(res.headers['access-control-allow-credentials']).toBeUndefined();
  });
});
