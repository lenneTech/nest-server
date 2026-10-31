import { BadRequestException } from '@nestjs/common';
import mongoose from 'mongoose';
import { describe, expect, it } from 'vitest';

import { generateUuidV7, isUuidV7 } from '../../src/core/common/persistence/id-format';
import { describeSchema, registerModelSchema } from '../../src/core/common/persistence/model-metadata.registry';
import { applySyncSchema, isSyncSchema } from '../../src/core/common/persistence/mongo/sync-schema.plugin';
import {
  assertClientId,
  insertWithServerId,
  SERVER_ID_ATTEMPTS,
  syncInsertRecord,
  tombstoneClearedFields,
} from '../../src/core/common/persistence/policies/sync.policy';
import {
  desiredMysqlTable,
  mysqlSyncTableStatements,
} from '../../src/core/common/persistence/sql/mysql/mysql-schema.compiler';
import {
  desiredTable,
  SYNC_TRIGGER,
  syncTableStatements,
} from '../../src/core/common/persistence/sql/postgres/postgres-schema.compiler';
import {
  isLiveFilter,
  liveUniqueIndex,
  resolveSyncOptions,
  withSequenceField,
  withSyncDescriptor,
} from '../../src/core/common/persistence/sync-model';

/**
 * Synchronized models (offline sync, DEV-3900): the declaration, the descriptor it produces, the MongoDB schema the
 * plugin prepares, and the SQL schema both compilers derive from the descriptor. The behaviour on every database is
 * the persistence parity matrix's (`tests/helpers/persistence-matrix.ts`, the `sync-*` cases).
 */
const notesSchema = () =>
  new mongoose.Schema(
    {
      code: { sparse: true, type: String, unique: true },
      expiresAt: Date,
      handle: { type: String, unique: true },
      name: String,
      ownerId: String,
      tenantId: String,
    },
    { timestamps: true },
  );

const SYNC = resolveSyncOptions({ scope: ['ownerId'] }, 'Note')!;
const PG = { appRole: 'nest_app', isTenantIsolated: () => true };

