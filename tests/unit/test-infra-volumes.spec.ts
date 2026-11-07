/**
 * Unit Tests: scripts/test-infra.mjs removes a container together with its anonymous volumes.
 *
 * Every image the script starts declares a data volume, so each `docker run` creates anonymous volumes, and a
 * `docker rm -f` without `-v` leaves them on disk with nothing that ever attaches them again. Two paths remove a
 * container: `down`, and `up` recreating a container that exited (the normal case after a reboot) or no longer
 * matches its pin.
 *
 * Needs no Docker: `node:child_process` is replaced by a recording fake, so the cases assert the exact `docker`
 * invocations. Every other container is pointed at a remote host, which `up()` skips, so the up case runs only the
 * Redis container, whose readiness probe goes through the same fake.
 *
 * @regression   test-infra — `down` and the recreation in `up` removed containers with `docker rm -f`, leaving their
 *   anonymous volumes behind (7 volumes under 6 stopped containers on one machine).
 * @seen-failing Drop `-v` from removeContainer() in scripts/test-infra.mjs — registered as mutation
 *   `test-infra-leaves-anonymous-volumes` in tests/regression-mutations.json.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const fake = vi.hoisted(() => ({
  calls: [] as string[][],
  /** `docker ps` answer per container name; absent = no such container */
  state: new Map<string, string>(),
}));

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return {
    ...actual,
    spawnSync: (command: string, args: string[]) => {
      if (command !== 'docker') {
        return actual.spawnSync(command, args, { encoding: 'utf8' });
      }
      fake.calls.push(args);
      let stdout = '';
      if (args[0] === 'ps') {
        const filter = args.find((arg) => arg.startsWith('name=^')) ?? '';
        stdout = fake.state.get(filter.slice('name=^'.length, -1)) ?? '';
      } else if (args[0] === 'exec' && args.includes('redis-cli')) {
        stdout = 'PONG';
      }
      return { status: 0, stderr: '', stdout };
    },
  };
});

const NAMES = [
  'nest-server-2985-redis',
  'nest-server-2985-rustfs',
  'nest-server-2985-postgres',
  'nest-server-2985-mysql',
  'nest-server-2985-mariadb',
  'nest-server-2985-mongo-rs',
];

async function loadScript(): Promise<{ down: () => void; up: () => Promise<boolean> }> {
  vi.resetModules();
  return import('../../scripts/test-infra.mjs');
}

const removals = () => fake.calls.filter((args) => args[0] === 'rm');

describe('scripts/test-infra.mjs: anonymous volumes', () => {
  beforeEach(() => {
    fake.calls.length = 0;
    fake.state.clear();
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    // CI sets LT_TEST_INFRA=0, which returns from up() before it touches Docker — the case would pass vacuously
    vi.stubEnv('LT_TEST_INFRA', '');
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  it('down removes every container together with its anonymous volumes', async () => {
    for (const name of NAMES) {
      fake.state.set(name, 'exited');
    }
    const { down } = await loadScript();

    down();

    expect(removals()).toEqual(NAMES.map((name) => ['rm', '-f', '-v', name]));
  });

  it('up removes an exited container with its anonymous volumes before it creates it again', async () => {
    // Every container but Redis on a remote host: up() skips those, so only Redis is recreated
    vi.stubEnv('S3_ENDPOINT', 'http://remote.invalid:9102');
    for (const key of ['PG_HOST', 'MYSQL_HOST', 'MARIADB_HOST', 'MONGO_RS_HOST']) {
      vi.stubEnv(key, 'remote.invalid');
    }
    vi.stubEnv('REDIS_HOST', 'localhost');
    fake.state.set('nest-server-2985-redis', 'exited');
    const { up } = await loadScript();

    expect(await up()).toBe(true);

    expect(removals()).toEqual([['rm', '-f', '-v', 'nest-server-2985-redis']]);
    const removedAt = fake.calls.findIndex((args) => args[0] === 'rm');
    const createdAt = fake.calls.findIndex((args) => args[0] === 'run');
    expect(createdAt, 'the container is created again after the removal').toBeGreaterThan(removedAt);
  });
});
