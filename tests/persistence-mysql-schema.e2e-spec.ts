import { BadRequestException } from '@nestjs/common';
import { Schema } from 'mongoose';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { describeSchema } from '../src/core/common/persistence/model-metadata.registry';
import { MYSQL_ERRORS, MysqlDataStore } from '../src/core/common/persistence/sql/mysql/mysql-data-store';
import type { MysqlExecutor } from '../src/core/common/persistence/sql/mysql/mysql-executor';
import {
  applyMysqlSchema,
  assertSafeMysqlApplicationAccount,
  type MysqlSchemaOptions,
  mysqlAccount,
  verifyMysqlSchema,
} from '../src/core/common/persistence/sql/mysql/mysql-schema.migrator';
import type { MysqlVariant } from '../src/core/common/persistence/sql/mysql/mysql-session';
import { DuplicateKeyError } from '../src/core/common/persistence/sql/sql-errors';
import { createSqlExecutor } from '../src/core/common/persistence/sql/sql-executor.factory';
import type { SqlExecutor, SqlTenantScope } from '../src/core/common/persistence/sql/sql-executor.interface';
import {
  SchemaMigrationRequiredError,
  SchemaOutOfDateError,
  UnsafeDatabaseRoleError,
} from '../src/core/common/persistence/sql/sql-schema.shared';
import { runSqlMigration } from '../src/core/modules/migrate/sql-migration.helper';
import { createMysqlTestDatabase, MYSQL_APP, type MysqlTestDatabase, mysqlUrl } from './helpers/mysql-test-db';

