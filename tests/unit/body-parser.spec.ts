import { Body, Controller, Logger, Module, Post, Req } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import { json } from 'express';
import request from 'supertest';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { ConfigService } from '../../src/core/common/services/config.service';
import { CoreBodyParserInitializer, parseBodyLimit } from '../../src/core/common/services/core-body-parser.initializer';

import type { INestApplication } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import type { IServerOptions } from '../../src/core/common/interfaces/server-options.interface';

/**
 * These tests drive a REAL Express app through the real initializer, because the property under
 * test is body-parser's own behaviour: which body sizes reach the handler and which are refused
 * with 413 before routing. Asserting that a parser was created with some limit would restate the
 * implementation and still pass if the layer never ended up in the chain.
 *
 * What this guards: body-parser's 100 kB default is a limit nobody chose. A document that grows past
 * it can no longer be saved, the caller gets a bare "request entity too large", and nothing is
 * logged that names the setting to change. The config must also hold under
 * `Test.createTestingModule()`, which never runs `main.ts` — the reason a `useBodyParser()` call in
 * `main.ts` was not enough.
 */

const DEFAULT_LIMIT = 100 * 1024;

/** Reports what reached the handler, without echoing a large body back */
@Controller()
class EchoController {
  @Post('echo')
  echo(@Body() body: any, @Req() req: any): { keys: string[]; rawBody: null | number; size: number } {
    return {
      keys: Object.keys(body ?? {}),
      rawBody: Buffer.isBuffer(req.rawBody) ? req.rawBody.length : null,
      size: JSON.stringify(body ?? {}).length,
    };
  }

  @Post('scoped/echo')
  scopedEcho(@Body() body: any): { size: number } {
    return { size: JSON.stringify(body ?? {}).length };
  }
}

@Module({ controllers: [EchoController], providers: [CoreBodyParserInitializer] })
class EchoModule {}

/** A JSON body of exactly `bytes` bytes */
function jsonOfSize(bytes: number): string {
  const envelope = '{"data":""}'.length;
  return `{"data":"${'x'.repeat(bytes - envelope)}"}`;
}

/** A URL-encoded body of exactly `bytes` bytes */
function formOfSize(bytes: number): string {
  return `data=${'x'.repeat(bytes - 'data='.length)}`;
}

/**
 * REPLACE the static config, do not merge into it — a `bodyParser` set by an earlier test would
 * otherwise survive into the next one.
 */
const initConfig = (config: Partial<IServerOptions>) =>
  ConfigService.setConfig(config as any, { reInit: true, warn: false });

/**
 * The boot path every e2e suite uses. `beforeInit` stands in for what a project's `main.ts` would
 * register before `listen()` — which under the testing module nothing does.
 */
async function createApp(
  config: Partial<IServerOptions>,
  beforeInit?: (app: NestExpressApplication) => void,
): Promise<INestApplication> {
  initConfig(config);
  const moduleRef = await Test.createTestingModule({ imports: [EchoModule] }).compile();
  const app = moduleRef.createNestApplication<NestExpressApplication>();
  beforeInit?.(app);
  await app.init();
  return app;
}

function postJson(app: INestApplication, body: string, path = '/echo') {
  return request(app.getHttpServer()).post(path).set('Content-Type', 'application/json').send(body);
}

function captureLogs(level: 'error' | 'log' | 'warn'): string[] {
  const messages: string[] = [];
  vi.spyOn(Logger.prototype, level).mockImplementation((message: any) => {
    messages.push(String(message));
  });
  return messages;
}

