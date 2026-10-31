/**
 * One APP INSTANCE of the cursor lab: its own process, its own pool, its own clock (`skewMs`).
 * Started by cursor-lab.mjs with a JSON argument; reports its counts over IPC and exits.
 *
 * Several async loops share the instance's pool, so writes overlap inside one instance as well as across instances.
 * Updates and deletes pick from a small HOT set (lock contention) or from the ids this instance or the seed created.
 */
import { randomBytes } from 'node:crypto';

import { openTarget } from './targets.mjs';

const args = JSON.parse(process.argv[2]);
const { durationMs, hotIds, instance, lateMaxMs, lateMinMs, lateP, loops, seedIds, skewMs, table, target, variant } = args;

const adapter = await openTarget(target, { maxConnections: loops + 2 });
const known = [...seedIds];
const stats = { deletes: 0, errors: 0, inserts: 0, late: 0, retries: 0, updates: 0, wallMs: 0 };
const firstError = [];

const pick = (list) => list[Math.floor(Math.random() * list.length)];
const started = Date.now();
const end = started + durationMs;

async function loop() {
  while (Date.now() < end) {
    const r = Math.random();
    const type = r < 0.5 ? 'insert' : r < 0.9 ? 'update' : 'delete';
    const id = type === 'insert' ? randomBytes(12).toString('hex') : Math.random() < 0.3 ? pick(hotIds) : pick(known);
    const lateMs = lateP && Math.random() < lateP ? lateMinMs + Math.floor(Math.random() * (lateMaxMs - lateMinMs)) : 0;
    // The app clock of THIS instance — what the old cursor (C0) wrote
    const appMs = Date.now() + skewMs;
    try {
      const { retries } = await adapter.write(variant, table, { appMs, id, lateMs, payload: `i${instance}-${Date.now()}`, type });
      stats.retries += retries ?? 0;
      stats[`${type}s`]++;
      if (lateMs) stats.late++;
      if (type === 'insert') known.push(id);
    } catch (error) {
      stats.errors++;
      if (firstError.length < 3) firstError.push(String(error?.message ?? error).slice(0, 200));
    }
  }
}

await Promise.all(Array.from({ length: loops }, loop));
stats.wallMs = Date.now() - started;
await adapter.close();
process.send({ firstError, instance, stats });
process.exit(0);
