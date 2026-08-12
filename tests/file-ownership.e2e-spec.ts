import { Test, TestingModule } from '@nestjs/testing';
import * as fs from 'fs';
import mongoose from 'mongoose';
import { MongoClient, ObjectId } from 'mongodb';
import * as path from 'path';
import { Readable } from 'stream';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { TestGraphQLType, TestHelper } from '../src';
import envConfig from '../src/config.env';
import { RoleEnum } from '../src/core/common/enums/role.enum';
import { IServerOptions } from '../src/core/common/interfaces/server-options.interface';
import { ConfigService } from '../src/core/common/services/config.service';
import { FILESYSTEM_FILES_COLLECTION } from '../src/core/modules/file/filesystem-file.helper';
import { FileService } from '../src/server/modules/file/file.service';
import { User } from '../src/server/modules/user/user.model';
import { ServerModule } from '../src/server/server.module';
import { createFixtureDir, removeFixtureDir } from './helpers/tmp-fixtures';

/**
 * The FINE half of the file security model, executed — against the REFERENCE SERVER'S OWN
 * `FileService`, not a fixture written for this file.
 *
 * `file.downloadRoles` is the coarse gate: it answers "may this caller reach the route at all".
 * The per-file rule — "…but only their OWN file" — can only be expressed by overriding
 * `CoreFileService.checkRights()`. That override used to exist exclusively as a commented-out
 * `@example`, plus a unit pin on the refusal PARITY (`tests/unit/core-file.controller.spec.ts`).
 * Nothing subclassed the service with the documented rule and proved it works end to end — so a
 * change that stopped `checkRights()` from being consulted, or that fed it a document it cannot
 * authorize against, shipped green. One did.
 *
 * This suite deliberately does NOT define its own subclass any more. An earlier version did, and
 * that is precisely the shape that let the defect through: a rule that lives only in a test proves
 * the FRAMEWORK can support ownership, never that the reference server actually exercises the seam.
 * `src/server/modules/file/file.service.ts` now implements the rule and `src/config.env.ts` widens
 * the gate to `S_USER`, so every other file-touching spec traverses it too — and this file stays as
 * the dedicated contract test that states the properties explicitly.
 *
 * Two properties are under test, and the second is the one that matters:
 *
 * 1. The rule fires: the owner gets their file, a different signed-in user does not.
 * 2. The refusal is a **404 that is byte-identical to an unknown id**, never a 403. A 403 would
 *    confirm the file exists, turning the endpoint into an existence oracle for a store whose
 *    ObjectIds are not secrets — which is precisely what `CoreFileService.checkRights()` promises
 *    ("Returning `false` makes the caller answer as if the file did not exist").
 *
 * BOTH LOOKUP PATHS are covered: by id (`getRawFileInfo`) and by filename (`getRawFileInfoByName`).
 * The by-name path is not a duplicate of the by-id one — it reads a different helper, and that
 * helper used to consult fewer stores than the download path did, so under
 * `file.storage: 'filesystem'` a by-name ownership rule saw `null` for a file the route then
 * happily streamed. Which way that fails depends on how the project wrote its rule: the documented
 * `!!raw && …` shape fails closed, the equally natural `if (!raw) return true` fails OPEN. Hence
 * this suite runs the whole app on the filesystem driver AND additionally stores one file directly
 * in GridFS, so both stores have to answer.
 */
const OWNER_METADATA_KEY = 'ownerId';

interface TestUser {
  email: string;
  id?: string;
  password: string;
  token?: string;
}

