#!/usr/bin/env node
/**
 * Start / stop the containers the infrastructure e2e suites need.
 *
 * Four suites talk to a REAL Redis and a REAL S3-compatible store rather than a
 * mock, and they fail loudly when it is missing — a silently skipped
 * infrastructure test is how an untested driver ships. That is the right call,
 * but it left the containers as a manual step that only CI actually performed:
 * `.github/workflows/*.yml` provisions them, a developer had to read the error
 * message and paste a docker command.
 *
 * This is that step, in one place, used by both. Idempotent: an already-running
 * container is reused, so repeated test runs pay the startup cost once.
 *
 * Usage:
 *   node scripts/test-infra.mjs up      # start and wait for readiness
 *   node scripts/test-infra.mjs down    # stop and remove
 *   node scripts/test-infra.mjs status  # what is running
 *
 * Opt out entirely with LT_TEST_INFRA=0 (CI provisions its own containers and
 * sets this, so the automatic start never fights the workflow).
 *
 * IMPORTANT — this module is IMPORTED by tests/global-setup.ts, so it must have
 * no side effects at import time. The CLI dispatch at the bottom is therefore
 * guarded by an entry-point check: only `node scripts/test-infra.mjs …` runs it.
 * Without that guard the dispatch fired on import, `process.argv[2]` was vitest's
 * own `run` subcommand, and a machine without Docker got a fully green test
 * summary followed by exit code 1 — see the guard's comment.
 */
import { spawnSync } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { request as httpRequest } from 'node:http';
import { pathToFileURL } from 'node:url';

/**
 * Endpoints, resolved from the SAME environment variables the suites read
 * (tests/redis-infra.e2e-spec.ts, tests/s3-infra.e2e-spec.ts,
 * tests/multi-replica.e2e-spec.ts, tests/graceful-shutdown.e2e-spec.ts, …).
 *
 * Hardcoding the published ports here made the documented escape hatch a lie:
 * `REDIS_PORT=6381 pnpm test` started a container on 6380 while every suite
 * dialled 6381. Defaults are unchanged, so nothing moves without an env var.
 *
 * Why 6380 and not 6379: on lt dev machines 6379 is an auth-protected TurboOps
 * Redis, so the test container binds a neighbouring port and needs no auth.
 */
const REDIS_HOST = process.env.REDIS_HOST || 'localhost';
const REDIS_PORT = process.env.REDIS_PORT ? Number(process.env.REDIS_PORT) : 6380;

const S3_ENDPOINT = process.env.S3_ENDPOINT || 'http://localhost:9102';
const S3_ACCESS_KEY = process.env.S3_ACCESS_KEY || 'rustfs';
const S3_SECRET_KEY = process.env.S3_SECRET_KEY || 'rustfs-secret';

const s3Url = parseEndpoint(S3_ENDPOINT);

/**
 * PostgreSQL for the SQL data store suites — with the SAME role separation every environment uses
 * (`.claude/plans/db-agnostic/PLAN.md` §3.9): the owner role owns the schema, the application role owns
 * nothing and has neither BYPASSRLS nor superuser, so row-level security holds against it. 5440 keeps clear of
 * a developer's own Postgres on 5432.
 */
const PG_HOST = process.env.PG_HOST || 'localhost';
const PG_PORT = process.env.PG_PORT ? Number(process.env.PG_PORT) : 5440;
const PG_OWNER_USER = process.env.PG_OWNER_USER || 'nest_owner';
const PG_OWNER_PASSWORD = process.env.PG_OWNER_PASSWORD || 'nest-owner-secret';
const PG_APP_USER = process.env.PG_APP_USER || 'nest_app';
const PG_APP_PASSWORD = process.env.PG_APP_PASSWORD || 'nest-app-secret';
const PG_MAINTENANCE_DB = 'nest_server_e2e';

