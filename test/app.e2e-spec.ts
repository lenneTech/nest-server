import { Test, TestingModule } from '@nestjs/testing';
import * as request from 'supertest';
import { ApplicationModule } from './../src/app.module';
import { FastifyAdapter } from '@nestjs/platform-fastify';

describe('AppController (e2e)', () => {
  let app;

  beforeEach(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [ApplicationModule],
    }).compile();

    app = moduleFixture.createNestApplication(new FastifyAdapter());
    await app.init();
  });

  it('getUsers', () => {
    return request(app.getHttpServer())
      .post('/grapqhl')
      .type('form')
      .send({query: `query
        {
          getUsers {
            id
            firstName
            lastName
          }
        }
      `})
      .set('Accept', 'application/json')
      .expect(200)
      .expect('Content-Type', /json/);
  });
});
