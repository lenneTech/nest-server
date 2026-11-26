/**
 * What an API answers a caller whose session has ended, in cookie mode (DEV-4393).
 *
 * `@lenne.tech/nuxt-extensions` signs a frontend out on a 401 and on nothing else. A browser keeps sending the session
 * cookie after the session expired, so an API that answers such a request with 403 leaves the user on a page that
 * shows "data could not be loaded" instead of the sign-in. The rule: nobody signed in — no cookie, a cookie the store
 * does not know, an expired session, an expired JWT — is 401; signed in without the right is 403.
 *
 * One case list, run against both role guards by the suites that import it: `RolesGuard` (the reference server,
 * legacy and IAM side by side) and `BetterAuthRolesGuard` (IAM only, how nest-server-starter assembles a project).
 */
import { Controller, Get } from '@nestjs/common';
import { Query, Resolver } from '@nestjs/graphql';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { CurrentUser } from '../../src/core/common/decorators/current-user.decorator';
import { Roles } from '../../src/core/common/decorators/roles.decorator';
import { RoleEnum } from '../../src/core/common/enums/role.enum';
import { resolveJwtCookieName } from '../../src/core/modules/better-auth/better-auth-cookie-prefix.helper';
import { isJwtShaped } from '../../src/core/modules/better-auth/core-better-auth-token.helper';
import { CoreBetterAuthService } from '../../src/core/modules/better-auth/core-better-auth.service';
import type { IamTestDb } from './iam-test-db';

/** A route any signed-in user may call, and one only an administrator may call — over REST and GraphQL */
@Controller('session-probe')
export class SessionProbeController {
  @Get('signed-in')
  @Roles(RoleEnum.S_USER)
  signedIn(@CurrentUser() user: { id?: string }) {
    return { id: user?.id ?? null };
  }

  @Get('admin')
  @Roles(RoleEnum.ADMIN)
  admin() {
    return { ok: true };
  }
}

@Resolver()
export class SessionProbeResolver {
  @Query(() => Boolean, { description: 'Test probe: any signed-in user' })
  @Roles(RoleEnum.S_USER)
  sessionProbeSignedIn(): boolean {
    return true;
  }

  @Query(() => Boolean, { description: 'Test probe: administrators only' })
  @Roles(RoleEnum.ADMIN)
  sessionProbeAdmin(): boolean {
    return true;
  }
}

interface Session {
  /** The `Cookie` header value a browser sends with the session cookie the sign-in set */
  cookie: string;
  /** The JWT the sign-in answers with (token in the body, the JWT plugin is on in the test configuration) */
  jwt: string;
  /** The session's token as stored, to expire it */
  token: string;
  userId: string;
}

/**
 * Registers the cases inside the calling `describe`. The suite builds the application in its own `beforeAll`, which
 * runs before the one registered here.
 */
