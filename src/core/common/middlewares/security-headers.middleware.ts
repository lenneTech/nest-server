import { Injectable, NestMiddleware } from '@nestjs/common';
import { Response as ExpressResponse, NextFunction, Request } from 'express';

import { ISecurityHeaders } from '../interfaces/server-options.interface';
import { ConfigService } from '../services/config.service';

/**
 * Sets the standard browser security headers on every response.
 *
 * WHY THIS IS IN THE FRAMEWORK AND NOT IN EACH PROJECT
 *
 * The same header set was being rebuilt by hand across the stack — one project inline in
 * `main.ts`, another as its own middleware, a third about to. A freshly generated project sent
 * none at all. Anything rebuilt per project drifts per project, and a header that is missing
 * produces no error anywhere: it shows up in a pentest report months later.
 *
 * Putting it here also reaches EXISTING projects on their next update, which a change in the
 * starter would not.
 *
 * ORDER MATTERS: THIS IS MIDDLEWARE, NOT AN INTERCEPTOR
 *
 * Registered through `CoreModule.configure()`, so it runs before guards and before the handler.
 * That is deliberate — a `401` from a roles guard is still a response a browser renders, and it
 * has to carry the headers too. An interceptor would miss every request rejected before the
 * handler, which is precisely the set an attacker is most likely to be generating.
 *
 * NOT A REPLACEMENT FOR THE EDGE
 *
 * A reverse proxy (Traefik, Caddy, nginx) can set the same headers, and where one does, its
 * values win — the proxy writes last. That is fine and intended: this layer exists so that a
 * deployment WITHOUT such a proxy, or a local instance, is not bare. Defense in depth, not a
 * turf claim.
 */
@Injectable()
export class SecurityHeadersMiddleware implements NestMiddleware {
  constructor(protected readonly configService: ConfigService) {}

  use(req: Request, res: ExpressResponse, next: NextFunction): void {
    const config = this.resolveConfig();
    if (!config) {
      return next();
    }

    // Express advertises itself by default. It tells an attacker which stack to target and buys
    // nothing; `app.disable('x-powered-by')` would work too, but doing it here keeps the whole
    // header policy in one readable place.
    if (config.removePoweredBy) {
      res.removeHeader('X-Powered-By');
    }

    if (config.contentTypeOptions) {
      res.setHeader('X-Content-Type-Options', 'nosniff');
    }

    if (config.frameOptions) {
      res.setHeader('X-Frame-Options', config.frameOptions);
    }

    if (config.referrerPolicy) {
      res.setHeader('Referrer-Policy', config.referrerPolicy);
    }

    if (config.contentSecurityPolicy) {
      res.setHeader('Content-Security-Policy', config.contentSecurityPolicy);
    }

    if (config.hsts && this.isSecureRequest(req)) {
      const directives = [`max-age=${config.hsts.maxAge}`];
      if (config.hsts.includeSubDomains) {
        directives.push('includeSubDomains');
      }
      if (config.hsts.preload) {
        directives.push('preload');
      }
      res.setHeader('Strict-Transport-Security', directives.join('; '));
    }

    next();
  }

  /**
   * Whether this request actually arrived over HTTPS.
   *
   * **HSTS is decided by the protocol, never by configuration or environment.** A browser
   * remembers the header: one `Strict-Transport-Security` sent from a dev server over
   * `http://localhost` makes EVERY project on that host unreachable over http for up to a year,
   * and there is no way to take it back from the server side. So an env flag must not be able to
   * turn it on where it does not belong — the request itself has to say so.
   *
   * `x-forwarded-proto` is read first because in every deployment that terminates TLS at a proxy
   * the connection reaching Node is plain http, and `req.secure` alone would answer "no" for
   * every production request. That header is only trustworthy behind a proxy, which is what
   * `trustProxy` exists to declare — and Express only populates `req.secure` from it when
   * `trust proxy` is set, so both halves agree on the same configuration.
   */
  protected isSecureRequest(req: Request): boolean {
    const forwarded = req.headers['x-forwarded-proto'];
    if (typeof forwarded === 'string' && forwarded.length) {
      // A proxy chain may append: "https,http". The client-facing hop is the first entry.
      return forwarded.split(',')[0].trim().toLowerCase() === 'https';
    }

    return req.secure === true || req.protocol === 'https';
  }

  /**
   * Resolves the effective policy, or `null` when the feature is switched off.
   *
   * Safe by default: an unconfigured project gets the full set except CSP. CSP is opt-in because
   * a wrong one breaks the application rather than hardening it, and a correct one depends on
   * what the project loads — this package cannot know that, and two of its own surfaces (the Hub
   * and the GraphQL playground) serve their own HTML.
   */
  protected resolveConfig():
    | null
    | (Required<Omit<ISecurityHeaders, 'contentSecurityPolicy' | 'enabled' | 'hsts'>> & {
        contentSecurityPolicy?: string;
        hsts: null | { includeSubDomains: boolean; maxAge: number; preload: boolean };
      }) {
    const raw = this.configService.getFastButReadOnly('security')?.headers;

    if (raw === false) {
      return null;
    }

    const options: ISecurityHeaders = raw === true || raw === undefined ? {} : raw;
    if (options.enabled === false) {
      return null;
    }

    const hsts =
      options.hsts === false ? null : options.hsts === true || options.hsts === undefined ? {} : options.hsts;

    return {
      contentSecurityPolicy: options.contentSecurityPolicy,
      contentTypeOptions: options.contentTypeOptions !== false,
      frameOptions: options.frameOptions === false ? undefined : (options.frameOptions ?? 'DENY'),
      hsts: hsts
        ? {
            includeSubDomains: hsts.includeSubDomains !== false,
            // One year. The value the major preload lists require, and long enough that it is a
            // decision rather than a formality.
            maxAge: typeof hsts.maxAge === 'number' ? hsts.maxAge : 31536000,
            // NOT on by default: `preload` is a submission to a browser-vendor list that is
            // slow and awkward to reverse, and it commits every subdomain. That belongs to
            // whoever owns the domain, not to a framework default.
            preload: hsts.preload === true,
          }
        : null,
      referrerPolicy:
        options.referrerPolicy === false ? undefined : (options.referrerPolicy ?? 'strict-origin-when-cross-origin'),
      removePoweredBy: options.removePoweredBy !== false,
    } as any;
  }
}
