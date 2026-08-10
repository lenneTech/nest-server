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
 */
import { spawnSync } from 'child_process';

const CONTAINERS = [
  {
    image: 'redis:7-alpine',
    name: 'nest-server-2985-redis',
    ports: ['6380:6379'],
    ready: (name) => run('docker', ['exec', name, 'redis-cli', 'ping']).stdout.trim() === 'PONG',
  },
  {
    args: ['server', '/data'],
    env: {
      RUSTFS_OBS_LOGGER_LEVEL: 'warn',
      RUSTFS_ROOT_PASSWORD: 'rustfs-secret',
      RUSTFS_ROOT_USER: 'rustfs',
      RUSTFS_VOLUMES: '/data',
    },
    image: 'rustfs/rustfs:1.0.0-rc.1',
    name: 'nest-server-2985-rustfs',
    ports: ['9102:9000'],
    // No shell client to ping with, so probe the HTTP port. Any answer — including
    // 403 from an unauthenticated request — proves the server is listening.
    ready: () => run('curl', ['-s', '-o', '/dev/null', '-w', '%{http_code}', 'http://localhost:9102']).status === 0,
  },
];

function run(command, args) {
  const result = spawnSync(command, args, { encoding: 'utf8' });
  return { status: result.status, stdout: result.stdout ?? '' };
}

function dockerAvailable() {
  return run('docker', ['info']).status === 0;
}

function containerState(name) {
  const { stdout } = run('docker', ['ps', '-a', '--filter', `name=^${name}$`, '--format', '{{.State}}']);
  return stdout.trim();
}

async function waitFor(container, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      if (container.ready(container.name)) {
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
    const state = containerState(container.name);

    if (state === 'running') {
      console.log(`[test-infra] ${container.name} already running`);
    } else {
      if (state) {
        // Exited/created from an earlier run — remove before recreating, so a
        // changed image or port mapping actually takes effect.
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
        console.error(`[test-infra] could not start ${container.name}`);
        return false;
      }
      console.log(`[test-infra] started ${container.name}`);
    }

    if (!(await waitFor(container))) {
      console.error(`[test-infra] ${container.name} did not become ready in time`);
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
      run('docker', ['rm', '-f', name]);
      console.log(`[test-infra] removed ${name}`);
    }
  }
}

function status() {
  if (!dockerAvailable()) {
    console.log('[test-infra] Docker not available');
    return;
  }
  for (const { name } of CONTAINERS) {
    console.log(`[test-infra] ${name}: ${containerState(name) || 'absent'}`);
  }
}

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

export { down, up };
