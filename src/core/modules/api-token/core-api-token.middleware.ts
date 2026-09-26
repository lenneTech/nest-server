import { HttpException, HttpStatus, Injectable, NestMiddleware, Optional, UnauthorizedException } from '@nestjs/common';
import { NextFunction, Request, Response } from 'express';

import { ErrorCode } from '../error-code/error-codes';
import { getApiTokenConfig, getApiTokenContext, readApiTokenCredentialFromHeaders } from './core-api-token.helpers';
import { CoreApiTokenService } from './core-api-token.service';

/**
 * Authenticates requests that carry an API token or a signed assertion — `Authorization: Bearer …` or
 * `x-api-key: …` — and sets `request.user` (a tenant-token principal, or the owning user of a user
 * token, both carrying the token context).
 *
 * Only credentials with the configured prefix are claimed; Better-Auth sessions, JWTs and legacy tokens
 * pass through untouched (and `CoreBetterAuthMiddleware` in turn leaves prefixed credentials alone).
 *
 * A prefixed credential that does not authenticate is answered with 401 on EVERY route, public ones
 * included — never silently downgraded to anonymous: an integration whose token was revoked must learn
 * that at once, not by missing data. Whether an authenticated token may call a route is decided later by
 * the guards (`@ApiTokenScopes`).
 */
@Injectable()
export class CoreApiTokenMiddleware implements NestMiddleware {
  constructor(@Optional() protected readonly apiTokenService?: CoreApiTokenService) {}

  async use(req: Request & { user?: unknown }, res: Response, next: NextFunction): Promise<void> {
    const config = getApiTokenConfig();
    if (!config.enabled) {
      return next();
    }

    const credential = readApiTokenCredentialFromHeaders(req.headers, config.prefix);
    if (!credential) {
      return next();
    }
    if (credential === 'conflict' || !this.apiTokenService) {
      throw new UnauthorizedException(ErrorCode.UNAUTHORIZED);
    }

    const user = await this.apiTokenService.authenticate(credential);
    const context = getApiTokenContext(user);
    if (!user || !context) {
      throw new UnauthorizedException(ErrorCode.UNAUTHORIZED);
    }

    const limited = await this.apiTokenService.consumeRateLimit(context.tokenId);
    if (limited) {
      res.setHeader('Retry-After', String(limited.retryAfter));
      throw new HttpException(ErrorCode.RATE_LIMIT_EXCEEDED, HttpStatus.TOO_MANY_REQUESTS);
    }

    this.apiTokenService.touchLastUsed(context.tokenId);
    // An explicit credential header wins over anything implicit (a cookie) — the same priority
    // Better-Auth applies between its Authorization header and its session cookie.
    req.user = user;
    next();
  }
}
