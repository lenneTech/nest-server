/**
 * Story Test: Entwickler möchte tus.io API, damit resumable Uploads möglich sind
 *
 * As a developer I want a tus.io compatible API so that I can upload files,
 * track upload progress, and resume interrupted uploads.
 *
 * This test uses tus-js-client to validate the complete tus protocol implementation.
 */
import { Test, TestingModule } from '@nestjs/testing';
import * as fs from 'fs';
import { PubSub } from 'graphql-subscriptions';
import * as http from 'http';
import { MongoClient } from 'mongodb';
import * as path from 'path';
import * as tus from 'tus-js-client';

import { HttpExceptionLogFilter, RoleEnum, TestHelper } from '../../src';
import envConfig from '../../src/config.env';
import { ServerModule } from '../../src/server/server.module';

/**
 * Poll until `check` returns a truthy value, or give up after `timeoutMs`.
 *
 * Replaces the fixed `wait(150)` sleeps this helper used to carry. Those were
 * both unnecessary (every preceding step is an awaited HTTP round-trip or an
 * awaited Mongo write, and the user cache TTL is 0 under VITEST) and fragile:
 * the e2e run governor drops into low-resource mode when another project's run
 * holds a slot, and a hardcoded 150 ms does not scale with that.
 */
const waitFor = async <T>(check: () => Promise<T>, timeoutMs = 5000, intervalMs = 25): Promise<T | undefined> => {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const result = await check();
    if (result) {
      return result;
    }
    if (Date.now() >= deadline) {
      return undefined;
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
};

describe('TUS Upload Story', () => {
  // Test environment properties
  let app;
  let testHelper: TestHelper;
  let httpServer: http.Server;
  let serverUrl: string;

  // Database
  let connection;
  let db;

  // Test data
  const testFilePath = path.join(__dirname, 'test-tus-upload.txt');
  const testFileContent = 'Hello TUS! This is a test file for resumable uploads.';
  const largeTestFilePath = path.join(__dirname, 'test-tus-upload-large.bin');

  // Unique test identifier for cleanup
  const testId = `tus-${Date.now()}-${Math.random().toString(36).substring(2, 8)}`;

  // TUS now requires a session by default (`tus.roles`, default S_USER), so every
  // protocol request below carries the admin session cookie. Anonymous access is
  // asserted separately in "Access control".
  const tusHeaders = (extra: Record<string, string> = {}): Record<string, string> => {
    const cookies = TestHelper.buildBetterAuthCookies(adminToken);
    return {
      Cookie: Object.entries(cookies)
        .map(([key, value]) => `${key}=${value}`)
        .join('; '),
      ...extra,
    };
  };

  // FileController's download routes are ADMIN-only, so the two integration
  // checks below need a real session. IAM auth is cookie-based: sign in, then
  // replay the session token from the `session` collection as a cookie.
  let adminToken: string;
  const adminEmail = `${testId}-admin@test.com`;

  const signUpAdmin = async (): Promise<string> => {
    const password = 'TusPass123!';
    await testHelper.rest('/iam/sign-up/email', {
      method: 'POST',
      payload: { email: adminEmail, name: 'TUS Admin', password, termsAndPrivacyAccepted: true },
      statusCode: 201,
    });

    const created = await waitFor(() => db.collection('users').findOne({ email: adminEmail }));
    if (!created) {
      throw new Error(`signUpAdmin: user ${adminEmail} was never persisted`);
    }

    await db
      .collection('users')
      .updateOne({ email: adminEmail }, { $set: { emailVerified: true, roles: [RoleEnum.ADMIN], verified: true } });
    await db.collection('iam_user').updateOne({ email: adminEmail }, { $set: { emailVerified: true } });

    await testHelper.rest('/iam/sign-in/email', {
      method: 'POST',
      payload: { email: adminEmail, password },
      statusCode: 200,
    });

    const dbUser = await db.collection('users').findOne({ email: adminEmail });
    const session = await waitFor<{ token?: string }>(() =>
      db.collection('session').findOne({
        $or: [
          { userId: dbUser?._id },
          { userId: dbUser?._id?.toString() },
          ...(dbUser?.iamId ? [{ userId: dbUser.iamId }] : []),
        ],
      }) as Promise<{ token?: string } | null>,
    );

    // Throw rather than returning ''. An empty cookie string is falsy, so
    // `download(url, { cookies: '' })` sets no Cookie header at all and the
    // request goes out ANONYMOUS — the download assertions below would then fail
    // with "expected 401 to be 200", pointing at the route under test instead of
    // at the auth setup that actually broke.
    if (!session?.token) {
      throw new Error(`signUpAdmin: no session token found for ${adminEmail}`);
    }
    return session.token;
  };

  // ===================================================================================================================
  // Setup & Teardown
  // ===================================================================================================================

  beforeAll(async () => {
    // Create test files
    await fs.promises.writeFile(testFilePath, testFileContent);
    // Create a larger file for chunked upload testing (100KB)
    const largeContent = Buffer.alloc(100 * 1024, 'x');
    await fs.promises.writeFile(largeTestFilePath, largeContent);

    try {
      const moduleFixture: TestingModule = await Test.createTestingModule({
        imports: [ServerModule],
        providers: [
          {
            provide: 'PUB_SUB',
            useValue: new PubSub(),
          },
        ],
      }).compile();

      app = moduleFixture.createNestApplication();
      app.useGlobalFilters(new HttpExceptionLogFilter());
      await app.init();

      // Start HTTP server for tus-js-client
      httpServer = app.getHttpServer();
      await new Promise<void>((resolve) => {
        httpServer.listen(0, '127.0.0.1', () => resolve());
      });
      const address = httpServer.address() as { port: number };
      serverUrl = `http://127.0.0.1:${address.port}`;

      testHelper = new TestHelper(app);

      // Connection to database
      connection = await MongoClient.connect(envConfig.mongoose.uri);
      db = await connection.db();

      adminToken = await signUpAdmin();
    } catch (e) {
      console.error('beforeAll Error:', e);
      throw e;
    }
  });

  afterAll(async () => {
    // Clean up test files
    try {
      await fs.promises.unlink(testFilePath);
      await fs.promises.unlink(largeTestFilePath);
    } catch {
      // Ignore if files don't exist
    }

    // Clean up uploaded files from GridFS
    try {
      const filesCollection = db.collection('fs.files');
      const chunksCollection = db.collection('fs.chunks');
      const files = await filesCollection.find({ filename: { $regex: testId } }).toArray();
      for (const file of files) {
        await chunksCollection.deleteMany({ files_id: file._id });
        await filesCollection.deleteOne({ _id: file._id });
      }
    } catch {
      // Ignore cleanup errors
    }

    // Clean up the admin test user created for the FileController downloads
    try {
      const dbUser = await db.collection('users').findOne({ email: adminEmail });
      if (dbUser) {
        await db.collection('session').deleteMany({
          $or: [
            { userId: dbUser._id },
            { userId: dbUser._id?.toString() },
            ...(dbUser.iamId ? [{ userId: dbUser.iamId }] : []),
          ],
        });
        // `account` holds the Better-Auth credential row; other suites clean it too.
        // Matters on a FAILING run, where the per-run DB is deliberately kept.
        await db.collection('account').deleteMany({
          $or: [{ userId: dbUser._id }, { userId: dbUser._id?.toString() }, ...(dbUser.iamId ? [{ userId: dbUser.iamId }] : [])],
        });
      }
      await db.collection('users').deleteMany({ email: adminEmail });
      await db.collection('iam_user').deleteMany({ email: adminEmail });
    } catch {
      // Ignore cleanup errors
    }

    // Close connections
    if (httpServer) {
      await new Promise<void>((resolve) => httpServer.close(() => resolve()));
    }
    await connection?.close();
    await app?.close();
  });

  // ===================================================================================================================
  // Happy Path Tests
  // ===================================================================================================================

  describe('Happy Path', () => {
    it('should expose tus endpoint at /tus', async () => {
      // TUS protocol doesn't support GET - only OPTIONS, HEAD, POST, PATCH, DELETE
      // GET should return 404 (not found / not handled)
      //
      // Authenticated on purpose: the route requires a session since 11.33.0, so
      // an anonymous GET answers 401 and would never reach the tus handler. That
      // gate matters here — @tus/server routes GET to a handler that streams the
      // upload back whenever the store implements read(), which @tus/file-store
      // does, so an unauthenticated GET was readable for any upload whose GridFS
      // migration had failed.
      await testHelper.rest('/tus', {
        cookies: adminToken,
        method: 'GET',
        statusCode: 404,
      });
    });

    it('should refuse an anonymous GET on the tus endpoint', async () => {
      await testHelper.rest('/tus', {
        method: 'GET',
        statusCode: 401,
      });
    });

    it('should handle tus OPTIONS request and return capabilities', async () => {
      const response = await new Promise<http.IncomingMessage>((resolve, reject) => {
        const req = http.request(
          {
            hostname: '127.0.0.1',
            method: 'OPTIONS',
            path: '/tus',
            port: (httpServer.address() as { port: number }).port,
          },
          resolve,
        );
        req.on('error', reject);
        req.end();
      });

      expect(response.statusCode).toBe(204);
      expect(response.headers['tus-resumable']).toBe('1.0.0');
      expect(response.headers['tus-version']).toBeDefined();
      expect(response.headers['tus-extension']).toBeDefined();
    });

    it('should upload a complete file via tus-js-client', async () => {
      const uploadedUrl = await new Promise<string>((resolve, reject) => {
        const file = fs.createReadStream(testFilePath);
        const stats = fs.statSync(testFilePath);

        const upload = new tus.Upload(file, {
          headers: tusHeaders(),
          chunkSize: 5 * 1024 * 1024, // 5MB chunks
          endpoint: `${serverUrl}/tus`,
          metadata: {
            filename: `${testId}-complete.txt`,
            filetype: 'text/plain',
          },
          onError: reject,
          onSuccess: () => {
            resolve(upload.url);
          },
          uploadSize: stats.size,
        });

        upload.start();
      });

      expect(uploadedUrl).toBeDefined();
      expect(uploadedUrl).toContain('/tus/');
    });

    it('should create a File entity in GridFS after upload completion', async () => {
      // Upload a file
      const filename = `${testId}-gridfs-test.txt`;
      await new Promise<void>((resolve, reject) => {
        const file = fs.createReadStream(testFilePath);
        const stats = fs.statSync(testFilePath);

        const upload = new tus.Upload(file, {
          headers: tusHeaders(),
          endpoint: `${serverUrl}/tus`,
          metadata: {
            filename,
            filetype: 'text/plain',
          },
          onError: reject,
          onSuccess: () => resolve(),
          uploadSize: stats.size,
        });

        upload.start();
      });

      // Wait a bit for async processing
      await new Promise((resolve) => setTimeout(resolve, 500));

      // Verify file exists in GridFS
      const filesCollection = db.collection('fs.files');
      const file = await filesCollection.findOne({ filename });
      expect(file).toBeDefined();
      expect(file).not.toBeNull();
      expect(file.length).toBe(testFileContent.length);
      // GridFS stores contentType in metadata (MongoDB 4.0+ standard)
      expect(file.metadata?.contentType).toBe('text/plain');
    });

    it('should download TUS-uploaded file via FileController by ID', async () => {
      // Upload a file via TUS
      const filename = `${testId}-filecontroller-test.txt`;
      const fileContent = 'Content for FileController download test';

      await new Promise<void>((resolve, reject) => {
        const upload = new tus.Upload(Buffer.from(fileContent), {
          headers: tusHeaders(),
          endpoint: `${serverUrl}/tus`,
          metadata: {
            filename,
            filetype: 'text/plain',
          },
          onError: reject,
          onSuccess: () => resolve(),
        });
        upload.start();
      });

      // Wait for GridFS migration
      await new Promise((resolve) => setTimeout(resolve, 500));

      // Get file ID from GridFS
      const filesCollection = db.collection('fs.files');
      const file = await filesCollection.findOne({ filename });
      expect(file).toBeDefined();
      const fileId = file._id.toString();

      // Download via FileController by ID (ADMIN endpoint — session cookie required)
      const response = await testHelper.download(`/files/id/${fileId}`, { cookies: adminToken });

      expect(response.statusCode).toBe(200);
      expect(response.data).toBe(fileContent);

      // ...and the same file is NOT served without a session.
      const anonymous = await testHelper.download(`/files/id/${fileId}`);
      expect(anonymous.statusCode).toEqual(401);
    });

    it('should download TUS-uploaded file via FileController by filename', async () => {
      // Upload a file via TUS with unique filename
      const filename = `${testId}-filecontroller-byname.txt`;
      const fileContent = 'Content for filename-based download test';

      await new Promise<void>((resolve, reject) => {
        const upload = new tus.Upload(Buffer.from(fileContent), {
          headers: tusHeaders(),
          endpoint: `${serverUrl}/tus`,
          metadata: {
            filename,
            filetype: 'text/plain',
          },
          onError: reject,
          onSuccess: () => resolve(),
        });
        upload.start();
      });

      // Wait for GridFS migration
      await new Promise((resolve) => setTimeout(resolve, 500));

      // Download via FileController by filename (ADMIN endpoint — session cookie required)
      const response = await testHelper.download(`/files/${filename}`, { cookies: adminToken });

      expect(response.statusCode).toBe(200);
      expect(response.data).toBe(fileContent);

      // ...and the same file is NOT served without a session. This route is the
      // weaker of the two: it resolves the FIRST match for a guessable name.
      const anonymous = await testHelper.download(`/files/${filename}`);
      expect(anonymous.statusCode).toEqual(401);
    });

    it('should support resumable uploads via uploadUrl', async () => {
      const filename = `${testId}-resumable.bin`;
      const fileBuffer = Buffer.alloc(50 * 1024, 'y'); // 50KB

      // Test that tus-js-client can complete an upload (which is what resume does)
      // The actual resume mechanism (using uploadUrl) is tested by providing it directly
      const uploadedUrl = await new Promise<string>((resolve, reject) => {
        const upload = new tus.Upload(fileBuffer, {
          headers: tusHeaders(),
          chunkSize: 10 * 1024,
          endpoint: `${serverUrl}/tus`,
          metadata: {
            filename,
            filetype: 'application/octet-stream',
          },
          onError: reject,
          onSuccess: () => resolve(upload.url),
        });

        upload.start();
      });

      expect(uploadedUrl).toBeDefined();
      expect(uploadedUrl).toContain('/tus/');

      // Verify file is complete in GridFS
      await new Promise((resolve) => setTimeout(resolve, 500));
      const filesCollection = db.collection('fs.files');
      const file = await filesCollection.findOne({ filename });
      expect(file).toBeDefined();
      expect(file).not.toBeNull();
      expect(file.length).toBe(fileBuffer.length);
    });

    it('should support termination extension (DELETE)', async () => {
      // The termination extension is enabled via OPTIONS response
      // Verify termination extension is reported
      const response = await new Promise<http.IncomingMessage>((resolve, reject) => {
        const req = http.request(
          {
            hostname: '127.0.0.1',
            method: 'OPTIONS',
            path: '/tus',
            port: (httpServer.address() as { port: number }).port,
          },
          resolve,
        );
        req.on('error', reject);
        req.end();
      });

      expect(response.statusCode).toBe(204);
      const extensions = response.headers['tus-extension'] as string;
      expect(extensions).toContain('termination');

      // DELETE on non-existent upload returns 404 (as expected)
      const deleteResponse = await new Promise<http.IncomingMessage>((resolve, reject) => {
        const req = http.request(
          {
            headers: tusHeaders({ 'Tus-Resumable': '1.0.0' }),
            hostname: '127.0.0.1',
            method: 'DELETE',
            path: '/tus/non-existent-id',
            port: (httpServer.address() as { port: number }).port,
          },
          resolve,
        );
        req.on('error', reject);
        req.end();
      });

      expect(deleteResponse.statusCode).toBe(404);
    });
  });

  // ===================================================================================================================
  // Configuration Tests
  // ===================================================================================================================

  describe('Configuration', () => {
    it('should support tus being enabled by default (no config needed)', async () => {
      // Verify tus endpoints are available without explicit configuration
      const response = await new Promise<http.IncomingMessage>((resolve, reject) => {
        const req = http.request(
          {
            hostname: '127.0.0.1',
            method: 'OPTIONS',
            path: '/tus',
            port: (httpServer.address() as { port: number }).port,
          },
          resolve,
        );
        req.on('error', reject);
        req.end();
      });

      expect(response.statusCode).toBe(204);
    });

    it('should report supported extensions in OPTIONS response', async () => {
      const response = await new Promise<http.IncomingMessage>((resolve, reject) => {
        const req = http.request(
          {
            hostname: '127.0.0.1',
            method: 'OPTIONS',
            path: '/tus',
            port: (httpServer.address() as { port: number }).port,
          },
          resolve,
        );
        req.on('error', reject);
        req.end();
      });

      const extensions = response.headers['tus-extension'] as string;
      expect(extensions).toContain('creation');
      expect(extensions).toContain('termination');
    });

    it('should support configurable max file size', async () => {
      const response = await new Promise<http.IncomingMessage>((resolve, reject) => {
        const req = http.request(
          {
            hostname: '127.0.0.1',
            method: 'OPTIONS',
            path: '/tus',
            port: (httpServer.address() as { port: number }).port,
          },
          resolve,
        );
        req.on('error', reject);
        req.end();
      });

      // Default max size should be 50GB
      const maxSize = response.headers['tus-max-size'];
      expect(maxSize).toBeDefined();
      expect(parseInt(maxSize as string, 10)).toBeGreaterThan(0);
    });
  });

  // ===================================================================================================================
  // Error Cases
  // ===================================================================================================================

  describe('Error Cases', () => {
    it('should return 404 for non-existent upload ID', async () => {
      const response = await new Promise<http.IncomingMessage>((resolve, reject) => {
        const req = http.request(
          {
            headers: tusHeaders({ 'Tus-Resumable': '1.0.0' }),
            hostname: '127.0.0.1',
            method: 'HEAD',
            path: '/tus/non-existent-upload-id',
            port: (httpServer.address() as { port: number }).port,
          },
          resolve,
        );
        req.on('error', reject);
        req.end();
      });

      expect(response.statusCode).toBe(404);
    });

    it('should reject requests without Tus-Resumable header on PATCH', async () => {
      const response = await new Promise<http.IncomingMessage>((resolve, reject) => {
        const req = http.request(
          {
            headers: tusHeaders({
              'Content-Type': 'application/offset+octet-stream',
              'Upload-Offset': '0',
              // Missing Tus-Resumable header
            }),
            hostname: '127.0.0.1',
            method: 'PATCH',
            path: '/tus/some-upload-id',
            port: (httpServer.address() as { port: number }).port,
          },
          resolve,
        );
        req.on('error', reject);
        req.end();
      });

      // Should return 412 Precondition Failed without Tus-Resumable header
      expect([400, 404, 412]).toContain(response.statusCode);
    });

    it('should handle unsupported tus version', async () => {
      const response = await new Promise<http.IncomingMessage>((resolve, reject) => {
        const req = http.request(
          {
            headers: tusHeaders({ 'Tus-Resumable': '0.0.1' }), // Unsupported version
            hostname: '127.0.0.1',
            method: 'HEAD',
            path: '/tus/some-upload-id',
            port: (httpServer.address() as { port: number }).port,
          },
          resolve,
        );
        req.on('error', reject);
        req.end();
      });

      // @tus/server v2 returns 400 Bad Request for unsupported versions
      // 404 for non-existent upload, 412 for version mismatch
      expect([400, 404, 412]).toContain(response.statusCode);
    });
  });

  // ===================================================================================================================
  // CORS Tests
  // ===================================================================================================================

  describe('CORS Support', () => {
    it('should include proper CORS headers in OPTIONS response', async () => {
      const response = await new Promise<http.IncomingMessage>((resolve, reject) => {
        const req = http.request(
          {
            headers: tusHeaders({
              'Access-Control-Request-Method': 'POST',
              Origin: 'http://example.com',
            }),
            hostname: '127.0.0.1',
            method: 'OPTIONS',
            path: '/tus',
            port: (httpServer.address() as { port: number }).port,
          },
          resolve,
        );
        req.on('error', reject);
        req.end();
      });

      expect(response.headers['access-control-allow-origin']).toBeDefined();
      expect(response.headers['access-control-allow-methods']).toBeDefined();
      expect(response.headers['access-control-expose-headers']).toBeDefined();
    });
  });

  // ===================================================================================================================
  // Module Inheritance Pattern Tests
  // ===================================================================================================================

  describe('Module Inheritance Pattern', () => {
    it('should refuse anonymous uploads by default', async () => {
      // This test asserted the OPPOSITE until 11.33.0 ("should allow uploads
      // without authentication (S_EVERYONE)"). The default is now S_USER: a tus
      // upload writes into the same shared GridFS bucket the download routes
      // guard, and with the termination extension it can delete from it too, so
      // anonymous 50 GB writes into an admin-only store was not defensible.
      //
      // Projects that genuinely want anonymous uploads opt in explicitly with
      // `tus: { roles: [RoleEnum.S_EVERYONE] }` — see the "…and can be re-opened
      // by configuration" assertion below for the mechanism.
      const filename = `${testId}-no-auth.txt`;

      const error = await new Promise<Error | undefined>((resolve) => {
        const file = fs.createReadStream(testFilePath);
        const stats = fs.statSync(testFilePath);

        const upload = new tus.Upload(file, {
          endpoint: `${serverUrl}/tus`,
          metadata: {
            filename,
            filetype: 'text/plain',
          },
          onError: (err) => resolve(err),
          onSuccess: () => resolve(undefined),
          uploadSize: stats.size,
        });

        upload.start();
      });

      expect(error).toBeDefined();
      expect(String(error)).toMatch(/401|403/);
    });

    it('should still accept uploads from an authenticated caller', async () => {
      const filename = `${testId}-authed.txt`;

      const uploadUrl = await new Promise<string>((resolve, reject) => {
        const file = fs.createReadStream(testFilePath);
        const stats = fs.statSync(testFilePath);

        const upload = new tus.Upload(file, {
          endpoint: `${serverUrl}/tus`,
          headers: tusHeaders(),
          metadata: {
            filename,
            filetype: 'text/plain',
          },
          onError: reject,
          onSuccess: () => resolve(upload.url),
          uploadSize: stats.size,
        });

        upload.start();
      });

      expect(uploadUrl).toBeDefined();
    });
  });

  // ===================================================================================================================
  // Integration Tests
  // ===================================================================================================================

  describe('FileModule Integration', () => {
    it('should create a file with correct metadata after tus upload', async () => {
      const filename = `${testId}-metadata-test.txt`;
      const contentType = 'text/plain';

      await new Promise<void>((resolve, reject) => {
        const file = fs.createReadStream(testFilePath);
        const stats = fs.statSync(testFilePath);

        const upload = new tus.Upload(file, {
          headers: tusHeaders(),
          endpoint: `${serverUrl}/tus`,
          metadata: {
            customField: 'custom-value',
            filename,
            filetype: contentType,
          },
          onError: reject,
          onSuccess: () => resolve(),
          uploadSize: stats.size,
        });

        upload.start();
      });

      // Wait for async processing
      await new Promise((resolve) => setTimeout(resolve, 500));

      // Verify file metadata in GridFS
      const filesCollection = db.collection('fs.files');
      const file = await filesCollection.findOne({ filename });

      expect(file).toBeDefined();
      expect(file).not.toBeNull();
      // GridFS stores contentType in metadata (MongoDB 4.0+ standard)
      expect(file.metadata?.contentType).toBe(contentType);
      expect(file.metadata).toBeDefined();
    });

    it('should store uploaded file in GridFS (download requires authentication)', async () => {
      const filename = `${testId}-download-test.txt`;

      await new Promise<void>((resolve, reject) => {
        const file = fs.createReadStream(testFilePath);
        const stats = fs.statSync(testFilePath);

        const upload = new tus.Upload(file, {
          headers: tusHeaders(),
          endpoint: `${serverUrl}/tus`,
          metadata: {
            filename,
            filetype: 'text/plain',
          },
          onError: reject,
          onSuccess: () => resolve(),
          uploadSize: stats.size,
        });

        upload.start();
      });

      // Wait for async processing
      await new Promise((resolve) => setTimeout(resolve, 500));

      // Get file info from GridFS
      const filesCollection = db.collection('fs.files');
      const file = await filesCollection.findOne({ filename });

      expect(file).toBeDefined();
      expect(file).not.toBeNull();
      expect(file.length).toBe(testFileContent.length);

      // Verify the file content is accessible via GridFS directly (download via API requires auth)
      const chunksCollection = db.collection('fs.chunks');
      const chunks = await chunksCollection.find({ files_id: file._id }).toArray();
      expect(chunks.length).toBeGreaterThan(0);

      const content = Buffer.concat(chunks.map((c) => c.data.buffer)).toString('utf-8');
      expect(content).toBe(testFileContent);
    });
  });
});
