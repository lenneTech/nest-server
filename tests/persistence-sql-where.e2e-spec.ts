import mongoose, { Schema, Types } from 'mongoose';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { Where } from '../src/core/common/persistence/data-store.interface';
import { describeSchema } from '../src/core/common/persistence/model-metadata.registry';
import { MongooseDataStore } from '../src/core/common/persistence/mongoose-data-store';
import { compileMysqlWhere } from '../src/core/common/persistence/sql/mysql/mysql-where.compiler';
import type { MysqlVariant } from '../src/core/common/persistence/sql/mysql/mysql-session';
import { compilePostgresWhere } from '../src/core/common/persistence/sql/postgres/postgres-where.compiler';
import { QueryCastError, UnsupportedQueryError } from '../src/core/common/persistence/sql/sql-errors';
import { createSqlExecutor } from '../src/core/common/persistence/sql/sql-executor.factory';
import type { SqlExecutor } from '../src/core/common/persistence/sql/sql-executor.interface';
import { columnName, SqlParams } from '../src/core/common/persistence/sql/sql-naming';
import { deriveTestDbUri } from './db-lifecycle.reporter';
import { createMysqlTestDatabase, type MysqlTestDatabase } from './helpers/mysql-test-db';
import { createPostgresTestDatabase, type PostgresTestDatabase } from './helpers/postgres-test-db';

/**
 * Filter parity (plan §3.2, A2): the same neutral filter against the same records answers with the same ids on
 * MongoDB — through `MongooseDataStore`, so Mongoose casts the values as it does for every CrudService call — and on
 * PostgreSQL, MySQL 8.4 and MariaDB 11.8 through their Where compilers (phase 6). The SQL rows are written FROM the
 * stored MongoDB documents, so every side holds identical data, schema defaults included.
 *
 * The tables are written by hand, so the compilers are proven apart from the schema compilers; their string columns
 * compare byte-wise (`COLLATE "C"`, `utf8mb4_bin`) because MongoDB does — the schema compilers do the same.
 */
const Address = new Schema({ city: String, floor: Number, zip: String }, { _id: false });
const Contact = new Schema({ kind: String, primary: Boolean, value: String }, { _id: false });
const PersonSchema = new Schema({
  active: Boolean,
  address: Address,
  age: Number,
  contacts: [Contact],
  createdAt: Date,
  email: { lowercase: true, trim: true, type: String },
  meta: Schema.Types.Mixed,
  name: String,
  ownerId: { ref: 'User', type: Schema.Types.ObjectId },
  roles: [String],
  score: Number,
  status: { enum: ['active', 'blocked', 'pending'], type: String },
  tags: [String],
});
const descriptor = describeSchema('WherePerson', PersonSchema);

const id = (n: number) => `00000000000000000000000${n}`;
const OWNER = '65a1b2c3d4e5f60718293a4b';
const d = (iso: string) => new Date(iso);
const PEOPLE = [
  {
    _id: id(1),
    active: true,
    address: { city: 'Berlin', floor: 3, zip: '10115' },
    age: 31,
    contacts: [{ kind: 'mail', primary: true, value: 'a@test.com' }],
    createdAt: d('2026-01-01'),
    email: 'Anna@Test.com',
    meta: { level: 3, tags: ['x', 'y'] },
    name: 'Anna',
    ownerId: OWNER,
    roles: ['admin'],
    score: 9.5,
    status: 'active',
    tags: ['a', 'b'],
  },
  {
    _id: id(2),
    active: false,
    address: { city: 'Köln', zip: '50667' },
    age: 45,
    contacts: [],
    createdAt: d('2026-02-01'),
    email: 'bernd@test.com',
    meta: { level: 1 },
    name: 'Bernd',
    roles: [],
    score: null,
    status: 'blocked',
    tags: ['b'],
  },
  {
    _id: id(3),
    active: true,
    address: { city: 'berlin', floor: 0 },
    age: 22,
    contacts: [
      { kind: 'phone', primary: false, value: '123' },
      { kind: 'mail', primary: false, value: 'c@test.com' },
    ],
    createdAt: d('2026-03-01'),
    meta: { level: 'high', tags: 'x' },
    name: 'carla',
    roles: ['editor'],
    tags: [],
  },
  {
    _id: id(4),
    active: true,
    age: null,
    contacts: [{ value: 'no-kind' }],
    createdAt: d('2026-04-01'),
    name: 'Dora',
    ownerId: OWNER,
    roles: ['admin', 'editor'],
    score: 3,
    status: 'pending',
    tags: ['c', 'a'],
  },
  {
    _id: id(5),
    active: false,
    address: { city: 'Hamburg', floor: 12, zip: '20095' },
    createdAt: d('2026-05-01'),
    email: 'emil@test.com',
    name: 'Emil',
    roles: ['viewer'],
    score: 7,
    tags: ['a'],
  },
  {
    _id: id(6),
    active: true,
    address: null,
    age: 60,
    createdAt: d('2026-06-01'),
    name: 'Frida',
    roles: [],
    score: 1,
    tags: ['d'],
  },
];

