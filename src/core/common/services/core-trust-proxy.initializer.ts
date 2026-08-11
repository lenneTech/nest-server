import { Injectable, Logger, OnApplicationBootstrap, OnModuleInit, Optional } from '@nestjs/common';
import { HttpAdapterHost } from '@nestjs/core';

import { IServerOptions } from '../interfaces/server-options.interface';
import { ConfigService } from './config.service';

/** Express setting name — the string Express itself keys the compiled trust function off */
const TRUST_PROXY = 'trust proxy';

/**
 * Applies `ServerOptions.trustProxy` to the underlying Express app, and warns when an IP-keyed
 * rate limiter runs without it.
 *
 * This lives in a CoreModule provider rather than in `main.ts` so a consumer inherits it by
 * upgrading, without editing its bootstrap. It works because `HttpAdapterHost` already holds the
 * adapter by the time providers are instantiated — `NestFactory` calls `container.setHttpAdapter()`
 * before the dependency scan — and `req.ip` is computed per request, so setting it any time before
 * `listen()` is early enough.
 *
 * Registered as a CoreModule provider; consumers never interact with it.
 */
@Injectable()
export class CoreTrustProxyInitializer implements OnApplicationBootstrap, OnModuleInit {
  protected readonly logger = new Logger(CoreTrustProxyInitializer.name);

  constructor(@Optional() protected readonly httpAdapterHost?: HttpAdapterHost) {}

  /**
   * Apply the configured value, if there is one.
   *
   * Only when configured: module init runs inside `app.init()`, i.e. AFTER `main.ts`, so applying
   * an unset value would silently overwrite a consumer's own `app.set('trust proxy', fn)` — which
   * is the documented escape hatch for the predicate form this option does not accept.
   */
  onModuleInit(): void {
    const configured = this.getConfigured();
    if (configured === undefined) {
      return;
    }

    const app = this.getExpressApp();
    if (!app) {
      // Fastify and non-HTTP contexts have no equivalent setting; there is nothing to apply and
      // nothing the consumer can do about it, so this stays silent rather than warning per boot.
      return;
    }

    app.set(TRUST_PROXY, configured);
    this.logger.log(
      `Express "trust proxy" set to ${JSON.stringify(configured)} — request.ip follows X-Forwarded-For accordingly`,
    );
  }

  /**
   * Warn once at boot when a rate limiter is keyed on an IP the app cannot actually determine.
   *
   * Runs in `onApplicationBootstrap` so every `onModuleInit` — including the limiters' own
   * auto-configuration — has completed, and reads the LIVE Express setting rather than the config
   * so a consumer who set it by hand in `main.ts` is not nagged.
   *
   * The failure this names is silent by construction: nothing in the request path can tell that
   * every caller resolved to the same address, so without this line the first symptom is users
   * being locked out of sign-in with no matching attack in the logs.
   */
  onApplicationBootstrap(): void {
    const limiters = this.enabledIpRateLimiters();
    if (this.getConfigured() !== undefined || !limiters.length) {
      return;
    }

    const app = this.getExpressApp();
    if (!app || app.get(TRUST_PROXY)) {
      return;
    }

    this.logger.warn(
      `Rate limiting is enabled (${limiters.join(', ')}) but Express "trust proxy" is not set. ` +
        'Behind a reverse proxy (Caddy, nginx, a Kubernetes ingress) request.ip is then the PROXY address for every ' +
        'request, so every client behind a reverse proxy shares one bucket and the limit throttles all of them at ' +
        'once. Set `trustProxy` in your server options to the number of proxy hops in front of this app ' +
        '(e.g. `trustProxy: 1`), or `trustProxy: false` if nothing proxies it — which also silences this warning.',
    );
  }

  /**
   * Which IP-keyed limiters are on.
   *
   * Read from config rather than injected, so this provider stays free of import edges to the auth
   * and better-auth modules. Both follow "presence implies enabled". The AI limiter is deliberately
   * absent: it keys on the user id, so `trust proxy` does not affect it.
   */
  protected enabledIpRateLimiters(): string[] {
    return (['auth.rateLimit', 'betterAuth.rateLimit'] as const).filter((path) => {
      const config = ConfigService.getFastButReadOnly<{ enabled?: boolean } | boolean>(path);
      if (config === undefined || config === null || config === false) {
        return false;
      }
      return typeof config === 'boolean' ? config : config.enabled !== false;
    });
  }

  /** The configured value, or `undefined` when the consumer did not set one */
  protected getConfigured(): IServerOptions['trustProxy'] {
    return ConfigService.getFastButReadOnly<IServerOptions['trustProxy']>('trustProxy');
  }

  /** The Express application, or `undefined` for a non-Express adapter */
  protected getExpressApp(): undefined | { get: (name: string) => any; set: (name: string, value: any) => void } {
    const instance = this.httpAdapterHost?.httpAdapter?.getInstance?.();
    return typeof instance?.set === 'function' && typeof instance?.get === 'function' ? instance : undefined;
  }
}