/**
 * Framework-owned schema evolution on MySQL 8.4 and MariaDB 11.8 (plan phase 6), against real servers with the owner /
 * application account split every environment uses — the counterpart of `persistence-sql-schema.e2e-spec.ts`. There is
 * no row-level security to test here; what the database still guarantees is the shape of the tables: byte-wise text,
 * unique indexes that treat a missing value as a value, the roles check, and an application account that can change
 * none of it.
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
  code: { sparse: true, type: String, unique: true },
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
const MEMBER = describeSchema(
  'SchemaMember',
  new Schema({ name: String, roles: [String] }, { collection: 'schemaMembers' }),
);
const SYSTEM: SqlTenantScope = { kind: 'system' };

for (const variant of ['mysql', 'mariadb'] as MysqlVariant[]) {
  describe(`${variant} schema evolution (e2e)`, () => {
    let database: MysqlTestDatabase;
    let owner: SqlExecutor;
    let app: SqlExecutor;
    let options: MysqlSchemaOptions;

    const columns = async (table: string) =>
      Object.fromEntries(
        (
          await owner.run<{ collation: null | string; extra: string; name: string; type: string }>(
            {
              params: [table],
              text: `SELECT COLUMN_NAME AS name, COLUMN_TYPE AS type, COLLATION_NAME AS collation, EXTRA AS extra
                FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = $1`,
            },
            SYSTEM,
          )
        ).rows.map((row) => [row.name, row]),
      );
    const indexes = async (table: string) =>
      (
        await owner.run<{ name: string }>(
          {
            params: [table],
            text: `SELECT DISTINCT INDEX_NAME AS name FROM information_schema.STATISTICS
              WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = $1 AND INDEX_NAME <> 'PRIMARY'`,
          },
          SYSTEM,
        )
      ).rows
        .map((row) => row.name)
        .sort();

    beforeAll(async () => {
      database = await createMysqlTestDatabase(variant, 'mysql-schema');
      owner = await createSqlExecutor({ engine: 'typeorm', maxConnections: 2, url: database.ownerUrl });
      app = await createSqlExecutor({ engine: 'kysely', maxConnections: 2, url: database.appUrl });
      options = { appAccount: await mysqlAccount(app), variant };
    });

    afterAll(async () => {
      await app?.close();
      await owner?.close();
      await database?.drop();
    });

    /**
     * @regression   DEV-3848 (db-agnostic phase 6) — a declared text index made its field `varchar(255)`, although no
     *   text index is created on MySQL: values over 255 characters were refused for an index that does not exist.
     * @seen-failing Count every declared index as bounding its fields in desiredMysqlTable() of
     *   src/core/common/persistence/sql/mysql/mysql-schema.compiler.ts — registered as mutation
     *   `mysql-text-index-bounds-string` in tests/regression-mutations.json.
     */
    it('creates tables with typed, byte-wise columns, indexes and the database grant for the application', async () => {
      const changes = await applyMysqlSchema(owner, [project(PROJECT_FIELDS, PROJECT_INDEXES), MEMBER], options);
      expect(changes.filter((change) => change.kind === 'notice').map((change) => change.description)).toEqual([
        expect.stringMatching(/index \{"tags":1\} is not created .* \(an index over an array, JSON or binary field\)/),
        expect.stringMatching(/index \{"address.city":1\} is not created .* \(an index on a path inside/),
        expect.stringMatching(/index \{"title":"text"\} is not created .* \(text indexes have no counterpart\)/),
      ]);
      const json = variant === 'mysql' ? 'json' : 'longtext';
      expect(await columns('schema_projects')).toMatchObject({
        address: { type: json },
        archived: { type: 'tinyint(1)' },
        budget: { type: 'double' },
        id: { collation: 'utf8mb4_bin', type: 'varchar(255)' },
        // Indexed text is bounded, everything else is not
        name: { collation: 'utf8mb4_bin', type: 'varchar(255)' },
        owner_id: { collation: 'utf8mb4_bin', type: 'varchar(255)' },
        secret: { collation: 'utf8mb4_bin', type: 'varchar(255)' },
        tags: { type: json },
        title: { collation: 'utf8mb4_bin', type: 'longtext' },
        // The unique index on `name` reads a missing value as a value of its own; `code` is sparse and needs none
        lt_nn_name: { extra: expect.stringMatching(/VIRTUAL GENERATED/i) },
      });
      expect((await columns('schema_projects')).lt_nn_code).toBeUndefined();
      expect(await indexes('schema_projects')).toEqual([
        expect.stringMatching(/^ix_schema_projects__budget_name_/),
        // The lookup index beside the unique index on the null sentinel of `name`
        expect.stringMatching(/^ix_schema_projects__name_/),
        expect.stringMatching(/^ix_schema_projects__secret_/),
        expect.stringMatching(/^ux_schema_projects__code_/),
        expect.stringMatching(/^ux_schema_projects__name_/),
      ]);
      const grants = await owner.run<{ privilege: string }>(
        {
          params: [options.appAccount],
          text: `SELECT PRIVILEGE_TYPE AS privilege FROM information_schema.SCHEMA_PRIVILEGES
            WHERE GRANTEE = $1 AND TABLE_SCHEMA = DATABASE()`,
        },
        SYSTEM,
      );
      expect(grants.rows.map((row) => row.privilege).sort()).toEqual(['DELETE', 'INSERT', 'SELECT', 'UPDATE']);
    });

    it('changes nothing on a second run, and the application account finds it up to date', async () => {
      const models = [project(PROJECT_FIELDS, PROJECT_INDEXES), MEMBER];
      const again = await applyMysqlSchema(owner, models, options);
      expect(again.filter((change) => change.kind !== 'notice')).toEqual([]);
      await expect(verifyMysqlSchema(app, models, options)).resolves.toBeDefined();
    });

    it('lets two replicas migrate at once: one applies, the other finds nothing left', async () => {
      const models = [describeSchema('SchemaRace', new Schema({ name: String }, { collection: 'schemaRace' }))];
      const second = await createSqlExecutor({ engine: 'drizzle', maxConnections: 1, url: database.ownerUrl });
      try {
        const results = await Promise.all([
          applyMysqlSchema(owner, models, options),
          applyMysqlSchema(second, models, options),
        ]);
        expect(
          results.map((changes) => changes.some((change) => change.description.startsWith('create table'))),
        ).toEqual(expect.arrayContaining([true, false]));
      } finally {
        await second.close();
      }
    });

    it('adds a new column and a non-unique index automatically, and refuses to start without the owner', async () => {
      const v2 = project({ ...PROJECT_FIELDS, priority: { index: true, type: Number } }, PROJECT_INDEXES);
      await expect(verifyMysqlSchema(app, [v2], options)).rejects.toBeInstanceOf(SchemaOutOfDateError);

      const changes = await applyMysqlSchema(owner, [v2], options);
      expect(changes.filter((change) => change.kind === 'automatic').map((change) => change.description)).toEqual([
        'add column schema_projects.priority',
        expect.stringMatching(/^create index ix_schema_projects__priority_\w+ on schema_projects$/),
      ]);
      expect((await columns('schema_projects')).priority).toMatchObject({ type: 'double' });
      await expect(verifyMysqlSchema(app, [v2], options)).resolves.toBeDefined();
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
      const changes = await applyMysqlSchema(owner, [v3], options);
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
     * @regression   DEV-3848 (db-agnostic phase 6) — as on PostgreSQL, a changed column type or a new unique index on
     *   an existing table can fail on — or rewrite — the stored rows; both are a reviewed migration on MySQL too.
     * @seen-failing Plan a new unique index as automatic in
     *   src/core/common/persistence/sql/mysql/mysql-schema.migrator.ts — registered as mutation
     *   `mysql-unique-index-automatic` in tests/regression-mutations.json.
     */
    it('refuses a type change and a new unique index, and applies nothing of that run', async () => {
      const { title: _title, ...rest } = PROJECT_FIELDS;
      const base = { ...rest, headline: String, priority: Number };
      const unique = project(
        { ...base, extra: String, slug: { type: String, unique: true } },
        PROJECT_INDEXES.slice(0, 3),
      );
      await expect(applyMysqlSchema(owner, [unique], options)).rejects.toBeInstanceOf(SchemaMigrationRequiredError);

      const retyped = project({ ...base, budget: String, extra: String }, PROJECT_INDEXES.slice(0, 3));
      const failure = await applyMysqlSchema(owner, [retyped], options).catch((error) => error);
      expect(failure).toBeInstanceOf(SchemaMigrationRequiredError);
      expect((failure as SchemaMigrationRequiredError).changes.map((change) => change.description)).toEqual([
        'schema_projects.budget is double, the model asks for varchar(255) COLLATE utf8mb4_bin',
      ]);
      // Planned before anything is applied: the automatic part of the refused runs never ran
      expect((await columns('schema_projects')).extra).toBeUndefined();
      expect((await columns('schema_projects')).slug).toBeUndefined();
    });

    /**
     * @regression   DEV-3848 (db-agnostic phase 6) — MySQL and MariaDB allow any number of NULLs under a unique index,
     *   while a non-sparse MongoDB unique index (and PostgreSQL's NULLS NOT DISTINCT) admits one record without the
     *   value: a second user without an e-mail, or a second token without a hash, would be stored.
     * @seen-failing Leave the null sentinel out of desiredIndex() in
     *   src/core/common/persistence/sql/mysql/mysql-schema.compiler.ts — registered as mutation
     *   `mysql-unique-null-distinct` in tests/regression-mutations.json.
     */
    it('treats a missing value as a value under a unique index, and a sparse unique index as MongoDB does', async () => {
      const model = describeSchema(
        'SchemaUnique',
        new Schema(
          { code: { sparse: true, type: String, unique: true }, name: { type: String, unique: true } },
          { collection: 'schemaUnique' },
        ),
      );
      await applyMysqlSchema(owner, [model], options);
      const store = new MysqlDataStore<any>(app as MysqlExecutor, model);
      await store.insert({ code: 'a' });
      await expect(store.insert({ code: 'b' })).rejects.toBeInstanceOf(DuplicateKeyError);
      // Sparse: records without the value do not collide, a repeated value does
      await store.insert({ name: 'x' });
      await store.insert({ name: 'y' });
      await expect(store.insert({ code: 'a', name: 'z' })).rejects.toBeInstanceOf(DuplicateKeyError);
      await expect(store.insert({ name: 'x' })).rejects.toBeInstanceOf(DuplicateKeyError);
    });

    /**
     * @regression   DEV-3848 (db-agnostic phase 6, review) — the null sentinel of a new unique index was planned as a
     *   separate automatic change, which the refused boot never applied: the suggested CREATE UNIQUE INDEX named a column
     *   that did not exist, runSqlMigration() failed, and every later boot was refused again.
     * @seen-failing Leave the sentinel's ADD COLUMN out of the unique index's migration in planExistingTable() of
     *   src/core/common/persistence/sql/mysql/mysql-schema.migrator.ts — registered as mutation
     *   `mysql-unique-migration-without-sentinel` in tests/regression-mutations.json.
     *
     * @regression   DEV-3848 (db-agnostic phase 6, review) — a unique index on a null sentinel cannot serve a filter on
     *   the column itself: every lookup by such a field (an API token on every request, an MCP OAuth code, a sign-in by
     *   e-mail) scanned the table, and updateOne()/deleteOne() locked all of it.
     * @seen-failing Leave out the lookup index beside a unique index on null sentinels in
     *   src/core/common/persistence/sql/mysql/mysql-schema.compiler.ts — registered as mutation
     *   `mysql-unique-lookup-scans` in tests/regression-mutations.json.
     */
    it('makes an existing text field unique through the suggested migration, and finds by it through an index', async () => {
      const plain = describeSchema('SchemaSlug', new Schema({ slug: String }, { collection: 'schemaSlugs' }));
      await applyMysqlSchema(owner, [plain], options);
      await owner.run(
        { params: [], text: "INSERT INTO schema_slugs (id, slug) VALUES ('s1', 'a'), ('s2', NULL)" },
        SYSTEM,
      );

      const unique = describeSchema(
        'SchemaSlug',
        new Schema({ slug: { type: String, unique: true } }, { collection: 'schemaSlugs' }),
      );
      const refused = await applyMysqlSchema(owner, [unique], options).catch((error) => error);
      expect(refused).toBeInstanceOf(SchemaMigrationRequiredError);
      const statements = (refused as SchemaMigrationRequiredError).changes.flatMap((change) => change.statements);
      // Indexed, the field becomes varchar(255) — the documented type change — then its sentinel, then the index
      expect(statements).toEqual([
        expect.stringMatching(/MODIFY COLUMN `slug` varchar\(255\)/),
        expect.stringMatching(/ADD COLUMN `lt_nn_slug`/),
        expect.stringMatching(/^CREATE UNIQUE INDEX .*\(`lt_nn_slug`\)$/),
      ]);

      await runSqlMigration(database.ownerUrl, statements);
      const changes = await applyMysqlSchema(owner, [unique], options);
      expect(changes.filter((change) => change.kind === 'migration')).toEqual([]);

      const store = new MysqlDataStore<any>(app as MysqlExecutor, unique);
      await expect(store.insert({})).rejects.toBeInstanceOf(DuplicateKeyError);
      const plan = await owner.run<{ key: null | string }>(
        { params: [], text: "EXPLAIN SELECT id FROM schema_slugs WHERE slug = 'a'" },
        SYSTEM,
      );
      expect(plan.rows[0].key).toMatch(/^ix_schema_slugs__slug_/);
    });

    it('treats a partial unique index on "field exists" as sparse, and refuses any other partial unique index', async () => {
      const exists = new Schema({ code: String }, { collection: 'schemaPartial' });
      exists.index({ code: 1 }, { partialFilterExpression: { code: { $exists: true } }, unique: true });
      const model = describeSchema('SchemaPartial', exists);
      await applyMysqlSchema(owner, [model], options);
      const store = new MysqlDataStore<any>(app as MysqlExecutor, model);
      await store.insert({});
      await store.insert({});
      await store.insert({ code: 'a' });
      await expect(store.insert({ code: 'a' })).rejects.toBeInstanceOf(DuplicateKeyError);

      const other = new Schema({ code: String, kind: String }, { collection: 'schemaPartialOther' });
      other.index({ code: 1 }, { partialFilterExpression: { kind: 'active' }, unique: true });
      await expect(applyMysqlSchema(owner, [describeSchema('SchemaPartialOther', other)], options)).rejects.toThrow(
        /partial unique index .* has no MySQL \/ MariaDB counterpart/,
      );
    });

    it('refuses a value longer than an indexed text column takes (400), and keeps a long unindexed text', async () => {
      const model = describeSchema(
        'SchemaLong',
        new Schema({ body: String, key: { index: true, type: String } }, { collection: 'schemaLong' }),
      );
      await applyMysqlSchema(owner, [model], options);
      const store = new MysqlDataStore<any>(app as MysqlExecutor, model);
      const record = await store.insert({ body: 'b'.repeat(10_000), key: 'k'.repeat(255) });
      expect(record.body).toHaveLength(10_000);
      await expect(store.insert({ key: 'k'.repeat(256) })).rejects.toBeInstanceOf(BadRequestException);
    });

    /**
     * @regression   DEV-3848 (db-agnostic phase 6) — four indexed text fields exceed InnoDB's 3072-byte key limit
     *   (utf8mb4: 1020 bytes each), and the boot of every application with the AI module stopped at `ai_slots`.
     * @seen-failing Index the full columns in desiredIndex() of
     *   src/core/common/persistence/sql/mysql/mysql-schema.compiler.ts — registered as mutation
     *   `mysql-long-index-not-prefixed` in tests/regression-mutations.json.
     */
    it('indexes a prefix of each text field when a lookup index exceeds the key limit, and refuses such a unique index', async () => {
      const fields = { capability: String, key: String, locale: String, tenantId: String };
      const lookup = new Schema(fields, { collection: 'schemaSlots' });
      lookup.index({ key: 1, locale: 1, capability: 1, tenantId: 1 });
      await applyMysqlSchema(owner, [describeSchema('SchemaSlot', lookup)], options);
      expect(await indexes('schema_slots')).toEqual([expect.stringMatching(/^ix_schema_slots__key_locale_/)]);

      const unique = new Schema(fields, { collection: 'schemaSlotsUnique' });
      unique.index({ key: 1, locale: 1, capability: 1, tenantId: 1 }, { unique: true });
      await expect(applyMysqlSchema(owner, [describeSchema('SchemaSlotUnique', unique)], options)).rejects.toThrow(
        /needs \d+ bytes, more than the 3072/,
      );
    });

    /**
     * @regression   DEV-3848 (db-agnostic phase 6) — the system-role storage rule (11.35.0) is a CHECK on MySQL and
     *   MariaDB as well, below every write path the framework has.
     * @seen-failing Drop the roles CHECK from desiredMysqlTable() in
     *   src/core/common/persistence/sql/mysql/mysql-schema.compiler.ts — registered as mutation
     *   `mysql-roles-check-missing` in tests/regression-mutations.json.
     */
    it('refuses system roles in a roles column, as the system-role policy does', async () => {
      for (const [id, roles] of [
        ['m1', ['admin', 'tenantAdmin']],
        ['m2', ['boss_x', 'xs_y', 'S']],
      ] as const) {
        await app.run(
          { params: [id, JSON.stringify(roles)], text: 'INSERT INTO schema_members (id, roles) VALUES ($1, $2)' },
          SYSTEM,
        );
      }
      for (const roles of [['s_self'], [' S_USER'], ['admin', 'S_Creator'], ['\ts_tab'], [' s_nbsp']]) {
        const error = await app
          .run(
            { params: [JSON.stringify(roles)], text: "INSERT INTO schema_members (id, roles) VALUES ('m3', $1)" },
            SYSTEM,
          )
          .then(
            () => undefined,
            (caught: { errno?: number }) => caught,
          );
        expect(error?.errno, JSON.stringify(roles)).toBe(MYSQL_ERRORS.checkFailed[variant]);
      }
    });

    /**
     * @regression   DEV-3848 (db-agnostic phase 6) — without row-level security the framework's tables and constraints
     *   are what its policies rely on, so the application account may change none of them.
     * @seen-failing Accept every privilege in assertSafeMysqlApplicationAccount() of
     *   src/core/common/persistence/sql/mysql/mysql-schema.migrator.ts — registered as mutation
     *   `mysql-app-account-ddl-accepted` in tests/regression-mutations.json.
     */
    it('accepts the application account and refuses one that may change the schema', async () => {
      await expect(assertSafeMysqlApplicationAccount(app, variant)).resolves.toBeUndefined();
      await expect(assertSafeMysqlApplicationAccount(owner, variant)).rejects.toThrow(
        /holds .*ALTER.*DROP.*SELECT, INSERT, UPDATE and DELETE/s,
      );
      await expect(assertSafeMysqlApplicationAccount(owner, variant)).rejects.toBeInstanceOf(UnsafeDatabaseRoleError);
    });

    it('refuses a URL scheme that names the other server', async () => {
      const other: MysqlVariant = variant === 'mysql' ? 'mariadb' : 'mysql';
      // The other scheme against this server: the account is the same, the claim about the server is not
      const mismatched = await createSqlExecutor({
        engine: 'kysely',
        maxConnections: 1,
        url: mysqlUrl(variant, MYSQL_APP, database.name).replace(/^(mysql|mariadb):/, `${other}:`),
      });
      try {
        await expect(assertSafeMysqlApplicationAccount(mismatched, other)).rejects.toThrow(
          new RegExp(`use the ${variant}:// scheme`),
        );
      } finally {
        await mismatched.close();
      }
    });
  });
}
