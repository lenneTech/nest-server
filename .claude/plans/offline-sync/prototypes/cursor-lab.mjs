/**
 * Cursor lab (PLAN.md §3.4, DEV-3899): does a pull cursor lose changes?
 *
 *   node cursor-lab.mjs --targets=pg-typeorm,mysql [--variants=C1,C2] [--scenarios=parallel,late]
 *                       [--reps=1] [--duration=15000] [--out=results.json]
 *
 * Per (target, variant, scenario, repetition) on a fresh table:
 *   1. seed 50 records (the first 5 are the HOT set every instance contends on);
 *   2. three app instances (child processes, clocks skewed 0 / +5 s / −5 s, four write loops each) insert, update and
 *      tombstone for `duration` ms — in `late` scenarios a share of the transactions stays open after its write;
 *   3. meanwhile two clients (page size 25 and 100) pull run after run, each run paging until `hasMore: false`;
 *   4. after the writers stop, each client pulls twice more over the SAME cursor;
 *   5. LOST = a record whose client version is below its final database version (tombstones included).
 *
 * `backfill` checks progress: 500 records with ONE identical sync key, pulled with page sizes 25 and 100.
 * `volume` measures a full pull of 10k / 100k records and an incremental pull after 200 changes.
 */
import { fork } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { performance } from 'node:perf_hooks';

import { createDatabase, dropDatabase, initialPos, openTarget, sleep, TARGETS, VARIANTS } from './targets.mjs';

const arg = (name, fallback) => process.argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3) ?? fallback;

const W_MS = Number(arg('window', 5000));
const W_US = BigInt(W_MS) * 1000n;
const DURATION = Number(arg('duration', 15000));
const REPS = Number(arg('reps', 1));
const MAX_PAGES = 20000;
const SKEWS = [0, 5000, -5000];
// Write loops per instance. Late scenarios need more of them: a loop holding a transaction open writes nothing else
const LOOPS = { late: 12, 'late-beyond-w': 12, parallel: 4 };

const SCENARIOS = {
  parallel: { lateP: 0 },
  late: { lateMaxMs: 2000, lateMinMs: 200, lateP: 0.15 },
  // Commit lag beyond W: documents what C2's guarantee rests on. Not part of the gate for a variant whose W is
  // derived from a limit the SERVER enforces (see PLAN.md §5).
  'late-beyond-w': { lateMaxMs: 8000, lateMinMs: 6000, lateP: 0.1, variants: ['C1', 'C1d', 'C1t', 'C1x', 'C2'] },
};

class Client {
  constructor(adapter, variant, table, limit) {
    Object.assign(this, { adapter, limit, table, variant });
    this.pos = initialPos(variant);
    this.lw = null; // C2 only: the low-water mark, the previous run's start minus W
    this.state = new Map();
    this.m = { duplicates: 0, latencies: [], maxPages: 0, nonTerminating: 0, received: 0, runs: 0, stale: 0 };
  }

  /** One run: pages until a page is shorter than the limit (`hasMore: false`). */
  async run() {
    const startedAt = this.variant === 'C2' ? await this.adapter.dbNowUs() : null;
    // C2 re-reads the window ONCE per run, from the low-water mark, then continues strictly by keyset
    let pos = this.variant === 'C2' && this.lw !== null ? { id: '', k: String(this.lw) } : this.pos;
    let pages = 0;
    for (;;) {
      const t0 = performance.now();
      const rows = await this.adapter.page(this.variant, this.table, pos, this.limit);
      this.m.latencies.push(performance.now() - t0);
      pages++;
      for (const row of rows) {
        this.m.received++;
        const prev = this.state.get(row.id);
        if (prev && prev.version === row.version) this.m.duplicates++;
        else if (prev && prev.version > row.version) this.m.stale++;
        else this.state.set(row.id, { deleted: row.deleted, version: row.version });
      }
      if (rows.length) pos = { id: rows.at(-1).id, k: rows.at(-1).k };
      if (rows.length < this.limit) break;
      if (pages >= MAX_PAGES) {
        this.m.nonTerminating++;
        break;
      }
    }
    this.pos = pos;
    if (startedAt !== null) {
      const next = startedAt - W_US;
      if (this.lw === null || next > this.lw) this.lw = next;
    }
    this.m.runs++;
    this.m.maxPages = Math.max(this.m.maxPages, pages);
    return pages;
  }

