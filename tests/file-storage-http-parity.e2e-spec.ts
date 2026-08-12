/**
 * FILE-STORAGE PARITY — the ROUTE contract, executed against all three drivers.
 *
 * Companion executor to `tests/file-storage-parity.e2e-spec.ts`; both read the one matrix in
 * `tests/helpers/file-storage-matrix.ts`. This one boots the REAL `ServerModule` once per driver,
 * so every layer between a request and the bytes is the shipped one: the roles guard reading
 * `file.downloadRoles` from `config.env.ts`, `CoreFileController`, and the reference server's own
 * `FileService.checkRights()` ownership rule.
 *
 * WHY IT IS A SEPARATE FILE FROM THE SERVICE EXECUTOR
 * ---------------------------------------------------
 * Cost and blast radius. Three Nest boots belong in a file vitest can schedule in parallel with the
 * cheap service matrix rather than in front of it, and a broken app boot should fail the route
 * contract without taking the service contract's 48 assertions with it.
 *
 * WHY THE FIXTURES ARE PLANTED, NOT UPLOADED
 * ------------------------------------------
 * The subject here is the two DOWNLOAD routes. Uploading through `/avatar/upload` would work for
 * exactly one file per user (the endpoint replaces the previous avatar) and would drag the image
 * filter and the multer path into a matrix that is not about them — while making the cross-driver
 * cells unwritable, since the upload always lands in the ACTIVE store. Planting straight into a
 * store is also the honest model of the state under test: a project that switched drivers has rows
 * in a store nothing writes to any more.
 */
import { Test, TestingModule } from '@nestjs/testing';
import { MongoClient, ObjectId } from 'mongodb';
import mongoose, { Connection } from 'mongoose';
import { afterAll, afterEach, beforeAll, describe, expect } from 'vitest';

import { TestGraphQLType, TestHelper } from '../src';
import envConfig from '../src/config.env';
import { RoleEnum } from '../src/core/common/enums/role.enum';
import { IServerOptions } from '../src/core/common/interfaces/server-options.interface';
import { ConfigService } from '../src/core/common/services/config.service';
import { ServerModule } from '../src/server/server.module';
import {
  applyParityConfig,
  createParityEnvironment,
  ParityEnvironment,
  restoreConfig,
} from './helpers/file-storage-drivers';
import { failMissingInfrastructure, PARITY_DRIVERS, parityIt } from './helpers/file-storage-matrix';
import { dropS3Buckets } from './helpers/s3-test-cleanup';

interface TestUser {
  email: string;
  id?: string;
  password: string;
  token?: string;
}

