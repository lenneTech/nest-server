import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const startTestInfra = vi.fn();
const createPostgresTestDatabase = vi.fn();
const createMysqlTestDatabase = vi.fn();

vi.mock('../../scripts/test-infra.mjs', () => ({ up: startTestInfra }));
vi.mock('../helpers/postgres-test-db', () => ({ createPostgresTestDatabase }));
vi.mock('../helpers/mysql-test-db', () => ({ createMysqlTestDatabase }));

const KEYS = ['KYSELY', 'MARIADB'].flatMap((key) =>
  ['URL', 'OWNER_URL', 'ERROR'].map((suffix) => `LT_TEST_IAM_SQL_${key}_${suffix}`),
);
const ROUTED = ['NSC__DATABASE__URL', 'NSC__DATABASE__OWNER_URL', 'NSC__DATABASE__SQL_ENGINE'];

/**
 * The IAM SQL projects' setup (DEV-3831). vitest runs every project's global setup before any test and before the root
 * setup, so whatever the IAM setup throws stops the whole run — the MongoDB project too.
 *
 * @regression   DEV-3831 (db-agnostic phase 3) — `tests/iam-sql.global-setup.ts` threw when PostgreSQL was not running:
 *   on a fresh machine `pnpm test` ran no test at all, and the root setup that starts the containers never ran.
 * @seen-failing Rethrow the database error in tests/iam-sql.global-setup.ts — registered as mutation
 *   `iam-sql-setup-stops-the-run` in tests/regression-mutations.json.
 */
describe('IAM SQL project setup', () => {
  beforeEach(() => {
    vi.resetModules();
    startTestInfra.mockReset().mockResolvedValue(true);
    createPostgresTestDatabase.mockReset();
    createMysqlTestDatabase.mockReset();
    delete (globalThis as Record<symbol, unknown>)[Symbol.for('lenne.tech:iam-sql-infra-started')];
    for (const key of KEYS) {
      delete process.env[key];
    }
  });

  afterEach(() => {
    for (const key of [...KEYS, ...ROUTED]) {
      delete process.env[key];
    }
    delete process.env.LT_TEST_IAM_SQL_ENGINE;
    delete process.env.LT_TEST_IAM_SQL_SERVER;
  });

  it('starts the test infrastructure and hands the database to the project', async () => {
    const drop = vi.fn();
    createPostgresTestDatabase.mockResolvedValue({ appUrl: 'postgres://app', drop, ownerUrl: 'postgres://owner' });
    const { default: setup } = await import('../iam-sql.global-setup');

    const teardown = await setup({ name: 'iam-sql-kysely' });

    expect(startTestInfra).toHaveBeenCalledTimes(1);
    expect(process.env.LT_TEST_IAM_SQL_KYSELY_URL).toBe('postgres://app');
    expect(process.env.LT_TEST_IAM_SQL_KYSELY_OWNER_URL).toBe('postgres://owner');
    await teardown();
    expect(drop).toHaveBeenCalledTimes(1);
  });

  it('does not stop the run when PostgreSQL is unreachable, and records why', async () => {
    createPostgresTestDatabase.mockRejectedValue(new Error('connect ECONNREFUSED 127.0.0.1:5440'));
    const { default: setup } = await import('../iam-sql.global-setup');

    await expect(setup({ name: 'iam-sql-kysely' })).resolves.toBeTypeOf('function');
    expect(process.env.LT_TEST_IAM_SQL_KYSELY_URL).toBeUndefined();
    expect(process.env.LT_TEST_IAM_SQL_KYSELY_ERROR).toContain('ECONNREFUSED');
  });

  it("fails the project's suites with the reason instead of falling back to MongoDB", async () => {
    process.env.LT_TEST_IAM_SQL_ENGINE = 'kysely';
    process.env.LT_TEST_IAM_SQL_KYSELY_ERROR = 'connect ECONNREFUSED 127.0.0.1:5440';

    await expect(import('../iam-sql.setup')).rejects.toThrow(/iam-sql-kysely: connect ECONNREFUSED/);
  });

  it('creates a MariaDB database for the project iam-mariadb (DEV-3904)', async () => {
    const drop = vi.fn();
    createMysqlTestDatabase.mockResolvedValue({ appUrl: 'mariadb://app', drop, ownerUrl: 'mariadb://owner' });
    const { default: setup } = await import('../iam-sql.global-setup');

    const teardown = await setup({ name: 'iam-mariadb' });

    expect(createMysqlTestDatabase).toHaveBeenCalledWith('mariadb', expect.any(String));
    expect(createPostgresTestDatabase).not.toHaveBeenCalled();
    expect(process.env.LT_TEST_IAM_SQL_MARIADB_URL).toBe('mariadb://app');
    await teardown();
    expect(drop).toHaveBeenCalledTimes(1);
  });

  it('routes a server project to its database with the default engine', async () => {
    process.env.LT_TEST_IAM_SQL_SERVER = 'mariadb';
    process.env.LT_TEST_IAM_SQL_MARIADB_URL = 'mariadb://app';
    process.env.LT_TEST_IAM_SQL_MARIADB_OWNER_URL = 'mariadb://owner';

    await import('../iam-sql.setup');

    expect(process.env.NSC__DATABASE__URL).toBe('mariadb://app');
    expect(process.env.NSC__DATABASE__OWNER_URL).toBe('mariadb://owner');
    expect(process.env.NSC__DATABASE__SQL_ENGINE).toBeUndefined();
  });

  it("fails a server project's suites with the reason", async () => {
    process.env.LT_TEST_IAM_SQL_SERVER = 'mariadb';
    process.env.LT_TEST_IAM_SQL_MARIADB_ERROR = 'MariaDB is not reachable';

    await expect(import('../iam-sql.setup')).rejects.toThrow(/iam-mariadb: MariaDB is not reachable/);
  });
});