/**
 * Ready = reachable over TCP (the image's init phase serves the unix socket only) AND the application role
 * exists with no way around RLS. Creating the role here keeps it idempotent across reused containers.
 */
function postgresReady(name) {
  const sql =
    `DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${PG_APP_USER}') THEN ` +
    `CREATE ROLE ${PG_APP_USER} LOGIN PASSWORD '${PG_APP_PASSWORD}' NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE; ` +
    `END IF; END $$;`;
  return (
    run('docker', [
      'exec',
      '-e',
      `PGPASSWORD=${PG_OWNER_PASSWORD}`,
      name,
      'psql',
      '-h',
      '127.0.0.1',
      '-U',
      PG_OWNER_USER,
      '-d',
      PG_MAINTENANCE_DB,
      '-v',
      'ON_ERROR_STOP=1',
      '-c',
      sql,
    ]).status === 0
  );
}

/**
 * MySQL 8.4 and MariaDB 11.8 for the MySQL dialect suites (plan phase 6) — the same two roles as PostgreSQL: the
 * owner creates databases and tables and grants, the application user starts with no privilege at all and receives
 * data access (SELECT, INSERT, UPDATE, DELETE) table by table from the schema runner. One user pair serves both
 * servers. 3316 / 3317 keep clear of a developer's own server on 3306.
 */
const MYSQL_HOST = process.env.MYSQL_HOST || 'localhost';
const MYSQL_PORT = process.env.MYSQL_PORT ? Number(process.env.MYSQL_PORT) : 3316;
const MARIADB_HOST = process.env.MARIADB_HOST || 'localhost';
const MARIADB_PORT = process.env.MARIADB_PORT ? Number(process.env.MARIADB_PORT) : 3317;
const MYSQL_ROOT_PASSWORD = 'nest-root-secret';
const MYSQL_OWNER_USER = process.env.MYSQL_OWNER_USER || 'nest_owner';
const MYSQL_OWNER_PASSWORD = process.env.MYSQL_OWNER_PASSWORD || 'nest-owner-secret';
const MYSQL_APP_USER = process.env.MYSQL_APP_USER || 'nest_app';
const MYSQL_APP_PASSWORD = process.env.MYSQL_APP_PASSWORD || 'nest-app-secret';

/**
 * Ready = reachable over TCP (both images serve only the unix socket while they initialise) AND both users exist.
 * Created here, idempotently, so a reused container is ready the same way as a fresh one.
 */
function mysqlReady(client) {
  const sql =
    `CREATE USER IF NOT EXISTS '${MYSQL_OWNER_USER}'@'%' IDENTIFIED BY '${MYSQL_OWNER_PASSWORD}'; ` +
    `GRANT ALL PRIVILEGES ON *.* TO '${MYSQL_OWNER_USER}'@'%' WITH GRANT OPTION; ` +
    `CREATE USER IF NOT EXISTS '${MYSQL_APP_USER}'@'%' IDENTIFIED BY '${MYSQL_APP_PASSWORD}';`;
  return (name) =>
    run('docker', ['exec', name, client, '-h', '127.0.0.1', '-uroot', `-p${MYSQL_ROOT_PASSWORD}`, '-e', sql]).status ===
    0;
}

/**
 * A one-node MongoDB replica set for the offline-sync contract suite (DEV-3901). On a replica set a project's
 * transaction can commit a synchronized write long after its stamp — what the pull window W must cover
 * (`.claude/plans/offline-sync/PLAN.md` §3.4) — and a standalone shows nothing of that. 27019 keeps clear of a
 * developer's own MongoDB on 27017. The suites connect with `directConnection=true`, so the member's host name never
 * has to resolve outside the container.
 */
const MONGO_RS_HOST = process.env.MONGO_RS_HOST || 'localhost';
const MONGO_RS_PORT = process.env.MONGO_RS_PORT ? Number(process.env.MONGO_RS_PORT) : 27019;

