// Transparent decision matrix for the SQL engine under nest-server's persistence port.
// Premise (validated): nest-server owns query compilation, security policies AND schema evolution
// (no engine preserves RLS/guard functions, derives renames from our metadata, or locks migrations
// in a way we can rely on). The engine is judged as: execution + connections/transactions + DDL
// building + native API for projects. Scores 1–5; the evidence for every score is in the comment.
// Weights per profile sum to 100.

const criteria = {
  nest: 'NestJS-Kompatibilität (offizielles Paket, Reife, Doku)',
  stable: 'Stabilität / Release-Reife',
  dialects: 'Dialekte inkl. MariaDB und MySQL',
  upkeep: 'Pflege und Rückhalt (Bus-Faktor, Team, Backlog)',
  security: 'Sicherheit (Meldungen, sichere APIs)',
  fit: 'Eignung als Framework-Unterbau',
  evolution: 'Beitrag zur Schema-Evolution',
  native: 'Native API für Projekte',
  perf: 'Performance auf dem Store-Pfad',
  community: 'Verbreitung, Momentum, Erfahrungsberichte',
};

const scores = {
  // nest 3: @nestjs/drizzle by Nest core, but 0.0.2 since 2026-09-23, no forFeature, ESM-only.
  // stable 1.5: 1.0 RC, 24 [BREAKING] items in rc.5, no GA date; Payload/Better-Auth stay on 0.45.
  // dialects 2.5: MariaDB mode open since 2024 (#2007), JSON on MariaDB comes back as string.
  // upkeep 3.5: PlanetScale employs the core team (2026-03-03); 1,343 issues / 710 PRs open.
  // security 4: one high SQLi (identifiers, 2026-04). fit 3: kit calls process.exit, migration API
  // undocumented. evolution 3: hint-based diff is good, but push disables RLS (#4948), no lock (#874).
  // community 4.5: ×9 downloads, ThoughtWorks "Assess", two documented production exits to Kysely.
  'Drizzle 1.0 RC': { nest: 3, stable: 1.5, dialects: 2.5, upkeep: 3.5, security: 4, fit: 3, evolution: 3, native: 4.5, perf: 5, community: 4.5 },
  // nest 5: @nestjs/typeorm 12.0.2 by Nest core, first in the docs, 13 M/month.
  // stable 4: 1.x since 2026-05, 0.3 kept patched. dialects 5: MariaDB first-class + 10 more.
  // upkeep 3.5: 30 committers in 6 months, top 11 %, steering committee + 10 maintainers; 473/243 open.
  // security 3: 4 SQLi-class advisories in 5 y, all in object-based find/save/QueryBuilder paths.
  // fit 4: EntitySchema at runtime, QueryRunner incl. index introspection; heavy; second SQL library
  // next to Better-Auth's Kysely. evolution 2: synchronize/generate lose data (test 10), migrations
  // take no lock (no advisory/GET_LOCK in the source). native 3.5: familiar to Nest developers, weakly
  // typed QueryBuilder. perf 5: raw path 0.83–0.99× of pg (13b); Repository path 1.1–2.1×.
  // community 3: largest Nest SQL base, but Immich (NestJS, 117k stars) left it for Kysely in 2025.
  'TypeORM 1.1': { nest: 5, stable: 4, dialects: 5, upkeep: 3.5, security: 3, fit: 4, evolution: 2, native: 3.5, perf: 5, community: 3 },
  // nest 2: no official package and not in the Nest docs, but proven in a large NestJS app (Immich).
  // stable 3: 0.x, minor releases carry small breaks (0.29 moved the Migrator import).
  // dialects 4.5: PG, MySQL, MariaDB (test 15: all pass), SQLite, MSSQL.
  // upkeep 2.5: 87 % of commits from one maintainer in 6 months; carried by Better-Auth and
  // MikroORM 7 depending on it. security 3: 4 high advisories in 2026 (JSON path, MySQL escaping).
  // fit 5: already a hard dependency of better-auth (required peer), so no new dependency and one SQL
  // library in the process; thin, runtime table names, driver errors pass through. evolution 3.5:
  // schema builder + Migrator with a lock that holds under 6 concurrent boots (test 15); no index
  // introspection. native 4: typed builder, needs a DB interface. perf 4.5: 0.91–1.49× of pg (13).
  // community 4: where documented Drizzle exits land, Immich's choice, Better-Auth's default SQL path.
  'Kysely 0.29': { nest: 2, stable: 3, dialects: 4.5, upkeep: 2.5, security: 3, fit: 5, evolution: 3.5, native: 4, perf: 4.5, community: 4 },
  // security 2.5: critical SQLi + prototype pollution (2026-03), SQLi via runtime identifiers (2026-05).
  // upkeep 2: one maintainer (73 %). evolution 2: wrong rename guesses (test 10).
  'MikroORM 7': { nest: 3, stable: 4, dialects: 4, upkeep: 2, security: 2.5, fit: 3, evolution: 2, native: 3.5, perf: 3, community: 2 },
  // fit 1 = knockout: schema and client are generated per project at build time, our models exist at runtime.
  'Prisma 7': { nest: 3, stable: 3, dialects: 3.5, upkeep: 4.5, security: 5, fit: 1, evolution: 3, native: 4.5, perf: 3.5, community: 5 },
};