  compare(final) {
    let lost = 0;
    let lostTombstones = 0;
    const examples = [];
    for (const [id, fin] of final) {
      const got = this.state.get(id);
      if (!got || got.version < fin.version || got.deleted !== fin.deleted) {
        lost++;
        if (fin.deleted) lostTombstones++;
        if (examples.length < 3) examples.push({ final: fin.version, have: got?.version ?? 0, id });
      }
    }
    const sorted = [...this.m.latencies].sort((a, b) => a - b);
    const q = (p) => (sorted.length ? Number(sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))].toFixed(2)) : 0);
    return {
      duplicates: this.m.duplicates,
      examples,
      limit: this.limit,
      lost,
      lostTombstones,
      maxPagesPerRun: this.m.maxPages,
      nonTerminating: this.m.nonTerminating,
      pageP50Ms: q(0.5),
      pageP95Ms: q(0.95),
      received: this.m.received,
      runs: this.m.runs,
      stale: this.m.stale,
    };
  }
}

function startWriter(args) {
  return new Promise((resolve, reject) => {
    const child = fork(new URL('./cursor-writer.mjs', import.meta.url), [JSON.stringify(args)], { stdio: ['ignore', 'inherit', 'inherit', 'ipc'] });
    let report;
    child.on('message', (message) => (report = message));
    child.on('error', reject);
    child.on('exit', (code) => (report ? resolve(report) : reject(new Error(`writer ${args.instance} exited ${code}`))));
  });
}

async function concurrentRun(target, variant, scenarioName, rep) {
  const scenario = SCENARIOS[scenarioName];
  const table = `cur_${variant}_${scenarioName.replace(/-/g, '_')}_${rep}`.toLowerCase();
  const adapter = await openTarget(target);
  await adapter.setup(variant, table);
  const seedIds = [];
  for (let i = 0; i < 50; i++) {
    const id = randomBytes(12).toString('hex');
    await adapter.write(variant, table, { appMs: Date.now(), id, lateMs: 0, payload: 'seed', type: 'insert' });
    seedIds.push(id);
  }
  const clients = [25, 100].map((limit) => new Client(adapter, variant, table, limit));

  let writing = true;
  const started = Date.now();
  const writers = Promise.all(
    SKEWS.map((skewMs, instance) =>
      startWriter({
        durationMs: DURATION,
        hotIds: seedIds.slice(0, 5),
        instance,
        lateMaxMs: scenario.lateMaxMs ?? 0,
        lateMinMs: scenario.lateMinMs ?? 0,
        lateP: scenario.lateP,
        loops: LOOPS[scenarioName],
        seedIds,
        skewMs,
        table,
        target,
        variant,
      }),
    ),
  ).finally(() => (writing = false));
  const pulling = clients.map(async (client) => {
    while (writing) {
      await client.run();
      await sleep(Math.floor(Math.random() * 150));
    }
  });
  const reports = await writers;
  const writeWallMs = Date.now() - started;
  await Promise.all(pulling);
  await sleep(1000);
  for (const client of clients) {
    await client.run();
    await client.run();
  }
  const final = await adapter.finalState(table);
  await adapter.close();

  const sum = (key) => reports.reduce((acc, r) => acc + r.stats[key], 0);
  const writes = sum('inserts') + sum('updates') + sum('deletes');
  return {
    clients: clients.map((c) => c.compare(final)),
    errors: sum('errors'),
    firstErrors: reports.flatMap((r) => r.firstError).slice(0, 3),
    late: sum('late'),
    records: final.size,
    rep,
    retries: sum('retries'),
    scenario: scenarioName,
    target,
    variant,
    writes,
    writesPerSec: Math.round(writes / (writeWallMs / 1000)),
  };
}

async function backfillRun(target, variant) {
  const table = `cur_${variant}_backfill`.toLowerCase();
  const adapter = await openTarget(target);
  await adapter.setup(variant, table);
  const n = 500;
  await adapter.backfill(variant, table, n, randomBytes(8).toString('hex'), Date.now());
  const out = [];
  for (const limit of [25, 100]) {
    const client = new Client(adapter, variant, table, limit);
    const pagesFirst = await client.run();
    const afterFirst = client.state.size;
    const pagesSecond = await client.run();
    out.push({
      limit,
      pagesFirst,
      pagesSecond,
      receivedFirstRun: afterFirst,
      secondRunDuplicates: client.m.duplicates,
      terminated: client.m.nonTerminating === 0,
    });
  }
  await adapter.close();
  return { n, results: out, scenario: 'backfill', target, variant };
}

