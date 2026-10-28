import type { Logger } from '@nestjs/common';

import { defaultSqlLockStore } from './infrastructure-locks.js';
import type { ModelDescriptor } from './model-descriptor.interface.js';

/**
 * How often expired rows are removed from SQL tables. MongoDB's TTL monitor does this for its collections about once a
 * minute; on SQL nothing does it unless the framework does. Nothing depends on it for correctness — every reader checks
 * the expiry itself — so the interval only bounds how long expired rows take up space.
 */
export const EXPIRY_SWEEP_INTERVAL_MS = 15 * 60_000;

/**
 * The records of a model whose TTL has passed, decided as MongoDB's TTL monitor decides it: a non-array date field plus
 * its TTL lies before `now` — a record without that date never expires — and, for a PARTIAL TTL index, the record also
 * matches the index's `partialFilterExpression`, because MongoDB expires nothing outside it. `undefined` when the model
 * declares no TTL.
 *
 * The partial filter is not decoration: `{ expireAfterSeconds, partialFilterExpression: { verified: false } }` expires
 * unverified accounts only, and a sweep that dropped the filter deleted every verified one as well. A filter the SQL
 * where compiler cannot express makes the delete fail, so nothing is deleted rather than too much.
 */
export function expiredRecordsFilter(model: ModelDescriptor, now: Date): Record<string, unknown> | undefined {
  const conditions = Object.values(model.fields)
    .filter(
      (field) =>
        field.kind === 'date' &&
        !field.isArray &&
        Number.isFinite(field.expiresAfterSeconds) &&
        field.expiresAfterSeconds >= 0,
    )
    .map((field) => {
      const expired = { [field.name]: { $lt: new Date(now.getTime() - field.expiresAfterSeconds * 1000) } };
      const ttlIndex = model.indexes.find(
        (index) =>
          Object.keys(index.fields).length === 1 && field.name in index.fields && 'expireAfterSeconds' in index.options,
      );
      const partial = ttlIndex?.options.partialFilterExpression as Record<string, unknown> | undefined;
      return partial ? { $and: [expired, partial] } : expired;
    });
  if (!conditions.length) {
    return undefined;
  }
  return conditions.length === 1 ? conditions[0] : { $or: conditions };
}

/** A scheduled sweep */
export interface ExpirySweep {
  /** Sweep at once, without the lease — after the sweep that may be running has finished */
  runNow(): Promise<void>;
  /** End the timer and wait for a sweep that is still running */
  stop(): Promise<void>;
}

/**
 * Run `sweep` now and then every `intervalMs` — on one replica per interval when the default source is a SQL database
 * (the lease `expiry-sweep:<key>` in its lease table, never released, so the next replica takes it once it expired),
 * otherwise on every replica. Running it on several is harmless: a sweep only deletes what has already expired.
 *
 * Fails open: a sweep or a lease that fails is logged and tried again at the next interval, it never stops the
 * application.
 */
export function scheduleExpirySweep(
  key: string,
  sweep: () => Promise<void>,
  options: { intervalMs?: number; logger: Logger },
): ExpirySweep {
  const intervalMs = options.intervalMs ?? EXPIRY_SWEEP_INTERVAL_MS;
  const owner = `expiry-sweep:${process.pid}:${Math.random().toString(36).slice(2)}`;
  let running: Promise<void> | undefined;

  const tick = async (): Promise<void> => {
    try {
      const locks = await defaultSqlLockStore('expiry-sweep');
      if (locks && !(await locks.tryAcquire(key, owner, Math.max(1, Math.floor(intervalMs / 1000))))) {
        return;
      }
      await sweep();
    } catch (error) {
      options.logger.warn(
        `Expiry sweep "${key}" failed, trying again in ${Math.max(1, Math.round(intervalMs / 60_000))} min: ${(error as Error)?.message ?? error}`,
      );
    }
  };
  const run = () => {
    // One sweep at a time: an interval that elapses during a slow sweep is skipped, not queued
    running ??= tick().finally(() => {
      running = undefined;
    });
  };

  run();
  const timer = setInterval(run, intervalMs);
  timer.unref();
  return {
    runNow: async () => {
      await running;
      await sweep();
    },
    stop: async () => {
      clearInterval(timer);
      await running;
    },
  };
}
