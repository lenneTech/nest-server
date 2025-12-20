import { HttpException, HttpStatus, Injectable, NestMiddleware } from '@nestjs/common';
import { NextFunction, Request, Response } from 'express';

import { BetterAuthRateLimiter, RateLimitResult } from './better-auth-rate-limiter.service';
import { BetterAuthService } from './better-auth.service';

/**
 * Middleware that applies rate limiting to Better-Auth endpoints
 *
 * This middleware:
 * 1. Checks if rate limiting is enabled
 * 2. Extracts the client IP address
 * 3. Checks the rate limit for the current request
 * 4. Returns 429 Too Many Requests if limit exceeded
 * 5. Adds rate limit headers to the response
 *
 * Configuration is done via betterAuth.rateLimit in environment config.
 *
 * @example
 * ```typescript
 * // In config.env.ts
 * betterAuth: {
 *   enabled: true,
 *   rateLimit: {
 *     enabled: true,
 *     max: 10,
 *     windowSeconds: 60,
 *   },
 * }
 * ```
 */
@Injectable()
export class BetterAuthRateLimitMiddleware implements NestMiddleware {
  constructor(
    private readonly rateLimiter: BetterAuthRateLimiter,
    private readonly betterAuthService: BetterAuthService,
  ) {}

  use(req: Request, res: Response, next: NextFunction) {
    // Skip if Better-Auth is not enabled
    if (!this.betterAuthService.isEnabled()) {
      return next();
    }

    // Skip if rate limiting is not enabled
    if (!this.rateLimiter.isEnabled()) {
      return next();
    }

    // Get client IP
    const ip = this.getClientIp(req);

    // Get the path relative to basePath
    const basePath = this.betterAuthService.getBasePath();
    const path = req.path.startsWith(basePath) ? req.path.substring(basePath.length) : req.path;

    // Check rate limit
    const result = this.rateLimiter.check(ip, path);

    // Add rate limit headers
    this.addRateLimitHeaders(res, result);

    // If not allowed, return 429
    if (!result.allowed) {
      throw new HttpException(
        {
          error: 'Too Many Requests',
          message: this.rateLimiter.getMessage(),
          retryAfter: result.resetIn,
          statusCode: HttpStatus.TOO_MANY_REQUESTS,
        },
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }

    next();
  }

  /**
   * Extract client IP address from request
   * Handles proxied requests via X-Forwarded-For header
   */
  private getClientIp(req: Request): string {
    // Check X-Forwarded-For header (for proxied requests)
    const forwardedFor = req.headers['x-forwarded-for'];
    if (forwardedFor) {
      const ips = Array.isArray(forwardedFor) ? forwardedFor[0] : forwardedFor.split(',')[0];
      return ips.trim();
    }

    // Check X-Real-IP header (nginx)
    const realIp = req.headers['x-real-ip'];
    if (realIp) {
      return Array.isArray(realIp) ? realIp[0] : realIp;
    }

    // Fall back to connection remote address
    return req.ip || req.socket?.remoteAddress || 'unknown';
  }

  /**
   * Add standard rate limit headers to response
   */
  private addRateLimitHeaders(res: Response, result: RateLimitResult): void {
    res.setHeader('X-RateLimit-Limit', result.limit.toString());
    res.setHeader('X-RateLimit-Remaining', result.remaining.toString());
    res.setHeader('X-RateLimit-Reset', result.resetIn.toString());

    if (!result.allowed) {
      res.setHeader('Retry-After', result.resetIn.toString());
    }
  }
}
