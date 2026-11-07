import { Injectable, NestMiddleware } from '@nestjs/common';
import type { NextFunction, Request, Response } from 'express';

import { ConfigService } from '../services/config.service';

/**
 * Removes every cookie value that is not a string from `req.cookies`, and from `req.signedCookies` every value that
 * is neither a string nor `false` (cookie-parser's marker for a cookie whose signature did not verify).
 *
 * cookie-parser turns a cookie value starting with `j:` into the parsed JSON, so a client sending
 * `iam.session_token=j:{"$ne":null}` puts an OBJECT into `req.cookies` — the shape a MongoDB filter reads as an operator.
 * That signed requests in as the owner of a stored session until 11.43.10 (DEV-4138). The framework writes only
 * string cookies, so a non-string value is never one of its own.
 *
 * @returns the names of the removed cookies (for logging and tests)
 */
export function dropNonStringCookies(req: { cookies?: unknown; signedCookies?: unknown }): string[] {
  const removed: string[] = [];
  for (const [store, keepFalse] of [
    [req.cookies, false],
    [req.signedCookies, true],
  ] as const) {
    if (!store || typeof store !== 'object') {
      continue;
    }
    const jar = store as Record<string, unknown>;
    for (const name of Object.keys(jar)) {
      const value = jar[name];
      if (typeof value === 'string' || (keepFalse && value === false)) {
        continue;
      }
      delete jar[name];
      removed.push(name);
    }
  }
  return removed;
}

/**
 * Keeps non-string values out of the parsed cookies of every request (DEV-4144), so no code path — framework or
 * project — can hand a `j:` cookie to a query as an object. Registered by `CoreModule` for all routes, right after the
 * request context; cookie-parser (registered in `main.ts`) has parsed the cookies by then.
 *
 * Switch: `security.stringCookiesOnly` (default `true`; only an explicit `false` turns it off). The guards at the
 * individual queries (`isQueryableString()`) stay — this middleware covers cookies, not body or query values.
 */
@Injectable()
export class StringCookiesMiddleware implements NestMiddleware {
  constructor(protected readonly configService: ConfigService) {}

  use(req: Request, _res: Response, next: NextFunction): void {
    if (this.configService.getFastButReadOnly<boolean>('security.stringCookiesOnly') !== false) {
      dropNonStringCookies(req);
    }
    next();
  }
}
