# Prototypes behind PLAN.md §5 (offline sync, phase 2)

Throwaway scripts that measured the cursor candidates of PLAN.md §3.4 and the unique-index question P2-4 on
2026-10-31 (DEV-3899). They are evidence, not product code: outside `src/`, `tests/` and `scripts/`, so neither lint,
format nor the npm package sees them. Delete this folder together with PLAN.md when the sync module ships.

## Running them

They run in place: the SQL engines are the framework's own executors from `dist/`, so build first. The test
containers come from `pnpm run test:infra` (PostgreSQL 5440, MySQL 3316, MariaDB 3317); MongoDB standalone is the one
on 127.0.0.1:27017; the replica set is a throwaway container. The credentials are local container defaults, not
secrets. Every script creates its own `…_test_…` databases and drops them when it ends.

```bash
pnpm run build && pnpm run test:infra
docker run -d --name nest-server-proto-mongo-rs -p 27027:27017 mongo:7.0 --replSet rs0 --bind_ip_all
# initiate once, with the driver (mongosh is not needed):
node -e "const {MongoClient}=require('mongodb');(async()=>{const c=await new MongoClient('mongodb://127.0.0.1:27027/?directConnection=true').connect();await c.db('admin').command({replSetInitiate:{_id:'rs0',members:[{_id:0,host:'127.0.0.1:27017'}]}});await c.close()})()"

cd .claude/plans/offline-sync/prototypes
node cursor-lab.mjs --targets=pg-typeorm --scenarios=parallel,late --reps=3 | tee run.log
node summarize.mjs run.log                    # the §5 tables from the printed lines (not from --out JSON)
node partial-unique.mjs                       # MONGO_OLD_URL=… adds an older MongoDB (measured: 5.0.31)
node commit-lag-probe.mjs
node pg-counter-snapshot.mjs 60 8            # phase 3: seconds per run, writers
```

The MongoDB claim of PLAN.md §3.4 — W above the server's transaction limit makes C2 exact — is reproduced with a
limit below W and writes that are not retried. Run it last: the limit stays until it is set back.

```bash
node -e "const {MongoClient}=require('mongodb');(async()=>{const c=await new MongoClient('mongodb://127.0.0.1:27027/?directConnection=true').connect();await c.db('admin').command({setParameter:1,transactionLifetimeLimitSeconds:3});await c.close()})()"
MONGO_TXN_NO_RETRY=1 node cursor-lab.mjs --targets=mongo-rs --variants=C2 --scenarios=late-beyond-w --reps=3
docker rm -f nest-server-proto-mongo-rs       # drops the limit with the container
```

`cursor-lab.mjs` options: `--targets` (`mongo-standalone`, `mongo-rs`, `pg-typeorm`, `pg-kysely`, `pg-drizzle`,
`mysql`, `mariadb`), `--variants` (`C0`, `C1n`, `C1`, `C1d`, `C1t`, `C1x`, `C2`), `--scenarios` (`parallel`, `late`,
`late-beyond-w`, `backfill`, `volume`), `--reps`, `--duration` (ms per run, default 15000), `--window` (W in ms,
default 5000), `--out` (the results as JSON; `summarize.mjs` reads the printed lines instead). Run the three PostgreSQL targets one after the other: the container allows 100
connections. `CURSOR_DB_SUFFIX=<x>` gives a run databases of its own, so two runs against one server do not drop each
other's.

## What each script measures

| Script | Plan § | Measures |
|---|---|---|
| `targets.mjs` | §3.4 | the adapters: one per database / engine / topology, each variant's write, page query and backfill |
| `cursor-writer.mjs` | §3.4 | one app instance — own process, own pool, own clock skew, several write loops |
| `cursor-lab.mjs` | §3.4, §5 | lost changes, duplicates, termination, page latency, write throughput per variant and target |
| `partial-unique.mjs` | §3.6, P2-4 | unique index over live records only: tombstones, live `NULL`, the MongoDB filter form and its index use |
| `commit-lag-probe.mjs` | §3.4 | which instant each database clock function stamps when the statement first waits for a row lock |
| `pg-counter-snapshot.mjs` | §3.4, §5 | phase 3 (DEV-3900): PostgreSQL write rate of the per-model counter row against an advisory lock plus a sequence, with and without a snapshot held open elsewhere |
| `summarize.mjs` | §5 | the §5 tables from saved `cursor-lab.mjs` output |

The variants:

| | Write | Page query | Expected |
|---|---|---|---|
| C0 | app clock of the writing instance | `(updMs, id) > pos` | loses (negative control) |
| C1n | plain sequence (`nextval`, `AUTO_INCREMENT`) | `seq > pos` | loses on late commits (negative control) |
| C1 | per-model counter row bumped in the write's own transaction (PostgreSQL: CTE, one statement; MySQL / MariaDB: two statements; MongoDB: counter document, replica set in a transaction, standalone as two operations) | `seq > pos` | exact where the counter lock holds to commit |
| C1t | as C1, the counter bumped by a `BEFORE INSERT/UPDATE` trigger — one autocommitted statement | `seq > pos` | as C1 |
| C1d | the counter always LAST: a single write through the trigger (which runs after the row lock); a long transaction writes its row with the sentinel `sync_seq = -1` and takes the counter with its final statement before COMMIT | `seq > pos` | exact, and a long transaction holds the counter only for its final statement |
| C1x | PostgreSQL: `pg_current_xact_id()` | `(xid, id) > pos AND xid < pg_snapshot_xmin(pg_current_snapshot())` | exact |
| C2 | database clock (`clock_timestamp()`, `NOW(6)`, `$$NOW`) in µs | from the low-water mark (previous run's start − W) once per run, then `(at, id) > pos` | exact while every commit lags its timestamp by less than W |

A LOST record is one whose client version is below its final database version after the writers stopped and each
client pulled twice more over the same cursor (tombstones included). Inserts are half of all writes, so a later
change rarely hides a lost one.
