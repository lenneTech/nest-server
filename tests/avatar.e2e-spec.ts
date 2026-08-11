import { Test, TestingModule } from '@nestjs/testing';
import * as fs from 'fs';
import { MongoClient } from 'mongodb';
import * as path from 'path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { TestGraphQLType, TestHelper } from '../src';
import envConfig from '../src/config.env';
import { ServerModule } from '../src/server/server.module';
import { createFixtureDir, removeFixtureDir } from './helpers/tmp-fixtures';
/**
 * The avatar upload had NO test at all, and was broken the whole time: `setAvatar()` looked the
 * user up with `findOne({ id })`, but `id` is a Mongoose virtual that does not exist in MongoDB,
 * so the filter matched nothing and every upload answered "session user no longer exists".
 * Found by running the server for real; covered here so it cannot regress silently again.
 *
 * The second assertion is what this ticket is about: the bytes must be reachable through the
 * central file storage, not from the pod-local disk the endpoint used to write to.
 */
describe('Avatar upload (e2e)', () => {
  let app;
  let mongoClient: MongoClient;
  let testHelper: TestHelper;
  // Upload fixtures are staged OUTSIDE the repository. They used to be written
  // into `tests/` and unlinked after the upload assertion — which leaks the file
  // on exactly the failure this spec exists to catch, and did: five 16-byte
  // `avatar-*.png` artifacts ended up committed. See tests/helpers/tmp-fixtures.ts.
  let fixtureDir: string;
  const user: { email: string; id?: string; password: string; token?: string } = {
    email: `avatar-${Math.random().toString(36).substring(7)}@test.com`,
    password: Math.random().toString(36).substring(7),
  };

  beforeAll(async () => {
    fixtureDir = await createFixtureDir('nest-server-avatar-');
    const moduleFixture: TestingModule = await Test.createTestingModule({ imports: [ServerModule] }).compile();
    app = moduleFixture.createNestApplication();
    await app.init();
    testHelper = new TestHelper(app);
    mongoClient = await MongoClient.connect(envConfig.mongoose.uri);
  }, 60_000);

  afterAll(async () => {
    await removeFixtureDir(fixtureDir);
    await mongoClient?.close();
    await app?.close();
  });

  it('signs up and signs in a user', async () => {
    const signUp: any = await testHelper.graphQl({
      arguments: { input: { email: user.email, firstName: 'Avatar', lastName: 'User', password: user.password } },
      fields: [{ user: ['id', 'email'] }],
      name: 'signUp',
      type: TestGraphQLType.MUTATION,
    });
    user.id = signUp.user.id;

    const signIn: any = await testHelper.graphQl({
      arguments: { input: { email: user.email, password: user.password } },
      fields: ['token', { user: ['id'] }],
      name: 'signIn',
      type: TestGraphQLType.MUTATION,
    });
    user.token = signIn.token;

    expect(user.id).toBeTruthy();
    expect(user.token).toBeTruthy();
  }, 60_000);

  it('stores the avatar in the central file storage, not on local disk', async () => {
    const filename = `avatar-${Math.random().toString(36).substring(7)}.png`;
    const local = path.join(fixtureDir, filename);
    // A minimal but real PNG header — the endpoint filters on mimetype and extension
    await fs.promises.writeFile(local, Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex'));

    // Before the fix this answered 401 "User of the current session no longer exists"
    const avatarId: any = await testHelper.rest('/avatar/upload', {
      attachments: { file: local },
      statusCode: 201,
      token: user.token,
    });

    expect(String(avatarId)).toMatch(/^[a-f0-9]{24}$/);

    // The user references the stored file...
    const dbUser = await mongoClient.db().collection('users').findOne({ email: user.email });
    expect(String(dbUser?.avatar)).toBe(String(avatarId));

    // ...and the bytes are reachable by id from the file storage, which is what lets a second
    // replica serve them. A pod-local path could not be.
    //
    // The uploader is a plain signed-in user, and `file.downloadRoles` defaults to ADMIN, so the
    // coarse gate refuses them: 403 (authenticated, but no right) — never 401, which would make an
    // SPA auth layer log them out over a missing avatar.
    //
    // This is deliberate for the reference server. A project that wants uploaders to reach their
    // own files sets `file: { downloadRoles: [RoleEnum.S_USER] }` and adds the owner rule sketched
    // in FileService; `AvatarController` already records the `metadata.ownerId` it reads.
    const asOwner = await testHelper.download(`/files/id/${avatarId}`, { token: user.token });
    expect(asOwner.statusCode).toBe(403);

    // With the role the gate asks for, the bytes come back from central storage — which is what
    // lets a second replica serve them. A pod-local path could not.
    await mongoClient
      .db()
      .collection('users')
      .updateOne({ email: user.email }, { $set: { roles: ['admin'] } });
    const signInAsAdmin: any = await testHelper.graphQl({
      arguments: { input: { email: user.email, password: user.password } },
      fields: ['token'],
      name: 'signIn',
      type: TestGraphQLType.MUTATION,
    });
    const download = await testHelper.download(`/files/id/${avatarId}`, { token: signInAsAdmin.token });
    expect(download.statusCode).toBe(200);
  }, 60_000);
});