async function volumeRun(target, variant) {
  const out = [];
  for (const size of [10000, 100000]) {
    const table = `cur_${variant}_volume_${size}`.toLowerCase();
    const adapter = await openTarget(target);
    await adapter.setup(variant, table);
    const tFill = performance.now();
    for (let done = 0; done < size; done += 5000) {
      await adapter.backfill(variant, table, Math.min(5000, size - done), randomBytes(8).toString('hex'), Date.now());
    }
    const fillMs = performance.now() - tFill;
    const client = new Client(adapter, variant, table, 500);
    const t0 = performance.now();
    const pages = await client.run();
    const fullMs = performance.now() - t0;
    const fullLatency = client.compare(new Map());
    // 200 changes, then one incremental run (C2 re-reads its window as part of it)
    const ids = [...client.state.keys()];
    for (let i = 0; i < 200; i++) {
      await adapter.write(variant, table, { appMs: Date.now(), id: ids[i * 37], lateMs: 0, payload: 'v', type: 'update' });
    }
    const dupBefore = client.m.duplicates;
    const t1 = performance.now();
    const incPages = await client.run();
    const incMs = performance.now() - t1;
    await adapter.close();
    out.push({
      fillMs: Math.round(fillMs),
      fullPullMs: Math.round(fullMs),
      fullPullPages: pages,
      incrementalDuplicates: client.m.duplicates - dupBefore,
      incrementalMs: Math.round(incMs),
      incrementalPages: incPages,
      pageP50Ms: fullLatency.pageP50Ms,
      pageP95Ms: fullLatency.pageP95Ms,
      size,
    });
  }
  return { results: out, scenario: 'volume', target, variant };
}

const targets = arg('targets', Object.keys(TARGETS).join(',')).split(',');
const scenarioNames = arg('scenarios', 'parallel,late,late-beyond-w,backfill,volume').split(',');
const variantFilter = arg('variants', '');
const results = [];

for (const target of targets) {
  const kind = TARGETS[target].kind;
  const variants = VARIANTS[kind].filter((v) => !variantFilter || variantFilter.split(',').includes(v));
  await createDatabase(target);
  try {
    for (const scenarioName of scenarioNames) {
      for (const variant of variants) {
        let result;
        if (scenarioName === 'backfill') {
          if (variant === 'C1n') continue;
          result = await backfillRun(target, variant);
          const line = result.results.map((r) => `limit ${r.limit}: ${r.receivedFirstRun}/${result.n} in ${r.pagesFirst} pages, 2nd run dup ${r.secondRunDuplicates}`).join(' | ');
          console.log(`${target} ${variant} backfill — ${line}`);
        } else if (scenarioName === 'volume') {
          if (!['C1', 'C1d', 'C1t', 'C1x', 'C2'].includes(variant)) continue;
          result = await volumeRun(target, variant);
          const line = result.results.map((r) => `${r.size}: full ${r.fullPullMs} ms / inc ${r.incrementalMs} ms (${r.incrementalDuplicates} dup)`).join(' | ');
          console.log(`${target} ${variant} volume — ${line}`);
        } else {
          const scenario = SCENARIOS[scenarioName];
          if (scenario.variants && !scenario.variants.includes(variant)) continue;
          for (let rep = 1; rep <= REPS; rep++) {
            result = await concurrentRun(target, variant, scenarioName, rep);
            const c = result.clients;
            console.log(
              `${target} ${variant} ${scenarioName}#${rep} — writes ${result.writes} (${result.writesPerSec}/s, late ${result.late}, retries ${result.retries}, errors ${result.errors}), records ${result.records}` +
                ` | LOST ${c.map((x) => x.lost).join('/')} dup ${c.map((x) => x.duplicates).join('/')} nonTerm ${c.map((x) => x.nonTerminating).join('/')} maxPages ${c.map((x) => x.maxPagesPerRun).join('/')} p95 ${c.map((x) => x.pageP95Ms).join('/')} ms`,
            );
            if (result.errors) console.log(`  errors: ${result.firstErrors.join(' || ')}`);
            results.push(result);
          }
          continue;
        }
        results.push(result);
      }
    }
  } finally {
    await dropDatabase(target);
  }
}

const out = arg('out', '');
if (out) writeFileSync(out, JSON.stringify({ durationMs: DURATION, results, windowMs: W_MS }, null, 2));
process.exit(0);
