import { Test, TestingModule } from '@nestjs/testing';
import { MongoClient, ObjectId } from 'mongodb';
import { TestGraphQLType, TestHelper } from '../src';
import envConfig from '../src/config.env';
import { ServerModule } from '../src/server/server.module';

describe('ServerModule (e2e)', () => {
  const port = 3030;
  let app;
  let testHelper: TestHelper;

  // database
  let connection;
  let db;

  // Global vars
  let gId: string;
  let gEmail: string;
  let gPassword: string;
  let gToken: string;

  // ===================================================================================================================
  // Preparations
  // ===================================================================================================================

  /**
   * Before all tests
   */
  beforeAll(async () => {
    try {
      // Start server for testing
      const moduleFixture: TestingModule = await Test.createTestingModule({
        imports: [ServerModule],
      }).compile();
      app = moduleFixture.createNestApplication();
      app.setBaseViewsDir(envConfig.templates.path);
      app.setViewEngine(envConfig.templates.engine);
      await app.init();
      await app.listen(port, '0.0.0.0'); // app.listen is required by subscriptions

      // Init TestHelper
      testHelper = new TestHelper(app, 'ws://localhost:' + port + '/graphql');

      // Get db
      console.info('MongoDB: Create connection to ' + envConfig.mongoose.uri);
      connection = await MongoClient.connect(envConfig.mongoose.uri);
      db = await connection.db();
    } catch (e) {
      console.info('beforeAllError', e);
    }
  });

  /**
   * After all tests are finished
   */
  afterAll(async () => {
    await connection.close();
    await app.close();
  });

  // ===================================================================================================================
  // Tests
  // ===================================================================================================================

  /**
   * Get index
   */
  it('get index', async () => {
    const res: any = await testHelper.rest('');
    expect(res.includes('Welcome to API')).toBe(true);
    expect(res.includes(envConfig.env + ' environment')).toBe(true);
  });

  /**
   * Get config without token should fail
   */
  it('get config without token', async () => {
    await testHelper.rest('/config', { statusCode: 401 });
  });

  /**
   * Sign up new user
   */
  it('signUp', async () => {
    gPassword = Math.random().toString(36).substring(7);
    gEmail = gPassword + '@testuser.com';

    const res: any = await testHelper.graphQl({
      name: 'signUp',
      type: TestGraphQLType.MUTATION,
      arguments: {
        input: {
          email: gEmail,
          password: gPassword,
          firstName: 'Everardo',
        },
      },
      fields: [{ user: ['id', 'email', 'roles', 'createdBy'] }],
    });
    expect(res.user.email).toEqual(gEmail);
    expect(res.user.roles).toEqual([]);
    expect(res.user.createdBy).toEqual(res.user.id);
    gId = res.user.id;
  });

  /**
   * Verify new user
   */
  it('verifyUser', async () => {
    const user = await db.collection('users').findOne({ _id: new ObjectId(gId) });
    const res: any = await testHelper.graphQl({
      arguments: {
        token: user.verificationToken,
      },
      name: 'verifyUser',
      type: TestGraphQLType.MUTATION,
    });
    expect(res).toEqual(true);
  });

  /**
   * Request password reset mail
   */
  it('requestPasswordResetMail with invalid email', async () => {
    const res: any = await testHelper.graphQl({
      arguments: {
        email: 'invalid' + gEmail,
      },
      name: 'requestPasswordResetMail',
    });
    expect(res.errors[0].extensions.response.statusCode).toEqual(404);
    expect(res.errors[0].message).toEqual('No user found with email: ' + 'invalid' + gEmail);
  });

  /**
   * Request password reset mail
   */
  it('requestPasswordResetMail with valid', async () => {
    const res: any = await testHelper.graphQl({
      arguments: {
        email: gEmail,
      },
      name: 'requestPasswordResetMail',
    });
    expect(res).toEqual(true);
  });

  /**
   * Request password reset mail
   */
  it('resetPassword', async () => {
    const user = await db.collection('users').findOne({ _id: new ObjectId(gId) });
    const res: any = await testHelper.graphQl({
      arguments: {
        token: user.passwordResetToken,
        password: 'new' + gPassword,
      },
      name: 'resetPassword',
      type: TestGraphQLType.MUTATION,
    });
    expect(res).toEqual(true);
    gPassword = 'new' + gPassword;
  });

  /**
   * Sign in user
   */
  it('signIn', async () => {
    const res: any = await testHelper.graphQl({
      name: 'signIn',
      arguments: {
        input: {
          email: gEmail,
          password: gPassword,
        },
      },
      fields: ['token', { user: ['id', 'email'] }],
    });
    expect(res.user.id).toEqual(gId);
    expect(res.user.email).toEqual(gEmail);
    gToken = res.token;
  });

  /**
   * Find users without token
   */
  it('findUsers without token', async () => {
    const res: any = await testHelper.graphQl({
      name: 'findUsers',
      fields: ['id', 'email'],
    });
    expect(res.errors.length).toBeGreaterThanOrEqual(1);
    expect(res.errors[0].extensions.response.statusCode).toEqual(401);
    expect(res.errors[0].message).toEqual('Unauthorized');
    expect(res.data).toBe(null);
  });

  /**
   * Find users
   */
  it('findUsers without rights', async () => {
    const res: any = await testHelper.graphQl(
      {
        name: 'findUsers',
        fields: ['id', 'email'],
      },
      { token: gToken }
    );
    expect(res.errors.length).toBeGreaterThanOrEqual(1);
    expect(res.errors[0].extensions.response.statusCode).toEqual(401);
    expect(res.errors[0].message).toEqual('Unauthorized');
    expect(res.data).toBe(null);
  });

  /**
   * Get config without admin rights should fail
   */
  it('get config without admin rights should fail', async () => {
    await testHelper.rest('/config', { token: gToken, statusCode: 401 });
  });

  /**
   * Update user
   */
  it('updateUser', async () => {
    const res: any = await testHelper.graphQl(
      {
        arguments: {
          id: gId,
          input: {
            firstName: 'Jonny',
          },
        },
        name: 'updateUser',
        fields: ['id', 'email', 'firstName', 'roles'],
        type: TestGraphQLType.MUTATION,
      },
      { token: gToken }
    );
    expect(res.id).toEqual(gId);
    expect(res.email).toEqual(gEmail);
    expect(res.firstName).toEqual('Jonny');
    expect(res.roles.length).toEqual(0);
  });

  /**
   * Update roles as non admin
   */
  it('user updates own role failed', async () => {
    const res: any = await testHelper.graphQl(
      {
        arguments: {
          id: gId,
          input: {
            roles: ['member'],
          },
        },
        name: 'updateUser',
        fields: ['id', 'email', 'firstName', 'roles'],
        type: TestGraphQLType.MUTATION,
      },
      { token: gToken }
    );

    expect(res.errors.length).toBeGreaterThanOrEqual(1);
    expect(res.errors[0].extensions.response.statusCode).toEqual(401);
    expect(res.errors[0].message).toEqual('The current user has no access rights for roles');
    expect(res.data).toBe(null);
  });

  /**
   * Get config with token
   */
  it('get config with admin rights', async () => {
    await db.collection('users').findOneAndUpdate({ _id: new ObjectId(gId) }, { $set: { roles: ['admin'] } });
    const res: any = await testHelper.rest('/config', { token: gToken });
    expect(res.env).toEqual(envConfig.env);
  });

  /**
   * Get user
   */
  it('getUser', async () => {
    const res: any = await testHelper.graphQl(
      {
        arguments: {
          id: gId,
        },
        name: 'getUser',
        fields: ['id', 'email', 'firstName', 'roles'],
      },
      { token: gToken }
    );
    expect(res.id).toEqual(gId);
    expect(res.email).toEqual(gEmail);
    expect(res.firstName).toEqual('Jonny');
    expect(res.roles[0]).toEqual('admin');
    expect(res.roles.length).toEqual(1);
  });

  /**
   * Find users
   */
  it('findUsers', async () => {
    const res: any = await testHelper.graphQl(
      {
        name: 'findUsers',
        fields: ['id', 'email'],
      },
      { token: gToken }
    );
    expect(res.length).toBeGreaterThanOrEqual(1);
  });

  /**
   * Subscription
   */
  it('subscription', async () => {
    // Start subscription
    const subscription: any = testHelper.graphQl(
      {
        name: 'userCreated',
        fields: ['id', 'email'],
        type: TestGraphQLType.SUBSCRIPTION,
      },
      { token: gToken, countOfSubscriptionMessages: 1 }
    );

    // Create user
    const passwd = Math.random().toString(36).substring(7);
    const email = passwd + '@testuser.com';
    const create: any = await testHelper.graphQl({
      name: 'signUp',
      type: TestGraphQLType.MUTATION,
      arguments: {
        input: {
          email: email,
          password: passwd,
        },
      },
      fields: [{ user: ['id', 'email'] }],
    });
    expect(create.user.email).toEqual(email);

    // Check subscription result
    const messages = await subscription;
    expect(messages.length).toEqual(1);
    expect(messages[0].email).toEqual(create.user.email);

    // Delete user
    const del: any = await testHelper.graphQl(
      {
        name: 'deleteUser',
        type: TestGraphQLType.MUTATION,
        arguments: {
          id: create.user.id,
        },
        fields: ['id'],
      },
      { token: gToken }
    );
    expect(del.id).toEqual(create.user.id);
  });

  /**
   * Update roles as admin
   */
  it('user updates roles as admin', async () => {
    const res: any = await testHelper.graphQl(
      {
        arguments: {
          id: gId,
          input: {
            roles: ['member'],
          },
        },
        name: 'updateUser',
        fields: ['id', 'email', 'firstName', 'roles'],
        type: TestGraphQLType.MUTATION,
      },
      { token: gToken }
    );
    expect(res.id).toEqual(gId);
    expect(res.email).toEqual(gEmail);
    expect(res.firstName).toEqual('Jonny');
    expect(res.roles[0]).toEqual('member');
    expect(res.roles.length).toEqual(1);
  });

  /**
   * Delete user
   */
  it('deleteUser', async () => {
    const res: any = await testHelper.graphQl(
      {
        name: 'deleteUser',
        type: TestGraphQLType.MUTATION,
        arguments: {
          id: gId,
        },
        fields: ['id'],
      },
      { token: gToken }
    );
    expect(res.id).toEqual(gId);
  });
});
