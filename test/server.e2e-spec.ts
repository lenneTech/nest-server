import { FastifyAdapter } from '@nestjs/platform-fastify';
import { Test, TestingModule } from '@nestjs/testing';
import { ServerModule } from '../src/server.module';
import { TestGraphQLType, TestHelper } from '../src/test/test.helper';

describe('AppController (e2e)', () => {
  let app;
  let testHelper: TestHelper;
  let id: string;
  let email: string;
  let password: string;
  let token: string;

  // ===================================================================================================================
  // Preparations
  // ===================================================================================================================

  /**
   * Before all tests
   */
  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [ServerModule],
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
      type: TestGraphQLType.MUTATION,
      arguments: {
        input: {
          email: this.email,
          password: this.password,
        },
      },
      fields: ['id', 'email'],
    });
    expect(res.email).toEqual(this.email);
    this.id = res.id;
  });

  /**
   * Sign in user
   */
  it('signIn', async () => {

    const res: any = await testHelper.graphQl({
      name: 'signIn',
      arguments: {
        email: this.email,
        password: this.password,
      },
      fields: ['token', { user: ['id', 'email'] }],
    });
    expect(res.user.id).toEqual(this.id);
    expect(res.user.email).toEqual(this.email);
    this.token = res.token;
  });

  /**
   * Find users without token
   */
  it('findUsers without token', async () => {
    const res: any = await testHelper.graphQl({
      name: 'findUsers', fields: ['id', 'email'],
    });
    expect(res.errors.length).toBeGreaterThanOrEqual(1);
    expect(res.errors[0].message.statusCode).toEqual(401);
    expect(res.errors[0].message.error).toEqual('Unauthorized');
    expect(res.data).toBe(null);
  });

  /**
   * Find users
   */
  it('findUsers', async () => {
    const res: any = await testHelper.graphQl({
      name: 'findUsers', fields: ['id', 'email'],
    }, this.token);
    expect(res.length).toBeGreaterThanOrEqual(1);
  });
});
