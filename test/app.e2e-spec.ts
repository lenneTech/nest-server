import { FastifyAdapter } from '@nestjs/platform-fastify';
import { Test, TestingModule } from '@nestjs/testing';
import envConfig from '../src/config.env';
import { ServerModule } from '../src/server.module';
import { GraphQLType, TestHelper } from './test.helper';

describe('AppController (e2e)', () => {
  let app;
  let testHelper: TestHelper;
  let email: string;
  let password: string;
  let token: string;

  // ===================================================================================================================
  // Preparations
  // ===================================================================================================================

  /**
   * Before each test
   */
  beforeEach(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [ServerModule.forRoot(envConfig)],
    }).compile();

    app = moduleFixture.createNestApplication(new FastifyAdapter());
    await app.init();
    testHelper = new TestHelper(app);
  });

  /**
   * After all tests are finished
   */
  afterAll(() => {
    app.close();
  });

  // ===================================================================================================================
  // Tests
  // ===================================================================================================================

  /**
   * Create new user
   */
  it('createUser', async () => {
    this.password = Math.random().toString(36).substring(7);
    this.email = this.password + '@testuser.com';

    const res: any = await testHelper.graphQl({
      name: 'createUser',
      type: GraphQLType.MUTATION,
      arguments: {
        email: this.email,
        password: this.password,
      },
      fields: ['id', 'email'],
    });
    expect(res.user.email).toEqual(this.email);
    this.token = res.token;
  });

  /**
   * Find users
   */
  it('findUsers', async () => {
    const res: any = await testHelper.graphQl({
      name: 'findUsers', fields: ['id', 'email'],
    });
    expect(res.length).toBeGreaterThanOrEqual(1);
  });
});
