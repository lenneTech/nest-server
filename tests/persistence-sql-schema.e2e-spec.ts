import { Client } from 'pg';
import { Schema } from 'mongoose';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { ModelDescriptor } from '../src/core/common/persistence/model-descriptor.interface';
import { describeSchema } from '../src/core/common/persistence/model-metadata.registry';
import { resolveSyncOptions, withSequenceField, withSyncDescriptor } from '../src/core/common/persistence/sync-model';
import type { PostgresSchemaOptions } from '../src/core/common/persistence/sql/postgres/postgres-schema.compiler';
import {
  applyPostgresSchema,
  assertSafeApplicationRole,
  planPostgresSchema,
  SchemaMigrationRequiredError,
  SchemaOutOfDateError,
  UnsafeDatabaseRoleError,
  verifyPostgresSchema,
} from '../src/core/common/persistence/sql/postgres/postgres-schema.migrator';
import { createSqlExecutor } from '../src/core/common/persistence/sql/sql-executor.factory';
import { runSqlMigration } from '../src/core/modules/migrate/sql-migration.helper';
import type { SqlExecutor, SqlTenantScope } from '../src/core/common/persistence/sql/sql-executor.interface';
import {
  createPostgresTestDatabase,
  PG_APP,
  PG_OWNER,
  type PostgresTestDatabase,
  postgresUrl,
} from './helpers/postgres-test-db';

/**
 * Framework-owned schema evolution on PostgreSQL (plan §3.12) and the database layer of tenant isolation (§3.4),
 * against a real server with the owner / application role split every environment uses (§3.9).
 */
const project = (
  fields: Record<string, unknown>,
  indexes: Array<[Record<string, unknown>, Record<string, unknown>?]> = [],
) => {
  const schema = new Schema(fields, { collection: 'schemaProjects' });
  for (const [spec, options] of indexes) {
    schema.index(spec as any, options);
  }
  return describeSchema('SchemaProject', schema);
};
const PROJECT_FIELDS = {
  address: new Schema({ city: String }, { _id: false }),
  archived: { default: false, type: Boolean },
  budget: { default: 0, type: Number },
  meta: Schema.Types.Mixed,
  name: { type: String, unique: true },
  ownerId: { ref: 'User', type: Schema.Types.ObjectId },
  secret: String,
  tags: { index: true, type: [String] },
  title: String,
};
const PROJECT_INDEXES: Array<[Record<string, unknown>, Record<string, unknown>?]> = [
  [{ budget: -1, name: 1 }],
  [{ secret: 1 }, { partialFilterExpression: { secret: { $type: 'string' } } }],
  [{ 'address.city': 1 }],
  [{ title: 'text' }],
];
const NOTE = describeSchema(
  'SchemaNote',
  new Schema({ body: String, tenantId: String }, { collection: 'schemaNotes' }),
);
const MEMBER = describeSchema(
  'SchemaMember',
  new Schema({ name: String, roles: [String] }, { collection: 'schemaMembers' }),
);

const OPTIONS: PostgresSchemaOptions = {
  appRole: PG_APP.user,
  isTenantIsolated: (model: ModelDescriptor) => model.tenantScoped,
};
const SYSTEM: SqlTenantScope = { kind: 'system' };
const NONE: SqlTenantScope = { kind: 'none' };
const tenant = (tenantId: string): SqlTenantScope => ({ kind: 'tenant', tenantId });