interface ParityCase {
  /** Asserted difference on every SQL database, with the reason */
  differentByDesign?: { reason: string; sql: number[] };
  name: string;
  where: Where;
}

const CASES: ParityCase[] = [
  { name: 'equality', where: { name: 'Anna' } },
  { name: '$ne includes missing and null', where: { age: { $ne: 31 } } },
  { name: 'null matches null and missing', where: { age: null } },
  { name: 'undefined reads like null', where: { age: undefined } },
  { name: '$ne null', where: { age: { $ne: null } } },
  { name: '$gt + $lte', where: { age: { $gt: 25, $lte: 45 } } },
  { name: '$in on a column', where: { name: { $in: ['Anna', 'Emil', 'X'] } } },
  { name: '$in with null', where: { score: { $in: [null, 7] } } },
  { name: '$in with a regular expression', where: { name: { $in: [/^a/i, 'Emil'] } } },
  { name: '$nin includes missing', where: { age: { $nin: [31, 45] } } },
  { name: 'boolean', where: { active: false } },
  { name: 'date range', where: { createdAt: { $gte: d('2026-02-01'), $lt: d('2026-05-01') } } },
  { name: 'date equality', where: { createdAt: d('2026-03-01') } },
  { name: 'string range compares byte-wise', where: { name: { $gt: 'Z' } } },
  { name: 'id', where: { id: id(2) } },
  { name: 'id $in', where: { id: { $in: [id(2), id(6)] } } },
  { name: 'id as an ObjectId', where: { id: new Types.ObjectId(id(3)) } },
  { name: 'reference as an ObjectId', where: { ownerId: new Types.ObjectId(OWNER) } },
  { name: 'reference as a string', where: { ownerId: OWNER } },
  { name: 'enum $in', where: { status: { $in: ['active', 'pending'] } } },
  { name: 'cast: numeric string', where: { age: '31' } },
  { name: 'cast: boolean word', where: { active: 'yes' } },
  { name: 'cast: date string', where: { createdAt: { $gte: '2026-04-01' } } },
  { name: 'setters: lowercase and trim on equality', where: { email: '  ANNA@Test.com ' } },
  { name: 'setters: lowercase on $in', where: { email: { $in: ['BERND@TEST.COM'] } } },
  { name: 'no setters on $regex', where: { email: { $regex: 'ANNA' } } },
  { name: 'regex with options', where: { email: { $options: 'i', $regex: '^ANNA' } } },
  { name: 'regex case-insensitive', where: { name: { $options: 'i', $regex: '^[ab]' } } },
  { name: 'RegExp object', where: { name: /a$/ } },
  { name: '$not with a RegExp', where: { name: { $not: /^a/i } } },
  { name: 'array contains an element', where: { tags: 'a' } },
  { name: 'array equals an array', where: { tags: ['a', 'b'] } },
  { name: 'array $in', where: { tags: { $in: ['c', 'd'] } } },
  { name: 'array $all', where: { tags: { $all: ['a', 'b'] } } },
  { name: 'array $size', where: { roles: { $size: 0 } } },
  { name: 'array $nin', where: { roles: { $nin: ['admin'] } } },
  { name: 'array $ne element', where: { roles: { $ne: 'editor' } } },
  { name: 'array range: any item', where: { tags: { $gte: 'c' } } },
  { name: 'array $elemMatch with operators', where: { tags: { $elemMatch: { $gte: 'b', $lt: 'd' } } } },
  { name: 'nested path', where: { 'address.city': 'Berlin' } },
  { name: 'nested regex', where: { 'address.city': { $options: 'i', $regex: '^berlin$' } } },
  { name: 'nested range', where: { 'address.floor': { $gte: 3 } } },
  { name: 'nested cast', where: { 'address.floor': '12' } },
  { name: 'nested $exists false', where: { 'address.zip': { $exists: false } } },
  { name: 'nested null', where: { 'address.zip': null } },
  { name: 'embedded object equality', where: { address: { city: 'Berlin', floor: 3, zip: '10115' } } },
  { name: 'path into array items', where: { 'contacts.kind': 'mail' } },
  { name: 'path into array items: $ne', where: { 'contacts.kind': { $ne: 'mail' } } },
  { name: 'path into array items: boolean', where: { 'contacts.primary': true } },
  { name: 'path into array items: regex', where: { 'contacts.value': { $regex: '@test' } } },
  { name: 'path into array items: $exists false', where: { 'contacts.kind': { $exists: false } } },
  { name: 'path into array items: $in', where: { 'contacts.kind': { $in: ['phone', 'fax'] } } },
  { name: '$elemMatch on objects', where: { contacts: { $elemMatch: { kind: 'mail', primary: false } } } },
  { name: '$elemMatch with $or', where: { contacts: { $elemMatch: { $or: [{ kind: 'phone' }, { primary: true }] } } } },
  { name: 'array of objects $size', where: { contacts: { $size: 2 } } },
  { name: 'array item equality', where: { contacts: { kind: 'mail', primary: true, value: 'a@test.com' } } },
  // Mongoose casts the object through the item schema, which puts its keys in schema order
  {
    name: 'array item equality in another key order',
    where: { contacts: { primary: true, value: 'a@test.com', kind: 'mail' } },
  },
  { name: 'undeclared content: path', where: { 'meta.level': 3 } },
  { name: 'undeclared content: range only within a type', where: { 'meta.level': { $gt: 2 } } },
  { name: 'undeclared content: array contains', where: { 'meta.tags': 'x' } },
  { name: 'undeclared content: regex reaches array items', where: { 'meta.tags': { $regex: '^y' } } },
  { name: 'undeclared content: $exists', where: { meta: { $exists: true } } },
  { name: '$or', where: { $or: [{ age: { $lt: 25 } }, { tags: 'd' }] } },
  { name: '$and + $or', where: { $or: [{ roles: 'admin' }, { 'address.city': 'berlin' }], active: true } },
  { name: '$nor', where: { $nor: [{ active: false }, { tags: 'a' }] } },
  { name: '$not with operators', where: { age: { $not: { $gt: 30 } } } },
  { name: 'empty filter', where: {} },
  {
    differentByDesign: { reason: 'a column cannot tell a stored null from an absent value', sql: [1, 2, 3, 6] },
    name: '$exists on a column',
    where: { age: { $exists: true } },
  },
];

