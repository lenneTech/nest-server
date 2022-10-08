import { Test, TestingModule } from '@nestjs/testing';
import { PubSub } from 'graphql-subscriptions';
import { MongoClient, ObjectId } from 'mongodb';
import { SortOrderEnum } from '../src';
import envConfig from '../src/config.env';
import { ComparisonOperatorEnum } from '../src/core/common/enums/comparison-operator.enum';
import { RoleEnum } from '../src/core/common/enums/role.enum';
import { User } from '../src/server/modules/user/user.model';
import { UserService } from '../src/server/modules/user/user.service';
import { ServerModule } from '../src/server/server.module';
import { TestGraphQLType, TestHelper } from '../src/test/test.helper';

describe('Project (e2e)', () => {
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
        password: random + i,
        email: random + i + '@testusers.com',
        firstName: 'Test' + '0'.repeat((userCount + '').length - (i + '').length) + i + random,
        lastName: 'User' + i + random,
      };

      // Sign up user
      const res: any = await testHelper.graphQl({
        name: 'signUp',
        type: TestGraphQLType.MUTATION,
        arguments: { input },
        fields: [{ user: ['id', 'email', 'firstName', 'lastName'] }],
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
        name: 'signIn',
        arguments: {
          input: {
            email: user.email,
            password: user.password,
          },
        },
        fields: ['token', { user: ['id', 'email'] }],
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

  /**
   * Find and count users
   */
  it('findAndCountUsers', async () => {
    const emails = users.map((user) => user.email);
    emails.pop();
    const args = {
      filter: {
        singleFilter: {
          field: 'email',
          operator: ComparisonOperatorEnum.IN,
          value: emails,
        },
      },
      skip: 1,
      limit: 2,
      sort: [{ field: 'firstName', order: SortOrderEnum.DESC }],
    };
    const res: any = await testHelper.graphQl(
      {
        name: 'findAndCountUsers',
        type: TestGraphQLType.QUERY,
        arguments: { ...args },
        fields: [{ items: ['id', 'email', 'firstName', 'lastName'] }, 'totalCount'],
      },
      { token: users[0].token }
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
    const emails = users.map((user) => user.email);
    const args = {
      filter: {
        singleFilter: {
          field: 'email',
          operator: ComparisonOperatorEnum.IN,
          value: emails,
        },
      },
      limit: 2,
      sort: [{ field: 'email', order: SortOrderEnum.DESC }],
      samples: 1,
    };
    const res: any = await testHelper.graphQl(
      {
        name: 'findUsers',
        type: TestGraphQLType.QUERY,
        arguments: { ...args },
        fields: ['id', 'email', 'firstName', 'lastName'],
      },
      { token: users[0].token }
    );
    expect(res.length).toEqual(1);
    expect(emails.includes(res[0].email)).toBe(true);
    const email = res[0].email;
    let otherEmail = res[0].email;
    while (email === otherEmail) {
      const otherRes: any = await testHelper.graphQl(
        {
          name: 'findUsers',
          type: TestGraphQLType.QUERY,
          arguments: { ...args },
          fields: ['id', 'email', 'firstName', 'lastName'],
        },
        { token: users[0].token }
      );
      expect(otherRes.length).toEqual(1);
      expect(emails.includes(otherRes[0].email)).toBe(true);
      otherEmail = otherRes[0].email;
    }
  });

  // ===================================================================================================================
  // Tests
  // ===================================================================================================================

  /**
   * Test
   */
  it('test', async () => {
    console.info('Implement test here');
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
          name: 'deleteUser',
          type: TestGraphQLType.MUTATION,
          arguments: {
            id: user.id,
          },
          fields: ['id'],
        },
        { token: users[users.length - 1].token }
      );
      expect(res.id).toEqual(user.id);
    }
  });
});