describe('synchronized models', () => {
  describe('resolveSyncOptions', () => {
    it('reads true and an options object, and nothing for an undeclared model', () => {
      expect(resolveSyncOptions(undefined, 'Note')).toBeUndefined();
      expect(resolveSyncOptions(false, 'Note')).toBeUndefined();
      expect(resolveSyncOptions(true, 'Note')).toEqual({ idFormat: 'objectId', scope: [] });
      expect(resolveSyncOptions({ idFormat: 'uuidv7', scope: ['ownerId'] }, 'Note')).toEqual({
        idFormat: 'uuidv7',
        scope: ['ownerId'],
      });
    });

    it('refuses an unknown id format and a malformed scope', () => {
      expect(() => resolveSyncOptions({ idFormat: 'uuid' as any }, 'Note')).toThrow(/idFormat/);
      expect(() => resolveSyncOptions({ scope: [''] }, 'Note')).toThrow(/scope/);
      expect(() => resolveSyncOptions({ scope: 'ownerId' as any }, 'Note')).toThrow(/scope/);
    });
  });

  describe('withSyncDescriptor', () => {
    it('adds version and deletedAt, keeps every declared field and marks the descriptor', () => {
      const declared = describeSchema('Note', notesSchema());
      const descriptor = withSyncDescriptor(declared, SYNC);
      expect(descriptor.sync).toEqual(SYNC);
      expect(descriptor.fields.version).toMatchObject({ default: 1, hasDefault: true, kind: 'number' });
      expect(descriptor.fields.deletedAt).toMatchObject({ default: null, hasDefault: true, kind: 'date' });
      expect(Object.keys(descriptor.fields)).toEqual(expect.arrayContaining(Object.keys(declared.fields)));
      // The change position is the dialect's own column, never part of the neutral descriptor
      expect(descriptor.fields).not.toHaveProperty('syncSeq');
      expect(descriptor.fields).not.toHaveProperty('syncAt');
    });

    it('restricts every unique index to live records; a sparse one keeps its meaning through $exists', () => {
      const descriptor = withSyncDescriptor(describeSchema('Note', notesSchema()), SYNC);
      const byField = (field: string) => descriptor.indexes.find((index) => field in index.fields)!;
      expect(byField('handle').options).toMatchObject({ partialFilterExpression: { deletedAt: null }, unique: true });
      expect(byField('code').options).toEqual({
        partialFilterExpression: { code: { $exists: true }, deletedAt: null },
        unique: true,
      });
      expect(byField('code').options).not.toHaveProperty('sparse');
      expect(liveUniqueIndex({ fields: { name: 1 }, options: {} })).toEqual({ fields: { name: 1 }, options: {} });
    });

    it('types the id as uuid for a uuidv7 model', () => {
      const descriptor = withSyncDescriptor(describeSchema('Note', notesSchema()), { idFormat: 'uuidv7', scope: [] });
      expect(descriptor.fields._id.kind).toBe('uuid');
    });

    it('refuses a system field name, an unknown scope field and a TTL', () => {
      const withVersion = new mongoose.Schema({ name: String, version: Number });
      expect(() => withSyncDescriptor(describeSchema('Note', withVersion), SYNC)).toThrow(/reserved/);
      expect(() =>
        withSyncDescriptor(describeSchema('Note', notesSchema()), { idFormat: 'objectId', scope: ['nobody'] }),
      ).toThrow(/scope/);
      const expiring = notesSchema();
      expiring.index({ expiresAt: 1 }, { expireAfterSeconds: 60 });
      expect(() => withSyncDescriptor(describeSchema('Note', expiring), SYNC)).toThrow(/TTL/);
    });

    it('withSequenceField adds the commit-ordered position and its index led by the tenant, for SQL only', () => {
      const descriptor = withSequenceField(withSyncDescriptor(describeSchema('Note', notesSchema()), SYNC));
      expect(descriptor.fields.syncSeq).toMatchObject({ hasDefault: false, kind: 'bigint' });
      expect(descriptor.indexes.at(-1)).toEqual({ fields: { syncSeq: 1, tenantId: 1 }, options: {} });
      expect(Object.keys(descriptor.indexes.at(-1)!.fields)).toEqual(['tenantId', 'syncSeq']);
      const plain = describeSchema('Plain', new mongoose.Schema({ name: String }));
      expect(withSequenceField(plain)).toBe(plain);
    });

    it('isLiveFilter recognises exactly the live-record condition', () => {
      expect(isLiveFilter({ deletedAt: null })).toBe(true);
      expect(isLiveFilter({ code: { $exists: true }, deletedAt: null })).toBe(false);
      expect(isLiveFilter({ deletedAt: { $type: 'null' } })).toBe(false);
      expect(isLiveFilter(undefined)).toBe(false);
    });
  });

  describe('the MongoDB schema (applySyncSchema)', () => {
    it('adds the system paths, rewrites the unique indexes like the descriptor and adds the keyset index', () => {
      const schema = notesSchema();
      const declared = registerModelSchema('SyncedNote', schema, SYNC);
      applySyncSchema(schema, SYNC);
      expect(isSyncSchema(schema)).toBe(true);
      for (const path of ['version', 'deletedAt', 'syncAt']) {
        expect(schema.path(path)).toBeDefined();
      }
      const indexes = schema.indexes();
      // The same unique indexes the descriptor (and so every SQL table) has
      for (const index of declared.indexes) {
        expect(indexes).toContainEqual([index.fields, expect.objectContaining(index.options)]);
      }
      expect(indexes.map(([fields]) => Object.keys(fields))).toContainEqual(['tenantId', 'syncAt', '_id']);
      expect(indexes.filter(([, options]) => options?.unique && !options.partialFilterExpression)).toEqual([]);
    });

    it('is idempotent, and a second registration still describes the declared schema', () => {
      const schema = notesSchema();
      const first = registerModelSchema('TwiceNote', schema, SYNC);
      applySyncSchema(schema, SYNC);
      const count = schema.indexes().length;
      applySyncSchema(schema, SYNC);
      expect(schema.indexes()).toHaveLength(count);
      expect(registerModelSchema('TwiceNote', schema, SYNC)).toEqual(first);
    });

    it('gives a uuidv7 model a UUID id that defaults to a fresh uuidv7', () => {
      const schema = notesSchema();
      applySyncSchema(schema, { idFormat: 'uuidv7', scope: [] });
      expect(schema.path('_id').instance).toBe('UUID');
      const Model = mongoose.model(`UuidNote${Date.now()}`, schema);
      expect(isUuidV7(String(new Model({ name: 'a' })._id))).toBe(true);
    });
  });

  describe('ids', () => {
    it('generateUuidV7 writes the version, the variant and the time, in lowercase', () => {
      const before = Date.now();
      const id = generateUuidV7();
      expect(isUuidV7(id)).toBe(true);
      expect(id[14]).toBe('7');
      expect('89ab').toContain(id[19]);
      const millis = Number.parseInt(id.replace(/-/g, '').slice(0, 12), 16);
      expect(millis).toBeGreaterThanOrEqual(before);
      expect(millis).toBeLessThanOrEqual(Date.now());
      expect(new Set(Array.from({ length: 100 }, () => generateUuidV7())).size).toBe(100);
    });

    it('isUuidV7 accepts only the stored form', () => {
      const id = generateUuidV7();
      expect(isUuidV7(id.toUpperCase())).toBe(false);
      expect(isUuidV7(id.replace(/-/g, ''))).toBe(false);
      expect(isUuidV7('0190f8b4-3c7a-4d2e-9b1f-2a3c4d5e6f70')).toBe(false);
      expect(isUuidV7('0190f8b4-3c7a-7d2e-cb1f-2a3c4d5e6f70')).toBe(false);
    });

    it('assertClientId keeps an id in the model format and refuses any other with 400', () => {
      expect(assertClientId('6720C0AABBCCDDEEFF001122', 'objectId', 'Note')).toBe('6720c0aabbccddeeff001122');
      const uuid = generateUuidV7();
      expect(assertClientId(uuid, 'uuidv7', 'Note')).toBe(uuid);
      expect(() => assertClientId(uuid, 'objectId', 'Note')).toThrow(BadRequestException);
      expect(() => assertClientId('6720c0aabbccddeeff001122', 'uuidv7', 'Note')).toThrow(BadRequestException);
      expect(() => assertClientId({}, 'objectId', 'Note')).toThrow(BadRequestException);
    });

    it('insertWithServerId replaces a taken server id, a bounded number of times, and nothing else', async () => {
      const taken = Object.assign(new Error('taken'), { taken: true });
      const ids: string[] = [];
      const result = await insertWithServerId(
        'objectId',
        async (id) => {
          ids.push(id);
          if (ids.length < SERVER_ID_ATTEMPTS) {
            throw taken;
          }
          return id;
        },
        (error) => (error as { taken?: boolean }).taken === true,
      );
      expect(new Set(ids).size).toBe(SERVER_ID_ATTEMPTS);
      expect(result).toBe(ids.at(-1));

      let calls = 0;
      await expect(
        insertWithServerId(
          'objectId',
          async () => {
            calls++;
            throw taken;
          },
          () => true,
        ),
      ).rejects.toBe(taken);
      expect(calls).toBe(SERVER_ID_ATTEMPTS);

      calls = 0;
      const other = new Error('other');
      await expect(
        insertWithServerId(
          'uuidv7',
          async () => {
            calls++;
            throw other;
          },
          () => false,
        ),
      ).rejects.toBe(other);
      expect(calls).toBe(1);
    });
  });

  describe('write rules', () => {
    it('an insert record carries the store system fields, whatever the caller sent', () => {
      expect(syncInsertRecord({ deletedAt: new Date(), name: 'a', syncAt: 1, syncSeq: 2, version: 9 })).toEqual({
        deletedAt: null,
        name: 'a',
        version: 1,
      });
    });

    it('a tombstone clears the content, never the id, system, audit, tenant or scope fields', () => {
      const fields = ['_id', 'code', 'createdAt', 'createdBy', 'deletedAt', 'handle', 'name', 'ownerId', 'tenantId'];
      expect(tombstoneClearedFields([...fields, 'updatedAt', 'updatedBy', 'version'], SYNC)).toEqual([
        'code',
        'handle',
        'name',
      ]);
    });
  });

  describe('SQL schema', () => {
    const descriptor = () =>
      withSequenceField(withSyncDescriptor(describeSchema('Note', notesSchema()), resolveSyncOptions(true, 'Note')!));

    it('PostgreSQL: a live unique index keeps NULLS NOT DISTINCT, a sparse one does not need it', () => {
      const table = desiredTable(descriptor(), PG);
      const handle = table.indexes.find((index) => index.create.includes('("handle")'))!;
      expect(handle.create).toMatch(/UNIQUE INDEX .* \("handle"\) NULLS NOT DISTINCT WHERE \("deleted_at" IS NULL\)$/);
      const code = table.indexes.find((index) => index.create.includes('("code")'))!;
      expect(code.create).not.toContain('NULLS NOT DISTINCT');
      expect(code.create).toMatch(/WHERE .*"code" IS NOT NULL.*"deleted_at" IS NULL/);
      expect(table.columns.find((column) => column.name === 'sync_seq')?.type).toBe('bigint');
      expect(table.indexes.some((index) => index.create.includes('("tenant_id", "sync_seq")'))).toBe(true);
    });

    it('PostgreSQL: the table gets its sequence, the trigger and the numbering of existing rows', () => {
      const table = desiredTable(descriptor(), PG);
      expect(table.sync?.sequence).toMatch(/^lt_sync_/);
      const statements = syncTableStatements(table.name, table.sync!, 'nest_app');
      expect(statements[0]).toMatch(/^CREATE SEQUENCE IF NOT EXISTS/);
      expect(statements[1]).toMatch(/^GRANT USAGE ON SEQUENCE .* TO "nest_app"$/);
      expect(statements[2]).toContain(`CREATE TRIGGER "${SYNC_TRIGGER}" BEFORE INSERT OR UPDATE`);
      expect(statements[3]).toMatch(/WHERE "sync_seq" IS NULL/);
    });

    it('MySQL / MariaDB: a live unique index reads virtual live-key columns', () => {
      const table = desiredMysqlTable(descriptor(), 'mysql');
      const liveHandle = table.columns.find((column) => column.name === 'lt_lk_handle')!;
      expect(liveHandle.generated).toBe('IF(`deleted_at` IS NULL, IFNULL(`handle`, CHAR(0 USING utf8mb4)), NULL)');
      const liveCode = table.columns.find((column) => column.name === 'lt_lk_code')!;
      expect(liveCode.generated).toBe('IF(`deleted_at` IS NULL, `code`, NULL)');
      const unique = table.indexes.find((index) => index.unique && index.create.includes('`lt_lk_handle`'))!;
      expect(unique.sentinels).toEqual(['lt_lk_handle']);
      expect(table.indexes.some((index) => !index.unique && index.create.endsWith('(`handle`)'))).toBe(true);
      expect(table.sync).toEqual({
        insertTrigger: expect.stringMatching(/^lt_sync_v1_/),
        updateTrigger: expect.stringMatching(/^lt_sync_v1_/),
      });
      const statements = mysqlSyncTableStatements(table.name, table.sync!);
      expect(statements.filter((statement) => statement.startsWith('CREATE TRIGGER'))).toHaveLength(2);
      expect(statements).toContain('START TRANSACTION');
      expect(statements.at(-1)).toBe('COMMIT');
    });

    it('a model without sync gets no change-order objects and no live-key columns', () => {
      const plain = describeSchema('Plain', notesSchema());
      expect(desiredTable(plain, PG).sync).toBeUndefined();
      const mysql = desiredMysqlTable(plain, 'mysql');
      expect(mysql.sync).toBeUndefined();
      expect(mysql.columns.some((column) => column.name.startsWith('lt_lk_'))).toBe(false);
    });
  });
});
