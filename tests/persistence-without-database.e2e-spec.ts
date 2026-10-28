import { Controller, Get, Module } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  CoreModule,
  CorePersistenceModule,
  createSchema,
  getConnectionToken,
  getModelToken,
  getStoreToken,
  RoleEnum,
  Roles,
  TestHelper,
} from '../src';
import envConfig from '../src/config.env';
import { ConfigService } from '../src/core/common/services/config.service';

/**
 * `database: false` (12.1.0+): a stateless service — a gateway, a renderer — runs without any database. Nothing
 * connects, the routes answer, and a model the framework or the project still registers refuses data access with the
 * reason instead of failing somewhere inside a driver. Better-Auth, which keeps its users in a database, is refused at
 * boot with what to change.
 */
@Controller('stateless-probe')
class StatelessProbeController {
  @Get()
  @Roles(RoleEnum.S_EVERYONE)
  ping() {
    return { ok: true };
  }
}

const statelessConfig = {
  ...envConfig,
  ai: undefined,
  betterAuth: false,
  cronJobs: undefined,
  database: false,
  graphQl: false,
  hub: undefined,
} as any;

describe('database: false — a service without a database', () => {
  let app: any;
  let previousConfig: any;

  beforeAll(async () => {
    previousConfig = ConfigService.configFastButReadOnly;
    ConfigService.setConfig(statelessConfig, { reInit: true, warn: false });

    @Module({
      controllers: [StatelessProbeController],
      imports: [
        CoreModule.forRoot(statelessConfig),
        CorePersistenceModule.forFeature([{ name: 'StatelessNote', schema: createSchema({ title: String }) }]),
      ],
    })
    class StatelessModule {}

    const fixture = await Test.createTestingModule({ imports: [StatelessModule] }).compile();
    app = fixture.createNestApplication();
    await app.init();
  });

  afterAll(async () => {
    await app?.close();
    if (previousConfig) {
      ConfigService.setConfig(previousConfig, { reInit: true, warn: false });
    }
  });

  /**
   * @regression   DEV-3833 (db-agnostic phase 5) — CoreModule connected MongoDB (the fallback URI) whatever the data
   *   sources said, so a project without MongoDB needed its libraries and a reachable server.
   * @seen-failing Connect MongoDB unconditionally in CoreModule.forRoot() (src/core.module.ts) — registered as mutation
   *   `mongodb-connected-without-source` in tests/regression-mutations.json.
   */
  it('boots and answers without connecting a database', async () => {
    expect(app.get(getConnectionToken(), { strict: false })).toBeNull();
    expect(await new TestHelper(app).rest('/stateless-probe')).toEqual({ ok: true });
  });

  /**
   * @regression   DEV-3833 (db-agnostic phase 5) — without a database a registered model got a Mongoose store over a
   *   stand-in, and the routing guard overwrote the stand-in's reason with "is stored on none".
   * @seen-failing Build a Mongoose store for a stand-in, or guard a stand-in, in CorePersistenceModule.forFeature()
   *   (src/core/common/persistence/core-persistence.module.ts) — registered as mutations `no-database-store-on-mongoose`
   *   and `stand-in-reason-overwritten` in tests/regression-mutations.json.
   */
  it('refuses data access of a registered model, naming the reason', () => {
    const store = app.get(getStoreToken('StatelessNote'), { strict: false });
    expect(store.driver).toBe('none');
    expect(() => store.find({})).toThrow(/StatelessNote\.find\(\).*database: false/);
    const model = app.get(getModelToken('StatelessNote'), { strict: false });
    expect(() => model.find({})).toThrow(/no MongoDB is configured/);
  });

  it('refuses Better-Auth with `database: false` at boot, with what to change', () => {
    expect(() => CoreModule.forRoot({ ...statelessConfig, betterAuth: true })).toThrow(/database: false.*betterAuth: false/s);
  });
});
