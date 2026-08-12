import { Test, TestingModule } from '@nestjs/testing';
import * as fs from 'fs';
import { MongoClient, ObjectId } from 'mongodb';
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
 *
 * The access half changed with the reference server's file-access model: `config.env.ts` widens
 * `file.downloadRoles` to `S_USER` and `FileService.checkRights()` makes the per-file decision.
 * So the uploader now fetches their OWN avatar back (200) — which is the point of an avatar — while
 * a stranger is refused. This spec previously asserted 403 for the uploader, which was correct
 * under the framework's `[ADMIN]` default and is exactly the behaviour that made an avatar
 * unusable by the user it belongs to.
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
  /** The id of the avatar uploaded by `user`, shared by the access cases below */
  let avatarId: string;
  const user: { email: string; id?: string; password: string; token?: string } = {
    email: `avatar-${Math.random().toString(36).substring(7)}@test.com`,
    password: Math.random().toString(36).substring(7),
  };
  /** A second signed-in user who owns nothing — the negative half of the ownership rule */
  const stranger: { email: string; id?: string; password: string; token?: string } = {
    email: `avatar-stranger-${Math.random().toString(36).substring(7)}@test.com`,
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

  const signUpAndIn = async (account: typeof user, firstName: string): Promise<void> => {
    const signUp: any = await testHelper.graphQl({
      arguments: { input: { email: account.email, firstName, lastName: 'User', password: account.password } },
      fields: [{ user: ['id', 'email'] }],
      name: 'signUp',
      type: TestGraphQLType.MUTATION,
    });
    account.id = signUp.user.id;

    const signIn: any = await testHelper.graphQl({
      arguments: { input: { email: account.email, password: account.password } },
      fields: ['token', { user: ['id'] }],
      name: 'signIn',
      type: TestGraphQLType.MUTATION,
    });
    account.token = signIn.token;

    expect(account.id).toBeTruthy();
    expect(account.token).toBeTruthy();
  };

  it('signs up and signs in a user', async () => {
    await signUpAndIn(user, 'Avatar');
    // A second account with no files of its own — needed to tell "the rule fires" apart from
    // "the route is simply open to everyone signed in".
    await signUpAndIn(stranger, 'Stranger');
  }, 60_000);

  it('stores the avatar in the central file storage, not on local disk', async () => {
    const filename = `avatar-${Math.random().toString(36).substring(7)}.png`;
    const local = path.join(fixtureDir, filename);
    // A minimal but real PNG header — the endpoint filters on mimetype and extension
    await fs.promises.writeFile(local, Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex'));

    // Before the fix this answered 401 "User of the current session no longer exists"
    const uploaded: any = await testHelper.rest('/avatar/upload', {
      attachments: { file: local },
      statusCode: 201,
      token: user.token,
    });
    avatarId = String(uploaded);

    expect(avatarId).toMatch(/^[a-f0-9]{24}$/);

    // The user references the stored file...
    const dbUser = await mongoClient.db().collection('users').findOne({ email: user.email });
    expect(String(dbUser?.avatar)).toBe(avatarId);

    // ...and the bytes are reachable by id from the file storage, which is what lets a second
    // replica serve them. A pod-local path could not be.
    //
    // 200 for the UPLOADER, without any role: `config.env.ts` widens `file.downloadRoles` to
    // `S_USER` so the coarse gate admits any signed-in caller, and `FileService.checkRights()`
    // then matches `metadata.ownerId` — which `AvatarController` wrote at upload time — against
    // the caller. An avatar its own owner cannot read is not an avatar.
    const asOwner = await testHelper.download(`/files/id/${avatarId}`, { token: user.token });
    expect(asOwner.statusCode).toBe(200);
    expect(Buffer.from(asOwner.data, 'binary').length).toBeGreaterThan(0);
  }, 60_000);

  it('refuses a stranger with a 404 that is byte-identical to an unknown id', async () => {
    // Passing the coarse gate is not the same as passing the fine one. `stranger` is signed in and
    // verified-enough to reach the route; the per-file rule is what stops them.
    //
    // 404, NOT 403 — deliberately. A 403 would confirm that this ObjectId names a real file, and
    // these ids are not secrets. The unknown-id comparison is the actual property: the two answers
    // must be indistinguishable, not merely both refusals.
    const unknownId = new ObjectId().toHexString();

    const refused = await testHelper.download(`/files/id/${avatarId}`, { token: stranger.token });
    const unknown = await testHelper.download(`/files/id/${unknownId}`, { token: stranger.token });

    expect(refused.statusCode).toBe(404);
    expect(unknown.statusCode).toBe(404);
    expect(refused.data).toBe(unknown.data);
  }, 60_000);

  it('lets ADMIN through, because the rule says so and not because the caller owns the file', async () => {
    // The same account that was just refused, promoted. Nothing about ownership changed — only the
    // role — so a 200 here can only come from `checkRights()`'s ADMIN branch.
    await mongoClient
      .db()
      .collection('users')
      .updateOne({ email: stranger.email }, { $set: { roles: ['admin'] } });
    const signInAsAdmin: any = await testHelper.graphQl({
      arguments: { input: { email: stranger.email, password: stranger.password } },
      fields: ['token'],
      name: 'signIn',
      type: TestGraphQLType.MUTATION,
    });

    const download = await testHelper.download(`/files/id/${avatarId}`, { token: signInAsAdmin.token });
    expect(download.statusCode).toBe(200);
  }, 60_000);
});
