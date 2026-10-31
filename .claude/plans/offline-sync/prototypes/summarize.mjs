/**
 * Summarize cursor-lab.mjs output lines (stdout, saved to log files) into the tables of PLAN.md §5.
 *
 *   node summarize.mjs run-a.log run-b.log …
 *
 * Reads the printed lines rather than the JSON, so a run that was stopped early still counts with what it finished.
 */
import { readFileSync } from 'node:fs';

const RUN =
  /^(\S+) (\S+) (\S+)#(\d+) — writes (\d+) \((\d+)\/s, late (\d+), retries (\d+), errors (\d+)\), records (\d+) \| LOST (\d+)\/(\d+) dup (\d+)\/(\d+) nonTerm (\d+)\/(\d+) maxPages (\d+)\/(\d+)/;
const BACKFILL = /^(\S+) (\S+) backfill — (.*)$/;
const VOLUME = /^(\S+) (\S+) volume — (.*)$/;

const runs = new Map();
const extra = [];
for (const file of process.argv.slice(2)) {
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    const m = RUN.exec(line);
    if (m) {
      const [, target, variant, scenario, , writes, perSec, late, retries, errors, records, lostA, lostB, dupA, dupB, ntA, ntB] = m;
      const key = `${scenario}|${target}|${variant}`;
      const entry = runs.get(key) ?? { errors: 0, late: 0, lost: [], nonTerm: 0, perSec: [], records: 0, retries: 0, runs: 0, writes: 0, dup: 0 };
      entry.runs++;
      entry.writes += Number(writes);
      entry.perSec.push(Number(perSec));
      entry.late += Number(late);
      entry.retries += Number(retries);
      entry.errors += Number(errors);
      entry.records += Number(records);
      entry.lost.push(Number(lostA) + Number(lostB));
      entry.dup += Number(dupA) + Number(dupB);
      entry.nonTerm += Number(ntA) + Number(ntB);
      runs.set(key, entry);
      continue;
    }
    const b = BACKFILL.exec(line) ?? VOLUME.exec(line);
    if (b) extra.push(line.trim());
  }
}

const scenarios = [...new Set([...runs.keys()].map((k) => k.split('|')[0]))];
for (const scenario of scenarios) {
  console.log(`\n### ${scenario}\n`);
  console.log('| Target | Variant | Runs | Writes | Writes/s (mean) | Late commits | Retries | Lost (per run, both clients) | Non-terminating runs |');
  console.log('|---|---|---|---|---|---|---|---|---|');
  for (const [key, e] of [...runs].filter(([k]) => k.startsWith(`${scenario}|`)).sort()) {
    const [, target, variant] = key.split('|');
    const mean = Math.round(e.perSec.reduce((a, b) => a + b, 0) / e.perSec.length);
    console.log(
      `| ${target} | ${variant} | ${e.runs} | ${e.writes} | ${mean} | ${e.late} | ${e.retries} | ${e.lost.join(' / ')} | ${e.nonTerm} |`,
    );
  }
}
if (extra.length) {
  console.log('\n### backfill / volume\n');
  for (const line of extra) console.log(`- ${line}`);
}
