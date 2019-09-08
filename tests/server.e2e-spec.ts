import { Test, TestingModule } from '@nestjs/testing';
import { ServerModule } from '../src/server.module';
import { TestGraphQLType, TestHelper } from '../src/test/test.helper';

describe('ServerModule (e2e)', () => {
  let app;
  let testHelper: TestHelper;

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
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [ServerModule],
    }).compile();

    app = moduleFixture
      .createNestApplication
      // new FastifyAdapter()
      ();
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
    gPassword = Math.random()
      .toString(36)
      .substring(7);
    gEmail = gPassword + '@testuser.com';

    const res: any = await testHelper.graphQl({
      name: 'createUser',
      type: TestGraphQLType.MUTATION,
      arguments: {
        input: {
          email: gEmail,
          password: gPassword,
          firstName: 'Everardo',
        },
      },
      fields: ['id', 'email'],
    });
    expect(res.email).toEqual(gEmail);
    gId = res.id;
  });

  /**
   * Sign in user
   */
  it('signIn', async () => {
    const res: any = await testHelper.graphQl({
      name: 'signIn',
      arguments: {
        email: gEmail,
        password: gPassword,
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
    expect(res.errors[0].message.statusCode).toEqual(401);
    expect(res.errors[0].message.error).toEqual('Unauthorized');
    expect(res.data).toBe(null);
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
      { token: gToken },
    );
    expect(res.length).toBeGreaterThanOrEqual(1);
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
        fields: ['id', 'email', 'firstName'],
        type: TestGraphQLType.MUTATION,
      },
      { token: gToken },
    );
    expect(res.id).toEqual(gId);
    expect(res.email).toEqual(gEmail);
    expect(res.firstName).toEqual('Jonny');
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
        fields: ['id', 'email', 'firstName'],
      },
      { token: gToken },
    );
    expect(res.id).toEqual(gId);
    expect(res.email).toEqual(gEmail);
    expect(res.firstName).toEqual('Jonny');
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
      { token: gToken },
    );
    expect(res.id).toEqual(gId);
  });
});
