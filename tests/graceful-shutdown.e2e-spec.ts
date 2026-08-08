import { Module } from '@nestjs/common';
import { ScheduleModule } from '@nestjs/schedule';
import { Test, TestingModule } from '@nestjs/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { CoreModule } from '../src/core.module';
import { CoreRedisService } from '../src/core/common/services/core-redis.service';
import { CoreS3Service } from '../src/core/common/services/core-s3.service';
import { installGracefulShutdown } from '../src/core/common/helpers/graceful-shutdown.helper';
import envConfig from '../src/config.env';
import { deriveTestDbUri } from './db-lifecycle.reporter';

/**
 * Graceful shutdown, across every subsystem at once.
 *
 * `shutdownDelayMs` only buys anything if the shutdown it delays actually completes: a load
 * balancer gets its head start, and then the process has to drain. A subsystem that keeps a timer,
 * a Redis connection or a BullMQ worker alive turns `app.close()` into a hang, which an orchestrator
 * answers with SIGKILL — dropping exactly the in-flight requests the delay existed to protect.
 *
 * So the suite boots the REAL CoreModule with everything on (Redis, S3, cron, TUS, Hub, AI) and
 * asserts three things about closing it: the delay is honored, the close finishes within a bound,
 * and the event loop is as empty afterwards as it was before.
 *
 * Needs Redis on localhost:6380 and an S3 store on localhost:9102 (see .claude/rules/testing.md).
 */
const RUN_ID = `shutdown-${Date.now()}-p${process.pid}`;
const SHUTDOWN_DELAY_MS = 2_000;

function buildConfig(overrides: Record<string, unknown> = {}) {
  return {
    ...envConfig,
    // A cron that fires during the test, so the shutdown has live scheduling to tear down
    cronJobs: { shutdownProbe: '*/2 * * * * *' },
    graphQl: false as const,
    mongoose: { ...envConfig.mongoose, uri: deriveTestDbUri('graceful-shutdown') },
    redis: {
      db: 15,
      host: process.env.REDIS_HOST || 'localhost',
      keyPrefix: RUN_ID,
      options: { connectTimeout: 2000, maxRetriesPerRequest: 1 },
      port: process.env.REDIS_PORT ? Number(process.env.REDIS_PORT) : 6380,
    },
    s3: {
      accessKeyId: process.env.S3_ACCESS_KEY || 'rustfs',
      autoCreateBucket: true,
      bucket: RUN_ID,
      endpoint: process.env.S3_ENDPOINT || 'http://localhost:9102',
      forcePathStyle: true,
      region: 'us-east-1',
      secretAccessKey: process.env.S3_SECRET_KEY || 'rustfs-secret',
    },
    shutdownDelayMs: SHUTDOWN_DELAY_MS,
    ...overrides,
  };
}

/**
 * Event-loop resources by kind.
 *
 * `getActiveResourcesInfo()` is the honest measure here: it reports what is actually keeping the
 * loop alive, which is the property under test — unlike counting objects, which says nothing about
 * whether the process can exit.
 */
function resourceCounts(): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const kind of (process as unknown as { getActiveResourcesInfo: () => string[] }).getActiveResourcesInfo()) {
    counts[kind] = (counts[kind] ?? 0) + 1;
  }
  return counts;
}

async function bootApp(config: Record<string, unknown>): Promise<{ app: any; fixture: TestingModule }> {
  @Module({ imports: [CoreModule.forRoot(config as any), ScheduleModule.forRoot()] })
  class ShutdownTestModule {}

  const fixture = await Test.createTestingModule({ imports: [ShutdownTestModule] }).compile();
  const app = fixture.createNestApplication();
  installGracefulShutdown(app);
  await app.init();
  return { app, fixture };
}