const profiles = {
  'Basis (Kais Kriterien)': { nest: 15, stable: 15, dialects: 12, upkeep: 10, security: 10, fit: 12, evolution: 8, native: 8, perf: 5, community: 5 },
  Gleichgewichtet: { nest: 10, stable: 10, dialects: 10, upkeep: 10, security: 10, fit: 10, evolution: 10, native: 10, perf: 10, community: 10 },
  'Momentum/Performance-lastig': { nest: 10, stable: 8, dialects: 8, upkeep: 12, security: 10, fit: 10, evolution: 8, native: 12, perf: 11, community: 11 },
  'Ohne MariaDB-Anforderung': { nest: 17, stable: 17, dialects: 2, upkeep: 11, security: 11, fit: 14, evolution: 9, native: 9, perf: 5, community: 5 },
  'Stabilität doppelt': { nest: 13, stable: 26, dialects: 10, upkeep: 9, security: 9, fit: 11, evolution: 7, native: 7, perf: 4, community: 4 },
  'Nest-Gewicht halbiert': { nest: 7, stable: 15, dialects: 13, upkeep: 11, security: 11, fit: 14, evolution: 9, native: 9, perf: 6, community: 5 },
  'Technische Eignung zuerst': { nest: 5, stable: 10, dialects: 10, upkeep: 10, security: 10, fit: 20, evolution: 12, native: 10, perf: 8, community: 5 },
};

const total = (s, w) => Object.keys(w).reduce((sum, k) => sum + (s[k] * w[k]) / 5, 0);
for (const [pname, w] of Object.entries(profiles)) {
  const sumW = Object.values(w).reduce((a, b) => a + b, 0);
  if (sumW !== 100) throw new Error(`${pname}: weights sum to ${sumW}`);
  const ranked = Object.entries(scores).map(([n, s]) => [n, total(s, w)]).sort((a, b) => b[1] - a[1]);
  console.log(`${pname.padEnd(30)} ${ranked.map(([n, v]) => `${n} ${v.toFixed(1)}`).join('  >  ')}`);
}
// Break-even: how much NestJS weight (taken evenly from the other criteria) keeps TypeORM ahead of Kysely?
const base = profiles['Basis (Kais Kriterien)'];
for (let nest = 15; nest >= 0; nest--) {
  const rest = 100 - nest;
  const others = Object.keys(base).filter((k) => k !== 'nest');
  const sumOthers = others.reduce((a, k) => a + base[k], 0);
  const w = { nest, ...Object.fromEntries(others.map((k) => [k, (base[k] / sumOthers) * rest])) };
  const t = total(scores['TypeORM 1.1'], w), k = total(scores['Kysely 0.29'], w);
  if (k >= t) { console.log(`Gleichstand TypeORM/Kysely erst bei einem NestJS-Gewicht von ${nest} % (Basis: 15 %)`); break; }
  if (nest === 0) console.log(`TypeORM bleibt vorn, selbst ohne NestJS-Gewicht (${t.toFixed(1)} vs ${k.toFixed(1)})`);
}
