import { Get, Param } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { afterEach, describe, expect, it } from 'vitest';

import { CoreSyncController } from '../../src/core/modules/sync/core-sync.controller';
import { CoreSyncModule } from '../../src/core/modules/sync/core-sync.module';
import { CoreSyncService } from '../../src/core/modules/sync/core-sync.service';

import type { INestApplication } from '@nestjs/common';

/**
 * `GET /sync/hints` against a project controller that re-declares `pull()` — the extension the sync README describes
 * (to release a scope to API tokens). Nest registers a class's own routes before the ones it inherits, so with the
 * hints on that class `GET /sync/:model` came first and read `hints` as a model name. A real Nest + Express router,
 * because the route ORDER is the property under test and nothing short of the router shows it.
 */
class ProjectSyncController extends CoreSyncController {
  @Get(':model')
  override async pull(@Param('model') model: string): Promise<any> {
    return { pulled: model };
  }
}

describe('sync hint route', () => {
  let app: INestApplication | undefined;

  afterEach(async () => {
    await app?.close();
    app = undefined;
  });

  /**
   * @regression   DEV-3902 review — a project controller re-declaring `pull()` turned `GET /sync/hints` into a pull of a
   *   model named `hints` (404), and an EventSource does not reconnect after an error status: hints stopped silently.
   * @seen-failing Register the hints controller after the sync controller in CoreSyncModule.forRoot()
   *   (src/core/modules/sync/core-sync.module.ts) — registered as mutation `sync-hints-route-after-model` in
   *   tests/regression-mutations.json.
   */
  it('reaches the hint stream although the project controller re-declares the pull route', async () => {
    const { controllers } = CoreSyncModule.forRoot({ controller: ProjectSyncController });
    const fakeService = {
      hintsEnabled: () => true,
      openHintStream: async (_req: any, res: any) => {
        res.status(200).send('stream');
      },
      rateLimit: async () => undefined,
    };
    const moduleRef = await Test.createTestingModule({
      controllers,
      providers: [{ provide: CoreSyncService, useValue: fakeService }],
    }).compile();
    app = moduleRef.createNestApplication({ logger: false });
    await app.init();

    const hints = await request(app.getHttpServer()).get('/sync/hints');
    expect(hints.status).toBe(200);
    expect(hints.text).toBe('stream');
    // The control: the project's own pull route still answers for a model
    const pulled = await request(app.getHttpServer()).get('/sync/SyncNote');
    expect(pulled.body).toEqual({ pulled: 'SyncNote' });
  });
});
