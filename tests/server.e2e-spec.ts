import { Test, TestingModule } from '@nestjs/testing';
import { PubSub } from 'graphql-subscriptions';
import { MongoClient, ObjectId } from 'mongodb';

import { ComparisonOperatorEnum, ConfigService, HttpExceptionLogFilter, TestGraphQLType, TestHelper } from '../src';
import envConfig from '../src/config.env';
import { getPlain } from '../src/core/common/helpers/input.helper';
import { UserCreateInput } from '../src/server/modules/user/inputs/user-create.input';
import { User } from '../src/server/modules/user/user.model';
import { UserService } from '../src/server/modules/user/user.service';
import { ServerModule } from '../src/server/server.module';

describe('ServerModule (e2e)', () => {
  // To enable debugging, include these flags in the options of the request you want to debug
  const log = true; // eslint-disable-line unused-imports/no-unused-vars
  const logError = true; // eslint-disable-line unused-imports/no-unused-vars

  // Test environment properties
  const port = 3030;
  let app;
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
      testHelper = new TestHelper(app, `ws://127.0.0.1:${port}/graphql`);
      userService = moduleFixture.get(UserService);
      configService = moduleFixture.get(ConfigService);
      oTempTokenPeriod = envConfig.jwt.sameTokenIdPeriod;
      await app.listen(port, '127.0.0.1'); // app.listen is required by subscriptions

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
    expect(res.errors[0].message).toEqual('No user found with email: ' + `invalid${gEmail}`);
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
      fields: ['token', 'refreshToken', { user: ['id', 'email'] }],
      name: 'signIn',
      type: TestGraphQLType.MUTATION,
    });
    expect(res.user.id).toEqual(gId);
    expect(res.user.email).toEqual(gEmail);
    expect(res.token.length).toBeGreaterThan(0);
    expect(res.refreshToken.length).toBeGreaterThan(0);
    gToken = res.token;
    gRefreshToken = res.refreshToken;
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
    expect(res.errors[0].extensions.originalError.statusCode).toEqual(401);
    expect(res.errors[0].message).toEqual('Unauthorized');
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
    expect(res.errors[0].extensions.originalError.statusCode).toEqual(401);
    expect(res.errors[0].message).toEqual('Missing role');
    expect(res.data).toBe(null);
  });

  /**
   * Get config without admin rights should fail
   */
  it('get config without admin rights should fail', async () => {
    await testHelper.rest('/config', { statusCode: 401, token: gToken });
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
        fields: ['id', 'email', 'firstName', 'roles'],
        name: 'updateUser',
        type: TestGraphQLType.MUTATION,
      },
      { token: gToken },
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
    expect(res.firstName).toEqual('Jonny');
    expect(res.roles[0]).toEqual('member');
    expect(res.roles.length).toEqual(1);
  });

  /**
   * Logout as user
   */
  it('logout as user', async () => {
    const res: any = await testHelper.rest('/auth/logout?allDevices=true', { log, token: gToken });
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
});