const MYSQL_VARIANTS: MysqlVariant[] = ['mysql', 'mariadb'];

/** The value of a stored document's field as a SQL column receives it */
function columnValue(key: string, value: unknown): unknown {
  if (value === null || value === undefined) return null;
  if (key === '_id' || key === 'ownerId') return String(value);
  return descriptor.fields[key].isArray || ['json', 'object'].includes(descriptor.fields[key].kind)
    ? JSON.stringify(value)
    : value;
}

describe('Where parity — MongoDB vs PostgreSQL, MySQL and MariaDB (e2e)', () => {
  let connection: mongoose.Connection;
  let store: MongooseDataStore;
  let database: PostgresTestDatabase;
  let executor: SqlExecutor;
  const mysqlDatabases = new Map<MysqlVariant, MysqlTestDatabase>();
  const mysqlExecutors = new Map<MysqlVariant, SqlExecutor>();

  beforeAll(async () => {
    connection = await mongoose.createConnection(deriveTestDbUri('sql-where')).asPromise();
    const model = connection.model('WherePerson', PersonSchema);
    await model.deleteMany({});
    await model.insertMany(PEOPLE);
    store = new MongooseDataStore(model);
    // The rows are what MongoDB stored, so defaults and casts are identical on every side
    const docs = (await model.find().lean()).map((doc) => Object.entries(doc).filter(([key]) => key !== '__v'));

    database = await createPostgresTestDatabase('sql-where');
    const owner = await createSqlExecutor({ engine: 'typeorm', maxConnections: 1, url: database.ownerUrl });
    try {
      await owner.run(
        {
          params: [],
          text: `CREATE TABLE where_person (
            id text PRIMARY KEY, active boolean, address jsonb, age double precision, contacts jsonb,
            created_at timestamptz, email text COLLATE "C", meta jsonb, name text COLLATE "C", owner_id text,
            roles jsonb, score double precision, status text COLLATE "C", tags jsonb)`,
        },
        { kind: 'system' },
      );
      await owner.run(
        { params: [], text: `GRANT SELECT ON where_person TO "${new URL(database.appUrl).username}"` },
        { kind: 'system' },
      );
      for (const entries of docs) {
        const columns = entries.map(([key]) => `"${columnName(key)}"`);
        const values = entries.map(([key, value]) => columnValue(key, value));
        await owner.run(
          {
            params: values,
            text: `INSERT INTO where_person (${columns.join(', ')}) VALUES (${values.map((_v, i) => `$${i + 1}`).join(', ')})`,
          },
          { kind: 'system' },
        );
      }
    } finally {
      await owner.close();
    }
    executor = await createSqlExecutor({ engine: 'typeorm', maxConnections: 2, url: database.appUrl });

    for (const variant of MYSQL_VARIANTS) {
      const mysqlDatabase = await createMysqlTestDatabase(variant, 'sql-where');
      mysqlDatabases.set(variant, mysqlDatabase);
      const mysqlOwner = await createSqlExecutor({ engine: 'typeorm', maxConnections: 1, url: mysqlDatabase.ownerUrl });
      try {
        await mysqlOwner.run(
          {
            params: [],
            text: `CREATE TABLE where_person (
              id varchar(24) PRIMARY KEY, active tinyint(1), address json, age double, contacts json,
              created_at datetime(3), email varchar(255), meta json, name varchar(255), owner_id varchar(24),
              roles json, score double, status varchar(255), tags json) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin`,
          },
          { kind: 'system' },
        );
        for (const entries of docs) {
          const columns = entries.map(([key]) => `\`${columnName(key)}\``);
          const values = entries.map(([key, value]) => columnValue(key, value));
          await mysqlOwner.run(
            {
              params: values,
              text: `INSERT INTO where_person (${columns.join(', ')}) VALUES (${values.map((_v, i) => `$${i + 1}`).join(', ')})`,
            },
            { kind: 'system' },
          );
        }
      } finally {
        await mysqlOwner.close();
      }
      mysqlExecutors.set(
        variant,
        await createSqlExecutor({ engine: 'typeorm', maxConnections: 2, url: mysqlDatabase.appUrl }),
      );
    }
  });

  afterAll(async () => {
    await connection?.dropDatabase();
    await connection?.close();
    await executor?.close();
    await database?.drop();
    for (const variant of MYSQL_VARIANTS) {
      await mysqlExecutors.get(variant)?.close();
      await mysqlDatabases.get(variant)?.drop();
    }
  });

  async function postgresIds(where: Where): Promise<string[]> {
    const params = new SqlParams();
    const condition = compilePostgresWhere(descriptor, where, params, { alias: 't' });
    const { rows } = await executor.run<{ id: string }>(
      { params: params.values, text: `SELECT t.id FROM where_person t WHERE ${condition}` },
      { kind: 'none' },
    );
    return rows.map((row) => row.id).sort();
  }

  async function mysqlIds(variant: MysqlVariant, where: Where): Promise<string[]> {
    const params = new SqlParams();
    const condition = compileMysqlWhere(variant, descriptor, where, params, { alias: 't' });
    const { rows } = await mysqlExecutors
      .get(variant)!
      .run<{ id: string }>(
        { params: params.values, text: `SELECT t.id FROM where_person t WHERE ${condition}` },
        { kind: 'none' },
      );
    return rows.map((row) => row.id).sort();
  }

  /** Every SQL database's answer, keyed by database */
  async function sqlIds(where: Where): Promise<Record<string, string[]>> {
    return {
      mariadb: await mysqlIds('mariadb', where),
      mysql: await mysqlIds('mysql', where),
      postgres: await postgresIds(where),
    };
  }

  /**
   * @regression   DEV-3829 (db-agnostic phase 1) — `$ne` compiled as `NOT (a = $1)` is NULL for a missing value, so
   *   a record without the field disappears from a `$ne` read that MongoDB returns.
   * @seen-failing Drop the COALESCE around the `$ne` equality in
   *   src/core/common/persistence/sql/postgres/postgres-where.compiler.ts — registered as mutation
   *   `sql-where-ne-excludes-missing` in tests/regression-mutations.json.
   *
   * @regression   DEV-3848 (db-agnostic phase 6) — MySQL 8.4 rewrites `EXISTS` over a `JSON_TABLE` that reads the outer
   *   row into a semi-join and then finds nothing: every "any array item matches" filter answered with no rows.
   * @seen-failing Compile `anyItem()` as `EXISTS (SELECT 1 …)` in
   *   src/core/common/persistence/sql/mysql/mysql-where.compiler.ts — registered as mutation
   *   `mysql-where-exists-semijoin` in tests/regression-mutations.json.
   */
  it.each(CASES)('$name', async ({ differentByDesign, where }) => {
    const mongo = (await store.find(where)).map((record) => record.id).sort();
    const sql = await sqlIds(where);
    const expected = differentByDesign ? differentByDesign.sql.map(id) : mongo;
    expect(sql).toEqual({ mariadb: expected, mysql: expected, postgres: expected });
    if (differentByDesign) {
      expect(mongo).not.toEqual(expected);
    }
  });

  it('refuses a value both databases refuse to cast', async () => {
    for (const where of [{ age: 'abc' }, { id: 'not-an-id' }, { createdAt: 'yesterday' }, { active: 'maybe' }]) {
      await expect(store.find(where)).rejects.toMatchObject({ name: 'CastError' });
      await expect(postgresIds(where)).rejects.toBeInstanceOf(QueryCastError);
      for (const variant of MYSQL_VARIANTS) {
        await expect(mysqlIds(variant, where)).rejects.toBeInstanceOf(QueryCastError);
      }
    }
  });

  it('refuses what it cannot express instead of dropping it', async () => {
    for (const where of [
      { unknownField: 1 },
      { 'address.x;drop': 1 },
      { 'address.unknown': 1 },
      { 'name.first': 'x' },
      { 'tags.0': 'a' },
      { $where: 'this.a' },
      { name: { $text: 'x' } },
      { name: { $gt: 'a', other: 1 } },
      { $or: [] },
      { name: { $eq: /x/ } },
      { age: { $regex: '1' } },
    ] as Where[]) {
      await expect(postgresIds(where), JSON.stringify(where)).rejects.toBeInstanceOf(UnsupportedQueryError);
      for (const variant of MYSQL_VARIANTS) {
        await expect(mysqlIds(variant, where), JSON.stringify(where)).rejects.toBeInstanceOf(UnsupportedQueryError);
      }
    }
  });
});
