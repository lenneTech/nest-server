/**
 * Swagger only where it is switched on (12.7.0, DEV-4086).
 *
 * `setupSwagger()` mounted the UI and the JSON document on every stage a project called it on — production included,
 * so the full API description (every route, every role, every input shape) was public there. It now asks
 * `isSwaggerEnabled()` first: served by default in `local`, `ci` and `e2e`, everywhere with `swagger: true`, nowhere
 * with `swagger: false`. Off mounts none of the four paths.
 */
import { Controller, Get, Module } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { afterEach, describe, expect, it } from 'vitest';

import { isSwaggerEnabled } from '../../src/core/common/helpers/swagger-enabled.helper';
import { setupSwagger } from '../../src/core/common/helpers/swagger.helper';

import type { INestApplication } from '@nestjs/common';
import type { IServerOptions } from '../../src/core/common/interfaces/server-options.interface';

@Controller('items')
class ItemsController {
  @Get()
  list(): string[] {
    return [];
  }
}

@Module({ controllers: [ItemsController] })
class SwaggerSwitchModule {}

const PATHS = ['/swagger', '/api-docs-json', '/swagger-api-tokens', '/api-docs-api-tokens-json'];

describe('isSwaggerEnabled()', () => {
  it.each(['local', 'ci', 'e2e'])('serves by default in %s', (env) => {
    expect(isSwaggerEnabled({ env })).toBe(true);
  });

  /**
   * @regression   12.7.0 (DEV-4086) — Swagger was mounted on every stage, production included, so the full API
   *   description was public wherever a project called setupSwagger().
   * @seen-failing Answer `true` for an unset switch in isSwaggerEnabled() in
   *   src/core/common/helpers/swagger-enabled.helper.ts — registered as mutation `swagger-default-on-everywhere` in
   *   tests/regression-mutations.json.
   */
  it.each(['production', 'develop', 'test', 'staging'])('is off by default in %s', (env) => {
    expect(isSwaggerEnabled({ env })).toBe(false);
  });

  it('follows an explicit boolean in every environment', () => {
    expect(isSwaggerEnabled({ env: 'production', swagger: true })).toBe(true);
    expect(isSwaggerEnabled({ env: 'local', swagger: false })).toBe(false);
  });

  /**
   * @regression   12.7.0 (DEV-4086) — the switch comes from configuration that may arrive as JSON (NEST_SERVER_CONFIG);
   *   the string 'false' is truthy and must not switch the documentation on.
   * @seen-failing Read any set value by truthiness in isSwaggerEnabled() in
   *   src/core/common/helpers/swagger-enabled.helper.ts — registered as mutation `swagger-string-switches-on` in
   *   tests/regression-mutations.json.
   */
  it('counts a value that is not a boolean as not set', () => {
    expect(isSwaggerEnabled({ env: 'production', swagger: 'false' } as unknown as Partial<IServerOptions>)).toBe(
      false,
    );
    expect(isSwaggerEnabled({ env: 'local', swagger: 'false' } as unknown as Partial<IServerOptions>)).toBe(true);
  });
});

describe('setupSwagger() and the switch', () => {
  let app: INestApplication | undefined;

  afterEach(async () => {
    await app?.close();
    app = undefined;
  });

  async function serve(config: Partial<IServerOptions>): Promise<INestApplication> {
    const moduleRef = await Test.createTestingModule({ imports: [SwaggerSwitchModule] }).compile();
    app = moduleRef.createNestApplication({ logger: false });
    setupSwagger(app, { apiTokenView: true, title: 'Switch' }, config);
    await app.init();
    return app;
  }

  /**
   * @regression   12.7.0 (DEV-4086) — setupSwagger() mounted the UI and the JSON documents whatever the stage.
   * @seen-failing Skip the isSwaggerEnabled() check in setupSwagger() in src/core/common/helpers/swagger.helper.ts —
   *   registered as mutation `swagger-mounted-when-off` in tests/regression-mutations.json.
   */
  it('mounts none of the four paths on a deployed stage without the switch', async () => {
    const served = await serve({ env: 'production' });

    for (const path of PATHS) {
      await request(served.getHttpServer()).get(path).expect(404);
    }
  });

  it('mounts all four with swagger: true, also in production', async () => {
    const served = await serve({ env: 'production', swagger: true });

    for (const path of PATHS) {
      await request(served.getHttpServer()).get(path).expect(200);
    }
  });
});