/** Ready = the set is initiated (idempotently, here) AND this node is the writable primary */
function mongoReplicaSetReady(name) {
  const initiate =
    "try { rs.status().ok } catch (e) { rs.initiate({ _id: 'rs0', members: [{ _id: 0, host: '127.0.0.1:27017' }] }).ok }";
  if (run('docker', ['exec', name, 'mongosh', '--quiet', '--eval', initiate]).status !== 0) {
    return false;
  }
  const primary = run('docker', ['exec', name, 'mongosh', '--quiet', '--eval', 'db.hello().isWritablePrimary']);
  return primary.status === 0 && primary.stdout.trim() === 'true';
}

/** Parse `S3_ENDPOINT` into host + port, tolerating a missing port and a bad URL. */
function parseEndpoint(endpoint) {
  try {
    const url = new URL(endpoint);
    return {
      host: url.hostname,
      port: url.port ? Number(url.port) : url.protocol === 'https:' ? 443 : 80,
    };
  } catch {
    return { host: 'localhost', port: 9102 };
  }
}

/**
 * A container can only publish a port on THIS machine. When the env vars point
 * somewhere else, the developer is supplying the service themselves — starting a
 * local container would be pure noise (and would bind a port nobody reads).
 */
function isLocal(host) {
  return ['0.0.0.0', '::', '::1', '127.0.0.1', 'localhost'].includes(host);
}

const CONTAINERS = [
  {
    host: REDIS_HOST,
    image: 'redis:7.4-alpine',
    name: 'nest-server-2985-redis',
    ports: [`${REDIS_PORT}:6379`],
    ready: (name) => run('docker', ['exec', name, 'redis-cli', 'ping']).stdout.trim() === 'PONG',
  },
  {
    args: ['server', '/data'],
    env: {
      RUSTFS_OBS_LOGGER_LEVEL: 'warn',
      RUSTFS_ROOT_PASSWORD: S3_SECRET_KEY,
      RUSTFS_ROOT_USER: S3_ACCESS_KEY,
      RUSTFS_VOLUMES: '/data',
    },
    host: s3Url.host,
    image: 'rustfs/rustfs:1.0.0-rc.1',
    name: 'nest-server-2985-rustfs',
    ports: [`${s3Url.port}:9000`],
    // No shell client to ping with, so probe the HTTP port directly.
    ready: () => httpReady(s3Url.host === '0.0.0.0' || s3Url.host === '::' ? '127.0.0.1' : s3Url.host, s3Url.port),
  },
  {
    env: {
      POSTGRES_DB: PG_MAINTENANCE_DB,
      POSTGRES_PASSWORD: PG_OWNER_PASSWORD,
      POSTGRES_USER: PG_OWNER_USER,
    },
    host: PG_HOST,
    image: 'postgres:18.6-alpine3.24',
    name: 'nest-server-2985-postgres',
    ports: [`${PG_PORT}:5432`],
    ready: postgresReady,
  },
  {
    env: { MYSQL_ROOT_PASSWORD },
    host: MYSQL_HOST,
    image: 'mysql:8.4.10',
    name: 'nest-server-2985-mysql',
    ports: [`${MYSQL_PORT}:3306`],
    ready: mysqlReady('mysql'),
  },
  {
    env: { MARIADB_ROOT_PASSWORD: MYSQL_ROOT_PASSWORD },
    host: MARIADB_HOST,
    image: 'mariadb:11.8.8',
    name: 'nest-server-2985-mariadb',
    ports: [`${MARIADB_PORT}:3306`],
    ready: mysqlReady('mariadb'),
  },
  {
    args: ['--replSet', 'rs0', '--bind_ip_all'],
    host: MONGO_RS_HOST,
    image: 'mongo:8.0.4',
    name: 'nest-server-2985-mongo-rs',
    ports: [`${MONGO_RS_PORT}:27017`],
    ready: mongoReplicaSetReady,
  },
];

