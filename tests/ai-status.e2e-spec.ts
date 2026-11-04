/**
 * `GET /ai/status` (12.3.1+) on the assembled stack: what a frontend sees before anybody signs in.
 *
 * The contract the frontend libraries build on: 200 with `{ mcp }` while the AI module is registered — without a
 * session, a token or a cookie — and 404 while it is not, because the route's absence IS the answer "AI is off".
 * Every other `/ai` route keeps answering 401 without a session; that refusal is asserted beside it, so a status
 * route that is public only because the whole controller lost its guard would fail here.
 */
import type { NestExpressApplication } from '@nestjs/platform-express';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { CoreBetterAuthModule, TestHelper } from '../src';
import { ConfigService } from '../src/core/common/services/config.service';
import envConfig from '../src/config.env';
import { apiTokenIamConfig, bootApiTokenIamApp } from './helpers/api-token-e2e.helpers';

const CASES = [
  {
    ai: { ...(envConfig as any).ai, mcp: true },
    dbSuffix: 'ai-status-mcp',
    expected: { mcp: true },
    name: 'AI on, MCP on',
  },
  {
    ai: { ...(envConfig as any).ai, mcp: false },
    dbSuffix: 'ai-status-no-mcp',
    expected: { mcp: false },
    name: 'AI on, MCP off',
  },
  { ai: undefined, dbSuffix: 'ai-status-off', expected: null, name: 'AI off' },
];

describe.each(CASES)('GET /ai/status — $name (e2e)', ({ ai, dbSuffix, expected }) => {
  let app: NestExpressApplication;
  let helper: TestHelper;
  let previousConfig: any;

  beforeAll(async () => {
    previousConfig = ConfigService.configFastButReadOnly;
    app = await bootApiTokenIamApp(apiTokenIamConfig(dbSuffix, { ai }));
    helper = new TestHelper(app);
  });

  afterAll(async () => {
    await app?.close();
    CoreBetterAuthModule.reset();
    if (previousConfig) {
      ConfigService.setConfig(previousConfig, { reInit: true, warn: false });
    }
  });

  if (expected) {
    it('answers 200 with what the module offers, without a session, token or cookie', async () => {
      const body = await helper.rest('/ai/status', { statusCode: 200 });
      expect(body).toEqual(expected);
    });

    it('paired refusal: the other /ai routes still need a session', async () => {
      await helper.rest('/ai/settings', { statusCode: 401 });
    });
  } else {
    it('answers 404: the route does not exist while the AI module is off', async () => {
      await helper.rest('/ai/status', { statusCode: 404 });
    });
  }
});
