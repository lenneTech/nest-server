import { CanActivate, ExecutionContext, HttpException, HttpStatus, Injectable } from '@nestjs/common';
import { GqlExecutionContext } from '@nestjs/graphql';

import { LegacyAuthRateLimiter } from '../services/legacy-auth-rate-limiter.service';

/**
 * Guard for rate limiting Legacy Auth endpoints
 *
 * This guard applies rate limiting to protect against brute-force attacks.
 * It works with both REST and GraphQL endpoints.
 *
 * Rate limiting must be enabled via configuration:
 * ```typescript
 * auth: {
 *   rateLimit: {
 *     enabled: true,
 *     max: 10,
 *     windowSeconds: 60,
 *   }
 * }
 * ```
 *
 * @since 11.7.x
 */
@Injectable()
export class LegacyAuthRateLimitGuard implements CanActivate {
  constructor(private readonly rateLimiter: LegacyAuthRateLimiter) {}

  canActivate(context: ExecutionContext): boolean {
    // If rate limiting is disabled, always allow
    if (!this.rateLimiter.isEnabled()) {
      return true;
    }

    const { endpoint, ip } = this.extractRequestInfo(context);
    const result = this.rateLimiter.check(ip, endpoint);

    if (!result.allowed) {
      throw new HttpException(
        {
          error: 'Too Many Requests',
          message: this.rateLimiter.getMessage(),
          remaining: result.remaining,
          retryAfter: result.resetIn,
          statusCode: HttpStatus.TOO_MANY_REQUESTS,
        },
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }

    return true;
  }

  /**
   * Extract IP and endpoint from the execution context
   */
  private extractRequestInfo(context: ExecutionContext): { endpoint: string; ip: string } {
    const contextType = context.getType<'graphql' | 'http'>();

    if (contextType === 'graphql') {
      const gqlContext = GqlExecutionContext.create(context);
      const info = gqlContext.getInfo();
      const ctx = gqlContext.getContext();

      // Get IP from request
      const req = ctx.req;
      const ip = this.getClientIp(req);

      // Get endpoint from GraphQL field name
      const endpoint = info?.fieldName || 'unknown';

      return { endpoint, ip };
    }

    // HTTP context
    const request = context.switchToHttp().getRequest();
    const ip = this.getClientIp(request);

    // Get endpoint from URL path
    const url = request.url || request.path || '';
    const endpoint = url.split('/').pop() || 'unknown';

    return { endpoint, ip };
  }

  /**
   * Get client IP from request, handling proxies
   */
  private getClientIp(request: any): string {
    if (!request) {
      return 'unknown';
    }

    // Check common proxy headers
    const forwardedFor = request.headers?.['x-forwarded-for'];
    if (forwardedFor) {
      // Take the first IP in the chain (original client)
      return forwardedFor.split(',')[0].trim();
    }

    const realIp = request.headers?.['x-real-ip'];
    if (realIp) {
      return realIp;
    }

    // Fall back to direct connection IP
    return request.ip || request.connection?.remoteAddress || 'unknown';
  }
}
