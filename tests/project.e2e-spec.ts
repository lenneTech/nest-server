import { DECORATORS } from '@nestjs/swagger/dist/constants';
import { Test, TestingModule } from '@nestjs/testing';
import { PubSub } from 'graphql-subscriptions';
import { MongoClient, ObjectId } from 'mongodb';

import {
  ComparisonOperatorEnum,
  CoreAuthSignInInput,
  HttpExceptionLogFilter,
  RoleEnum,
  SortOrderEnum,
  TestGraphQLType,
  TestHelper,
} from '../src';
import envConfig from '../src/config.env';
import { User } from '../src/server/modules/user/user.model';
import { UserService } from '../src/server/modules/user/user.service';
import { ServerModule } from '../src/server/server.module';

describe('Project (e2e)', () => {
  // To enable debugging, include these flags in the options of the request you want to debug
  const log = true; // eslint-disable-line unused-imports/no-unused-vars
  const logError = true; // eslint-disable-line unused-imports/no-unused-vars

  // Test environment properties
  let app;
  let testHelper: TestHelper;

  // database
  let connection;
  let db;

  // Global vars
  let userService: UserService;
  const users: Partial<User & { token: string }>[] = [];

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
    const userCount = 5;
    const random = Math.random().toString(36).substring(7);
    for (let i = 0; i < userCount; i++) {
      const input = {
        email: `${random + i}@testusers.com`,
        firstName: `Test${'0'.repeat(`${userCount}`.length - `${i}`.length)}${i}${random}`,
        lastName: `User${i}${random}`,
        password: random + i,
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

      // Verify user
      await db.collection('users').updateOne({ _id: new ObjectId(res.id) }, { $set: { verified: true } });
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

  it('updateUser', async () => {
    const res: any = await testHelper.graphQl(
      {
        arguments: {
          id: users[0].id,
          input: {
            jobTitle: 'Entwickler',
          },
        },
        fields: ['id', 'jobTitle'],
        name: 'updateUser',
        type: TestGraphQLType.MUTATION,
      },
      { language: 'de', token: users[0].token },
    );

    expect(res.id).toEqual(users[0].id);
    expect(res.jobTitle).toEqual('Entwickler');
  });

  it('set translation of jobTitle', async () => {
    const res: any = await testHelper.graphQl(
      {
        arguments: {
          id: users[0].id,
          input: {
            jobTitle: 'Developer',
          },
        },
        fields: ['id', 'jobTitle'],
        name: 'updateUser',
        type: TestGraphQLType.MUTATION,
      },
      { language: 'en', log: true, token: users[0].token },
    );

    expect(res.id).toEqual(users[0].id);
    expect(res.jobTitle).toEqual('Developer');
  });

  it('get default of jobTitle', async () => {
    const res: any = await testHelper.graphQl(
      {
        arguments: {
          id: users[0].id,
        },
        fields: ['id', 'jobTitle'],
        name: 'getUser',
        type: TestGraphQLType.QUERY,
      },
      { language: 'de', token: users[0].token },
    );

    expect(res.id).toEqual(users[0].id);
    expect(res.jobTitle).toEqual('Entwickler');
  });

  it('get translation of jobTitle', async () => {
    const res: any = await testHelper.graphQl(
      {
        arguments: {
          id: users[0].id,
        },
        fields: ['id', 'jobTitle'],
        name: 'getUser',
        type: TestGraphQLType.QUERY,
      },
      { language: 'en', token: users[0].token },
    );

    expect(res.id).toEqual(users[0].id);
    expect(res.jobTitle).toEqual('Developer');
  });

  it('get fallback for jobTitle if there is no translation', async () => {
    const res: any = await testHelper.graphQl(
      {
        arguments: {
          id: users[0].id,
        },
        fields: ['id', 'jobTitle'],
        name: 'getUser',
        type: TestGraphQLType.QUERY,
      },
      { language: 'fr', token: users[0].token },
    );

    expect(res.id).toEqual(users[0].id);
    expect(res.jobTitle).toEqual('Entwickler');
  });

  /**
   * Find and count users
   */
  it('findAndCountUsers', async () => {
    const emails = users.map(user => user.email);
    emails.pop();
    const args = {
      filter: {
        singleFilter: {
          field: 'email',
          operator: ComparisonOperatorEnum.IN,
          value: emails,
        },
      },
      limit: 2,
      skip: 1,
      sort: [{ field: 'firstName', order: SortOrderEnum.DESC }],
    };
    const res: any = await testHelper.graphQl(
      {
        arguments: { ...args },
        fields: [{ items: ['id', 'email', 'firstName', 'lastName'] }, 'totalCount'],
        name: 'findAndCountUsers',
        type: TestGraphQLType.QUERY,
      },
      { token: users[0].token },
    );
    const min = Math.min(args.limit, emails.length - args.skip);
    expect(res.totalCount).toEqual(emails.length);
    expect(res.items.length).toEqual(min);
    for (let i = 0; i < min; i++) {
      const resPos = emails.length - 1 - args.skip - i;
      const curPos = i;
      expect(res.items[curPos].id).toEqual(users[resPos].id);
      expect(res.items[curPos].email).toEqual(users[resPos].email);
      expect(emails.includes(res.items[curPos].email)).toBe(true);
      expect(res.items[curPos].firstName).toEqual(users[resPos].firstName);
      expect(res.items[curPos].lastName).toEqual(users[resPos].lastName);
    }
  });

  /**
   * Get sample user
   */
  it('getSampleUser', async () => {
    const emails = users.map(user => user.email);
    const args = {
      filter: {
        singleFilter: {
          field: 'email',
          operator: ComparisonOperatorEnum.IN,
          value: emails,
        },
      },
      limit: 2,
      samples: 1,
      sort: [{ field: 'email', order: SortOrderEnum.DESC }],
    };
    const res: any = await testHelper.graphQl(
      {
        arguments: { ...args },
        fields: ['id', 'email', 'firstName', 'lastName'],
        name: 'findUsers',
        type: TestGraphQLType.QUERY,
      },
      { token: users[0].token },
    );
    expect(res.length).toEqual(1);
    expect(emails.includes(res[0].email)).toBe(true);
    const email = res[0].email;
    let otherEmail = res[0].email;
    while (email === otherEmail) {
      const otherRes: any = await testHelper.graphQl(
        {
          arguments: { ...args },
          fields: ['id', 'email', 'firstName', 'lastName'],
          name: 'findUsers',
          type: TestGraphQLType.QUERY,
        },
        { token: users[0].token },
      );
      expect(otherRes.length).toEqual(1);
      expect(emails.includes(otherRes[0].email)).toBe(true);
      otherEmail = otherRes[0].email;
    }
  });

  /**
   * Test if swagger error-structure mirrors the actual error structure
   */
  it('Try sign in without input', async () => {
    const res: any = await testHelper.rest('/auth/signin', { method: 'POST', statusCode: 400 });
    expect(res).toMatchObject({
      message: 'Missing input',
      name: 'BadRequestException',
      response: {
        error: 'Bad Request',
        message: 'Missing input',
        statusCode: 400,
      },
      status: 400,
    });
  });

  /**
   * Test if swagger error-structure mirrors the actual error structure
   */
  it('Validates common-error structure', async () => {
    const res: any = await testHelper.rest('/auth/signin', { method: 'POST', payload: {}, statusCode: 400 });

    // Test for generic object equality
    expect(res).toMatchObject({
      message: expect.any(String),
      name: expect.any(String),
      options: expect.any(Object),
      response: {
        email: {
          isEmail: expect.any(String),
          isNotEmpty: expect.any(String),
        },
        password: {
          isNotEmpty: expect.any(String),
          isString: expect.any(String),
        },
      },
      status: expect.any(Number),
    });

    // Test for concrete values
    expect(res).toMatchObject({
      message: 'Bad Request Exception',
      name: 'BadRequestException',
      options: {},
      response: {
        email: {
          isEmail: 'email must be an email',
          isNotEmpty: 'email should not be empty',
        },
        password: {
          isNotEmpty: 'password should not be empty',
          isString: 'password must be a string',
        },
      },
      status: 400,
    });
  });

  it('Check unified-field decorator metadata', () => {
    const gqlMetaData = Reflect.getMetadata('graphql:class_type', CoreAuthSignInInput);
    const swaggerKeys = Reflect.getMetadata(DECORATORS.API_MODEL_PROPERTIES_ARRAY, CoreAuthSignInInput.prototype);

    expect(gqlMetaData).toBeDefined();
    expect(swaggerKeys.length).toBeGreaterThan(0);
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
