import { Test, TestingModule } from '@nestjs/testing';
import * as fs from 'fs';
import { PubSub } from 'graphql-subscriptions';
import { VariableType } from 'json-to-graphql-query';
import { MongoClient, ObjectId } from 'mongodb';
import * as path from 'path';

import { HttpExceptionLogFilter, TestGraphQLType, TestHelper } from '../src';
import envConfig from '../src/config.env';
import { RoleEnum } from '../src/core/common/enums/role.enum';
import { FileInfo } from '../src/server/modules/file/file-info.model';
import { User } from '../src/server/modules/user/user.model';
import { UserService } from '../src/server/modules/user/user.service';
import { ServerModule } from '../src/server/server.module';
import { createFixtureDir, removeFixtureDir } from './helpers/tmp-fixtures';

describe('File (e2e)', () => {
  // To enable debugging, include these flags in the options of the request you want to debug
  const log = true;
  const logError = true;

  // Testenvironment properties
  let app;
  let testHelper: TestHelper;

  // database
  let connection;
  let db;

  // Global vars
  let userService: UserService;
  const users: Partial<User & { token: string }>[] = [];
  let fileInfo: FileInfo;
  let fileContent: string;

  // Upload fixtures are staged OUTSIDE the repository. Writing them into
  // `tests/` and unlinking after the upload assertion leaks the file on exactly
  // the failure the spec exists to catch — that is how five committed
  // `avatar-*.png` artifacts came about. See tests/helpers/tmp-fixtures.ts.
  let fixtureDir: string;

  // ===================================================================================================================
  // Preparations
  // ===================================================================================================================

  /**
   * Before all tests
   */
  beforeAll(async () => {
    // Indicates that cookies are enabled
    if (envConfig.cookies) {
      console.error('NOTE: Cookie handling is enabled. The tests with tokens will fail!');
    }
    fixtureDir = await createFixtureDir('nest-server-file-');
    try {
      const moduleFixture: TestingModule = await Test.createTestingModule({
        imports: [ServerModule],
        providers: [
          UserService,
          {
            provide: 'PUB_SUB',
            useValue: new PubSub(),
          },
        ],
      }).compile();
      app = moduleFixture.createNestApplication();
      app.useGlobalFilters(new HttpExceptionLogFilter());
      app.setBaseViewsDir(envConfig.templates.path);
      app.setViewEngine(envConfig.templates.engine);
      await app.init();
      testHelper = new TestHelper(app);
      userService = moduleFixture.get(UserService);

      // Connection to database
      connection = await MongoClient.connect(envConfig.mongoose.uri);
      db = await connection.db();
    } catch (e) {
      console.error('beforeAllError', e);
    }
  });

  /**
   * After all tests are finished
   */
  afterAll(async () => {
    await removeFixtureDir(fixtureDir);
    await connection.close();
    await app.close();
  });

  // ===================================================================================================================
  // Initialization tests
  // ===================================================================================================================

  /**
   * Create and verify users for testing
   */
  it('createAndVerifyUsers', async () => {
    const userCount = 2;
    for (let i = 0; i < userCount; i++) {
      const random = Math.random().toString(36).substring(7);
      const input = {
        email: `${random}@testusers.com`,
        firstName: `Test${random}`,
        lastName: `User${random}`,
        password: random,
      };

      // Sign up user
      const res: any = await testHelper.graphQl({
        arguments: { input },
        fields: [{ user: ['id', 'email', 'firstName', 'lastName'] }],
        name: 'signUp',
        type: TestGraphQLType.MUTATION,
      });
      res.user.password = input.password;
      users.push(res.user);

      // Verify user. NB: `res` is `{ user: {...} }` — this used to read `res.id`,
      // which is undefined, and `new ObjectId(undefined)` mints a FRESH id rather
      // than throwing, so the update silently matched zero documents and nobody
      // was ever verified.
      await db.collection('users').updateOne({ _id: new ObjectId(res.user.id) }, { $set: { verified: true } });
    }
    expect(users.length).toBeGreaterThanOrEqual(userCount);
  });

  /**
   * Sign in users
   */
  it('signInUsers', async () => {
    for (const user of users) {
      const res: any = await testHelper.graphQl({
        arguments: {
          input: {
            email: user.email,
            password: user.password,
          },
        },
        fields: ['token', { user: ['id', 'email'] }],
        name: 'signIn',
        type: TestGraphQLType.MUTATION,
      });
      expect(res.user.id).toEqual(user.id);
      expect(res.user.email).toEqual(user.email);
      user.token = res.token;
    }
  });

  /**
   * Prepare users
   */
  it('prepareUsers', async () => {
    await db
      .collection('users')
      .findOneAndUpdate({ _id: new ObjectId(users[0].id) }, { $set: { roles: [RoleEnum.ADMIN] } });
  });

  // ===================================================================================================================
  // Access control on the WRITE endpoints
  //
  // 11.33.0 closed `/files/**` for anonymous callers — `deleteFile` in particular was anonymously
  // callable, which is what motivated the change. The download side is covered further down
  // (`refusesAnonymousDownloadById` and friends); this section covers the write side, which had no
  // negative test at all: every upload and delete below used `users[0].token`, the admin.
  //
  // The status is asserted EXACTLY, never as `401|403`. The framework's policy is deterministic —
  // unauthenticated => 401, authenticated-without-right => 403 — and SPA auth layers branch on it:
  // a permission error returned as 401 makes the client treat the session as expired and logs the
  // user out of the whole app. A regex accepting either would let that regression through.
  // See `.claude/rules/role-system.md` § "Status Codes: 401 vs 403".
  //
  // Both surfaces are covered: REST (`POST /files/upload`, `DELETE /files/:id`) and GraphQL
  // (`uploadFile`, `uploadFiles`, `deleteFile`). They are gated independently — `FileController`
  // and `FileResolver` are separate classes carrying their own `@Roles` metadata — so covering one
  // says nothing about the other.
  // ===================================================================================================================

  /** GraphQL transports its status inside the payload; HTTP stays 200. */
  const graphQlStatusOf = (res: any): number => res?.errors?.[0]?.extensions?.originalError?.statusCode;

  it('refusesAnonymousUploadViaREST', async () => {
    const local = path.join(fixtureDir, `anon-upload-${Math.random().toString(36).substring(7)}.txt`);
    await fs.promises.writeFile(local, 'anonymous upload attempt');

    // The role gate runs before the multer interceptor, so the bytes are never even parsed.
    await testHelper.rest('/files/upload', {
      attachments: { file: local },
      statusCode: 401,
    });
  });

  it('refusesNonAdminUploadViaREST', async () => {
    // users[1] is a regular, verified user without RoleEnum.ADMIN. 403, not 401 — they ARE
    // authenticated, they just lack the right.
    const local = path.join(fixtureDir, `nonadmin-upload-${Math.random().toString(36).substring(7)}.txt`);
    await fs.promises.writeFile(local, 'non-admin upload attempt');

    await testHelper.rest('/files/upload', {
      attachments: { file: local },
      statusCode: 403,
      token: users[1].token,
    });
  });

  it('refusesAnonymousUploadViaGraphQL', async () => {
    const local = path.join(fixtureDir, `anon-gql-${Math.random().toString(36).substring(7)}.txt`);
    await fs.promises.writeFile(local, 'anonymous graphql upload attempt');

    const res: any = await testHelper.graphQl(
      {
        arguments: { file: new VariableType('file') },
        fields: ['id', 'filename'],
        name: 'uploadFile',
        type: TestGraphQLType.MUTATION,
        variables: { file: 'Upload!' },
      },
      { variables: { file: { type: 'attachment', value: local } } },
    );

    expect(graphQlStatusOf(res)).toEqual(401);
    expect(res.data?.uploadFile ?? null).toBeNull();
  });

  it('refusesNonAdminUploadViaGraphQL', async () => {
    const local = path.join(fixtureDir, `nonadmin-gql-${Math.random().toString(36).substring(7)}.txt`);
    await fs.promises.writeFile(local, 'non-admin graphql upload attempt');

    const res: any = await testHelper.graphQl(
      {
        arguments: { file: new VariableType('file') },
        fields: ['id', 'filename'],
        name: 'uploadFile',
        type: TestGraphQLType.MUTATION,
        variables: { file: 'Upload!' },
      },
      { token: users[1].token, variables: { file: { type: 'attachment', value: local } } },
    );

    expect(graphQlStatusOf(res)).toEqual(403);
    expect(res.data?.uploadFile ?? null).toBeNull();
  });

  it('refusesAnonymousMultiUploadViaGraphQL', async () => {
    // `uploadFiles` carries its own @Roles metadata, so it needs its own assertion.
    const local = path.join(fixtureDir, `anon-multi-${Math.random().toString(36).substring(7)}.txt`);
    await fs.promises.writeFile(local, 'anonymous multi upload attempt');

    const res: any = await testHelper.graphQl(
      {
        arguments: { files: new VariableType('files') },
        name: 'uploadFiles',
        type: TestGraphQLType.MUTATION,
        variables: { files: '[Upload!]!' },
      },
      { variables: { files: { type: 'attachment', value: [local] } } },
    );

    expect(graphQlStatusOf(res)).toEqual(401);
  });

  it('refusesNonAdminMultiUploadViaGraphQL', async () => {
    const local = path.join(fixtureDir, `nonadmin-multi-${Math.random().toString(36).substring(7)}.txt`);
    await fs.promises.writeFile(local, 'non-admin multi upload attempt');

    const res: any = await testHelper.graphQl(
      {
        arguments: { files: new VariableType('files') },
        name: 'uploadFiles',
        type: TestGraphQLType.MUTATION,
        variables: { files: '[Upload!]!' },
      },
      { token: users[1].token, variables: { files: { type: 'attachment', value: [local] } } },
    );

    expect(graphQlStatusOf(res)).toEqual(403);
  });

  // ===================================================================================================================
  // Tests for file handling via GraphQL
  // ===================================================================================================================

  it('uploadFileViaGraphQL', async () => {
    const filename = `${Math.random().toString(36).substring(7)}.txt`;
    fileContent = 'Hello GraphQL';

    // Set paths
    const local = path.join(fixtureDir, filename);

    // Write and send file
    await fs.promises.writeFile(local, fileContent);
    const res: any = await testHelper.graphQl(
      {
        arguments: { file: new VariableType('file') },
        fields: ['id', 'filename'],
        name: 'uploadFile',
        type: TestGraphQLType.MUTATION,
        variables: { file: 'Upload!' },
      },
      { token: users[0].token, variables: { file: { type: 'attachment', value: local } } },
    );

    // Test result
    expect(res.id.length).toBeGreaterThan(0);
    expect(res.filename).toEqual(filename);
    fileInfo = res;
  });

  it('getFileInfoForGraphQLFile', async () => {
    const res: any = await testHelper.graphQl(
      {
        arguments: { filename: fileInfo.filename },
        fields: ['id', 'filename'],
        name: 'getFileInfo',
        type: TestGraphQLType.QUERY,
      },
      { token: users[0].token },
    );
    expect(res.id).toEqual(fileInfo.id);
    expect(res.filename).toEqual(fileInfo.filename);
  });

  it('downloadGraphQLFileById', async () => {
    // Download by ID uses /files/id/:id (admin endpoint via CoreFileController)
    const res = await testHelper.download(`/files/id/${fileInfo.id}`, { token: users[0].token });
    expect(res.statusCode).toEqual(200);
    expect(res.data).toEqual(fileContent);
  });

  it('downloadGraphQLFileByFilename', async () => {
    // Download by filename uses /files/:filename (admin endpoint via CoreFileController)
    const res = await testHelper.download(`/files/${fileInfo.filename}`, { token: users[0].token });
    expect(res.statusCode).toEqual(200);
    expect(res.data).toEqual(fileContent);
  });

  it('deleteGraphQLFile', async () => {
    const res: any = await testHelper.graphQl(
      {
        arguments: { filename: fileInfo.filename },
        fields: ['id'],
        name: 'deleteFile',
        type: TestGraphQLType.MUTATION,
      },
      { token: users[0].token },
    );
    expect(res.id).toEqual(fileInfo.id);
  });

  it('getGraphQLFileInfo', async () => {
    const res: any = await testHelper.graphQl(
      {
        arguments: { filename: fileInfo.filename },
        fields: ['id', 'filename'],
        name: 'getFileInfo',
        type: TestGraphQLType.QUERY,
      },
      { token: users[0].token },
    );
    expect(res).toEqual(null);
  });

  it('uploadFilesViaGraphQL', async () => {
    // The multi-upload mutation stores into the CENTRAL file storage (GridFS/S3), not
    // the process working directory — so this asserts the files are afterwards
    // retrievable through the API, which is what a second replica would see too.
    // A `../uploads/<name>` stat would pass on a single pod and prove nothing.
    const local1 = path.join(fixtureDir, 'test1.txt');
    const local2 = path.join(fixtureDir, 'test2.txt');

    // Write and send file
    await fs.promises.writeFile(local1, 'Hello GraphQL 1');
    await fs.promises.writeFile(local2, 'Hello GraphQL 2');
    const res: any = await testHelper.graphQl(
      {
        arguments: { files: new VariableType('files') },
        name: 'uploadFiles',
        type: TestGraphQLType.MUTATION,
        variables: { files: '[Upload!]!' },
      },
      { token: users[0].token, variables: { files: { type: 'attachment', value: [local1, local2] } } },
    );

    expect(res).toEqual(true);

    // Both files are downloadable from the store, with their content intact
    for (const [filename, content] of [
      ['test1.txt', 'Hello GraphQL 1'],
      ['test2.txt', 'Hello GraphQL 2'],
    ]) {
      // Admin token: uploads made through the GraphQL mutation carry no owner
      // metadata, so only `file.downloadRoles` (default ADMIN) grants access.
      const download = await testHelper.download(`/files/${filename}`, { token: users[0].token });
      expect(download.statusCode).toEqual(200);
      expect(download.data).toEqual(content);

      // Clean up the stored file again
      await testHelper.graphQl(
        {
          arguments: { filename },
          fields: ['id'],
          name: 'deleteFile',
          type: TestGraphQLType.MUTATION,
        },
        { token: users[0].token },
      );
    }
  });

  // ===================================================================================================================
  // Tests for file handling via REST
  // ===================================================================================================================

  it('uploadFileViaREST', async () => {
    const filename = `${Math.random().toString(36).substring(7)}.txt`;
    fileContent = 'Hello REST';

    // Set paths
    const local = path.join(fixtureDir, filename);

    // Write and send file
    await fs.promises.writeFile(local, fileContent);
    const res = await testHelper.rest('/files/upload', {
      attachments: { file: local },
      statusCode: 201,
      token: users[0].token,
    });

    // Test result
    expect(res.id.length).toBeGreaterThan(0);
    expect(res.filename).toEqual(filename);
    fileInfo = res;
  });

  it('getFileInfoForRESTFile', async () => {
    const res = await testHelper.rest(`/files/info/${fileInfo.id}`, { token: users[0].token });
    expect(res.id).toEqual(fileInfo.id);
    expect(res.filename).toEqual(fileInfo.filename);
  });

  it('downloadRESTFileById', async () => {
    // Download by ID uses /files/id/:id (admin endpoint via CoreFileController)
    const res = await testHelper.download(`/files/id/${fileInfo.id}`, { token: users[0].token });
    expect(res.statusCode).toEqual(200);
    expect(res.data).toEqual(fileContent);
  });

  it('downloadRESTFileByFilename', async () => {
    // Download by filename uses /files/:filename (admin endpoint via CoreFileController)
    const res = await testHelper.download(`/files/${fileInfo.filename}`, { token: users[0].token });
    expect(res.statusCode).toEqual(200);
    expect(res.data).toEqual(fileContent);
  });

  it('refusesAnonymousDownloadById', async () => {
    // Regression guard: both download routes carried @Roles(S_EVERYONE), which the
    // roles guard turns into `return true` WITHOUT authenticating — every blob of
    // the shared GridFS bucket was readable by anyone who could guess an ObjectId.
    //
    // 401 exactly, not "401 or 403": the framework's status policy is deterministic
    // (unauthenticated => 401, authenticated-without-right => 403), and SPA auth
    // layers branch on it — a 401 triggers the logout flow. Accepting either would
    // let a regression of that policy pass unnoticed.
    const res = await testHelper.download(`/files/id/${fileInfo.id}`);
    expect(res.statusCode).toEqual(401);
    expect(res.data).not.toContain(fileContent);
  });

  it('refusesAnonymousDownloadByFilename', async () => {
    // Weaker route still: getFileInfoByName() returns the FIRST match, so a
    // guessable original filename would have been enough.
    const res = await testHelper.download(`/files/${fileInfo.filename}`);
    expect(res.statusCode).toEqual(401);
    expect(res.data).not.toContain(fileContent);
  });

  it('refusesNonAdminDownload', async () => {
    // users[1] is a regular, verified user without RoleEnum.ADMIN. 403, not 401 —
    // the caller IS authenticated, they just lack the right.
    const res = await testHelper.download(`/files/id/${fileInfo.id}`, { token: users[1].token });
    expect(res.statusCode).toEqual(403);
    expect(res.data).not.toContain(fileContent);
  });

  it('downloadRESTFileWithTokenOption', async () => {
    // Verify options-object form of token auth works (same as string form)
    const res = await testHelper.download(`/files/id/${fileInfo.id}`, { token: users[0].token });
    expect(res.statusCode).toEqual(200);
    expect(res.data).toEqual(fileContent);
  });

  it('refusesInvalidSessionCookie', async () => {
    // Renamed from `downloadRESTFileWithCookies`: with the route gated, a bogus
    // cookie produces exactly the anonymous outcome, so the old name promised a
    // positive cookie-auth check this assertion cannot make. The positive one
    // lives in `downloadRESTFileWithValidSessionCookie` below.
    //
    // Before the routes were gated this asserted 200, which only ever proved the
    // endpoint ignored credentials altogether.
    const res = await testHelper.download(`/files/id/${fileInfo.id}`, { cookies: 'test-session-token' });
    expect(res.statusCode).toEqual(401);
  });

  it('downloadRESTFileWithBothTokenAndCookies', async () => {
    // Verify both cookies and token can be set simultaneously (like rest())
    const res = await testHelper.download(`/files/id/${fileInfo.id}`, {
      cookies: 'test-session-token',
      token: users[0].token,
    });
    expect(res.statusCode).toEqual(200);
    expect(res.data).toEqual(fileContent);
  });

  it('downloadBufferWithTokenOption', async () => {
    const buffer = await testHelper.downloadBuffer(`/files/id/${fileInfo.id}`, { token: users[0].token });
    expect(Buffer.isBuffer(buffer)).toBe(true);
    expect(buffer.toString()).toEqual(fileContent);
  });

  it('downloadBufferWithCookies', async () => {
    // Subject here is downloadBuffer + the Cookie header, not authorization —
    // the route is admin-gated, so a valid credential has to come along. The
    // bogus cookie still exercises the header path (see the "both" case above).
    const buffer = await testHelper.downloadBuffer(`/files/id/${fileInfo.id}`, {
      cookies: 'test-session-token',
      token: users[0].token,
    });
    expect(Buffer.isBuffer(buffer)).toBe(true);
    expect(buffer.toString()).toEqual(fileContent);
  });

  // -------------------------------------------------------------------------------------------------------------------
  // Delete refusals. Deliberately placed while `fileInfo` still exists, so each case can also
  // assert that the file SURVIVED — a 401/403 that nonetheless deleted the blob would otherwise
  // pass. `deleteFile` was the anonymously-callable endpoint that motivated closing these routes.
  // -------------------------------------------------------------------------------------------------------------------

  it('refusesAnonymousDeleteViaREST', async () => {
    await testHelper.rest(`/files/${fileInfo.id}`, { method: 'DELETE', statusCode: 401 });

    // Still there.
    const stillThere = await testHelper.rest(`/files/info/${fileInfo.id}`, { token: users[0].token });
    expect(stillThere.id).toEqual(fileInfo.id);
  });

  it('refusesNonAdminDeleteViaREST', async () => {
    // 403, not 401 — users[1] is authenticated and merely lacks the right.
    await testHelper.rest(`/files/${fileInfo.id}`, { method: 'DELETE', statusCode: 403, token: users[1].token });

    const stillThere = await testHelper.rest(`/files/info/${fileInfo.id}`, { token: users[0].token });
    expect(stillThere.id).toEqual(fileInfo.id);
  });

  it('refusesAnonymousDeleteViaGraphQL', async () => {
    const res: any = await testHelper.graphQl({
      arguments: { filename: fileInfo.filename },
      fields: ['id'],
      name: 'deleteFile',
      type: TestGraphQLType.MUTATION,
    });

    expect(graphQlStatusOf(res)).toEqual(401);

    const stillThere = await testHelper.rest(`/files/info/${fileInfo.id}`, { token: users[0].token });
    expect(stillThere.id).toEqual(fileInfo.id);
  });

  it('refusesNonAdminDeleteViaGraphQL', async () => {
    const res: any = await testHelper.graphQl(
      {
        arguments: { filename: fileInfo.filename },
        fields: ['id'],
        name: 'deleteFile',
        type: TestGraphQLType.MUTATION,
      },
      { token: users[1].token },
    );

    expect(graphQlStatusOf(res)).toEqual(403);

    const stillThere = await testHelper.rest(`/files/info/${fileInfo.id}`, { token: users[0].token });
    expect(stillThere.id).toEqual(fileInfo.id);
  });

  it('deleteRESTFile', async () => {
    const res = await testHelper.rest(`/files/${fileInfo.id}`, { method: 'DELETE', token: users[0].token });
    expect(res.id).toEqual(fileInfo.id);
  });

  it('getRESTFileInfo', async () => {
    const res = await testHelper.rest(`/files/info/${fileInfo.id}`, { token: users[0].token });
    expect(res).toEqual(null);
  });

  // ===================================================================================================================
  // Clean up tests
  // ===================================================================================================================

  /**
   * Delete users
   */
  it('deleteUsers', async () => {
    // Add admin role to last user
    await userService.setRoles(users[users.length - 1].id, ['admin']);

    for (const user of users) {
      const res: any = await testHelper.graphQl(
        {
          arguments: {
            id: user.id,
          },
          fields: ['id'],
          name: 'deleteUser',
          type: TestGraphQLType.MUTATION,
        },
        { token: users[users.length - 1].token },
      );
      expect(res.id).toEqual(user.id);
    }
  });
});