export function registerSessionExpiryCases(getApp: () => any, getIamDb: () => IamTestDb): void {
  const email = `session-expiry-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@test.com`;
  const password = 'Session-Expiry-1';

  const server = () => getApp().getHttpServer();

  const signIn = async (): Promise<Session> => {
    const res = await request(server()).post('/iam/sign-in/email').send({ email, password });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const setCookie = ([] as string[]).concat(res.headers['set-cookie'] ?? []);
    const sessionCookie = setCookie.map((header) => header.split(';')[0]).find((pair) => /\.session_token=/.test(pair));
    expect(sessionCookie, `the sign-in sets the session cookie: ${setCookie.join(' | ')}`).toBeTruthy();
    expect(isJwtShaped(res.body?.token), 'the sign-in answers with a JWT').toBe(true);
    const userId = String(res.body.user?.id);
    const token = await getIamDb().latestSessionToken(userId);
    expect(token, 'the new session is stored').toBeTruthy();
    return { cookie: sessionCookie!, jwt: res.body.token, token: token!, userId };
  };

  const rest = (path: string, cookie?: string, bearer?: string) => {
    const call = request(server()).get(path);
    if (cookie) call.set('Cookie', cookie);
    if (bearer) call.set('Authorization', `Bearer ${bearer}`);
    return call;
  };

  /** HTTP status a GraphQL query answered with: the error's status, or 200 when the query returned its data */
  const graphQlStatus = async (field: string, cookie?: string): Promise<number> => {
    const call = request(server()).post('/graphql');
    if (cookie) call.set('Cookie', cookie);
    const res = await call.send({ query: `query { ${field} }` });
    const status = res.body?.errors?.[0]?.extensions?.originalError?.statusCode;
    if (status) return status;
    expect(res.body?.data?.[field], JSON.stringify(res.body)).toBe(true);
    return 200;
  };

  /** A Better-Auth JWT for the given payload, signed with the application's own key */
  const signJwt = async (payload: Record<string, unknown>): Promise<string> => {
    const api = getApp().get(CoreBetterAuthService, { strict: false }).getApi() as any;
    const { token } = await api.signJWT({ body: { payload } });
    return token;
  };

  const decode = (jwt: string): Record<string, unknown> =>
    JSON.parse(Buffer.from(jwt.split('.')[1], 'base64url').toString('utf8'));

  beforeAll(async () => {
    const signUp = await request(server())
      .post('/iam/sign-up/email')
      .send({ email, name: 'Session Expiry', password, termsAndPrivacyAccepted: true });
    expect(signUp.status, JSON.stringify(signUp.body)).toBe(201);
  });

  afterAll(async () => {
    await getIamDb()?.deleteUsers({ email });
  });

  describe('paired controls', () => {
    it('lets a live session cookie through, as the user who holds it', async () => {
      const session = await signIn();
      const res = await rest('/session-probe/signed-in', session.cookie).expect(200);
      expect(res.body.id).toBe(session.userId);
      expect(await graphQlStatus('sessionProbeSignedIn', session.cookie)).toBe(200);
    });

    it('answers a signed-in user without the right with 403, not 401', async () => {
      const session = await signIn();
      await rest('/session-probe/admin', session.cookie).expect(403);
      expect(await graphQlStatus('sessionProbeAdmin', session.cookie)).toBe(403);
    });
  });

  describe('nobody signed in: 401', () => {
    it('without any credential', async () => {
      await rest('/session-probe/signed-in').expect(401);
      await rest('/session-probe/admin').expect(401);
      expect(await graphQlStatus('sessionProbeSignedIn')).toBe(401);
    });

    it('with a session cookie the store does not know', async () => {
      const session = await signIn();
      const [name] = session.cookie.split('=');
      const unknown = `${name}=unknown-session-${Math.random().toString(36).slice(2)}`;
      await rest('/session-probe/signed-in', unknown).expect(401);
      await rest('/session-probe/admin', unknown).expect(401);
      expect(await graphQlStatus('sessionProbeSignedIn', unknown)).toBe(401);
      expect(await graphQlStatus('sessionProbeAdmin', unknown)).toBe(401);
    });

    it('with the session cookie of an expired session', async () => {
      const session = await signIn();
      await getIamDb().expireSession(session.token);

      await rest('/session-probe/signed-in', session.cookie).expect(401);
      await rest('/session-probe/admin', session.cookie).expect(401);
      expect(await graphQlStatus('sessionProbeSignedIn', session.cookie)).toBe(401);
      expect(await graphQlStatus('sessionProbeAdmin', session.cookie)).toBe(401);
    });

    it('with the JWT cookie of an expired session', async () => {
      // A JWT is bound to its session (12.11.0): its own expiry is 15 minutes, the session ended before
      const session = await signIn();
      await getIamDb().expireSession(session.token);
      const jwtCookie = `${resolveJwtCookieName()}=${session.jwt}`;

      await rest('/session-probe/signed-in', jwtCookie).expect(401);
      expect(await graphQlStatus('sessionProbeSignedIn', jwtCookie)).toBe(401);
    });

    it('with an expired JWT of a live session, in the cookie and as bearer', async () => {
      const session = await signIn();
      const now = Math.floor(Date.now() / 1000);
      const payload = decode(session.jwt);

      // Paired control: the same payload, re-signed with a future expiry, is accepted — only the expiry decides below
      const live = await signJwt({ ...payload, exp: now + 600, iat: now });
      await rest('/session-probe/signed-in', `${resolveJwtCookieName()}=${live}`).expect(200);

      const expired = await signJwt({ ...payload, exp: now - 60, iat: now - 3600 });
      const jwtCookie = `${resolveJwtCookieName()}=${expired}`;
      await rest('/session-probe/signed-in', jwtCookie).expect(401);
      await rest('/session-probe/signed-in', undefined, expired).expect(401);
      expect(await graphQlStatus('sessionProbeSignedIn', jwtCookie)).toBe(401);
    });
  });
}