describe('parseBodyLimit', () => {
  it.each([
    [2_097_152, 2_097_152],
    [1, 1],
    [1.9, 1],
    ['2097152', 2_097_152],
    ['500kb', 512_000],
    ['2mb', 2_097_152],
    ['2MB', 2_097_152],
    [' 2 mb ', 2_097_152],
    ['1.5mb', 1_572_864],
    ['1gb', 1_073_741_824],
    ['100b', 100],
  ])('reads %j as %j bytes', (input, expected) => {
    expect(parseBodyLimit(input)).toBe(expected);
  });

  it.each([
    0,
    -1,
    Number.NaN,
    Number.POSITIVE_INFINITY,
    '',
    '0',
    '0kb',
    '-1mb',
    'lots',
    '2 megabytes',
    '1tb',
    null,
    true,
    {},
  ])('refuses %j', (input) => {
    // Each of these would otherwise reach body-parser as a nonsense limit (a negative one refuses
    // every body) or as an exception at boot. Refusing is what keeps a typo from changing the limit.
    expect(parseBodyLimit(input)).toBeUndefined();
  });
});

describe('CoreBodyParserInitializer', () => {
  let app: INestApplication | undefined;

  afterEach(async () => {
    await app?.close();
    app = undefined;
    vi.restoreAllMocks();
  });

  describe('without configuration', () => {
    it('keeps body-parser default of 100 kB, byte-exact', async () => {
      captureLogs('warn');
      app = await createApp({});

      const atLimit = await postJson(app, jsonOfSize(DEFAULT_LIMIT));
      const overLimit = await postJson(app, jsonOfSize(DEFAULT_LIMIT + 1));

      expect(atLimit.status).toBe(201);
      expect(overLimit.status).toBe(413);
    });

    it('answers a 413 with the error code, the size and the limit instead of a bare message', async () => {
      captureLogs('warn');
      app = await createApp({});

      const res = await postJson(app, jsonOfSize(137_270));

      expect(res.status).toBe(413);
      expect(res.body.message).toBe(`#LTNS_0304: Request body too large [137270 bytes, limit ${DEFAULT_LIMIT} bytes]`);
    });

    it('logs the 413 with the route and the config key to change, but not the query string', async () => {
      const warnings = captureLogs('warn');
      app = await createApp({});

      await postJson(app, jsonOfSize(137_270), '/echo?token=secret-value');

      const line = warnings.find((message) => message.startsWith('413 '));
      expect(line).toContain('POST /echo');
      expect(line).toContain('137270 bytes');
      expect(line).toContain('bodyParser.json.limit');
      expect(line).not.toContain('secret-value');
    });

    it('leaves every other parser error as NestJS answers it', async () => {
      app = await createApp({});

      const res = await postJson(app, '{"data":');

      expect(res.status).toBe(400);
      expect(res.body.message).not.toContain('LTNS_0304');
    });

    it('keeps a global parser registered before init, and still translates its 413', async () => {
      // The shape a project's main.ts has after `server.useBodyParser('json', { limit })`: NestJS
      // then skips its own parser, and the project's limit must survive the initializer.
      captureLogs('warn');
      app = await createApp({}, (nestApp) => nestApp.useBodyParser('json', { limit: 200 * 1024 }));

      expect((await postJson(app, jsonOfSize(150 * 1024))).status).toBe(201);
      const over = await postJson(app, jsonOfSize(250 * 1024));
      expect(over.status).toBe(413);
      expect(over.body.message).toContain(`limit ${200 * 1024} bytes`);
    });
  });

  describe('with bodyParser.json.limit', () => {
    /**
     * The case that failed in production: a real document of 137,270 characters. This boot path
     * never runs main.ts, so a limit set there could not have made this pass.
     *
     * @regression   11.42.4 — a JSON body limit could only be raised through `useBodyParser()` in
     *   main.ts, which `Test.createTestingModule()` never runs: the e2e suite kept 100 kB whatever the
     *   project configured, and a test of a large save asserted its own setup.
     * @seen-failing Make the initializer ignore the configured limit — registered as mutation
     *   `body-parser-config-ignored` in tests/regression-mutations.json.
     */
    it('accepts a body over the default under the testing module', async () => {
      app = await createApp({ bodyParser: { json: { limit: '2mb' } } });

      const res = await postJson(app, jsonOfSize(137_270));

      expect(res.status).toBe(201);
      expect(res.body.size).toBe(137_270);
    });

    it('enforces the configured limit, byte-exact, and reports it', async () => {
      captureLogs('warn');
      app = await createApp({ bodyParser: { json: { limit: 200_000 } } });

      expect((await postJson(app, jsonOfSize(200_000))).status).toBe(201);
      const over = await postJson(app, jsonOfSize(200_001));
      expect(over.status).toBe(413);
      expect(over.body.message).toBe('#LTNS_0304: Request body too large [200001 bytes, limit 200000 bytes]');
    });

    it('does not raise the URL-encoded limit along with it', async () => {
      captureLogs('warn');
      app = await createApp({ bodyParser: { json: { limit: '2mb' } } });

      const res = await request(app.getHttpServer())
        .post('/echo')
        .set('Content-Type', 'application/x-www-form-urlencoded')
        .send(formOfSize(150 * 1024));

      expect(res.status).toBe(413);
      expect(res.body.message).toContain(`limit ${DEFAULT_LIMIT} bytes`);
    });

    it('replaces a global parser registered before init — the configured value wins', async () => {
      captureLogs('warn');
      app = await createApp({ bodyParser: { json: { limit: '2mb' } } }, (nestApp) =>
        nestApp.useBodyParser('json', { limit: 10 * 1024 }),
      );

      expect((await postJson(app, jsonOfSize(150 * 1024))).status).toBe(201);
    });

    it('leaves a path-scoped parser alone', async () => {
      // `server.use('/upload', json({ limit }))` is how a project gives ONE path its own limit; it
      // sits in front of the global parser and must keep both its limit and its own 413.
      // NestJS logs that untranslated 413 as an error with a stack trace — expected here.
      // The global parser is registered explicitly as well: without it NestJS registers none at all
      // (see the next case), and a body that was never parsed also answers 201.
      captureLogs('error');
      app = await createApp({ bodyParser: { json: { limit: '2mb' } } }, (nestApp) => {
        nestApp.use('/scoped', json({ limit: '1kb' }));
        nestApp.useBodyParser('json');
      });

      const scoped = await postJson(app, jsonOfSize(2 * 1024), '/scoped/echo');
      expect(scoped.status).toBe(413);
      expect(scoped.body.message).toBe('request entity too large');
      const global = await postJson(app, jsonOfSize(150 * 1024));
      expect(global.status).toBe(201);
      expect(global.body.keys, 'the global parser must have PARSED the body, not merely let it through').toEqual([
        'data',
      ]);
    });

    /**
     * @regression   11.42.6 — NestJS registers its global parser only if no layer named
     *   `jsonParser` exists yet, and a path-scoped `json()` registered in main.ts before init is
     *   one. A project following the 11.42.4 guide (drop `useBodyParser()` from main.ts) lost JSON
     *   parsing everywhere outside that path — a sign-in failed with "Missing input" — and nothing
     *   logged why. The case above used to set up exactly that and asserted only the status.
     * @seen-failing Silence the shadowed-parser warning in `warnMissingGlobalParser()` — registered
     *   as mutation `body-parser-path-scoped-collision-silent` in tests/regression-mutations.json.
     */
    it('warns when a path-scoped parser made NestJS skip its global one', async () => {
      const warnings = captureLogs('warn');
      captureLogs('error');
      app = await createApp({}, (nestApp) => nestApp.use('/scoped', json({ limit: '1kb' })));

      // The failure the warning explains: outside the scoped path nothing parses the body.
      const unparsed = await postJson(app, jsonOfSize(1024));
      expect(unparsed.body.keys).toEqual([]);
      const warning = warnings.find((message) => message.includes('No global json body parser is registered'));
      expect(warning, `expected the collision to be reported, got:\n${warnings.join('\n')}`).toBeDefined();
      expect(warning).toContain("server.useBodyParser('json')");
    });

    it('does not warn when the global parser exists next to a path-scoped one', async () => {
      const warnings = captureLogs('warn');
      captureLogs('error');
      app = await createApp({}, (nestApp) => {
        nestApp.use('/scoped', json({ limit: '1kb' }));
        nestApp.useBodyParser('json');
      });

      expect(warnings.filter((message) => message.includes('No global json body parser'))).toEqual([]);
    });

    /**
     * The parser runs before authentication: a typo must never change the limit — not to "no
     * limit", and not to "every body refused".
     *
     * @regression   11.42.4 — guards the new option at the moment it is introduced: handed through
     *   unchecked, `0` and negative limits reject every body and a word throws at boot.
     * @seen-failing Pass the configured value to body-parser unparsed — registered as mutation
     *   `body-parser-invalid-limit-passed-through` in tests/regression-mutations.json.
     */
    it.each([['lots'], [0], [-1], ['-2mb']])('refuses %j, logs it, and keeps the 100 kB default', async (limit) => {
      const errors = captureLogs('error');
      captureLogs('warn');
      app = await createApp({ bodyParser: { json: { limit } } } as Partial<IServerOptions>);

      expect((await postJson(app, jsonOfSize(DEFAULT_LIMIT + 1))).status).toBe(413);
      expect((await postJson(app, jsonOfSize(1024))).status).toBe(201);
      expect(errors.some((message) => message.includes('bodyParser.json.limit'))).toBe(true);
    });
  });

  describe('with bodyParser.urlencoded.limit', () => {
    it('raises the URL-encoded limit, keeping nested parsing', async () => {
      app = await createApp({ bodyParser: { urlencoded: { limit: '1mb' } } });

      const res = await request(app.getHttpServer())
        .post('/echo')
        .set('Content-Type', 'application/x-www-form-urlencoded')
        .send(`nested[key]=value&${formOfSize(150 * 1024)}`);

      expect(res.status).toBe(201);
      // `extended: true`, as NestJS registers it: `nested[key]` becomes an object, not a flat key.
      expect(res.body.keys).toEqual(['nested', 'data']);
    });
  });

  describe('rawBody', () => {
    @Module({ controllers: [EchoController], providers: [CoreBodyParserInitializer] })
    class RawBodyModule {}

    async function createFactoryApp(rawBody: boolean): Promise<INestApplication> {
      initConfig({ bodyParser: { json: { limit: '2mb' } } });
      const factoryApp = await NestFactory.create(RawBodyModule, { abortOnError: false, logger: false, rawBody });
      await factoryApp.init();
      return factoryApp;
    }

    /**
     * Webhook signature checks read req.rawBody; losing it once a limit is configured would fail
     * every webhook, with nothing at boot to say why.
     *
     * @regression   11.42.4 — guards the parser replacement at the moment it is introduced: NestJS
     *   installs the raw-body capture only on the parsers IT creates, so a replacement has to carry
     *   it over itself.
     * @seen-failing Report `rawBody` as off regardless of the app options — registered as mutation
     *   `body-parser-rawbody-dropped` in tests/regression-mutations.json.
     */
    it('keeps req.rawBody for an app created with rawBody: true', async () => {
      app = await createFactoryApp(true);

      const res = await postJson(app, jsonOfSize(150 * 1024));

      expect(res.status).toBe(201);
      expect(res.body.rawBody).toBe(150 * 1024);
    });

    it('does not capture it otherwise', async () => {
      app = await createFactoryApp(false);

      const res = await postJson(app, jsonOfSize(150 * 1024));

      expect(res.status).toBe(201);
      expect(res.body.rawBody).toBeNull();
    });
  });

  it('warns when a limit is configured but NestJS registered no parser', async () => {
    const warnings = captureLogs('warn');
    initConfig({ bodyParser: { json: { limit: '2mb' } } });
    const moduleRef = await Test.createTestingModule({ imports: [EchoModule] }).compile();
    app = moduleRef.createNestApplication({ bodyParser: false });
    await app.init();

    expect(warnings.some((message) => message.includes('no global json body parser is registered'))).toBe(true);
  });
});