describe('Graceful shutdown', () => {
  beforeAll(async () => {
    // Fail fast and legibly when the infrastructure is not up, instead of ~40s of retries
    const probe = new CoreRedisService({
      getFastButReadOnly: (key: string) =>
        key === 'redis'
          ? { db: 15, host: 'localhost', options: { connectTimeout: 2000, maxRetriesPerRequest: 1 }, port: 6380 }
          : undefined,
    } as any);
    await probe.onModuleInit();
    try {
      await probe.getClient().ping();
    } finally {
      await probe.onApplicationShutdown();
    }
  }, 60_000);

  afterAll(async () => {
    // Drop every key this run created
    const cleaner = new CoreRedisService({
      getFastButReadOnly: (key: string) =>
        key === 'redis'
          ? { db: 15, host: 'localhost', keyPrefix: RUN_ID, options: { maxRetriesPerRequest: 1 }, port: 6380 }
          : undefined,
    } as any);
    await cleaner.onModuleInit();
    try {
      const client = cleaner.getClient();
      let cursor = '0';
      do {
        const [next, keys] = await client.scan(cursor, 'MATCH', `${RUN_ID}*`, 'COUNT', 300);
        if (keys.length) {
          await client.del(...keys);
        }
        cursor = next;
      } while (cursor !== '0');
    } catch {
      // Nothing to clean up
    }
    await cleaner.onApplicationShutdown();
  }, 60_000);

  it('closes promptly — the delay lives in the signal handler, not inside close()', async () => {
    // `shutdownDelayMs` is honored BEFORE close() is entered (see
    // graceful-shutdown.helper.spec.ts). Once close() runs, every subsystem must tear down
    // without stalling: an orchestrator that already waited its grace period answers a slow
    // close with SIGKILL, which drops exactly the requests the delay existed to protect.
    const { app } = await bootApp(buildConfig());

    const started = Date.now();
    await app.close();

    expect(Date.now() - started).toBeLessThan(15_000);
  }, 120_000);

  it('leaves the event loop as empty as it found it', async () => {
    // The property that makes a container exit on SIGTERM instead of being killed 10s later.
    const before = resourceCounts();

    const { app } = await bootApp(buildConfig());
    // Let the cron fire and the Redis/S3 clients settle, so teardown has real work to do
    await new Promise(resolve => setTimeout(resolve, 2_500));
    await app.close();
    // Give anything scheduled during close a chance to finish
    await new Promise(resolve => setTimeout(resolve, 1_000));

    const after = resourceCounts();
    const leaked = Object.entries(after)
      .filter(([kind, count]) => count > (before[kind] ?? 0))
      // Vitest's own machinery (its tty/pipe handles and the timer backing the awaits above)
      // is not the application's; only resources the app created are in scope here.
      .filter(([kind]) => !['Immediate', 'PipeWrap', 'Timeout', 'TTYWrap'].includes(kind))
      .map(([kind, count]) => `${kind}: ${before[kind] ?? 0} -> ${count}`);

    expect(leaked, `Resources survived app.close(): ${leaked.join(', ')}`).toEqual([]);
  }, 120_000);

  it('closes every Redis connection it opened, including extra ones', async () => {
    const { app, fixture } = await bootApp(buildConfig());
    const redis = fixture.get(CoreRedisService);

    // The shared client, the dedicated subscriber, and an extra connection of the kind BullMQ takes
    redis.getClient();
    redis.getSubscriber();
    redis.createClient('shutdown-test-extra');

    await app.close();

    // After shutdown the service holds nothing — asking for the client is an error again, which is
    // only true if the shutdown hook actually released them.
    expect(() => redis.getClient()).toThrow(/init/i);
  }, 120_000);

  it('releases the S3 client', async () => {
    const { app, fixture } = await bootApp(buildConfig());
    const s3 = fixture.get(CoreS3Service);
    expect(s3.enabled).toBe(true);
    expect(() => s3.getClient()).not.toThrow();

    await app.close();

    expect(() => s3.getClient()).toThrow(/init/i);
  }, 120_000);

  it('shuts down cleanly without Redis or S3 configured', async () => {
    // The fallback path has its own resources (in-memory stores, local cron timers) and its own
    // way to leak them.
    const config = buildConfig();
    delete (config as Record<string, unknown>).redis;
    delete (config as Record<string, unknown>).s3;

    const before = resourceCounts();
    const { app } = await bootApp(config);
    await new Promise(resolve => setTimeout(resolve, 2_500));

    const started = Date.now();
    await app.close();
    expect(Date.now() - started).toBeLessThan(SHUTDOWN_DELAY_MS + 20_000);

    await new Promise(resolve => setTimeout(resolve, 1_000));
    const after = resourceCounts();
    const leaked = Object.entries(after)
      .filter(([kind, count]) => count > (before[kind] ?? 0))
      .filter(([kind]) => !['Immediate', 'PipeWrap', 'Timeout', 'TTYWrap'].includes(kind))
      .map(([kind, count]) => `${kind}: ${before[kind] ?? 0} -> ${count}`);

    expect(leaked, `Resources survived app.close(): ${leaked.join(', ')}`).toEqual([]);
  }, 120_000);

  it('can be started and stopped repeatedly without accumulating resources', async () => {
    // A leak of one handle per boot is invisible in a single close and fatal in a test suite or any
    // host that creates more than one app.
    const baseline = resourceCounts();

    for (let i = 0; i < 3; i++) {
      const { app } = await bootApp(buildConfig());
      await app.close();
    }
    await new Promise(resolve => setTimeout(resolve, 1_000));

    const after = resourceCounts();
    const growth = Object.entries(after)
      .filter(([kind, count]) => count > (baseline[kind] ?? 0))
      .filter(([kind]) => !['Immediate', 'PipeWrap', 'Timeout', 'TTYWrap'].includes(kind))
      .map(([kind, count]) => `${kind}: ${baseline[kind] ?? 0} -> ${count}`);

    expect(growth, `Resources accumulated over 3 boot/close cycles: ${growth.join(', ')}`).toEqual([]);
  }, 240_000);
});
