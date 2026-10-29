import { SchemaFactory } from '@nestjs/mongoose';
import { Schema } from 'mongoose';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { expiredRecordsFilter, scheduleExpirySweep } from '../../src/core/common/persistence/expiry-sweep';
import type { LockStore } from '../../src/core/common/persistence/lock-store.interface';
import { describeSchema } from '../../src/core/common/persistence/model-metadata.registry';
import { setPersistenceRuntime } from '../../src/core/common/persistence/persistence-runtime.registry';
import { AI_MCP_OAUTH_CODE_TTL_SECONDS } from '../../src/core/modules/ai/core-ai.constants';
import { AiMcpOAuthCodeSchema } from '../../src/core/modules/ai/models/core-ai-mcp-oauth.models';
import { CoreAiToolGrant } from '../../src/core/modules/ai/models/core-ai-tool-grant.model';

const INTERVAL = 60_000;

/** A logger that records its warnings */
function recordingLogger() {
  const warnings: string[] = [];
  return { logger: { warn: (message: string) => warnings.push(message) } as any, warnings };
}

/** One lease table shared by the "replicas" of a test, as the default SQL source's `lt_locks` is */
function sharedLocks(): LockStore & { held: Map<string, { owner: string; until: number }> } {
  const held = new Map<string, { owner: string; until: number }>();
  return {
    held,
    release: async () => false,
    renew: async () => false,
    tryAcquire: async (key, owner, ttlSeconds) => {
      const lease = held.get(key);
      if (lease && lease.until > Date.now()) {
        return false;
      }
      held.set(key, { owner, until: Date.now() + ttlSeconds * 1000 });
      return true;
    },
  };
}

describe('scheduleExpirySweep', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    setPersistenceRuntime(undefined);
  });

  it('sweeps at once and then once per interval, on every replica without a SQL lease table', async () => {
    const sweep = vi.fn(async () => {});
    const handle = scheduleExpirySweep('models', sweep, { intervalMs: INTERVAL, logger: recordingLogger().logger });

    await vi.advanceTimersByTimeAsync(0);
    expect(sweep).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(INTERVAL);
    expect(sweep).toHaveBeenCalledTimes(2);

    await handle.stop();
    await vi.advanceTimersByTimeAsync(3 * INTERVAL);
    expect(sweep).toHaveBeenCalledTimes(2);
  });

  it('lets one replica per interval sweep when the default source keeps leases', async () => {
    const locks = sharedLocks();
    setPersistenceRuntime({ defaultLockStore: async () => locks } as any);
    const first = vi.fn(async () => {});
    const second = vi.fn(async () => {});

    const replicas = [
      scheduleExpirySweep('models', first, { intervalMs: INTERVAL, logger: recordingLogger().logger }),
      scheduleExpirySweep('models', second, { intervalMs: INTERVAL, logger: recordingLogger().logger }),
    ];
    await vi.advanceTimersByTimeAsync(0);

    expect(first.mock.calls.length + second.mock.calls.length).toBe(1);
    expect([...locks.held.keys()]).toEqual(['expiry-sweep:models']);

    // Once the lease ran out, the next interval is swept again — by one of them
    await vi.advanceTimersByTimeAsync(INTERVAL + 1);
    expect(first.mock.calls.length + second.mock.calls.length).toBe(2);
    await Promise.all(replicas.map((replica) => replica.stop()));
  });

  it('logs a failing sweep and tries again at the next interval, without throwing', async () => {
    const { logger, warnings } = recordingLogger();
    const sweep = vi.fn(async () => {
      throw new Error('relation "codes" does not exist');
    });
    const handle = scheduleExpirySweep('models', sweep, { intervalMs: INTERVAL, logger });

    await vi.advanceTimersByTimeAsync(INTERVAL);
    expect(sweep).toHaveBeenCalledTimes(2);
    expect(warnings).toHaveLength(2);
    expect(warnings[0]).toContain(
      'Expiry sweep "models" failed, trying again in 1 min: relation "codes" does not exist',
    );
    await handle.stop();
  });

  it('starts no second sweep while one is running, and stop() waits for it', async () => {
    let finish!: () => void;
    let finished = false;
    const sweep = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          finish = () => {
            finished = true;
            resolve();
          };
        }),
    );
    const handle = scheduleExpirySweep('models', sweep, { intervalMs: INTERVAL, logger: recordingLogger().logger });
    await vi.advanceTimersByTimeAsync(2 * INTERVAL);
    expect(sweep).toHaveBeenCalledTimes(1);

    const stopped = handle.stop();
    finish();
    await stopped;
    expect(finished).toBe(true);
  });
});

/**
 * The TTLs the sweep reads on a SQL table come from the models' schemas; MongoDB builds its TTL index from the same
 * declaration (the OAuth codes from the service, which keeps `autoIndex` off).
 */
describe('TTL declarations the expiry sweep acts on', () => {
  it('declares the ten-minute authorization code lifetime on the code model', () => {
    expect(describeSchema('AiMcpOAuthCode', AiMcpOAuthCodeSchema as any).fields.createdAt.expiresAfterSeconds).toBe(
      AI_MCP_OAUTH_CODE_TTL_SECONDS,
    );
  });

  it('lets a tool grant expire at its expiresAt', () => {
    const descriptor = describeSchema('AiToolGrant', SchemaFactory.createForClass(CoreAiToolGrant) as any);
    expect(descriptor.fields.expiresAt).toMatchObject({ expiresAfterSeconds: 0, kind: 'date' });
  });
});

describe('expiredRecordsFilter — what a SQL sweep deletes', () => {
  const now = new Date('2026-10-28T12:00:00.000Z');
  const minuteAgo = new Date('2026-10-28T11:59:00.000Z');

  /**
   * @regression   DEV-3832 (db-agnostic phase 4, review) — the sweep built its delete from the TTL field alone and dropped
   *   the index's `partialFilterExpression`: every 15 minutes it deleted every old row, also those MongoDB keeps
   *   (with `{ verified: false }`, every verified account).
   * @seen-failing Return the date condition without the partial filter in expiredRecordsFilter() in
   *   src/core/common/persistence/expiry-sweep.ts — registered as mutation `sql-ttl-partial-filter-ignored` in
   *   tests/regression-mutations.json.
   */
  it('expires only what a partial TTL index covers, as MongoDB does', () => {
    const schema = new Schema({ accepted: Boolean, sentAt: Date });
    schema.index({ sentAt: 1 }, { expireAfterSeconds: 60, partialFilterExpression: { accepted: false } });

    expect(expiredRecordsFilter(describeSchema('Invite', schema as any), now)).toEqual({
      $and: [{ sentAt: { $lt: minuteAgo } }, { accepted: false }],
    });
  });

  it('expires a plain TTL by its date alone, any of several, and never an array of dates', () => {
    const plain = new Schema({ issuedAt: { expires: 60, type: Date } });
    expect(expiredRecordsFilter(describeSchema('Code', plain as any), now)).toEqual({ issuedAt: { $lt: minuteAgo } });

    const two = new Schema({ a: { expires: 60, type: Date }, b: { index: { expireAfterSeconds: 0 }, type: Date } });
    expect(expiredRecordsFilter(describeSchema('Two', two as any), now)).toEqual({
      $or: [{ a: { $lt: minuteAgo } }, { b: { $lt: now } }],
    });

    const none = new Schema({ seenAt: [{ type: Date }], label: String });
    expect(expiredRecordsFilter(describeSchema('None', none as any), now)).toBeUndefined();
  });
});
