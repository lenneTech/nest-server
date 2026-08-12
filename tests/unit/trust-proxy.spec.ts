import { Controller, Get, Logger, Req } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { ConfigService } from '../../src/core/common/services/config.service';
import { CoreTrustProxyInitializer } from '../../src/core/common/services/core-trust-proxy.initializer';

import type { INestApplication } from '@nestjs/common';
import type { IServerOptions } from '../../src/core/common/interfaces/server-options.interface';

/**
 * These tests drive a REAL Express app through the real initializer, because the property under
 * test is Express's own behaviour: `req.ip` follows `X-Forwarded-For` only as far as
 * `trust proxy` allows, and that setting defaults to `false`. Asserting that `app.set()` was called
 * would restate the implementation and still pass if the value never reached `req.ip`.
 *
 * What this guards: keying a rate limit on `request.ip` without the setting collapses every client
 * behind a reverse proxy onto ONE bucket, so the limit throttles everybody at once.
 */

/** Reports what Express resolved as the client IP for the request */
@Controller()
class ProbeController {
  @Get('probe')
  probe(@Req() req: any): { ip: string } {
    return { ip: req.ip };
  }
}

/**
 * REPLACE the static config, do not merge into it.
 *
 * `new ConfigService(cfg)` merges once the singleton exists, so a `trustProxy` set by an earlier
 * test would survive into the next one and silently satisfy the "already configured" branch.
 */
const initConfig = (config: Partial<IServerOptions>) =>
  ConfigService.setConfig(config as any, { reInit: true, warn: false });

async function createApp(config: Partial<IServerOptions>): Promise<INestApplication> {
  initConfig(config);
  const moduleRef = await Test.createTestingModule({
    controllers: [ProbeController],
    providers: [CoreTrustProxyInitializer],
  }).compile();

  const app = moduleRef.createNestApplication();
  await app.init();
  return app;
}

describe('CoreTrustProxyInitializer', () => {
  let app: INestApplication | undefined;

  afterEach(async () => {
    await app?.close();
    app = undefined;
    vi.restoreAllMocks();
  });

  it('ignores a forwarded header when trustProxy is not configured', async () => {
    // Express's default. The header is attacker-controlled without a proxy in front, so believing
    // it would let any client pick its own rate-limit bucket per request.
    app = await createApp({});

    const res = await request(app.getHttpServer()).get('/probe').set('X-Forwarded-For', '9.9.9.9');

    expect(res.body.ip).not.toBe('9.9.9.9');
  });

  it('honours the forwarded header when trustProxy is configured', async () => {
    app = await createApp({ trustProxy: 1 });

    const res = await request(app.getHttpServer()).get('/probe').set('X-Forwarded-For', '9.9.9.9');

    expect(res.body.ip).toBe('9.9.9.9');
  });

  it('trusts exactly the configured number of hops', async () => {
    // The hop count is the whole point: with two proxies in front, the client-supplied entry is
    // the leftmost one and must stay untrusted. Trusting one hop picks the entry the nearest
    // proxy appended, not the one the client invented.
    app = await createApp({ trustProxy: 1 });

    const res = await request(app.getHttpServer())
      .get('/probe')
      .set('X-Forwarded-For', '1.1.1.1, 2.2.2.2');

    expect(res.body.ip).toBe('2.2.2.2');
  });

  it('accepts a subnet list', async () => {
    app = await createApp({ trustProxy: ['loopback', '10.0.0.0/8'] });

    const res = await request(app.getHttpServer()).get('/probe').set('X-Forwarded-For', '9.9.9.9');

    // supertest connects over loopback, which the list trusts, so the forwarded entry is used
    expect(res.body.ip).toBe('9.9.9.9');
  });

  it('leaves the setting alone when trustProxy is not configured', async () => {
    // Module init runs inside app.init(), i.e. AFTER main.ts — so applying an unset value would
    // silently overwrite a consumer's own app.set('trust proxy', fn), the documented escape hatch
    // for the predicate form the option does not accept.
    app = await createApp({});
    const express = app.getHttpAdapter().getInstance();
    express.set('trust proxy', 1);

    const res = await request(app.getHttpServer()).get('/probe').set('X-Forwarded-For', '9.9.9.9');

    expect(res.body.ip).toBe('9.9.9.9');
  });

  describe('boot warning', () => {
    /**
     * The misconfiguration is silent by construction — nothing in the request path can tell that
     * every caller resolved to the same address — so the warning is the only thing standing
     * between it and a lockout nobody can explain.
     */
    async function warningsFor(config: Partial<IServerOptions>): Promise<string[]> {
      const warnings: string[] = [];
      vi.spyOn(Logger.prototype, 'warn').mockImplementation((message: any) => {
        warnings.push(String(message));
      });
      app = await createApp(config);
      return warnings.filter(message => message.includes('trust proxy'));
    }

    it('warns when a rate limiter is enabled and trustProxy is unset', async () => {
      const warnings = await warningsFor({ auth: { rateLimit: { max: 10 } } } as Partial<IServerOptions>);

      expect(warnings).toHaveLength(1);
      expect(warnings[0]).toContain('auth.rateLimit');
      expect(warnings[0]).toContain('shares one bucket');
    });

    it('names the better-auth limiter too', async () => {
      const warnings = await warningsFor({ betterAuth: { rateLimit: {} } } as Partial<IServerOptions>);

      expect(warnings[0]).toContain('betterAuth.rateLimit');
    });

    it('stays quiet when trustProxy is configured', async () => {
      expect(await warningsFor({ auth: { rateLimit: { max: 10 } }, trustProxy: 1 } as Partial<IServerOptions>)).toEqual(
        [],
      );
    });

    it('stays quiet when trustProxy is explicitly false — the "nothing proxies me" answer', async () => {
      expect(
        await warningsFor({ auth: { rateLimit: { max: 10 } }, trustProxy: false } as Partial<IServerOptions>),
      ).toEqual([]);
    });

    it('stays quiet when no IP-keyed rate limiter is enabled', async () => {
      expect(await warningsFor({ auth: { rateLimit: { enabled: false } } } as Partial<IServerOptions>)).toEqual([]);
      expect(await warningsFor({})).toEqual([]);
    });
  });
});