describe('Per-file ownership via checkRights (e2e)', () => {
  let app;
  let mongoClient: MongoClient;
  let testHelper: TestHelper;
  let fixtureDir: string;
  let storageDir: string;
  let previousConfig: Partial<IServerOptions>;

  const testId = `owner-${Date.now()}-p${process.pid}`;
  const makeUser = (label: string): TestUser => ({
    email: `${testId}-${label}@test.com`,
    password: `Pw-${Math.random().toString(36).substring(2, 10)}`,
  });

  const alice = makeUser('alice');
  const bob = makeUser('bob');
  const admin = makeUser('admin');

  /** Alice's avatar, stored through the FILESYSTEM driver by AvatarController */
  let aliceAvatar: { filename: string; id: string };
  /** A file written straight to GRIDFS, so the multi-store lookup has to answer for it too */
  let aliceGridFsFile: { filename: string; id: string };

  const signUpAndIn = async (user: TestUser): Promise<void> => {
    const signUp: any = await testHelper.graphQl({
      arguments: { input: { email: user.email, firstName: 'Owner', lastName: 'Test', password: user.password } },
      fields: [{ user: ['id', 'email'] }],
      name: 'signUp',
      type: TestGraphQLType.MUTATION,
    });
    user.id = signUp.user.id;
    await mongoClient
      .db()
      .collection('users')
      .updateOne({ _id: new ObjectId(user.id) }, { $set: { verified: true } });

    const signIn: any = await testHelper.graphQl({
      arguments: { input: { email: user.email, password: user.password } },
      fields: ['token'],
      name: 'signIn',
      type: TestGraphQLType.MUTATION,
    });
    user.token = signIn.token;
    expect(user.token, `${user.email} must have a token`).toBeTruthy();
  };

  /** Upload a PNG through AvatarController, which records `metadata.ownerId` */
  const uploadAvatar = async (user: TestUser, label: string): Promise<{ filename: string; id: string }> => {
    const filename = `${testId}-${label}.png`;
    const local = path.join(fixtureDir, filename);
    // Minimal but real PNG header — the endpoint filters on mimetype and extension
    await fs.promises.writeFile(local, Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex'));

    const id: any = await testHelper.rest('/avatar/upload', {
      attachments: { file: local },
      statusCode: 201,
      token: user.token,
    });
    expect(String(id)).toMatch(/^[a-f0-9]{24}$/);
    return { filename, id: String(id) };
  };

  /**
   * The `currentUser` a controller hands the service: a real `User` model, so `hasRole()` exists
   * and the ownership rule compares against a genuine id rather than a hand-built object literal.
   */
  const loadUser = async (user: TestUser): Promise<User> => {
    const doc = await mongoClient.db().collection('users').findOne({ _id: new ObjectId(user.id) });
    expect(doc, `${user.email} must exist`).toBeTruthy();
    return User.map({ ...doc, id: user.id });
  };

  beforeAll(async () => {
    fixtureDir = await createFixtureDir('nest-server-file-ownership-');
    storageDir = path.join(fixtureDir, 'storage');

    previousConfig = ConfigService.configFastButReadOnly as Partial<IServerOptions>;
    // Filesystem driver on purpose — see the docblock: it is the store whose absence from
    // `getRawFileInfoByName()` made a by-name ownership rule authorize against a different file
    // set than the download route serves. Only the DRIVER is swapped; `file.downloadRoles` is
    // carried over from the real config, because the coarse gate is part of what is under test.
    ConfigService.setConfig(
      {
        ...(previousConfig as any),
        file: { ...(previousConfig as any).file, storage: 'filesystem', storageDir },
      } as IServerOptions,
      { reInit: true },
    );

    // NOTE: no `applyFileRoles()` call here. The role metadata was already written by
    // `CoreModule.forRoot(envConfig)` when `ServerModule` was imported, from
    // `config.env.ts`'s `file: { downloadRoles: [RoleEnum.S_USER] }`. Re-applying it locally would
    // let this suite pass against a config that had silently reverted to `[ADMIN]` — under which
    // the guard answers first and `checkRights()` is never reached. The first case below asserts
    // the gate instead of arranging it.
    const moduleFixture: TestingModule = await Test.createTestingModule({ imports: [ServerModule] }).compile();
    app = moduleFixture.createNestApplication();
    await app.init();
    testHelper = new TestHelper(app);
    mongoClient = await MongoClient.connect(envConfig.mongoose.uri);

    for (const user of [alice, bob, admin]) {
      await signUpAndIn(user);
    }
    await mongoClient
      .db()
      .collection('users')
      .updateOne({ _id: new ObjectId(admin.id) }, { $set: { roles: [RoleEnum.ADMIN] } });
    // Re-issue the admin's token so it carries the role
    const adminSignIn: any = await testHelper.graphQl({
      arguments: { input: { email: admin.email, password: admin.password } },
      fields: ['token'],
      name: 'signIn',
      type: TestGraphQLType.MUTATION,
    });
    admin.token = adminSignIn.token;

    aliceAvatar = await uploadAvatar(alice, 'alice-avatar');

    // A second file for the same owner, written straight into GridFS. The active driver is
    // 'filesystem', so this is a file from "before the switch" — reads must still find it, and the
    // ownership rule must still authorize against ITS metadata.
    const bucket = new mongoose.mongo.GridFSBucket(mongoClient.db() as any, { bucketName: 'fs' });
    const gridFsFilename = `${testId}-alice-gridfs.txt`;
    const gridFsId = await new Promise<any>((resolve, reject) => {
      const stream = bucket.openUploadStream(gridFsFilename, {
        metadata: { contentType: 'text/plain', [OWNER_METADATA_KEY]: alice.id },
      });
      stream.on('error', reject);
      stream.on('finish', () => resolve(stream.id));
      Readable.from(['gridfs bytes owned by alice']).pipe(stream);
    });
    aliceGridFsFile = { filename: gridFsFilename, id: String(gridFsId) };
  }, 120_000);

  afterAll(async () => {
    try {
      await mongoClient?.db()?.collection(FILESYSTEM_FILES_COLLECTION).deleteMany({ filename: { $regex: testId } });
      await mongoClient?.db()?.collection('users').deleteMany({ email: { $regex: testId } });
    } catch {
      // Ignore cleanup errors
    }
    await mongoClient?.close();
    await app?.close();
    await removeFixtureDir(fixtureDir);
    // Global config is shared per worker — restore it, in case this file ever stops being the only
    // one in its own. The file-role metadata is NOT touched here: this suite no longer rewrites it,
    // so there is nothing to restore, and calling `applyFileRoles(undefined)` would actively CLOBBER
    // the app-wide `[S_USER]` gate back to the framework default for any spec sharing this worker.
    ConfigService.setConfig(previousConfig as IServerOptions, { reInit: true });
  }, 120_000);

  // ===================================================================================================================
  // Setup sanity — without these, every refusal below could be a refusal for the wrong reason
  // ===================================================================================================================

  it('lets the coarse gate through for any signed-in user, so the fine rule is actually reached', async () => {
    // Asserts the SHIPPED configuration (`config.env.ts` → `file.downloadRoles: [S_USER]`), not an
    // arrangement made by this file. If it were still [ADMIN], Bob's 404s below would in fact be the
    // role guard's 403 turned into something else — and this suite would be testing nothing about
    // checkRights(). That failure mode is why the gate is asserted rather than applied here.
    const asOwner = await testHelper.download(`/files/id/${aliceAvatar.id}`, { token: alice.token });
    expect(asOwner.statusCode).toBe(200);
  });

  it('resolves the file through the filesystem driver, not GridFS', async () => {
    const fsDoc = await mongoClient
      .db()
      .collection(FILESYSTEM_FILES_COLLECTION)
      .findOne({ _id: new ObjectId(aliceAvatar.id) });
    expect(fsDoc?.metadata?.[OWNER_METADATA_KEY]).toBe(alice.id);
    expect(await mongoClient.db().collection('fs.files').findOne({ filename: aliceAvatar.filename })).toBeNull();
  });

  // ===================================================================================================================
  // By id — getRawFileInfo()
  // ===================================================================================================================

  it('answers a non-owner with 404, byte-identical to an unknown id', async () => {
    const unknownId = new ObjectId().toHexString();

    const refused = await testHelper.download(`/files/id/${aliceAvatar.id}`, { token: bob.token });
    const unknown = await testHelper.download(`/files/id/${unknownId}`, { token: bob.token });

    // 404, NOT 403. A 403 here would confirm that this id names a real file.
    expect(refused.statusCode).toBe(404);
    expect(unknown.statusCode).toBe(404);
    // …and indistinguishable from it, which is the actual property: same status AND same body.
    expect(refused.statusCode).toBe(unknown.statusCode);
    expect(refused.data).toBe(unknown.data);
    // Nothing of the file leaked into the refusal.
    expect(refused.data).not.toContain(aliceAvatar.filename);
  });

  it('serves the owner their own file by id', async () => {
    const res = await testHelper.download(`/files/id/${aliceAvatar.id}`, { token: alice.token });
    expect(res.statusCode).toBe(200);
    expect(Buffer.from(res.data, 'binary').length).toBeGreaterThan(0);
  });

  it('lets ADMIN through, because the rule says so and not because the guard did', async () => {
    const res = await testHelper.download(`/files/id/${aliceAvatar.id}`, { token: admin.token });
    expect(res.statusCode).toBe(200);
  });

  // ===================================================================================================================
  // By filename — getRawFileInfoByName()
  //
  // A separate code path with its own store lookup, so a passing by-id case says nothing here.
  // ===================================================================================================================

  it('answers a non-owner with 404 on the filename route, byte-identical to an unknown filename', async () => {
    const refused = await testHelper.download(`/files/${aliceAvatar.filename}`, { token: bob.token });
    const unknown = await testHelper.download(`/files/${testId}-does-not-exist.png`, { token: bob.token });

    expect(refused.statusCode).toBe(404);
    expect(unknown.statusCode).toBe(404);
    expect(refused.data).toBe(unknown.data);
  });

  it('serves the owner their own file by filename', async () => {
    // The fail-closed direction of the by-name bug: with the filesystem store missing from
    // `getRawFileInfoByName()`, this returned null for a file the route can plainly stream, and the
    // documented `!!raw && …` rule denied the owner their own file.
    const res = await testHelper.download(`/files/${aliceAvatar.filename}`, { token: alice.token });
    expect(res.statusCode).toBe(200);
  });

  it('authorizes a GridFS-stored file by filename too, under a filesystem-driver deployment', async () => {
    // The fail-OPEN direction, and the reason the lookup has to consult EVERY store: a rule written
    // as `if (!raw) return true` would hand this file to Bob. Reads span all stores, so the
    // authorization read has to as well.
    const asOwner = await testHelper.download(`/files/${aliceGridFsFile.filename}`, { token: alice.token });
    expect(asOwner.statusCode).toBe(200);
    expect(asOwner.data).toBe('gridfs bytes owned by alice');

    const asStranger = await testHelper.download(`/files/${aliceGridFsFile.filename}`, { token: bob.token });
    expect(asStranger.statusCode).toBe(404);
    expect(asStranger.data).not.toContain('gridfs bytes owned by alice');
  });

  it('authorizes a GridFS-stored file by id too', async () => {
    expect((await testHelper.download(`/files/id/${aliceGridFsFile.id}`, { token: alice.token })).statusCode).toBe(200);
    expect((await testHelper.download(`/files/id/${aliceGridFsFile.id}`, { token: bob.token })).statusCode).toBe(404);
  });

  // ===================================================================================================================
  // Delete by filename — the two-questions bug
  //
  // Runs LAST on purpose: uploading another avatar for Alice makes AvatarController clean up
  // `aliceAvatar`, which the cases above still need.
  // ===================================================================================================================

  it('refuses a non-owner deleting by filename, and leaves the file in place', async () => {
    // The other half of the pair below: the rule must still REFUSE, so a green delete case cannot
    // be explained by the reference server's rule having gone permissive.
    const bobUser = await loadUser(bob);
    const service = app.get(FileService);

    expect(await service.deleteFileByName(aliceAvatar.filename, { currentUser: bobUser })).toBeNull();
    // Refused, not deleted — the owner can still fetch it.
    expect((await testHelper.download(`/files/id/${aliceAvatar.id}`, { token: alice.token })).statusCode).toBe(200);
  });

  it('deletes by filename with the caller context the outer check was granted with', async () => {
    // Regression: deleteFileByName() authorized the caller and then re-resolved the file via
    // getFileInfoByName() WITHOUT serviceOptions — so an overridden checkRights() was asked two
    // different questions about one request. Its sibling deleteFile() forwards to getFileInfo();
    // this one did not.
    //
    // The symptom is the worst part: the owner is cleared by the outer check, the inner lookup
    // denies with an empty context, and `deleteFileByName()` raises NotFoundException — `File not
    // found` for a file that exists and that the caller was just authorized for. A missing file
    // and a refused one are different answers, and this returned neither correctly.
    //
    // This case is only able to detect that because `FileService.checkRights()` FAILS CLOSED on a
    // missing user. An `if (!options.currentUser) return true` shortcut — the shape the docs used
    // to teach, and the shape the starter copied — makes the context-less inner lookup succeed too,
    // and the whole assertion passes with the bug fully present.
    const doomed = await uploadAvatar(alice, 'alice-delete-by-name');

    // Same lesson one layer up: AvatarController's cleanup of the REPLACED avatar passes the real
    // `{ currentUser }`, so the ownership rule COVERS that delete (Alice owns the old file) rather
    // than exempting it. Called with an empty context against a fail-closed rule it would refuse
    // silently — `deleteFile()` returns null, nothing throws, and the old avatar leaks forever.
    expect((await testHelper.download(`/files/id/${aliceAvatar.id}`, { token: alice.token })).statusCode).toBe(404);

    const aliceUser = await loadUser(alice);
    const service = app.get(FileService);

    const deleted = await service.deleteFileByName(doomed.filename, { currentUser: aliceUser });
    expect(deleted?.id).toBe(doomed.id);

    // Gone for real, not merely reported as gone.
    expect((await testHelper.download(`/files/id/${doomed.id}`, { token: alice.token })).statusCode).toBe(404);
  });
});
