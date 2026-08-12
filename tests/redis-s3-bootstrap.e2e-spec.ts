import { Module } from '@nestjs/common';
import { ScheduleModule } from '@nestjs/schedule';
import { Test, TestingModule } from '@nestjs/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { CoreModule } from '../src/core.module';
import { CoreRedisService } from '../src/core/common/services/core-redis.service';
import { CoreS3Service } from '../src/core/common/services/core-s3.service';
import { getCronJobsInfrastructure } from '../src/core/common/services/core-cron-jobs.registry';
import envConfig from '../src/config.env';
import { deriveTestDbUri } from './db-lifecycle.reporter';

/**
 * Boot the real CoreModule with Redis AND S3 configured.
 *
 * Every other test for these features builds the services directly or against a fake, so
 * none of them exercises the wiring: an unresolvable provider, a lifecycle hook that throws
 * on a real connection, or a registry that is never populated would pass all of them and
 * fail on the first `nest start` of a consumer project. This asserts the assembled
 * application actually comes up — and that the optional infrastructure is live inside it.
 *
 * Needs Redis on localhost:6380 and RustFS on localhost:9102 (see .claude/rules/testing.md).
 */
const testConfig = {
  ...envConfig,
  cronJobs: {},
  graphQl: false as const,
  mongoose: {
    ...envConfig.mongoose,
    uri: deriveTestDbUri('redis-s3-bootstrap'),
  },
  redis: {
    db: 15,
    host: process.env.REDIS_HOST || 'localhost',
    keyPrefix: `nest-server-bootstrap-${Date.now()}-p${process.pid}`,
    options: { connectTimeout: 2000, maxRetriesPerRequest: 1 },
    port: process.env.REDIS_PORT ? Number(process.env.REDIS_PORT) : 6380,
  },
  s3: {
    accessKeyId: process.env.S3_ACCESS_KEY || 'rustfs',
    bucket: `nest-server-bootstrap-${Date.now()}-p${process.pid}`,
    endpoint: process.env.S3_ENDPOINT || 'http://localhost:9102',
    forcePathStyle: true,
    region: 'us-east-1',
    secretAccessKey: process.env.S3_SECRET_KEY || 'rustfs-secret',
  },
};

describe('Bootstrap with Redis and S3 configured', () => {
  let app;
  let moduleFixture: TestingModule;

  beforeAll(async () => {
    @Module({
      imports: [CoreModule.forRoot(testConfig as any), ScheduleModule.forRoot()],
    })
    class RedisS3BootstrapModule {}

    moduleFixture = await Test.createTestingModule({ imports: [RedisS3BootstrapModule] }).compile();
    app = moduleFixture.createNestApplication();
    await app.init();
  }, 60_000);

  afterAll(async () => {
    await app?.close();
  });

  it('brings the application up', () => {
    expect(app).toBeDefined();
  });

  it('exposes a connected CoreRedisService', async () => {
    const redis = moduleFixture.get(CoreRedisService);

    expect(redis.enabled).toBe(true);
    // A real command, not just "the object exists" — the lazy ioredis import and the
    // connection both have to have happened for this to answer.
    expect(await redis.getClient().ping()).toBe('PONG');
  });

  it('exposes an initialized CoreS3Service', async () => {
    const s3 = moduleFixture.get(CoreS3Service);

    expect(s3.enabled).toBe(true);
    expect(s3.getConfig()?.bucket).toBe(testConfig.s3.bucket);
    // getClient() throws until onModuleInit has run, so this proves the hook fired
    expect(() => s3.getClient()).not.toThrow();
  });

  it('populates the cron infrastructure registry, so consumer subclasses need no change', () => {
    const infrastructure = getCronJobsInfrastructure();

    expect(infrastructure.connection).toBeDefined();
    expect(infrastructure.redisService?.enabled).toBe(true);
  });

  it('closes every Redis connection on shutdown', async () => {
    const redis = moduleFixture.get(CoreRedisService);
    await app.close();
    app = undefined;

    // After shutdown the shared client is released, so asking for it is an error again
    expect(() => redis.getClient()).toThrow(/init/i);
  });
});
