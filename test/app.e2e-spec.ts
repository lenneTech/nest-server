import { FastifyAdapter } from '@nestjs/platform-fastify';
import { Test, TestingModule } from '@nestjs/testing';
import { ServerModule } from '../src/server.module';
import envConfig from '../src/config.env';
import { TestHelper } from './test.helper';

describe('AppController (e2e)', () => {
  let app;
  let testHelper: TestHelper;

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
   * Find users
   */
  it('findUsers', async () => {
    const res: any = await testHelper.graphQl({
      name: 'findUsers', fields: ['id', 'email'],
    });
    expect(res.length).toBeGreaterThanOrEqual(1);
  });
});