describe('File storage parity — download routes (e2e)', () => {
  let connection: Connection;
  let mongoClient: MongoClient;
  let env: ParityEnvironment;
  let teardown: () => Promise<void>;
  let previousConfig: Partial<IServerOptions>;

  const testId = `parity-http-${Date.now()}-p${process.pid}`;
  const makeUser = (label: string): TestUser => ({
    email: `${testId}-${label}@test.com`,
    password: `Pw-${Math.random().toString(36).substring(2, 10)}`,
  });
  const owner = makeUser('owner');
  const stranger = makeUser('stranger');
  const admin = makeUser('admin');
  let usersReady = false;

  const signUpAndIn = async (helper: TestHelper, user: TestUser): Promise<void> => {
    const signUp: any = await helper.graphQl({
      arguments: { input: { email: user.email, firstName: 'Parity', lastName: 'Test', password: user.password } },
      fields: [{ user: ['id', 'email'] }],
      name: 'signUp',
      type: TestGraphQLType.MUTATION,
    });
    user.id = signUp.user.id;
    await mongoClient
      .db()
      .collection('users')
      .updateOne({ _id: new ObjectId(user.id) }, { $set: { verified: true } });
    await refreshToken(helper, user);
  };

  const refreshToken = async (helper: TestHelper, user: TestUser): Promise<void> => {
    const signIn: any = await helper.graphQl({
      arguments: { input: { email: user.email, password: user.password } },
      fields: ['token'],
      name: 'signIn',
      type: TestGraphQLType.MUTATION,
    });
    user.token = signIn.token;
    expect(user.token, `${user.email} must have a token`).toBeTruthy();
  };

  beforeAll(async () => {
    previousConfig = ConfigService.configFastButReadOnly as Partial<IServerOptions>;
    connection = mongoose.createConnection(envConfig.mongoose.uri);
    await connection.asPromise();
    mongoClient = await MongoClient.connect(envConfig.mongoose.uri);
    try {
      ({ env, teardown } = await createParityEnvironment({
        base: previousConfig,
        connection,
        label: 'parity-http',
      }));
    } catch (error) {
      failMissingInfrastructure('s3', error);
    }
  }, 180_000);

  afterAll(async () => {
    await teardown?.();
    await mongoClient
      ?.db()
      ?.collection('users')
      .deleteMany({ email: { $regex: testId } })
      .catch(() => undefined);
    await dropS3Buckets(env?.s3Service?.getClient(), [env?.bucket]);
    await env?.s3Service?.onApplicationShutdown();
    await mongoClient?.close();
    await connection?.close();
    restoreConfig(previousConfig);
  }, 180_000);

  for (const driver of PARITY_DRIVERS) {
    describe(`driver: ${driver}`, () => {
      let app: any;
      let testHelper: TestHelper;
      /** Owned by `owner`, stored in the ACTIVE driver's store. */
      let ownFile: { filename: string; id: string };
      const ownContent = `bytes served under ${driver}`;
      const others = PARITY_DRIVERS.filter(other => other !== driver);

      beforeAll(async () => {
        applyParityConfig({ base: previousConfig, bucket: env.bucket, directory: env.directory, driver });

        const moduleFixture: TestingModule = await Test.createTestingModule({ imports: [ServerModule] }).compile();
        app = moduleFixture.createNestApplication();
        await app.init();
        testHelper = new TestHelper(app);

        if (!usersReady) {
          for (const user of [owner, stranger, admin]) {
            await signUpAndIn(testHelper, user);
          }
          await mongoClient
            .db()
            .collection('users')
            .updateOne({ _id: new ObjectId(admin.id) }, { $set: { roles: [RoleEnum.ADMIN] } });
          // Re-issue so the token carries the role it was just granted.
          await refreshToken(testHelper, admin);
          usersReady = true;
        }

        ownFile = await env.plant(driver, {
          content: ownContent,
          contentType: 'text/plain',
          filename: `${testId}-${driver}-own.txt`,
          metadata: { ownerId: owner.id },
        });
      }, 180_000);

      afterAll(async () => {
        await app?.close();
      });

      // The role gate has to be the SHIPPED one, or every 404 below could be a 403 in disguise and
      // this whole block would be testing the guard instead of the per-file rule. Asserted rather
      // than arranged, exactly as `tests/file-ownership.e2e-spec.ts` does.
      afterEach(() => {
        expect(
          (ConfigService.configFastButReadOnly as any)?.file?.downloadRoles,
          'config.env.ts must keep file.downloadRoles at [S_USER] for the fine rule to be reachable',
        ).toEqual([RoleEnum.S_USER]);
      });

      parityIt('http.ownerDownloadsById', driver, async () => {
        const res = await testHelper.download(`/files/id/${ownFile.id}`, { token: owner.token });
        expect(res.statusCode).toBe(200);
        expect(res.data).toBe(ownContent);
      });

      parityIt('http.ownerDownloadsByName', driver, async () => {
        // A separate code path with its own by-name authorization lookup — the by-id case above
        // does not cover it, and the by-name half is where 11.33.0's store omission lived.
        const res = await testHelper.download(`/files/${ownFile.filename}`, { token: owner.token });
        expect(res.statusCode).toBe(200);
        expect(res.data).toBe(ownContent);
      });

      parityIt('http.deliveryHeaders', driver, async () => {
        const res = await testHelper.download(`/files/id/${ownFile.id}`, { token: owner.token });

        expect(res.headers['content-type']).toContain('text/plain');
        expect(res.headers['content-disposition']).toContain(ownFile.filename);
        // `private, no-store` is security-relevant, not cosmetic: these routes are
        // authorization-gated, and RFC 9111 lets a shared cache store a response carrying no cache
        // directive — a CDN with a blanket `/files/*` rule would then hand an authorized response
        // to the next, unauthorized requester. A driver that lost the header would reopen at the
        // proxy layer exactly what the role gate closes at the application layer.
        expect(res.headers['cache-control']).toBe('private, no-store');
      });

      parityIt('http.nonOwnerGets404LikeUnknownId', driver, async () => {
        const unknownId = new ObjectId().toHexString();

        const refused = await testHelper.download(`/files/id/${ownFile.id}`, { token: stranger.token });
        const unknown = await testHelper.download(`/files/id/${unknownId}`, { token: stranger.token });

        // 404, NOT 403 — a 403 would confirm that this id names a real file, turning the route into
        // an existence oracle for a store whose ObjectIds are not secrets.
        expect(refused.statusCode).toBe(404);
        expect(unknown.statusCode).toBe(404);
        // …and indistinguishable from it: same status AND same body.
        expect(refused.data).toBe(unknown.data);
        expect(refused.data).not.toContain(ownContent);
        expect(refused.data).not.toContain(ownFile.filename);
      });

      parityIt('http.nonOwnerGets404LikeUnknownName', driver, async () => {
        const refused = await testHelper.download(`/files/${ownFile.filename}`, { token: stranger.token });
        const unknown = await testHelper.download(`/files/${testId}-${driver}-does-not-exist.txt`, {
          token: stranger.token,
        });

        expect(refused.statusCode).toBe(404);
        expect(unknown.statusCode).toBe(404);
        expect(refused.data).toBe(unknown.data);
        expect(refused.data).not.toContain(ownContent);
      });

      parityIt('http.anonymousGets401', driver, async () => {
        // 401 exactly, not "401 or 403": the framework's status policy is deterministic and SPA auth
        // layers branch on it — a permission error returned as 401 logs the user out of the app.
        for (const url of [`/files/id/${ownFile.id}`, `/files/${ownFile.filename}`]) {
          const res = await testHelper.download(url);
          expect(res.statusCode, url).toBe(401);
          expect(res.data).not.toContain(ownContent);
        }
      });

      parityIt('http.adminDownloads', driver, async () => {
        // Through the RULE's admin branch, not through the guard: the coarse gate is `[S_USER]`,
        // which the stranger also satisfies.
        for (const url of [`/files/id/${ownFile.id}`, `/files/${ownFile.filename}`]) {
          const res = await testHelper.download(url, { token: admin.token });
          expect(res.statusCode, url).toBe(200);
          expect(res.data).toBe(ownContent);
        }
      });

      parityIt('http.crossDriverDownload', driver, async () => {
        for (const other of others) {
          const filename = `${testId}-${driver}-from-${other}.txt`;
          const content = `written under ${other}, downloaded under ${driver}`;
          const planted = await env.plant(other, {
            content,
            contentType: 'text/plain',
            filename,
            metadata: { ownerId: owner.id },
          });

          const byId = await testHelper.download(`/files/id/${planted.id}`, { token: owner.token });
          expect(byId.statusCode, `${other} by id`).toBe(200);
          expect(byId.data).toBe(content);

          const byName = await testHelper.download(`/files/${filename}`, { token: owner.token });
          expect(byName.statusCode, `${other} by name`).toBe(200);
          expect(byName.data).toBe(content);

          // The refusal must travel across stores too — otherwise a driver switch would silently
          // widen access to everything written before it.
          const refused = await testHelper.download(`/files/id/${planted.id}`, { token: stranger.token });
          expect(refused.statusCode, `${other} refusal`).toBe(404);
        }
      });
    });
  }
});
