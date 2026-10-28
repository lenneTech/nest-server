import { describe, expect, it } from 'vitest';

import { IServerOptions } from '../../src/core/common/interfaces/server-options.interface';
import {
  assertFileStorageAvailable,
  hasDatabaseConfig,
  hasUsableS3Config,
  resolveFileStorage,
} from '../../src/core/modules/file/file-storage.helper';

const cfg = (partial: Record<string, any>): Partial<IServerOptions> => partial as Partial<IServerOptions>;

const DB = { mongoose: { uri: 'mongodb://localhost/test' } };
const S3 = { s3: { bucket: 'my-bucket' } };

describe('resolveFileStorage', () => {
  describe('explicit choice', () => {
    it.each(['filesystem', 'gridfs', 's3'] as const)('honours file.storage = %s', (driver) => {
      const res = resolveFileStorage(cfg({ ...DB, ...S3, file: { storage: driver } }));
      expect(res.driver).toBe(driver);
      expect(res.explicit).toBe(true);
    });

    it('wins over everything the defaults would have derived', () => {
      // S3 is configured and would be the default — the explicit value still wins.
      expect(resolveFileStorage(cfg({ ...DB, ...S3, file: { storage: 'gridfs' } })).driver).toBe('gridfs');
    });

    it('rejects an unknown driver instead of falling back', () => {
      expect(() => resolveFileStorage(cfg({ ...DB, file: { storage: 'azure' } }))).toThrow(/Invalid file\.storage/);
    });
  });

  describe('derived default', () => {
    it('prefers S3 when a bucket is configured', () => {
      const res = resolveFileStorage(cfg({ ...DB, ...S3 }));
      expect(res.driver).toBe('s3');
      expect(res.explicit).toBe(false);
    });

    it('falls to GridFS when a database is configured and S3 is not', () => {
      expect(resolveFileStorage(cfg(DB)).driver).toBe('gridfs');
    });

    it('falls to the filesystem when neither is configured', () => {
      expect(resolveFileStorage(cfg({})).driver).toBe('filesystem');
    });

    it('ignores an S3 block that names no bucket', () => {
      // Region/endpoint alone cannot be written to — the bucket is the one thing
      // S3 cannot default, so without it S3 is not a usable default.
      expect(resolveFileStorage(cfg({ ...DB, s3: { region: 'eu-central-1' } })).driver).toBe('gridfs');
    });

    it('ignores an explicitly disabled S3 block', () => {
      expect(resolveFileStorage(cfg({ ...DB, s3: { bucket: 'b', enabled: false } })).driver).toBe('gridfs');
    });

    /**
     * @regression   DEV-3832 (db-agnostic phase 4) — with the file metadata routed to a SQL source, GridFS was still
     *   derived: a project that moved its data to PostgreSQL had every upload put into MongoDB, bytes and metadata.
     * @seen-failing Drop the SQL-metadata branch of resolveFileStorage() in
     *   src/core/modules/file/file-storage.helper.ts — registered as mutation `gridfs-derived-for-sql-metadata` in
     *   tests/regression-mutations.json.
     */
    it('derives the filesystem, not GridFS, when the file metadata lives in a SQL source', () => {
      const PG = 'postgres://app:secret@localhost:5440/files';
      const sqlDefault = resolveFileStorage(cfg({ ...DB, database: { url: PG } }));
      expect(sqlDefault).toMatchObject({ driver: 'filesystem', explicit: false });
      expect(sqlDefault.reason).toContain('SQL source "default"');
      // Routed per model, too — and named after the source it went to
      const routed = resolveFileStorage(
        cfg({ ...DB, database: { models: { CoreFilesystemFile: 'files' }, sources: { files: PG } } }),
      );
      expect(routed.driver).toBe('filesystem');
      expect(routed.reason).toContain('SQL source "files"');

      // What the rule leaves alone: S3 still wins, an explicit GridFS is kept, metadata on MongoDB keeps GridFS
      expect(resolveFileStorage(cfg({ ...DB, ...S3, database: { url: PG } })).driver).toBe('s3');
      expect(resolveFileStorage(cfg({ ...DB, database: { url: PG }, file: { storage: 'gridfs' } })).driver).toBe(
        'gridfs',
      );
      expect(
        resolveFileStorage(cfg({ ...DB, database: { models: { CoreFilesystemFile: 'mongoose' }, url: PG } })).driver,
      ).toBe('gridfs');
    });
  });

  describe('backwards compatibility', () => {
    it('keeps a pre-11.33 project on GridFS', () => {
      // No `file` config, no `s3` — exactly what every existing project looks
      // like. Anything other than 'gridfs' here would silently move their files.
      const res = resolveFileStorage(cfg({ ...DB, jwt: { secret: 'x' }, port: 3000 }));
      expect(res.driver).toBe('gridfs');
      expect(res.explicit).toBe(false);
    });

    it('keeps them on GridFS even when only the role knobs are configured', () => {
      expect(resolveFileStorage(cfg({ ...DB, file: { downloadRoles: ['admin'] } })).driver).toBe('gridfs');
    });
  });
});

describe('assertFileStorageAvailable', () => {
  it('passes when the driver is available', () => {
    expect(() => assertFileStorageAvailable(resolveFileStorage(cfg(DB)), true)).not.toThrow();
  });

  it('throws for an explicit choice that is unavailable — never falls back', () => {
    // The regression this exists for: S3 selected, S3 unusable, files silently
    // written to GridFS while the operator reads the config and believes S3.
    const res = resolveFileStorage(cfg({ ...DB, file: { storage: 's3' } }));
    expect(() => assertFileStorageAvailable(res, false)).toThrow(/file\.storage is set to 's3'/);
  });

  it('also throws for a DERIVED driver that is unavailable', () => {
    // `s3.bucket` makes S3 the default, but the bytes go nowhere unless the
    // project's FileService forwards s3Service to super().
    const res = resolveFileStorage(cfg({ ...DB, ...S3 }));
    expect(() => assertFileStorageAvailable(res, false)).toThrow(/selected automatically/);
  });

  it('names a way out in the message', () => {
    const res = resolveFileStorage(cfg({ ...DB, file: { storage: 's3' } }));
    expect(() => assertFileStorageAvailable(res, false)).toThrow(/@aws-sdk\/client-s3/);
  });
});

describe('config predicates', () => {
  it('hasUsableS3Config requires a bucket', () => {
    expect(hasUsableS3Config(cfg(S3))).toBe(true);
    expect(hasUsableS3Config(cfg({ s3: { region: 'eu' } }))).toBe(false);
    expect(hasUsableS3Config(cfg({}))).toBe(false);
  });

  it('hasDatabaseConfig asks whether a URI is CONFIGURED, not whether it responds', () => {
    // A configured-but-unreachable database must fail the boot, not silently
    // redirect files to the local disk.
    expect(hasDatabaseConfig(cfg(DB))).toBe(true);
    expect(hasDatabaseConfig(cfg({ mongoose: { uri: '' } }))).toBe(false);
    expect(hasDatabaseConfig(cfg({}))).toBe(false);
  });
});
