import { BadRequestException, Injectable, NestMiddleware } from '@nestjs/common';
import type { NextFunction, Request, Response } from 'express';

import { ErrorCode } from '../error-code/error-codes.js';

/**
 * Whether a raw request path contains something URL resolution rewrites: a `.` or `..` segment (also
 * percent-encoded), a backslash (a segment separator for WHATWG URLs), or an encoded slash or backslash.
 *
 * Every check in front of Better-Auth (rate limiter, controller routes, password routes) reads the RAW path, while
 * Better-Auth routes the path `new URL()` resolved. A path the two read differently passes those checks as one route
 * and runs as another. No route under the Better-Auth base path needs any of these, so such a request is refused.
 *
 * A loop over segments, no regex over the whole path: the path comes from an unauthenticated request and may be as
 * long as Node's header limit allows.
 */
export function hasNonCanonicalPathSegments(path: string): boolean {
  if (path.includes('\\')) {
    return true;
  }
  for (const segment of path.split('/')) {
    if (segment.includes('%')) {
      const lower = segment.toLowerCase();
      if (lower.includes('%2f') || lower.includes('%5c')) {
        return true;
      }
    }
    // The longest dot segment is `%2e%2e`
    if (segment.length === 0 || segment.length > 6) {
      continue;
    }
    const dots = segment.replace(/%2e/gi, '.');
    if (dots === '.' || dots === '..') {
      return true;
    }
  }
  return false;
}

/**
 * The path as Better-Auth routes it: dot segments resolved (also percent-encoded ones), backslashes read as slashes —
 * what `new URL()` makes of it. Query string and fragment are dropped. A path `new URL()` refuses comes back as given.
 */
export function canonicalRequestPath(path: string): string {
  try {
    return new URL(path, 'http://canonical.invalid').pathname;
  } catch {
    return path;
  }
}

/**
 * Whether `path` contains the segments of `endpoint` as a contiguous run of WHOLE segments: `/sign-in` matches
 * `/sign-in/email` and `/phone-number/sign-in`, never `/sign-in-legacy`. Segments are compared as they are; pass a
 * {@link canonicalRequestPath} result, so `..` is already resolved.
 */
export function pathContainsSegments(path: string, endpoint: string): boolean {
  const wanted = endpoint.split('/').filter(Boolean);
  if (wanted.length === 0) {
    return false;
  }
  const segments = path.split('/').filter(Boolean);
  for (let start = 0; start + wanted.length <= segments.length; start++) {
    if (wanted.every((segment, offset) => segments[start + offset] === segment)) {
      return true;
    }
  }
  return false;
}

/**
 * First middleware under the Better-Auth base path: refuses a request whose path is not in canonical form (see
 * {@link hasNonCanonicalPathSegments}) with 400, before any check reads that path.
 */
@Injectable()
export class CoreBetterAuthPathGuardMiddleware implements NestMiddleware {
  use(req: Request, _res: Response, next: NextFunction) {
    const path = (req.originalUrl || req.url || '').split('?')[0];
    if (hasNonCanonicalPathSegments(path)) {
      throw new BadRequestException(ErrorCode.INVALID_REQUEST_PATH);
    }
    next();
  }
}
