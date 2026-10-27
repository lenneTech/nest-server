import { Logger } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { CoreModule } from '../../src/core.module';
import { IServerOptions } from '../../src/core/common/interfaces/server-options.interface';
import {
  assertDataSourcesSupported,
  DataSourceConfigError,
  driverFromUrl,
  resolveDataSources,
  resolveModelSource,
} from '../../src/core/common/persistence/data-source.config';
import { getPersistedModelOptions, PersistedModel } from '../../src/core/common/persistence/persisted-model.decorator';

const MONGO = 'mongodb://localhost/app';

describe('data source configuration', () => {
  describe('driverFromUrl', () => {
    it.each([
      ['mongodb://localhost/app', 'mongodb'],
      ['mongodb+srv://cluster.example.com/app', 'mongodb'],
      ['postgres://app@db/app', 'postgres'],
      ['postgresql://app@db/app', 'postgres'],
      ['mysql://app@db/app', 'mysql'],
      ['mariadb://app@db/app', 'mariadb'],
    ])('%s → %s', (url, driver) => {
      expect(driverFromUrl(url)).toBe(driver);
    });

    it('refuses an unknown scheme without echoing credentials', () => {
      const attempt = () => driverFromUrl('oracle://admin:s3cr3t@db.internal/app');
      expect(attempt).toThrow(DataSourceConfigError);
      expect(attempt).toThrow(/oracle:/);
      expect(attempt).not.toThrow(/s3cr3t/);
    });
  });

  describe('resolveDataSources', () => {
    it('keeps today’s behaviour without `database`: the mongoose URI is the default source', () => {
      const resolved = resolveDataSources({ explicitMongoose: true, mongooseUri: MONGO });
      expect(resolved.disabled).toBe(false);
      expect(resolved.defaultSource).toBe('default');
      expect(resolved.sources.default).toEqual({ driver: 'mongodb', name: 'default', url: MONGO });
    });

    it('takes a URL shorthand as the default source, with TypeORM as the default SQL engine', () => {
      const resolved = resolveDataSources({ database: 'postgres://app@db/app', mongooseUri: MONGO });
      expect(resolved.sources.default).toEqual({
        driver: 'postgres',
        name: 'default',
        sqlEngine: 'typeorm',
        url: 'postgres://app@db/app',
      });
      expect(Object.keys(resolved.sources)).toEqual(['default']);
    });

    it('applies the top-level engine, and lets a source override it', () => {
      const resolved = resolveDataSources({
        database: {
          sources: {
            reporting: { sqlEngine: 'drizzle', url: 'postgres://app@reporting/app' },
            logs: 'mongodb://logs/app',
          },
          sqlEngine: 'kysely',
          url: 'postgres://app@db/app',
        },
        mongooseUri: MONGO,
      });
      expect(resolved.sources.default.sqlEngine).toBe('kysely');
      expect(resolved.sources.reporting.sqlEngine).toBe('drizzle');
      expect(resolved.sources.logs).toEqual({ driver: 'mongodb', name: 'logs', url: 'mongodb://logs/app' });
    });

    it('keeps the mongoose URI as default when `database` only adds sources', () => {
      const resolved = resolveDataSources({
        database: { sources: { reporting: 'postgres://app@reporting/app' } },
        explicitMongoose: true,
        mongooseUri: MONGO,
      });
      expect(resolved.sources.default.driver).toBe('mongodb');
      expect(resolved.sources.reporting.driver).toBe('postgres');
    });

    it('turns an explicitly configured mongoose URI into the source "mongoose" when `database` sets the default', () => {
      const resolved = resolveDataSources({
        database: 'postgres://app@db/app',
        explicitMongoose: true,
        mongooseUri: MONGO,
      });
      expect(resolved.sources.default.driver).toBe('postgres');
      expect(resolved.sources.mongoose).toEqual({ driver: 'mongodb', name: 'mongoose', url: MONGO });
    });

    it('ignores the framework’s own fallback mongoose URI when `database` sets the default', () => {
      const resolved = resolveDataSources({
        database: 'postgres://app@db/app',
        explicitMongoose: false,
        mongooseUri: MONGO,
      });
      expect(resolved.sources.mongoose).toBeUndefined();
    });

    it('resolves `database: false` to no data source at all', () => {
      const resolved = resolveDataSources({ database: false, explicitMongoose: true, mongooseUri: MONGO });
      expect(resolved).toEqual({ defaultSource: undefined, disabled: true, modelSources: {}, sources: {} });
    });

    it.each([
      ['an engine outside the list', { sqlEngine: 'prisma', url: 'postgres://app@db/app' }, /sqlEngine/],
      ['an engine on a MongoDB source', { sources: { logs: { sqlEngine: 'typeorm', url: MONGO } } }, /SQL/],
      ['a source named "default"', { sources: { default: MONGO } }, /reserved/],
      ['a source name with invalid characters', { sources: { 'my logs': MONGO } }, /name/],
      ['a URL that is not a string', { url: 42 }, /url/],
      ['a model mapped to an unknown source', { models: { AuditEntry: 'logs' } }, /AuditEntry/],
    ])('refuses %s', (_label, database, message) => {
      const attempt = () => resolveDataSources({ database: database as any, mongooseUri: MONGO });
      expect(attempt).toThrow(DataSourceConfigError);
      expect(attempt).toThrow(message);
    });
  });

  describe('resolveModelSource', () => {
    const resolved = resolveDataSources({
      database: {
        models: { AuditEntry: 'logs' },
        sources: { logs: 'mongodb://logs/app', reporting: 'mongodb://rep/app' },
      },
      mongooseUri: MONGO,
    });

    it('takes the configuration first, then the decorator, then the default', () => {
      expect(resolveModelSource(resolved, 'AuditEntry', 'reporting')).toBe('logs');
      expect(resolveModelSource(resolved, 'Report', 'reporting')).toBe('reporting');
      expect(resolveModelSource(resolved, 'User')).toBe('default');
    });

    it('refuses a decorator naming an unknown source', () => {
      expect(() => resolveModelSource(resolved, 'Report', 'nowhere')).toThrow(/Report/);
    });

    it('has no source for any model when the database is disabled', () => {
      const none = resolveDataSources({ database: false, mongooseUri: MONGO });
      expect(resolveModelSource(none, 'User')).toBeUndefined();
    });
  });

  describe('@PersistedModel', () => {
    it('records the declared data source on the class', () => {
      @PersistedModel({ dataSource: 'logs' })
      class AuditEntry {}
      class Undeclared {}
      expect(getPersistedModelOptions(AuditEntry)).toEqual({ dataSource: 'logs' });
      expect(getPersistedModelOptions(Undeclared)).toBeUndefined();
    });
  });

  describe('assertDataSourcesSupported (what this version can wire)', () => {
    it('accepts a single MongoDB default source', () => {
      expect(() => assertDataSourcesSupported(resolveDataSources({ mongooseUri: MONGO }))).not.toThrow();
    });

    it.each([
      ['a SQL default source', 'postgres://app@db/app', /postgres/],
      ['no database at all', false, /database: false/],
      ['an additional source', { sources: { logs: 'mongodb://logs/app' } }, /logs/],
    ])('refuses %s with a named error', (_label, database, message) => {
      const resolved = resolveDataSources({ database: database as any, mongooseUri: MONGO });
      expect(() => assertDataSourcesSupported(resolved)).toThrow(DataSourceConfigError);
      expect(() => assertDataSourcesSupported(resolved)).toThrow(message);
    });
  });

  describe('CoreModule.forRoot wiring', () => {
    beforeEach(() => {
      vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    });

    afterEach(() => {
      vi.restoreAllMocks();
    });

    const base: Partial<IServerOptions> = {
      betterAuth: { enabled: true, secret: 'betterauth-secret-32-chars-min!!' },
      env: 'test',
      mongoose: { uri: MONGO },
    };

    it('boots unchanged without `database`', () => {
      expect(() => CoreModule.forRoot(base)).not.toThrow();
    });

    it('refuses a database this version cannot wire, before anything connects', () => {
      expect(() => CoreModule.forRoot({ ...base, database: 'postgres://app@db/app' })).toThrow(DataSourceConfigError);
    });

    /**
     * @regression   DEV-3828 (db-agnostic phase 0, review) — a MongoDB URL in `database` passed the boot guard,
     *   but Mongoose still connected with the fallback URI (`NSC__MONGOOSE__URI` or
     *   `mongodb://localhost/nest-server-default`): another database, without an error.
     * @seen-failing Remove the `config.mongoose.uri = defaultSource.url;` assignment from src/core.module.ts —
     *   registered as mutation `database-mongodb-url-not-connected` in tests/regression-mutations.json.
     */
    it.each([
      ['a URL', 'mongodb://db.example.com/app', 'mongodb://db.example.com/app'],
      ['an object', { url: 'mongodb+srv://cluster.example.net/app' }, 'mongodb+srv://cluster.example.net/app'],
    ])('connects Mongoose to a MongoDB default source given as %s', (_label, database, expected) => {
      const forRoot = vi.spyOn(MongooseModule, 'forRoot');
      const { mongoose: _ignored, ...withoutMongoose } = base;
      CoreModule.forRoot({ ...withoutMongoose, database } as Partial<IServerOptions>);
      expect(forRoot).toHaveBeenCalledWith(expected, expect.anything());
    });

    it('keeps connecting to the configured mongoose URI without `database`', () => {
      const forRoot = vi.spyOn(MongooseModule, 'forRoot');
      CoreModule.forRoot(base);
      expect(forRoot).toHaveBeenCalledWith(MONGO, expect.anything());
    });
  });
});
