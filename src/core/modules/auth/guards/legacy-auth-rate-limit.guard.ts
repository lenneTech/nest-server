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

  async canActivate(context: ExecutionContext): Promise<boolean> {
    // If rate limiting is disabled, always allow
    if (!this.rateLimiter.isEnabled()) {
      return true;
    }

    const { endpoint, ip } = this.extractRequestInfo(context);
    const result = await this.rateLimiter.check(ip, endpoint);

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
   * Get the client IP that the rate limit counter is keyed on.
   *
   * `request.ip` — NOT `x-forwarded-for` directly. Express derives `req.ip` from the forwarded
   * chain only as far as the app's `trust proxy` setting allows, and falls back to the socket
   * address otherwise. Reading the header ourselves skips that check entirely, so any client
   * simply picks its own bucket by sending a fresh value per request: the counter never reaches
   * the limit, and the brute-force protection this guard exists for is off. A deployment behind
   * a proxy must therefore configure `trust proxy` — that is the one place where "which hop do I
   * believe" belongs.
   */
  private getClientIp(request: any): string {
    return request?.ip || request?.socket?.remoteAddress || 'unknown';
  }
}
