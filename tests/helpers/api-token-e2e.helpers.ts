/**
 * Shared bootstrap for the API token e2e specs: an IAM-only CoreModule stack, and users created the
 * way a real client creates them (Better-Auth sign-up and sign-in).
 */
import { Module } from '@nestjs/common';
import { NestExpressApplication } from '@nestjs/platform-express';
import { ScheduleModule } from '@nestjs/schedule';
import { Test, TestingModule } from '@nestjs/testing';
import { PubSub } from 'graphql-subscriptions';
import { Db } from 'mongodb';
import { expect } from 'vitest';

import { CoreBetterAuthModule, CoreModule, HttpExceptionLogFilter, TestHelper } from '../../src';
import envConfig from '../../src/config.env';
import { Any } from '../../src/core/common/scalars/any.scalar';
import { DateScalar } from '../../src/core/common/scalars/date.scalar';
import { JSON as JSONScalar } from '../../src/core/common/scalars/json.scalar';
import { ConfigService } from '../../src/core/common/services/config.service';
import { deriveTestDbUri } from '../db-lifecycle.reporter';

export const API_TOKEN_TEST_ENCRYPTION_KEY = 'e2e-api-token-encryption-key-of-32-plus-chars';

/** An IAM-only config on its own database, with `extra` layered over the e2e environment. */
export function apiTokenIamConfig(dbSuffix: string, extra: Record<string, unknown>): any {
  return {
    ...envConfig,
    betterAuth: { ...(envConfig as any).betterAuth, enabled: true },
    mongoose: { ...envConfig.mongoose, uri: deriveTestDbUri(dbSuffix) },
    ...extra,
  };
}

/** Boot an IAM-only app (BetterAuthRolesGuard) with the given controllers / providers / imports. */
export async function bootApiTokenIamApp(
  config: any,
  metadata: { controllers?: any[]; imports?: any[]; providers?: any[] } = {},
): Promise<NestExpressApplication> {
  CoreBetterAuthModule.reset();
  // CoreModule.forRoot() MERGES into the process-wide ConfigService; a key this stack leaves out on
  // purpose (multiTenancy, apiTokens) would otherwise survive from the previous stack in this process.
  ConfigService.setConfig(config, { reInit: true, warn: false });

  @Module({
    controllers: metadata.controllers ?? [],
    imports: [CoreModule.forRoot(config), ScheduleModule.forRoot(), ...(metadata.imports ?? [])],
    providers: [
      Any,
      DateScalar,
      JSONScalar,
      { provide: 'PUB_SUB', useValue: new PubSub() },
      ...(metadata.providers ?? []),
    ],
  })
  class ApiTokenIamTestModule {}

  const fixture: TestingModule = await Test.createTestingModule({ imports: [ApiTokenIamTestModule] }).compile();
  const app = fixture.createNestApplication<NestExpressApplication>();
  app.useGlobalFilters(new HttpExceptionLogFilter());
  app.setBaseViewsDir(config.templates.path);
  app.setViewEngine(config.templates.engine);
  await app.init();
  return app;
}

export interface ApiTokenTestUser {
  email: string;
  id: string;
  password: string;
  token: string;
}

let userCounter = 0;

/** Sign a user up and in through Better-Auth; `roles` are written BEFORE sign-in so no cache holds old ones. */
export async function signUpAndSignIn(
  helper: TestHelper,
  db: Db,
  label: string,
  roles?: string[],
): Promise<ApiTokenTestUser> {
  const email = `api-token-${label}-${Date.now()}-${++userCounter}@test.com`;
  const password = 'ApiTokenPassword123!';
  await helper.rest('/iam/sign-up/email', {
    method: 'POST',
    payload: { email, name: label, password, termsAndPrivacyAccepted: true },
    statusCode: 201,
  });
  await db
    .collection('users')
    .updateOne({ email }, { $set: { emailVerified: true, verified: true, ...(roles ? { roles } : {}) } });
  await db.collection('iam_user').updateOne({ email }, { $set: { emailVerified: true } });
  const signIn = await helper.rest('/iam/sign-in/email', {
    method: 'POST',
    payload: { email, password },
    statusCode: 200,
  });
  const user = await db.collection('users').findOne({ email });
  expect(signIn?.token, `sign-in of ${label} must yield a token`).toBeTruthy();
  return { email, id: user!._id.toString(), password, token: signIn.token };
}

/**
 * Reset a password through Better-Auth's own flow (`/iam/request-password-reset` → `/iam/reset-password`),
 * reading the reset token from the verification store the way tests/stories/password-reset-parity does.
 */
export async function resetPasswordViaIam(
  helper: TestHelper,
  db: Db,
  email: string,
  newPassword: string,
): Promise<void> {
  await helper.rest('/iam/request-password-reset', {
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
  expect(verification.length, 'the IAM reset request must store a verification token').toBe(1);
  await helper.rest('/iam/reset-password', {
    method: 'POST',
    payload: { newPassword, token: String(verification[0].identifier).replace('reset-password:', '') },
  });
}