function run(command, args) {
  const result = spawnSync(command, args, { encoding: 'utf8' });
  return { status: result.status, stderr: result.stderr ?? '', stdout: result.stdout ?? '' };
}

/** Trim a captured stderr down to something that fits in a one-line hint. */
function describeFailure(result) {
  const detail = (result.stderr || result.stdout || '').trim().split('\n').filter(Boolean).slice(-3).join(' | ');
  return detail || `exit code ${result.status}`;
}

/**
 * HTTP readiness probe for the S3 store.
 *
 * Deliberately node:http and not `curl`:
 *   - `curl` is an undeclared dependency. When it is missing, spawnSync returns
 *     `status: null`, the probe never succeeds, and the developer waits out the
 *     full 60s timeout on a failure that has nothing to do with RustFS.
 *   - the old probe only checked curl's exit code, which is 0 for ANY HTTP
 *     answer — including 500. A RustFS that is listening but failed to mount
 *     /data counted as "ready", and the run then died deep inside the S3 suites.
 *
 * Accepted: 2xx/3xx (serving) and exactly 403 (listening, and answering an
 * unauthenticated request to an S3 root the way S3 does). 5xx is explicitly NOT
 * ready — that is the broken-but-listening case worth catching here.
 */
function httpReady(host, port, timeoutMs = 2000) {
  return new Promise((resolve) => {
    const req = httpRequest({ host, method: 'GET', path: '/', port, timeout: timeoutMs }, (res) => {
      res.resume();
      const code = res.statusCode ?? 0;
      resolve((code >= 200 && code < 400) || code === 403);
    });
    req.on('error', () => resolve(false));
    req.on('timeout', () => {
      req.destroy();
      resolve(false);
    });
    req.end();
  });
}

function dockerAvailable() {
  return run('docker', ['info']).status === 0;
}

function containerState(name) {
  const { stdout } = run('docker', ['ps', '-a', '--filter', `name=^${name}$`, '--format', '{{.State}}']);
  return stdout.trim();
}

/**
 * Does the RUNNING container still match what this script would create?
 *
 * Idempotency is the point of this script, but "reuse whatever is running" made
 * both the image pin and the port env vars unenforceable: a container started
 * before `REDIS_PORT=6381` (or before the image pin moved) keeps its old mapping
 * forever, so the suites dial a port nothing is bound to. Comparing first means
 * the escape hatch works on an existing machine, not only on a fresh one.
 *
 * A container we cannot inspect is left alone — never destroy on a failed probe.
 */
function containerMatches(container) {
  const image = run('docker', ['inspect', '-f', '{{.Config.Image}}', container.name]);
  if (image.status !== 0) {
    return true;
  }
  if (image.stdout.trim() !== container.image) {
    return false;
  }

  const bindings = run('docker', [
    'inspect',
    '-f',
    '{{range $port, $conf := .HostConfig.PortBindings}}{{$port}}={{(index $conf 0).HostPort}} {{end}}',
    container.name,
  ]);
  if (bindings.status !== 0) {
    return true;
  }
  const actual = bindings.stdout.trim();
  return container.ports.every((mapping) => {
    const [hostPort, containerPort] = mapping.split(':');
    return actual.includes(`${containerPort}/tcp=${hostPort}`);
  });
}

async function waitFor(container, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      if (await container.ready(container.name)) {
        return true;
      }
    } catch {
      // not up yet
    }
    if (Date.now() >= deadline) {
      return false;
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
}