describe('PostgreSQL schema evolution and row-level security (e2e)', () => {
  let database: PostgresTestDatabase;
  let owner: SqlExecutor;
  let app: SqlExecutor;

  const columns = async (table: string) =>
    Object.fromEntries(
      (
        await owner.run<{ collation: null | string; default: null | string; name: string; type: string }>(
          {
            params: [table],
            text: `SELECT a.attname AS name, format_type(a.atttypid, a.atttypmod) AS type, pg_get_expr(d.adbin, d.adrelid) AS default,
                CASE WHEN a.attcollation <> t.typcollation THEN co.collname END AS collation
              FROM pg_attribute a JOIN pg_type t ON t.oid = a.atttypid LEFT JOIN pg_collation co ON co.oid = a.attcollation
                LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
              WHERE a.attrelid = $1::regclass AND a.attnum > 0 AND NOT a.attisdropped`,
          },
          SYSTEM,
        )
      ).rows.map((row) => [row.name, row]),
    );

  beforeAll(async () => {
    database = await createPostgresTestDatabase('sql-schema');
    owner = await createSqlExecutor({ engine: 'typeorm', maxConnections: 2, url: database.ownerUrl });
    app = await createSqlExecutor({ engine: 'kysely', maxConnections: 2, url: database.appUrl });
  });

  afterAll(async () => {
    await app?.close();
    await owner?.close();
    await database?.drop();
  });

  it('creates tables, typed columns, indexes, row-level security and grants', async () => {
    const changes = await applyPostgresSchema(owner, [project(PROJECT_FIELDS, PROJECT_INDEXES), NOTE, MEMBER], OPTIONS);
    expect(changes.filter((change) => change.kind === 'migration')).toEqual([]);
    expect(
      changes.find((change) => change.kind === 'notice' && change.description.includes('"title":"text"')),
    ).toBeDefined();

    const projectColumns = await columns('schema_projects');
    expect(projectColumns.id).toMatchObject({ type: 'text' });
    expect(projectColumns.name).toMatchObject({ collation: 'C', type: 'text' });
    expect(projectColumns.budget).toMatchObject({ default: '0', type: 'double precision' });
    expect(projectColumns.archived).toMatchObject({ default: 'false', type: 'boolean' });
    expect(projectColumns.tags).toMatchObject({ default: "'[]'::jsonb", type: 'jsonb' });
    expect(projectColumns.owner_id).toMatchObject({ collation: 'C', type: 'text' });
    expect(projectColumns.meta).toMatchObject({ type: 'jsonb' });
    expect(projectColumns.address).toMatchObject({ type: 'jsonb' });

    const indexes = (
      await owner.run<{ definition: string; name: string }>(
        {
          params: [],
          text: "SELECT indexname AS name, indexdef AS definition FROM pg_indexes WHERE tablename = 'schema_projects'",
        },
        SYSTEM,
      )
    ).rows.map((row) => row.definition);
    expect(indexes.join('\n')).toMatch(/UNIQUE INDEX ux_schema_projects__name_\w+ .*\(name\) NULLS NOT DISTINCT/);
    expect(indexes.join('\n')).toMatch(/USING gin \(tags jsonb_path_ops\)/);
    expect(indexes.join('\n')).toMatch(/\(budget DESC, name\)/);
    expect(indexes.join('\n')).toMatch(/WHERE \(secret IS NOT NULL\)/);
    expect(indexes.join('\n')).toMatch(/\(\(address #>> '\{city\}'::text\[\]\)\)/);

    const { rows } = await owner.run<{ forced: boolean; rls: boolean }>(
      {
        params: [],
        text: "SELECT relrowsecurity AS rls, relforcerowsecurity AS forced FROM pg_class WHERE relname = 'schema_notes'",
      },
      SYSTEM,
    );
    expect(rows[0]).toEqual({ forced: true, rls: true });
  });

  it('changes nothing on a second run, and the application role finds it up to date', async () => {
    const models = [project(PROJECT_FIELDS, PROJECT_INDEXES), NOTE, MEMBER];
    const again = await applyPostgresSchema(owner, models, OPTIONS);
    expect(again.filter((change) => change.kind !== 'notice')).toEqual([]);
    await expect(verifyPostgresSchema(app, models, OPTIONS)).resolves.toBeDefined();
  });

  it('lets two replicas migrate at once: one applies, the other finds nothing left', async () => {
    const models = [describeSchema('SchemaRace', new Schema({ name: String }, { collection: 'schemaRace' }))];
    const second = await createSqlExecutor({ engine: 'drizzle', maxConnections: 1, url: database.ownerUrl });
    try {
      const results = await Promise.all([
        applyPostgresSchema(owner, models, OPTIONS),
        applyPostgresSchema(second, models, OPTIONS),
      ]);
      expect(
        results.map((changes) => changes.some((change) => change.description.startsWith('create table'))),
      ).toContain(false);
    } finally {
      await second.close();
    }
  });

  it('adds a new column and a new non-unique index automatically, and refuses to start without the owner', async () => {
    const v2 = project({ ...PROJECT_FIELDS, priority: { index: true, type: Number } }, PROJECT_INDEXES);
    await expect(verifyPostgresSchema(app, [v2], OPTIONS)).rejects.toBeInstanceOf(SchemaOutOfDateError);

    const changes = await applyPostgresSchema(owner, [v2], OPTIONS);
    expect(changes.filter((change) => change.kind === 'automatic').map((change) => change.description)).toEqual([
      'add column schema_projects.priority',
      expect.stringMatching(/^create index ix_schema_projects__priority_\w+ on schema_projects$/),
    ]);
    expect((await columns('schema_projects')).priority).toMatchObject({ type: 'double precision' });
    await expect(verifyPostgresSchema(app, [v2], OPTIONS)).resolves.toBeDefined();
  });

  it('renames a column declared with renamedFrom and keeps its data', async () => {
    await owner.run(
      { params: [], text: "INSERT INTO schema_projects (id, title) VALUES ('p-rename', 'kept')" },
      SYSTEM,
    );
    const { title: _title, ...rest } = PROJECT_FIELDS;
    const v3 = project(
      { ...rest, headline: { renamedFrom: 'title', type: String }, priority: Number },
      PROJECT_INDEXES.slice(0, 3),
    );

    const changes = await applyPostgresSchema(owner, [v3], OPTIONS);
    expect(changes.map((change) => change.description)).toContain(
      'rename schema_projects.title to headline (declared renamedFrom)',
    );
    const { rows } = await owner.run<{ headline: string }>(
      { params: [], text: "SELECT headline FROM schema_projects WHERE id = 'p-rename'" },
      SYSTEM,
    );
    expect(rows).toEqual([{ headline: 'kept' }]);
    expect((await columns('schema_projects')).title).toBeUndefined();
  });

  /**
   * @regression   DEV-3829 (db-agnostic phase 1) — a changed column type or a new unique index applied at boot can
   *   fail on — or rewrite — the rows already stored; plan §3.12 makes both a reviewed migration.
   * @seen-failing Plan a new unique index as automatic in
   *   src/core/common/persistence/sql/postgres/postgres-schema.migrator.ts — registered as mutation
   *   `sql-schema-unique-index-automatic` in tests/regression-mutations.json.
   */
  it('refuses a type change and a new unique index, and applies nothing of that run', async () => {
    const { title: _title, ...rest } = PROJECT_FIELDS;
    const base = { ...rest, headline: String, priority: Number };
    const unique = project(
      { ...base, code: String, slug: { type: String, unique: true } },
      PROJECT_INDEXES.slice(0, 3),
    );
    await expect(applyPostgresSchema(owner, [unique], OPTIONS)).rejects.toBeInstanceOf(SchemaMigrationRequiredError);

    const retyped = project({ ...base, budget: String, code: String }, PROJECT_INDEXES.slice(0, 3));
    const failure = await applyPostgresSchema(owner, [retyped], OPTIONS).catch((error) => error);
    expect(failure).toBeInstanceOf(SchemaMigrationRequiredError);
    expect((failure as SchemaMigrationRequiredError).changes.map((change) => change.description)).toEqual([
      'schema_projects.budget is double precision, the model asks for text COLLATE "C"',
    ]);
    // The automatic part of the refused runs (column `code`, column `slug`) was rolled back with it
    expect((await columns('schema_projects')).code).toBeUndefined();
    expect((await columns('schema_projects')).slug).toBeUndefined();
  });

  it('applies a refused change through a reviewed SQL migration (runSqlMigration), after which the boot passes', async () => {
    const { title: _title, ...rest } = PROJECT_FIELDS;
    const retyped = project(
      { ...rest, budget: String, headline: String, priority: Number },
      PROJECT_INDEXES.slice(0, 3),
    );
    const refusal = (await applyPostgresSchema(owner, [retyped], OPTIONS).catch(
      (error) => error,
    )) as SchemaMigrationRequiredError;
    expect(refusal).toBeInstanceOf(SchemaMigrationRequiredError);
    const statements = refusal.changes.flatMap((change) => change.statements);
    expect(statements).toEqual([
      'ALTER TABLE "schema_projects" ALTER COLUMN "budget" TYPE text COLLATE "C" USING "budget"::text',
    ]);
    expect(refusal.message).toContain(`suggested: ${statements[0]}`);

    await runSqlMigration(database.ownerUrl, statements);

    expect((await columns('schema_projects')).budget).toMatchObject({ collation: 'C', type: 'text' });
    const after = await applyPostgresSchema(owner, [retyped], OPTIONS);
    expect(after.filter((change) => change.kind === 'migration')).toEqual([]);
  });

  /**
   * @regression   DEV-3829 (db-agnostic phase 1) — removing a model from tenant isolation by configuration (a slip
   *   in `multiTenancy`, an `excludeSchemas` entry) must not switch database-level isolation off on its own.
   * @seen-failing Plan the removal of row-level security as automatic in
   *   src/core/common/persistence/sql/postgres/postgres-schema.migrator.ts — registered as mutation
   *   `sql-schema-drops-rls-automatically` in tests/regression-mutations.json.
   */
  it('never removes row-level security on its own when a table stops being tenant-isolated', async () => {
    const changes = await planPostgresSchema((statement) => owner.run(statement, SYSTEM), [NOTE], {
      ...OPTIONS,
      isTenantIsolated: () => false,
    });
    const removal = changes.find((change) => change.description.includes('no longer tenant-isolated'));
    expect(removal).toMatchObject({ kind: 'migration' });
    await expect(
      applyPostgresSchema(owner, [NOTE], { ...OPTIONS, isTenantIsolated: () => false }),
    ).rejects.toBeInstanceOf(SchemaMigrationRequiredError);
  });

  it('keeps a column the model no longer declares and reports it', async () => {
    const shrunk = project({ name: { type: String, unique: true } });
    const changes = await planPostgresSchema((statement) => owner.run(statement, SYSTEM), [shrunk], OPTIONS);
    expect(changes.filter((change) => change.kind === 'notice').map((change) => change.description)).toContain(
      'schema_projects.budget is no longer declared; the column is kept until a migration drops it',
    );
    expect(changes.filter((change) => change.kind !== 'notice')).toEqual([]);
  });

  describe('row-level security on a tenant table', () => {
    beforeAll(async () => {
      await owner.run({ params: [], text: 'DELETE FROM schema_notes' }, SYSTEM);
      for (const [id, tenantId] of [
        ['n1', 't1'],
        ['n2', 't2'],
        ['n3', 't3'],
      ]) {
        await app.run(
          { params: [id, tenantId], text: 'INSERT INTO schema_notes (id, tenant_id) VALUES ($1, $2)' },
          tenant(tenantId),
        );
      }
    });

    const ids = async (executor: SqlExecutor, scope: SqlTenantScope) =>
      (
        await executor.run<{ id: string }>({ params: [], text: 'SELECT id FROM schema_notes ORDER BY id' }, scope)
      ).rows.map((row) => row.id);

    it('shows a tenant its own rows, a member its tenants, system work everything', async () => {
      expect(await ids(app, tenant('t1'))).toEqual(['n1']);
      expect(await ids(app, { kind: 'tenants', tenantIds: ['t1', 't3'] })).toEqual(['n1', 'n3']);
      expect(await ids(app, { kind: 'tenants', tenantIds: [] })).toEqual([]);
      expect(await ids(app, SYSTEM)).toEqual(['n1', 'n2', 'n3']);
    });

    /**
     * @regression   DEV-3829 (db-agnostic phase 1) — a guard function that reads a missing tenant context as "no
     *   restriction" turns every query outside the framework's scope — native, raw, a forgotten scope — into a read
     *   of every tenant's rows.
     * @seen-failing Return NULL instead of raising for an unknown scope in the guard function in
     *   src/core/common/persistence/sql/postgres/postgres-schema.compiler.ts — registered as mutation
     *   `sql-rls-guard-allows-missing-scope` in tests/regression-mutations.json.
     */
    it('refuses a query without a tenant context, also outside the framework (42501)', async () => {
      await expect(ids(app, NONE)).rejects.toMatchObject({ code: '42501' });
      const raw = new Client({ connectionString: database.appUrl });
      await raw.connect();
      try {
        await expect(raw.query('SELECT id FROM schema_notes')).rejects.toMatchObject({ code: '42501' });
      } finally {
        await raw.end();
      }
    });

    it('refuses writing a row into another tenant (WITH CHECK)', async () => {
      await expect(
        app.run({ params: [], text: "INSERT INTO schema_notes (id, tenant_id) VALUES ('x', 't2')" }, tenant('t1')),
      ).rejects.toMatchObject({ code: '42501' });
      const moved = await app
        .run({ params: [], text: "UPDATE schema_notes SET tenant_id = 't2' WHERE id = 'n1'" }, tenant('t1'))
        .catch((error) => error);
      expect(moved).toMatchObject({ code: '42501' });
      const foreign = await app.run(
        { params: [], text: "UPDATE schema_notes SET body = 'x' WHERE id = 'n2'" },
        tenant('t1'),
      );
      expect(foreign.rowCount).toBe(0);
    });

    /**
     * @regression   DEV-3829 (db-agnostic phase 1) — without FORCE, row-level security does not bind the table's
     *   owner, so any connection as the owner (a migration, a maintenance script, a misconfigured `url`) reads every
     *   tenant.
     * @seen-failing Drop `FORCE ROW LEVEL SECURITY` from tenantPolicyStatements() in
     *   src/core/common/persistence/sql/postgres/postgres-schema.compiler.ts — registered as mutation
     *   `sql-rls-not-forced` in tests/regression-mutations.json.
     */
    it('binds the table owner too (FORCE)', async () => {
      const ownerSession = new Client({
        connectionString: postgresUrl({ password: PG_OWNER.password, user: PG_OWNER.user }, database.name),
      });
      await ownerSession.connect();
      try {
        // The container's owner is a superuser, which no row-level security binds: take the plain owner role
        await ownerSession.query(`CREATE ROLE "lt_table_owner_${process.pid}" NOLOGIN NOSUPERUSER NOBYPASSRLS`);
        await ownerSession.query(`ALTER TABLE schema_notes OWNER TO "lt_table_owner_${process.pid}"`);
        await ownerSession.query(`SET ROLE "lt_table_owner_${process.pid}"`);
        await expect(ownerSession.query('SELECT id FROM schema_notes')).rejects.toMatchObject({ code: '42501' });
      } finally {
        await ownerSession.query('RESET ROLE').catch(() => undefined);
        await ownerSession.query(`ALTER TABLE schema_notes OWNER TO "${PG_OWNER.user}"`).catch(() => undefined);
        await ownerSession.query(`DROP ROLE IF EXISTS "lt_table_owner_${process.pid}"`).catch(() => undefined);
        await ownerSession.end();
      }
    });
  });

  /**
   * @regression   DEV-3829 (db-agnostic phase 1) — a stored system role (`s_self`) satisfies every S_SELF check
   *   (11.35.0); on SQL the database refuses it as well, below every write path the framework has.
   * @seen-failing Drop the roles CHECK from desiredTable() in
   *   src/core/common/persistence/sql/postgres/postgres-schema.compiler.ts — registered as mutation
   *   `sql-schema-allows-system-roles` in tests/regression-mutations.json.
   */
  describe('a model that becomes synchronized (offline sync, DEV-3900)', () => {
    const declared = (fields: Record<string, unknown>) =>
      describeSchema('SchemaLog', new Schema(fields, { collection: 'schemaLogs' }));
    const synced = (fields: Record<string, unknown>) =>
      withSequenceField(withSyncDescriptor(declared(fields), resolveSyncOptions(true, 'SchemaLog')!));
    const rows = async () =>
      (
        await owner.run<{ id: string; sync_seq: null | string; version: number }>(
          { params: [], text: 'SELECT id, version, sync_seq::text AS sync_seq FROM schema_logs ORDER BY id' },
          SYSTEM,
        )
      ).rows;

    it('adds the system columns, numbers the rows it already holds, and the application role numbers new ones', async () => {
      await applyPostgresSchema(owner, [declared({ message: String })], OPTIONS);
      for (const id of ['l1', 'l2', 'l3']) {
        await owner.run({ params: [id], text: "INSERT INTO schema_logs (id, message) VALUES ($1, 'before')" }, SYSTEM);
      }

      const changes = await applyPostgresSchema(owner, [synced({ message: String })], OPTIONS);
      expect(changes.filter((change) => change.kind === 'migration')).toEqual([]);
      expect(changes.map((change) => change.description)).toEqual(
        expect.arrayContaining([
          'create the change-order function lt_sync_stamp()',
          'add column schema_logs.version',
          'add column schema_logs.deleted_at',
          'add column schema_logs.sync_seq',
          'add the change-order trigger of schema_logs',
        ]),
      );
      const numbered = await rows();
      expect(numbered.map((row) => row.version)).toEqual([1, 1, 1]);
      expect(new Set(numbered.map((row) => row.sync_seq)).size).toBe(3);
      expect(numbered.every((row) => row.sync_seq !== null)).toBe(true);
      await expect(verifyPostgresSchema(app, [synced({ message: String })], OPTIONS)).resolves.toBeDefined();

      // The trigger, as the application role (nextval needs the sequence grant)
      await app.run({ params: [], text: "INSERT INTO schema_logs (id, message) VALUES ('l4', 'after')" }, SYSTEM);
      await app.run({ params: [], text: "UPDATE schema_logs SET message = 'changed' WHERE id = 'l1'" }, SYSTEM);
      const after = await rows();
      const highest = Math.max(...numbered.map((row) => Number(row.sync_seq)));
      expect(Number(after.find((row) => row.id === 'l4')!.sync_seq)).toBeGreaterThan(highest);
      expect(Number(after.find((row) => row.id === 'l1')!.sync_seq)).toBeGreaterThan(
        Number(after.find((row) => row.id === 'l4')!.sync_seq),
      );
    });

    it('replaces a change-order trigger of an earlier version', async () => {
      await owner.run(
        { params: [], text: 'ALTER TRIGGER lt_sync_stamp_v1 ON schema_logs RENAME TO lt_sync_stamp_v0' },
        SYSTEM,
      );
      const changes = await applyPostgresSchema(owner, [synced({ message: String })], OPTIONS);
      expect(changes.map((change) => change.description)).toContain('replace the change-order trigger of schema_logs');
      const { rows: triggers } = await owner.run<{ name: string }>(
        {
          params: [],
          text: "SELECT tgname AS name FROM pg_trigger WHERE tgrelid = 'schema_logs'::regclass AND NOT tgisinternal",
        },
        SYSTEM,
      );
      expect(triggers.map((trigger) => trigger.name)).toEqual(['lt_sync_stamp_v1']);
    });

    it('refuses to make an existing unique index live-only on its own: changed uniqueness is a migration', async () => {
      const codes = (sync: boolean) => {
        const model = describeSchema(
          'SchemaCode',
          new Schema({ code: { type: String, unique: true } }, { collection: 'schemaCodes' }),
        );
        return sync ? withSequenceField(withSyncDescriptor(model, resolveSyncOptions(true, 'SchemaCode')!)) : model;
      };
      await applyPostgresSchema(owner, [codes(false)], OPTIONS);
      const refusal = await applyPostgresSchema(owner, [codes(true)], OPTIONS).catch((error: unknown) => error);
      expect(refusal).toBeInstanceOf(SchemaMigrationRequiredError);
      expect(String((refusal as Error).message)).toMatch(/NULLS NOT DISTINCT WHERE \("deleted_at" IS NULL\)/);
    });
  });

  it('refuses system roles in a roles column, as the system-role policy does', async () => {
    await app.run(
      {
        params: [JSON.stringify(['admin', 'tenantAdmin'])],
        text: "INSERT INTO schema_members (id, roles) VALUES ('m1', $1)",
      },
      SYSTEM,
    );
    for (const roles of [['s_self'], [' S_USER'], ['admin', 'S_Creator']]) {
      await expect(
        app.run(
          { params: [JSON.stringify(roles)], text: "INSERT INTO schema_members (id, roles) VALUES ('m2', $1)" },
          SYSTEM,
        ),
        JSON.stringify(roles),
      ).rejects.toMatchObject({ code: '23514' });
    }
  });

  describe('the application role check', () => {
    const probe = `lt_probe_${process.pid}`;
    let admin: Client;

    beforeAll(async () => {
      admin = new Client({ connectionString: database.ownerUrl });
      await admin.connect();
      await admin.query(`CREATE ROLE "${probe}" LOGIN PASSWORD 'probe-secret' NOSUPERUSER NOBYPASSRLS`);
      await admin.query(`GRANT CONNECT ON DATABASE "${database.name}" TO "${probe}"`);
      await admin.query('CREATE TABLE probe_owned (id text PRIMARY KEY)');
      await admin.query(`ALTER TABLE probe_owned OWNER TO "${probe}"`);
      await admin.query('CREATE TABLE probe_truncate (id text PRIMARY KEY)');
    });

    afterAll(async () => {
      await admin.query('DROP TABLE IF EXISTS probe_owned, probe_truncate').catch(() => undefined);
      await admin.query(`DROP OWNED BY "${probe}"`).catch(() => undefined);
      await admin.query(`DROP ROLE IF EXISTS "${probe}"`).catch(() => undefined);
      await admin.end();
    });

    const asProbe = async (check: (executor: SqlExecutor) => Promise<void>) => {
      const executor = await createSqlExecutor({
        engine: 'typeorm',
        maxConnections: 1,
        url: postgresUrl({ password: 'probe-secret', user: probe }, database.name),
      });
      try {
        await check(executor);
      } finally {
        await executor.close();
      }
    };

    it('accepts the application role', async () => {
      await expect(assertSafeApplicationRole(app, ['schema_projects', 'schema_notes'])).resolves.toBeUndefined();
    });

    it('refuses a superuser', async () => {
      await expect(assertSafeApplicationRole(owner, ['schema_notes'])).rejects.toThrow(/is a superuser/);
    });

    /**
     * @regression   DEV-3829 (db-agnostic phase 1) — a table's owner may disable its row-level security, so an
     *   application role that owns a framework table can switch tenant isolation off from the app's connection.
     * @seen-failing Drop the ownership test from assertSafeApplicationRole() in
     *   src/core/common/persistence/sql/postgres/postgres-schema.migrator.ts — registered as mutation
     *   `sql-role-check-accepts-owner` in tests/regression-mutations.json.
     */
    it('refuses a role that owns a table', async () => {
      await asProbe((executor) =>
        expect(assertSafeApplicationRole(executor, ['probe_owned'])).rejects.toThrow(/owns .*probe_owned/),
      );
    });

    /**
     * @regression   DEV-3829 (db-agnostic phase 1, review) — a BYPASSRLS role reads and writes every tenant's rows
     *   whatever the policies say; the check refused it, and nothing pinned that.
     * @seen-failing Drop the BYPASSRLS test from assertSafeApplicationRole() in
     *   src/core/common/persistence/sql/postgres/postgres-schema.migrator.ts — registered as mutation
     *   `sql-role-check-accepts-bypassrls` in tests/regression-mutations.json.
     */
    it('refuses a role with BYPASSRLS', async () => {
      await admin.query(`ALTER ROLE "${probe}" BYPASSRLS`);
      try {
        // A table the probe neither owns nor may truncate: BYPASSRLS is the only reason left to refuse
        await asProbe((executor) =>
          expect(assertSafeApplicationRole(executor, ['schema_notes'])).rejects.toThrow(/has BYPASSRLS/),
        );
      } finally {
        await admin.query(`ALTER ROLE "${probe}" NOBYPASSRLS`);
      }
    });

    it('refuses a role that may TRUNCATE (which ignores row-level security)', async () => {
      await admin.query(`GRANT TRUNCATE ON probe_truncate TO "${probe}"`);
      await asProbe((executor) =>
        expect(assertSafeApplicationRole(executor, ['probe_truncate'])).rejects.toBeInstanceOf(UnsafeDatabaseRoleError),
      );
    });
  });
});
