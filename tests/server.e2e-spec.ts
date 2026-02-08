import { Test, TestingModule } from '@nestjs/testing';
import { PubSub } from 'graphql-subscriptions';
import { MongoClient, ObjectId } from 'mongodb';

import {
  ComparisonOperatorEnum,
  ConfigService,
  getPlain,
  HttpExceptionLogFilter,
  scimToMongo,
  TestGraphQLType,
  TestHelper,
} from '../src';
import envConfig from '../src/config.env';
import { UserCreateInput } from '../src/server/modules/user/inputs/user-create.input';
import { User } from '../src/server/modules/user/user.model';
import { UserService } from '../src/server/modules/user/user.service';
import { ServerModule } from '../src/server/server.module';

describe('ServerModule (e2e)', () => {
  // To enable debugging, include these flags in the options of the request you want to debug
  const _log = true;
  const _logError = true;

  // Test environment properties
  let app;
  let httpServer;
  let testHelper: TestHelper;

  // database
  let connection;
  let db;

  // Services
  let userService: UserService;
  let configService: ConfigService;

  // Original data
  let oTempTokenPeriod: number;

  // Global vars
  let gId: string;
  let gEmail: string;
  let gPassword: string;
  let gToken: string;
  let gRefreshToken: string;
  let gLastRefreshRequestTime: number;
  let gUpdatedTs: number;

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
    try {
      // Start server for testing
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

      // Start HTTP server on dynamic port (required for WebSocket subscriptions)
      httpServer = app.getHttpServer();
      await new Promise<void>((resolve) => {
        httpServer.listen(0, '127.0.0.1', () => resolve());
      });
      const port = httpServer.address().port;

      testHelper = new TestHelper(app, `ws://127.0.0.1:${port}/graphql`);
      userService = moduleFixture.get(UserService);
      configService = moduleFixture.get(ConfigService);
      oTempTokenPeriod = envConfig.jwt.sameTokenIdPeriod;

      // Connection to database
      console.info(`MongoDB: Create connection to ${envConfig.mongoose.uri}`);
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
    await connection.close();
    if (httpServer) {
      await new Promise<void>((resolve) => httpServer.close(() => resolve()));
    }
    await app.close();
  });

  // ===================================================================================================================
  // Tests
  // ===================================================================================================================

  /**
   * Health check
   */
  it('health check', async () => {
    if (envConfig.healthCheck?.enabled) {
      const res: any = await testHelper.rest('/health-check');
      expect(res.status).toBe('ok');
    }
  });

  /**
   * Get Schema
   */
  it('get schema', async () => {
    const res: any = await testHelper.rest('/graphql', {
      headers: {
        'content-type': 'application/json',
        'x-apollo-operation-name': 'IntrospectionQuery',
      },
      method: 'POST',
      payload:
        '{"operationName":"IntrospectionQuery","variables":{},"query":"query IntrospectionQuery {\\n  __schema {\\n    queryType {\\n      name\\n    }\\n    mutationType {\\n      name\\n    }\\n    subscriptionType {\\n      name\\n    }\\n    types {\\n      ...FullType\\n    }\\n    directives {\\n      name\\n      description\\n      locations\\n      args {\\n        ...InputValue\\n      }\\n    }\\n  }\\n}\\n\\nfragment FullType on __Type {\\n  kind\\n  name\\n  description\\n  fields(includeDeprecated: true) {\\n    name\\n    description\\n    args {\\n      ...InputValue\\n    }\\n    type {\\n      ...TypeRef\\n    }\\n    isDeprecated\\n    deprecationReason\\n  }\\n  inputFields {\\n    ...InputValue\\n  }\\n  interfaces {\\n    ...TypeRef\\n  }\\n  enumValues(includeDeprecated: true) {\\n    name\\n    description\\n    isDeprecated\\n    deprecationReason\\n  }\\n  possibleTypes {\\n    ...TypeRef\\n  }\\n}\\n\\nfragment InputValue on __InputValue {\\n  name\\n  description\\n  type {\\n    ...TypeRef\\n  }\\n  defaultValue\\n}\\n\\nfragment TypeRef on __Type {\\n  kind\\n  name\\n  ofType {\\n    kind\\n    name\\n    ofType {\\n      kind\\n      name\\n      ofType {\\n        kind\\n        name\\n        ofType {\\n          kind\\n          name\\n          ofType {\\n            kind\\n            name\\n            ofType {\\n              kind\\n              name\\n              ofType {\\n                kind\\n                name\\n              }\\n            }\\n          }\\n        }\\n      }\\n    }\\n  }\\n}\\n"}',
    });
    expect(res.data.__schema.queryType.name).toEqual('Query');
  });

  /**
   * Get index
   */
  it('get index', async () => {
    const res: any = await testHelper.rest('');
    expect(res.includes('Welcome to API')).toBe(true);
    expect(res.includes(`${envConfig.env} environment`)).toBe(true);
  });

  /**
   * Get config without token should fail
   */
  it('get config without token', async () => {
    await testHelper.rest('/config', { statusCode: 401 });
  });

  /**
   * Sign up new user with existing email
   */
  it('signUpWithExistingEmail', async () => {
    gPassword = Math.random().toString(36).substring(7);
    gEmail = `${gPassword}@testuser.com`;

    const res: any = await testHelper.graphQl({
      arguments: {
        input: {
          email: gEmail,
          firstName: 'Everardo',
          password: gPassword,
        },
      },
      fields: ['token', 'refreshToken', { user: ['id', 'email', 'roles', 'createdBy'] }],
      name: 'signUp',
      type: TestGraphQLType.MUTATION,
    });
    expect(res.user.email).toEqual(gEmail);
    expect(res.user.roles).toEqual([]);
    expect(res.user.createdBy).toEqual(res.user.id);
    gId = res.user.id;
    const res2: any = await testHelper.graphQl({
      arguments: {
        input: {
          email: gEmail,
          firstName: `Everardo${2}`,
          password: gPassword + 2,
        },
      },
      fields: [{ user: ['id', 'email', 'roles', 'createdBy'] }],
      name: 'signUp',
      type: TestGraphQLType.MUTATION,
    });
    expect(res2.errors.length).toBeGreaterThanOrEqual(1);
    expect(res2.errors[0].extensions.originalError.statusCode).toEqual(400);
    expect(res2.errors[0].message).toEqual('Email address already in use');
    expect(res2.data).toBe(null);
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
        email: `invalid${gEmail}`,
      },
      name: 'requestPasswordResetMail',
      type: TestGraphQLType.MUTATION,
    });
    expect(res.errors[0].extensions.originalError.statusCode).toEqual(404);
    expect(res.errors[0].message).toEqual(`No user found with email: invalid${gEmail}`);
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
      type: TestGraphQLType.MUTATION,
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
        password: `new${gPassword}`,
        token: user.passwordResetToken,
      },
      name: 'resetPassword',
      type: TestGraphQLType.MUTATION,
    });
    expect(res).toEqual(true);
    gPassword = `new${gPassword}`;
  });

  /**
   * Sign in user
   */
  it('signIn', async () => {
    const res: any = await testHelper.graphQl({
      arguments: {
        input: {
          email: gEmail,
          password: gPassword,
        },
      },
      fields: ['token', 'refreshToken', { user: ['id', 'email', 'createdAt', 'createdTs', 'updatedAt', 'updatedTs'] }],
      name: 'signIn',
      type: TestGraphQLType.MUTATION,
    });
    expect(res.user.id).toEqual(gId);
    expect(res.user.email).toEqual(gEmail);
    expect(res.token.length).toBeGreaterThan(0);
    expect(res.refreshToken.length).toBeGreaterThan(0);
    expect(res.user.createdAt).toBeDefined();
    expect(new Date(res.user.createdAt).getTime()).toEqual(res.user.createdTs);
    expect(res.user.updatedAt).toBeDefined();
    expect(new Date(res.user.updatedAt).getTime()).toEqual(res.user.updatedTs);
    expect(res.user.updatedTs).toBeGreaterThanOrEqual(res.user.createdTs);
    gToken = res.token;
    gRefreshToken = res.refreshToken;
    gUpdatedTs = res.user.updatedTs;
  });

  /**
   * Try to get refresh token with token
   */
  it('tryToGetRefreshTokenWithToken', async () => {
    const res: any = await testHelper.graphQl(
      {
        fields: ['token', 'refreshToken', { user: ['id', 'email'] }],
        name: 'refreshToken',
        type: TestGraphQLType.MUTATION,
      },
      { token: gToken },
    );
    expect(res.errors.length).toBeGreaterThanOrEqual(1);
    expect(res.errors[0].extensions.originalError.statusCode).toEqual(401);
    expect(res.errors[0].message).toEqual('Invalid token');
    expect(res.data).toBe(null);
  });

  /**
   * Get refresh token with refresh token
   */
  it('getRefreshTokenWithRefreshToken', async () => {
    gLastRefreshRequestTime = Date.now();
    const res: any = await testHelper.graphQl(
      {
        fields: ['token', 'refreshToken', { user: ['id', 'email'] }],
        name: 'refreshToken',
        type: TestGraphQLType.MUTATION,
      },
      { token: gRefreshToken },
    );
    expect(res.user.id).toEqual(gId);
    expect(res.user.email).toEqual(gEmail);
    expect(res.token.length).toBeGreaterThan(0);
    expect(res.refreshToken.length).toBeGreaterThan(0);
    expect(res.token.length).not.toEqual(gToken);
    expect(res.refreshToken.length).not.toEqual(gRefreshToken);
    gToken = res.token;
    gRefreshToken = res.refreshToken;
  });

  /**
   * Get refresh token with refresh token again to check the temporary tokenId
   */
  it('getRefreshTokenWithRefreshTokenAgain', async () => {
    const res: any = await testHelper.graphQl(
      {
        fields: ['token', 'refreshToken', { user: ['id', 'email'] }],
        name: 'refreshToken',
        type: TestGraphQLType.MUTATION,
      },
      { token: gRefreshToken },
    );
    expect(res.user.id).toEqual(gId);
    expect(res.user.email).toEqual(gEmail);
    expect(res.token.length).toBeGreaterThan(0);
    expect(res.refreshToken.length).toBeGreaterThan(0);
    expect(res.token.length).not.toEqual(gToken);
    expect(res.refreshToken.length).not.toEqual(gRefreshToken);
    if (envConfig.jwt.sameTokenIdPeriod) {
      const timeBetween = Date.now() - gLastRefreshRequestTime;
      console.debug(
        `tempToken used | config: ${envConfig.jwt.sameTokenIdPeriod}, timeBetween: ${timeBetween}, rest: ${
          envConfig.jwt.sameTokenIdPeriod - timeBetween
        }`,
      );
      expect(gLastRefreshRequestTime).toBeGreaterThanOrEqual(Date.now() - envConfig.jwt.sameTokenIdPeriod);
      expect(testHelper.parseJwt(res.token).tokenId).toEqual(testHelper.parseJwt(gToken).tokenId);
    } else {
      console.debug('tempToken not used');
      expect(testHelper.parseJwt(res.token).tokenId).not.toEqual(testHelper.parseJwt(gToken).tokenId);
    }
    gToken = res.token;
    gRefreshToken = res.refreshToken;
  });

  /**
   * Get refresh token with refresh token again to check the temporary tokenId with other config
   */
  it('getRefreshTokenWithRefreshTokenOtherConfig', async () => {
    const sameTokenIdPeriod = oTempTokenPeriod ? 0 : 200;
    configService.setProperty('jwt.sameTokenIdPeriod', sameTokenIdPeriod);
    expect(configService.getFastButReadOnly('jwt.sameTokenIdPeriod')).toEqual(sameTokenIdPeriod);
    expect(configService.getFastButReadOnly('jwt.sameTokenIdPeriod')).not.toEqual(oTempTokenPeriod);
    const res: any = await testHelper.graphQl(
      {
        fields: ['token', 'refreshToken', { user: ['id', 'email'] }],
        name: 'refreshToken',
        type: TestGraphQLType.MUTATION,
      },
      { token: gRefreshToken },
    );
    expect(res.user.id).toEqual(gId);
    expect(res.user.email).toEqual(gEmail);
    expect(res.token.length).toBeGreaterThan(0);
    expect(res.refreshToken.length).toBeGreaterThan(0);
    expect(res.token.length).not.toEqual(gToken);
    expect(res.refreshToken.length).not.toEqual(gRefreshToken);
    if (sameTokenIdPeriod) {
      const timeBetween = Date.now() - gLastRefreshRequestTime;
      console.debug(
        `tempToken2 used | config: ${sameTokenIdPeriod}, timeBetween: ${timeBetween}, rest: ${
          sameTokenIdPeriod - timeBetween
        }`,
      );
      expect(testHelper.parseJwt(res.token).tokenId).toEqual(testHelper.parseJwt(gToken).tokenId);
    } else {
      console.debug('tempToken2 not used');
      expect(testHelper.parseJwt(res.token).tokenId).not.toEqual(testHelper.parseJwt(gToken).tokenId);
    }
    configService.setProperty('jwt.sameTokenIdPeriod', oTempTokenPeriod);
    gToken = res.token;
    gRefreshToken = res.refreshToken;
  });

  /**
   * Find users without token
   */
  it('findUsers without token', async () => {
    const res: any = await testHelper.graphQl({
      fields: ['id', 'email'],
      name: 'findUsers',
    });
    expect(res.errors.length).toBeGreaterThanOrEqual(1);
    expect(res.errors[0].message).toMatch(/LTNS_0100/); // Unauthorized error code
    expect(res.data).toBe(null);
  });

  /**
   * Find users
   */
  it('findUsers without rights', async () => {
    const res: any = await testHelper.graphQl(
      {
        fields: ['id', 'email'],
        name: 'findUsers',
      },
      { token: gToken },
    );
    expect(res.errors.length).toBeGreaterThanOrEqual(1);
    expect(res.errors[0].message).toMatch(/LTNS_0101/); // Access denied error code
    expect(res.data).toBe(null);
  });

  /**
   * Get config without admin rights should fail
   */
  it('get config without admin rights should fail', async () => {
    await testHelper.rest('/config', { statusCode: 403, token: gToken });
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
        fields: ['id', 'email', 'firstName', 'roles', 'createdAt', 'createdTs', 'updatedAt', 'updatedBy', 'updatedTs'],
        name: 'updateUser',
        type: TestGraphQLType.MUTATION,
      },
      { token: gToken },
    );
    expect(res.id).toEqual(gId);
    expect(res.email).toEqual(gEmail);
    expect(res.firstName).toEqual('Jonny');
    expect(res.roles.length).toEqual(0);
    expect(res.createdAt).toBeDefined();
    expect(new Date(res.createdAt).getTime()).toEqual(res.createdTs);
    expect(res.updatedBy).toEqual(gId);
    expect(res.updatedAt).toBeDefined();
    expect(new Date(res.updatedAt).getTime()).toEqual(res.updatedTs);
    expect(res.updatedTs).toBeGreaterThan(res.createdTs);
    expect(res.updatedTs).toBeGreaterThan(gUpdatedTs);
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
        fields: ['id', 'email', 'firstName', 'roles'],
        name: 'updateUser',
        type: TestGraphQLType.MUTATION,
      },
      { token: gToken },
    );

    expect(res.errors.length).toBeGreaterThanOrEqual(1);
    expect(res.errors[0].extensions.originalError.statusCode).toEqual(401);
    expect(res.errors[0].message).toEqual('The current user has no access rights for roles of UserInput');
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
        fields: ['id', 'email', 'firstName', 'roles'],
        name: 'getUser',
      },
      { token: gToken },
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
        fields: ['id', 'email'],
        name: 'findUsers',
      },
      { token: gToken },
    );
    expect(res.length).toBeGreaterThanOrEqual(1);
  });

  /**
   * Find user via ID
   */
  it('findUserViaId', async () => {
    const res: any = await testHelper.graphQl(
      {
        arguments: { filter: { singleFilter: { field: 'id', operator: ComparisonOperatorEnum.EQ, value: gId } } },
        fields: ['id', 'email'],
        name: 'findUsers',
      },
      { token: gToken },
    );
    expect(res.length).toBe(1);
    expect(res[0].id).toEqual(gId);
    expect(res[0].email).toEqual(gEmail);
  });

  /**
   * Find sample user
   */
  it('findSampleUser', async () => {
    const res: any = await testHelper.graphQl(
      {
        arguments: { samples: 1 },
        fields: ['id', 'email'],
        name: 'findUsers',
      },
      { token: gToken },
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
        fields: ['id', 'email'],
        name: 'userCreated',
        type: TestGraphQLType.SUBSCRIPTION,
      },
      { countOfSubscriptionMessages: 1, token: gToken },
    );

    // Create user
    const passwd = Math.random().toString(36).substring(7);
    const email = `${passwd}@testuser.com`;
    const create: any = await testHelper.graphQl({
      arguments: {
        input: {
          email,
          password: passwd,
        },
      },
      fields: [{ user: ['id', 'email'] }],
      name: 'signUp',
      type: TestGraphQLType.MUTATION,
    });
    expect(create.user.email).toEqual(email);

    // Check subscription result
    const messages = await subscription;
    expect(messages.length).toEqual(1);
    expect(messages[0].email).toEqual(create.user.email);

    // Delete user
    const del: any = await testHelper.graphQl(
      {
        arguments: {
          id: create.user.id,
        },
        fields: ['id'],
        name: 'deleteUser',
        type: TestGraphQLType.MUTATION,
      },
      { token: gToken },
    );
    expect(del.id).toEqual(create.user.id);
  });

  // ===========================================================================
  // REST API Controller Tests
  // ===========================================================================

  /**
   * REST: Get users without token should fail
   */
  it('REST: findUsers without token should fail', async () => {
    await testHelper.rest('/users', { statusCode: 401 });
  });

  /**
   * REST: Get users without admin rights should fail
   */
  it('REST: findUsers without admin rights should fail', async () => {
    // First create a new non-admin user for this test
    const passwd = Math.random().toString(36).substring(7);
    const email = `${passwd}@resttest.com`;
    const signUpRes: any = await testHelper.graphQl({
      arguments: {
        input: {
          email,
          password: passwd,
        },
      },
      fields: ['token', { user: ['id'] }],
      name: 'signUp',
      type: TestGraphQLType.MUTATION,
    });
    await testHelper.rest('/users', { statusCode: 403, token: signUpRes.token });

    // Clean up
    await testHelper.graphQl(
      {
        arguments: { id: signUpRes.user.id },
        fields: ['id'],
        name: 'deleteUser',
        type: TestGraphQLType.MUTATION,
      },
      { token: gToken },
    );
  });

  /**
   * REST: Get users with admin rights
   */
  it('REST: findUsers with admin rights', async () => {
    const res: any = await testHelper.rest('/users', { token: gToken });
    expect(Array.isArray(res)).toBe(true);
    expect(res.length).toBeGreaterThanOrEqual(1);
  });

  /**
   * REST: Get users with count
   */
  it('REST: findAndCountUsers with admin rights', async () => {
    const res: any = await testHelper.rest('/users/count', { token: gToken });
    expect(res.items).toBeDefined();
    expect(Array.isArray(res.items)).toBe(true);
    expect(res.totalCount).toBeDefined();
    expect(typeof res.totalCount).toBe('number');
    expect(res.totalCount).toBeGreaterThanOrEqual(1);
  });

  /**
   * REST: Get user by ID
   */
  it('REST: getUser by ID', async () => {
    const res: any = await testHelper.rest(`/users/${gId}`, { token: gToken });
    expect(res.id).toEqual(gId);
    expect(res.email).toEqual(gEmail);
  });

  /**
   * REST: Get user by ID without token should fail
   */
  it('REST: getUser by ID without token should fail', async () => {
    await testHelper.rest(`/users/${gId}`, { statusCode: 401 });
  });

  /**
   * REST: Create user
   */
  it('REST: createUser', async () => {
    const passwd = Math.random().toString(36).substring(7);
    const email = `${passwd}@restcreate.com`;
    const res: any = await testHelper.rest('/users', {
      method: 'POST',
      payload: {
        email,
        firstName: 'RestTest',
        password: passwd,
      },
      statusCode: 201,
      token: gToken,
    });
    expect(res.email).toEqual(email);
    expect(res.firstName).toEqual('RestTest');
    expect(res.id).toBeDefined();

    // Clean up
    await testHelper.graphQl(
      {
        arguments: { id: res.id },
        fields: ['id'],
        name: 'deleteUser',
        type: TestGraphQLType.MUTATION,
      },
      { token: gToken },
    );
  });

  /**
   * REST: Create user without admin rights should fail
   */
  it('REST: createUser without admin rights should fail', async () => {
    // First create a non-admin user
    const passwd = Math.random().toString(36).substring(7);
    const email = `${passwd}@resttest2.com`;
    const signUpRes: any = await testHelper.graphQl({
      arguments: {
        input: {
          email,
          password: passwd,
        },
      },
      fields: ['token', { user: ['id'] }],
      name: 'signUp',
      type: TestGraphQLType.MUTATION,
    });

    const passwd2 = Math.random().toString(36).substring(7);
    const email2 = `${passwd2}@restcreate2.com`;
    await testHelper.rest('/users', {
      method: 'POST',
      payload: {
        email: email2,
        password: passwd2,
      },
      statusCode: 403,
      token: signUpRes.token,
    });

    // Clean up
    await testHelper.graphQl(
      {
        arguments: { id: signUpRes.user.id },
        fields: ['id'],
        name: 'deleteUser',
        type: TestGraphQLType.MUTATION,
      },
      { token: gToken },
    );
  });

  /**
   * REST: Update user
   */
  it('REST: updateUser', async () => {
    const res: any = await testHelper.rest(`/users/${gId}`, {
      method: 'PATCH',
      payload: {
        firstName: 'RestUpdated',
      },
      token: gToken,
    });
    expect(res.id).toEqual(gId);
    expect(res.firstName).toEqual('RestUpdated');
  });

  /**
   * REST: Update user without token should fail
   */
  it('REST: updateUser without token should fail', async () => {
    await testHelper.rest(`/users/${gId}`, {
      method: 'PATCH',
      payload: {
        firstName: 'ShouldFail',
      },
      statusCode: 401,
    });
  });

  /**
   * REST: Delete user
   */
  it('REST: deleteUser', async () => {
    // Create user for deletion
    const passwd = Math.random().toString(36).substring(7);
    const email = `${passwd}@restdelete.com`;
    const createRes: any = await testHelper.rest('/users', {
      method: 'POST',
      payload: {
        email,
        password: passwd,
      },
      statusCode: 201,
      token: gToken,
    });

    // Delete user
    const res: any = await testHelper.rest(`/users/${createRes.id}`, {
      method: 'DELETE',
      token: gToken,
    });
    expect(res.id).toEqual(createRes.id);
  });

  /**
   * REST: Delete user without token should fail
   */
  it('REST: deleteUser without token should fail', async () => {
    await testHelper.rest(`/users/${gId}`, {
      method: 'DELETE',
      statusCode: 401,
    });
  });

  /**
   * REST: Request password reset mail
   */
  it('REST: requestPasswordResetMail', async () => {
    const passwd = Math.random().toString(36).substring(7);
    const email = `${passwd}@resettest.com`;

    // Create user
    const createRes: any = await testHelper.rest('/users', {
      method: 'POST',
      payload: {
        email,
        password: passwd,
      },
      statusCode: 201,
      token: gToken,
    });

    // Request password reset
    const res: any = await testHelper.rest('/users/password/reset-request', {
      method: 'POST',
      payload: {
        email,
      },
      statusCode: 201,
    });
    expect(res).toBe(true);

    // Clean up
    await testHelper.graphQl(
      {
        arguments: { id: createRes.id },
        fields: ['id'],
        name: 'deleteUser',
        type: TestGraphQLType.MUTATION,
      },
      { token: gToken },
    );
  });

  /**
   * REST: Reset password with token
   */
  it('REST: resetPassword', async () => {
    const passwd = Math.random().toString(36).substring(7);
    const email = `${passwd}@resetpw.com`;

    // Create user
    const createRes: any = await testHelper.graphQl({
      arguments: {
        input: {
          email,
          password: passwd,
        },
      },
      fields: [{ user: ['id', 'email'] }],
      name: 'signUp',
      type: TestGraphQLType.MUTATION,
    });

    // Request password reset
    await testHelper.rest('/users/password/reset-request', {
      method: 'POST',
      payload: {
        email,
      },
      statusCode: 201,
    });

    // Get token from database
    const user = await db.collection('users').findOne({ _id: new ObjectId(createRes.user.id) });

    // Reset password
    const res: any = await testHelper.rest('/users/password/reset', {
      method: 'POST',
      payload: {
        password: `new${passwd}`,
        token: user.passwordResetToken,
      },
      statusCode: 201,
    });
    expect(res).toBe(true);

    // Clean up
    await testHelper.graphQl(
      {
        arguments: { id: createRes.user.id },
        fields: ['id'],
        name: 'deleteUser',
        type: TestGraphQLType.MUTATION,
      },
      { token: gToken },
    );
  });

  /**
   * REST: Verify user
   */
  it('REST: verifyUser', async () => {
    const passwd = Math.random().toString(36).substring(7);
    const email = `${passwd}@verifytest.com`;

    // Create user
    const createRes: any = await testHelper.graphQl({
      arguments: {
        input: {
          email,
          password: passwd,
        },
      },
      fields: [{ user: ['id', 'email'] }],
      name: 'signUp',
      type: TestGraphQLType.MUTATION,
    });

    // Get token from database
    const user = await db.collection('users').findOne({ _id: new ObjectId(createRes.user.id) });

    // Verify user
    const res: any = await testHelper.rest('/users/verify', {
      method: 'POST',
      payload: {
        token: user.verificationToken,
      },
      statusCode: 201,
    });
    expect(res).toBe(true);

    // Clean up
    await testHelper.graphQl(
      {
        arguments: { id: createRes.user.id },
        fields: ['id'],
        name: 'deleteUser',
        type: TestGraphQLType.MUTATION,
      },
      { token: gToken },
    );
  });

  /**
   * REST: Get verified state
   */
  it('REST: getVerifiedState', async () => {
    const passwd = Math.random().toString(36).substring(7);
    const email = `${passwd}@verifiedstate.com`;

    // Create user
    const createRes: any = await testHelper.graphQl({
      arguments: {
        input: {
          email,
          password: passwd,
        },
      },
      fields: [{ user: ['id', 'email'] }],
      name: 'signUp',
      type: TestGraphQLType.MUTATION,
    });

    // Get token from database
    const user = await db.collection('users').findOne({ _id: new ObjectId(createRes.user.id) });

    // Get verified state (should be null or false before verification)
    const resBefore: any = await testHelper.rest(`/users/verified-state?token=${user.verificationToken}`);
    expect(resBefore).toBeFalsy();

    // Verify user
    await testHelper.graphQl({
      arguments: {
        token: user.verificationToken,
      },
      name: 'verifyUser',
      type: TestGraphQLType.MUTATION,
    });

    // Get verified state (should be true after verification)
    const resAfter: any = await testHelper.rest(`/users/verified-state?token=${user.verificationToken}`);
    expect(resAfter).toBe(true);

    // Clean up
    await testHelper.graphQl(
      {
        arguments: { id: createRes.user.id },
        fields: ['id'],
        name: 'deleteUser',
        type: TestGraphQLType.MUTATION,
      },
      { token: gToken },
    );
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
        fields: ['id', 'email', 'firstName', 'roles'],
        name: 'updateUser',
        type: TestGraphQLType.MUTATION,
      },
      { token: gToken },
    );
    expect(res.id).toEqual(gId);
    expect(res.email).toEqual(gEmail);
    expect(res.firstName).toEqual('RestUpdated');
    expect(res.roles[0]).toEqual('member');
    expect(res.roles.length).toEqual(1);
  });

  /**
   * Logout as user on a specific device
   */
  it('logout as user on one device', async () => {
    const res: any = await testHelper.rest('/auth/logout', { token: gToken });
    expect(res).toBe(true);
  });

  /**
   * Logout as user on all devices
   */
  it('logout as user on all devices', async () => {
    const res: any = await testHelper.rest('/auth/logout?allDevices=true', { token: gToken });
    expect(res).toBe(true);
  });

  /**
   * Delete user
   */
  it('deleteUser', async () => {
    const res: any = await testHelper.graphQl(
      {
        arguments: {
          id: gId,
        },
        fields: ['id'],
        name: 'deleteUser',
        type: TestGraphQLType.MUTATION,
      },
      { token: gToken },
    );
    expect(res.id).toEqual(gId);
  });

  /**
   * Check user service
   */
  it('check user service', async () => {
    const userCount = 2;
    const random = Math.random().toString(36).substring(7);
    const users = [];
    for (let i = 0; i < userCount; i++) {
      const input = {
        email: `${random + i}@testusers.com`,
        firstName: `Test${'0'.repeat(`${userCount}`.length - `${i}`.length)}${i}${random}`,
        lastName: `User${i}${random}`,
        password: random + i,
      };
      users.push(await userService.create(input as UserCreateInput));
    }
    expect(users.length).toBeGreaterThanOrEqual(userCount);

    const findFilter = {
      filterQuery: {
        firstName: { $regex: `^.*${random}$` },
      },
      queryOptions: { sort: { firstName: -1 } },
    };

    // Check users
    const userArray = await userService.find(findFilter);
    const testUser = await userService.get(users[users.length - 1].id);
    expect(userArray.length).toEqual(userCount);
    expect(userArray[0] instanceof User).toEqual(true);
    expect(testUser instanceof User).toEqual(true);
    expect(users[users.length - 1].id).toEqual(testUser.id);
    expect(users[users.length - 1].id).toEqual(userArray[0].id);
    const keys = Object.keys(getPlain(testUser));
    expect(keys.length).toBeGreaterThan(1);
    expect(keys.length).toEqual(Object.keys(getPlain(userArray[0])).length);
    for (const key of Object.keys(getPlain(testUser))) {
      expect(testUser[key]).toEqual(userArray[0][key]);
    }

    // Delete users
    for (const user of users) {
      await userService.delete(user.id);
    }

    // Try to find;
    const found = await userService.find(findFilter);
    expect(Array.isArray(found)).toEqual(true);
    expect(found.length).toEqual(0);
  });

  // ===================================================================================================================
  // SCIM Helper Tests
  // ===================================================================================================================

  describe('SCIM Helper', () => {
    describe('scimToMongo', () => {
      // Basic condition tests
      describe('Basic conditions', () => {
        it('should handle equals (eq) condition', () => {
          const result = scimToMongo('userName eq "Joe"');
          expect(result).toEqual({ userName: { $eq: 'Joe' } });
        });

        it('should properly parse number values', () => {
          const result = scimToMongo('age gt 25');
          expect(result).toEqual({ age: { $gt: 25 } });
        });

        it('should properly parse bool values', () => {
          const result = scimToMongo('bald eq true');
          expect(result).toEqual({ bald: { $eq: true } });
        });

        it('should handle contains (co) condition', () => {
          const result = scimToMongo('userName co "test"');
          expect(result).toEqual({ userName: { $options: 'i', $regex: 'test' } });
        });

        it('should handle starts with (sw) condition', () => {
          const result = scimToMongo('userName sw "John"');
          expect(result).toEqual({ userName: { $options: 'i', $regex: '^John' } });
        });

        it('should handle ends with (ew) condition', () => {
          const result = scimToMongo('userName ew "Smith"');
          expect(result).toEqual({ userName: { $options: 'i', $regex: 'Smith$' } });
        });

        it('should handle greater than (gt) condition', () => {
          const result = scimToMongo('age gt "25"');
          expect(result).toEqual({ age: { $gt: '25' } });
        });

        it('should handle greater than or equal (ge) condition', () => {
          const result = scimToMongo('age ge "18"');
          expect(result).toEqual({ age: { $gte: '18' } });
        });

        it('should handle less than (lt) condition', () => {
          const result = scimToMongo('age lt "65"');
          expect(result).toEqual({ age: { $lt: '65' } });
        });

        it('should handle less than or equal (le) condition', () => {
          const result = scimToMongo('age le "30"');
          expect(result).toEqual({ age: { $lte: '30' } });
        });

        it('should handle present (pr) condition', () => {
          const result = scimToMongo('userName pr');
          expect(result).toEqual({ userName: { $exists: true } });
        });

        it('should handle array contains (aco) condition', () => {
          const result = scimToMongo('roles aco "admin"');
          expect(result).toEqual({ roles: 'admin' });
        });
      });

      // Logical operator tests
      describe('Logical operators', () => {
        it('should handle AND operator', () => {
          const result = scimToMongo('userName eq "Joe" and age gt "25"');
          expect(result).toEqual({
            $and: [{ userName: { $eq: 'Joe' } }, { age: { $gt: '25' } }],
          });
        });

        it('should handle OR operator', () => {
          const result = scimToMongo('userName eq "Joe" or userName eq "Jane"');
          expect(result).toEqual({
            $or: [{ userName: { $eq: 'Joe' } }, { userName: { $eq: 'Jane' } }],
          });
        });

        it('should handle complex logical combinations', () => {
          const result = scimToMongo('userName eq "Joe" and age gt "25" or department eq "IT"');
          expect(result).toEqual({
            $or: [
              {
                $and: [{ userName: { $eq: 'Joe' } }, { age: { $gt: '25' } }],
              },
              { department: { $eq: 'IT' } },
            ],
          });
        });

        it('should handle case insensitive logical operators', () => {
          const result = scimToMongo('userName eq "Joe" AND age gt "25"');
          expect(result).toEqual({
            $and: [{ userName: { $eq: 'Joe' } }, { age: { $gt: '25' } }],
          });
        });
      });

      // Parentheses and grouping tests
      describe('Parentheses and grouping', () => {
        it('should handle parentheses for grouping', () => {
          const result = scimToMongo('(userName eq "Joe" or userName eq "Jane") and age gt "25"');
          expect(result).toEqual({
            $and: [
              {
                $or: [{ userName: { $eq: 'Joe' } }, { userName: { $eq: 'Jane' } }],
              },
              { age: { $gt: '25' } },
            ],
          });
        });

        it('should handle nested parentheses', () => {
          const result = scimToMongo(
            '((userName eq "Joe" or userName eq "Jane") and age gt "25") or department eq "IT"',
          );
          expect(result).toEqual({
            $or: [
              {
                $and: [
                  {
                    $or: [{ userName: { $eq: 'Joe' } }, { userName: { $eq: 'Jane' } }],
                  },
                  { age: { $gt: '25' } },
                ],
              },
              { department: { $eq: 'IT' } },
            ],
          });
        });
      });

      // Array filter tests
      describe('Array filters', () => {
        it('should handle simple array filter', () => {
          const result = scimToMongo('emails[type eq "work"]');
          expect(result).toEqual({
            emails: {
              $elemMatch: { type: { $eq: 'work' } },
            },
          });
        });

        it('should handle array filter with logical operators', () => {
          const result = scimToMongo('emails[type eq "work" and primary eq "true"]');
          expect(result).toEqual({
            emails: {
              $elemMatch: {
                $and: [{ type: { $eq: 'work' } }, { primary: { $eq: 'true' } }],
              },
            },
          });
        });

        it('should handle array filter combined with other conditions', () => {
          const result = scimToMongo('emails[type eq "work"] and userName eq "Joe"');
          expect(result).toEqual({
            $and: [
              {
                emails: {
                  $elemMatch: { type: { $eq: 'work' } },
                },
              },
              { userName: { $eq: 'Joe' } },
            ],
          });
        });
      });

      // Special character handling
      describe('Special character handling', () => {
        it('should escape regex characters in contains operations', () => {
          const result = scimToMongo('userName co "test.user+regex"');
          expect(result).toEqual({
            userName: {
              $options: 'i',
              $regex: 'test\\.user\\+regex',
            },
          });
        });

        it('should escape regex characters in starts with operations', () => {
          const result = scimToMongo('userName sw "user[0-9]"');
          expect(result).toEqual({
            userName: {
              $options: 'i',
              $regex: '^user\\[0-9\\]',
            },
          });
        });

        it('should escape regex characters in ends with operations', () => {
          const result = scimToMongo('userName ew "user*"');
          expect(result).toEqual({
            userName: {
              $options: 'i',
              $regex: 'user\\*$',
            },
          });
        });
      });

      // Edge cases and error handling
      describe('Edge cases and error handling', () => {
        it('should handle quoted values correctly', () => {
          const result = scimToMongo('userName eq "John Doe"');
          expect(result).toEqual({ userName: { $eq: 'John Doe' } });
        });

        it('should handle unquoted values', () => {
          const result = scimToMongo('active eq true');
          expect(result).toEqual({ active: { $eq: true } });
        });

        it('should throw error for unsupported comparator', () => {
          expect(() => scimToMongo('userName xx "test"')).toThrow('Unsupported comparator: xx');
        });

        it('should throw error for mismatched parentheses', () => {
          expect(() => scimToMongo('(userName eq "test"')).toThrow("Expected ')' at position");
        });

        it('should throw error for mismatched brackets', () => {
          expect(() => scimToMongo('emails[type eq "work"')).toThrow("Expected ']' at position");
        });

        it('should handle empty input', () => {
          const result = scimToMongo('');
          expect(result).toEqual({});
        });
      });

      // Complex real-world scenarios
      describe('Complex real-world scenarios', () => {
        it('should handle complex user filtering scenario', () => {
          const result = scimToMongo(
            'userName sw "john" and (emails[type eq "work"] or emails[type eq "personal"]) and active eq "true"',
          );

          expect(result).toEqual({
            $and: [
              { userName: { $options: 'i', $regex: '^john' } },
              {
                $or: [
                  { emails: { $elemMatch: { type: { $eq: 'work' } } } },
                  { emails: { $elemMatch: { type: { $eq: 'personal' } } } },
                ],
              },
              { active: { $eq: 'true' } },
            ],
          });
        });

        it('should handle dotted attribute paths', () => {
          const result = scimToMongo('name.givenName eq "John"');
          expect(result).toEqual({ 'name.givenName': { $eq: 'John' } });
        });

        it('should handle numeric-like strings in attribute paths', () => {
          const result = scimToMongo('user123.name eq "test"');
          expect(result).toEqual({ 'user123.name': { $eq: 'test' } });
        });
      });
    });
  });
});