async function up() {
  if (process.env.LT_TEST_INFRA === '0') {
    console.log('[test-infra] LT_TEST_INFRA=0 — skipping');
    return true;
  }
  if (!dockerAvailable()) {
    console.warn('[test-infra] Docker is not available — infrastructure suites will fail with their own hint.');
    return false;
  }

  for (const container of CONTAINERS) {
    if (!isLocal(container.host)) {
      // The suites were pointed at a service this script cannot provision.
      console.log(
        `[test-infra] ${container.name}: skipped, ${container.host} is not this machine (using your own service)`,
      );
      continue;
    }

    const state = containerState(container.name);

    if (state === 'running' && containerMatches(container)) {
      console.log(`[test-infra] ${container.name} already running (${container.ports.join(', ')})`);
    } else {
      if (state) {
        // Exited/created from an earlier run, or running with a stale image /
        // port mapping — remove before recreating, so the change takes effect.
        run('docker', ['rm', '-f', container.name]);
      }
      const args = ['run', '-d', '--name', container.name];
      for (const port of container.ports) {
        args.push('-p', port);
      }
      for (const [key, value] of Object.entries(container.env ?? {})) {
        args.push('-e', `${key}=${value}`);
      }
      args.push(container.image, ...(container.args ?? []));

      const created = run('docker', args);
      if (created.status !== 0) {
        // Include docker's own message: the realistic failure is "port is already
        // allocated", and without it the developer only learns THAT it failed.
        console.error(
          `[test-infra] could not start ${container.name} (${container.ports.join(', ')}): ${describeFailure(created)}`,
        );
        return false;
      }
      console.log(`[test-infra] started ${container.name} (${container.ports.join(', ')})`);
    }

    if (!(await waitFor(container))) {
      console.error(`[test-infra] ${container.name} did not become ready in time`);
      const logs = run('docker', ['logs', '--tail', '20', container.name]);
      const detail = describeFailure(logs);
      if (detail) {
        console.error(`[test-infra] ${container.name} logs: ${detail}`);
      }
      return false;
    }
  }

  console.log('[test-infra] ready');
  return true;
}

function down() {
  if (!dockerAvailable()) {
    return;
  }
  for (const { name } of CONTAINERS) {
    if (containerState(name)) {
      const removed = run('docker', ['rm', '-f', name]);
      if (removed.status === 0) {
        console.log(`[test-infra] removed ${name}`);
      } else {
        console.error(`[test-infra] could not remove ${name}: ${describeFailure(removed)}`);
      }
    }
  }
}

function status() {
  if (!dockerAvailable()) {
    console.log('[test-infra] Docker not available');
    return;
  }
  for (const container of CONTAINERS) {
    const where = isLocal(container.host) ? container.ports.join(', ') : `external: ${container.host}`;
    console.log(`[test-infra] ${container.name}: ${containerState(container.name) || 'absent'} (${where})`);
  }
}

/**
 * CLI dispatch — ONLY when this file is the process entry point.
 *
 * tests/global-setup.ts imports `up` from here. Without this guard the block ran
 * on import too: under `vitest run …` `process.argv[2]` is `run`, which fell into
 * the `up()` branch, so every test run started the containers TWICE and — on a
 * machine without a Docker daemon — set `process.exitCode = 1`. The suites then
 * printed a fully green summary and the process exited non-zero, which is the
 * exact opposite of the "never fatal" contract global-setup documents.
 *
 * Rule: an imported module must never touch process.exitCode.
 *
 * argv[1] is resolved through realpath first: Node sets `import.meta.url` to the
 * REAL path of the main module but leaves argv[1] exactly as it was typed, so a
 * run through a symlink (a .bin shim, a linked checkout) would otherwise compare
 * two different strings and silently do nothing at all.
 */
function isEntryPoint() {
  const invoked = process.argv[1];
  if (!invoked) {
    return false;
  }
  try {
    return import.meta.url === pathToFileURL(realpathSync(invoked)).href;
  } catch {
    return import.meta.url === pathToFileURL(invoked).href;
  }
}

if (isEntryPoint()) {
  const command = process.argv[2] ?? 'up';
  if (command === 'down') {
    down();
  } else if (command === 'status') {
    status();
  } else {
    const ok = await up();
    // `up` is used as a precondition, so a failure has to be visible to the caller.
    if (!ok) {
      process.exitCode = 1;
    }
  }
}

export { down, up };
