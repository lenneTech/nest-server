import { Logger } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { CoreModule } from '../../src/core.module';
import { IServerOptions } from '../../src/core/common/interfaces/server-options.interface';
import {
  assertDataSourcesSupported,
  DataSourceConfigError,
  driverFromUrl,
  redactUrl,
  resolveDataSources,
  resolveModelSource,
} from '../../src/core/common/persistence/data-source.config';
import {
  getPersistedModelOptions,
  getPersistedModelOptionsByName,
  PersistedModel,
} from '../../src/core/common/persistence/persisted-model.decorator';

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

  /**
   * @regression   DEV-3829 (db-agnostic phase 1, review) — the credentials were cut at the FIRST `@`, so a password
   *   with an unencoded `@` (which node-postgres accepts) put its tail into every boot log line and error.
   * @seen-failing Cut at the first `@` in redactUrl() in src/core/common/persistence/data-source.config.ts —
   *   registered as mutation `redact-url-first-at` in tests/regression-mutations.json.
   */
  describe('redactUrl', () => {
    it.each([
      ['postgres://app:s3cr3t@db.internal:5432/app', 'postgres://db.internal:5432'],
      ['postgres://app:p@ss@w0rd@db.internal/app', 'postgres://db.internal'],
      ['postgres://app:p@ss@db.internal?sslmode=require', 'postgres://db.internal'],
      ['mongodb+srv://u:x@y@cluster.example.com/app#frag', 'mongodb+srv://cluster.example.com'],
      ['postgres://db.internal/app', 'postgres://db.internal'],
    ])('%s → %s', (url, expected) => {
      expect(redactUrl(url)).toBe(expected);
    });

    it('never echoes what it cannot parse', () => {
      expect(redactUrl('app:s3cr3t@db.internal/app')).toBe('<unparsable URL>');
      expect(redactUrl(42)).toBe('<number>');
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

    it('is found by the class name for a model registered without its class', () => {
      @PersistedModel({ dataSource: 'logs' })
      class NamedLedgerEntry {}
      expect(NamedLedgerEntry.name).toBe('NamedLedgerEntry');
      expect(getPersistedModelOptionsByName('NamedLedgerEntry')).toEqual({ dataSource: 'logs' });
      expect(getPersistedModelOptionsByName('NeverDeclared')).toBeUndefined();
    });

    it('refuses to guess between two classes of one name that name different sources', () => {
      const first = (() => {
        @PersistedModel({ dataSource: 'logs' })
        class SharedName {}
        return SharedName;
      })();
      (() => {
        @PersistedModel({ dataSource: 'reports' })
        class SharedName {}
        return SharedName;
      })();
      expect(first.name).toBe('SharedName');
      expect(() => getPersistedModelOptionsByName('SharedName')).toThrow(/pass `model`/);
    });
  });

  describe('assertDataSourcesSupported (what this version can wire)', () => {
    it('accepts a single MongoDB default source', () => {
      expect(() => assertDataSourcesSupported(resolveDataSources({ mongooseUri: MONGO }))).not.toThrow();
    });

    it.each([
      ['a PostgreSQL default source', 'postgres://app@db/app'],
      ['a PostgreSQL default with an owner', { ownerUrl: 'postgres://owner@db/app', url: 'postgres://app@db/app' }],
      ['an additional PostgreSQL source', { sources: { reports: 'postgresql://app@db/reports' } }],
      // Refused until phase 5 (12.1.0), which runs a project without a database
      ['no database at all', false],
      // Refused until phase 6, which adds the MySQL dialect
      ['a MySQL source', 'mysql://app@db/app'],
      ['a MariaDB source', { sources: { legacy: 'mariadb://app@db/app' } }],
    ])('accepts %s', (_label, database) => {
      expect(() =>
        assertDataSourcesSupported(resolveDataSources({ database: database as any, mongooseUri: MONGO })),
      ).not.toThrow();
    });

    it.each([['a second MongoDB source', { sources: { logs: 'mongodb://logs/app' } }, /logs/]])(
      'refuses %s with a named error',
      (_label, database, message) => {
        const resolved = resolveDataSources({ database: database as any, mongooseUri: MONGO });
        expect(() => assertDataSourcesSupported(resolved)).toThrow(DataSourceConfigError);
        expect(() => assertDataSourcesSupported(resolved)).toThrow(message);
      },
    );
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
      expect(() =>
        CoreModule.forRoot({ ...base, database: { sources: { logs: 'mongodb://logs/app' }, url: MONGO } }),
      ).toThrow(DataSourceConfigError);
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
  describe('ownerUrl', () => {
    it('belongs to the default source, and to a named SQL source', () => {
      const resolved = resolveDataSources({
        database: {
          ownerUrl: 'postgres://owner@db/app',
          sources: { reports: { ownerUrl: 'postgres://owner@db/reports', url: 'postgres://app@db/reports' } },
          url: 'postgres://app@db/app',
        },
      });
      expect(resolved.sources.default.ownerUrl).toBe('postgres://owner@db/app');
      expect(resolved.sources.reports.ownerUrl).toBe('postgres://owner@db/reports');
    });

    it.each([
      ['on a MongoDB source', { ownerUrl: 'mongodb://owner@db/app', url: 'mongodb://db/app' }, /SQL sources only/],
      [
        'of another database kind',
        { ownerUrl: 'mongodb://owner@db/app', url: 'postgres://app@db/app' },
        /same database/,
      ],
    ])('is refused %s', (_label, database, message) => {
      expect(() => resolveDataSources({ database: database as any })).toThrow(message);
    });

    /**
     * @regression   DEV-3829 (db-agnostic phase 1, review) — NSC__DATABASE__OWNER_URL merged over a `database` URL
     *   string replaces it with `{ ownerUrl }`: the URL was gone and every model silently fell back to MongoDB.
     * @seen-failing Drop the `ownerUrl` without `url` refusal in resolveDataSources() in
     *   src/core/common/persistence/data-source.config.ts — registered as mutation `owner-url-without-url-accepted`
     *   in tests/regression-mutations.json.
     */
    it('is refused without the URL it belongs to (an env variable replaced the URL shorthand)', () => {
      const attempt = () =>
        resolveDataSources({ database: { ownerUrl: 'postgres://owner:s3cr3t@db/app' }, mongooseUri: MONGO });
      expect(attempt).toThrow(DataSourceConfigError);
      expect(attempt).toThrow(/database\.url/);
      expect(attempt).not.toThrow(/s3cr3t/);
    });
  });
});
