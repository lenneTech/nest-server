import { Test, TestingModule } from '@nestjs/testing';
import { PubSub } from 'graphql-subscriptions';
import { RoleEnum } from '../src/core/common/enums/role.enum';
import { TestGraphQLType, TestHelper } from '../src/test/test.helper';
import envConfig from '../src/config.env';
import { User } from '../src/server/modules/user/user.model';
import { UserService } from '../src/server/modules/user/user.service';
import { ServerModule } from '../src/server/server.module';
import { MongoClient, ObjectId } from 'mongodb';

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
      userService = moduleFixture.get<UserService>(UserService);

      // Connection to database
      connection = await MongoClient.connect(envConfig.mongoose.uri);
      db = await connection.db();
    } catch (e) {
      console.log('beforeAllError', e);
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
    const userCount = 2;
    for (let i = 0; i < userCount; i++) {
      const random = Math.random().toString(36).substring(7);
      const input = {
        password: random,
        email: random + '@testusers.com',
        firstName: 'Test' + random,
        lastName: 'User' + random,
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

  // ===================================================================================================================
  // Tests
  // ===================================================================================================================

  /**
   * Test
   */
  it('test', async () => {
    console.log('Implement test here');
  });

  // ===================================================================================================================
  // Clean up tests
  // ===================================================================================================================

  /**
   * Delete users
   */
  it('deleteUsers', async () => {
    // Add admin role to user 2
    await userService.setRoles(users[1].id, ['admin']);

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
        { token: users[1].token }
      );
      expect(res.id).toEqual(user.id);
    }
  });
});
