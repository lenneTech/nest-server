import { CanActivate, ExecutionContext, Injectable, Logger, SetMetadata } from '@nestjs/common';
import { Reflector } from '@nestjs/core';

/**
 * Metadata key for the per-route rate limit configuration.
 */
export const SYNC_RATE_LIMIT_KEY = 'sync:rate-limit';

export interface ISyncRateLimitMeta {
  max: number;
  windowSeconds: number;
}

/**
 * Decorator: attaches a rate-limit configuration to a controller route.
 *
 * @example
 * ```typescript
 * @Get('User')
 * @SyncRateLimit({ max: 60, windowSeconds: 60 })
 * pull(...) { ... }
 * ```
 */
export function SyncRateLimit(meta: ISyncRateLimitMeta | false): MethodDecorator {
  return SetMetadata(SYNC_RATE_LIMIT_KEY, meta);
}

interface IBucket {
  count: number;
  windowStart: number;
}

/**
 * In-memory token-bucket rate limiter, keyed by (userId or IP, route).
 *
 * For multi-instance deployments, override the guard via
 * `ICoreModuleOverrides.sync.rateLimitGuard` with a Redis-backed
 * implementation that shares state across instances.
 *
 * If `false` is set as the rate-limit metadata for a route, the guard
 * always allows the request.
 */
@Injectable()
export class SyncRateLimitGuard implements CanActivate {
  private readonly logger = new Logger(SyncRateLimitGuard.name);
  private readonly buckets = new Map<string, IBucket>();
  private cleanupInterval: NodeJS.Timeout | null = null;

  constructor(protected readonly reflector: Reflector) {
    // Periodic cleanup of stale buckets to avoid unbounded growth.
    if (typeof setInterval !== 'undefined') {
      this.cleanupInterval = setInterval(() => this.cleanup(), 60_000);
      // Allow Node to exit even when the interval is still scheduled.
      if (this.cleanupInterval.unref) this.cleanupInterval.unref();
    }
  }

  canActivate(context: ExecutionContext): boolean {
    const meta = this.reflector.get<ISyncRateLimitMeta | false | undefined>(
      SYNC_RATE_LIMIT_KEY,
      context.getHandler(),
    );

    // No metadata or explicitly disabled → allow.
    if (!meta) return true;

    const req = context.switchToHttp().getRequest();
    const userId = (req?.user as any)?.id || (req?.user as any)?._id || req?.ip || 'anonymous';
    const route = `${req?.method || 'GET'}:${req?.route?.path || req?.url || 'unknown'}`;
    const key = `${userId}::${route}`;

    const now = Date.now();
    const windowMs = meta.windowSeconds * 1000;

    let bucket = this.buckets.get(key);
    if (!bucket || now - bucket.windowStart >= windowMs) {
      bucket = { count: 0, windowStart: now };
      this.buckets.set(key, bucket);
    }

    bucket.count += 1;

    if (bucket.count > meta.max) {
      this.logger.warn(`Sync rate limit exceeded for ${key} (${bucket.count}/${meta.max} per ${meta.windowSeconds}s)`);
      return false;
    }

    return true;
  }

  private cleanup() {
    const now = Date.now();
    // Drop buckets older than 5 minutes (well past any reasonable window).
    const stale = 5 * 60_000;
    for (const [key, bucket] of this.buckets.entries()) {
      if (now - bucket.windowStart > stale) {
        this.buckets.delete(key);
      }
    }
  }

  onModuleDestroy() {
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
      this.cleanupInterval = null;
    }
  }
}
