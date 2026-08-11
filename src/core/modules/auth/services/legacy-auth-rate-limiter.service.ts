import { Injectable, Logger, OnModuleInit, Optional } from '@nestjs/common';

import { IAuthRateLimit } from '../../../common/interfaces/server-options.interface';
import { ConfigService } from '../../../common/services/config.service';
import { CoreRedisService } from '../../../common/services/core-redis.service';
import {
  InMemoryRateLimitStore,
  rateLimitKey,
  rateLimitKeyPrefix,
  RateLimitStore,
  RedisRateLimitStore,
} from '../../../common/services/rate-limit-store';

/**
 * Result of a rate limit check
 *
 * @internal This interface is identical to BetterAuthRateLimiter's RateLimitResult.
 * Use the exported RateLimitResult from better-auth module if needed externally.
 */
interface RateLimitResult {
  /** Whether the request is allowed */
  allowed: boolean;
  /** Current request count in the window */
  current: number;
  /** Maximum requests allowed */
  limit: number;
  /** Number of remaining requests in the window */
  remaining: number;
  /** Seconds until the rate limit resets */
  resetIn: number;
}

/**
 * Default rate limiting configuration
 */
const DEFAULT_CONFIG: Required<IAuthRateLimit> = {
  enabled: false,
  max: 10,
  message: 'Too many requests, please try again later.',
  windowSeconds: 60,
};

/**
 * Rate limiter for Legacy Auth endpoints
 *
 * This service provides rate limiting to protect against brute-force attacks
 * on authentication endpoints. Counters live in a {@link RateLimitStore}: shared
 * via Redis when `ServerOptions.redis` is configured, process-local otherwise.
 *
 * Features:
 * - Configurable request limits and time windows
 * - Automatic cleanup of expired entries
 * - IP-based tracking
 * - Auto-configuration from ConfigService
 *
 * Configuration via config.env.ts:
 * ```typescript
 * auth: {
 *   rateLimit: {
 *     enabled: true,
 *     max: 10,
 *     windowSeconds: 60,
 *     message: 'Too many login attempts, please try again later.',
 *   }
 * }
 * ```
 *
 * @since 11.7.x
 */
@Injectable()
export class LegacyAuthRateLimiter implements OnModuleInit {
  protected readonly logger = new Logger(LegacyAuthRateLimiter.name);
  protected config: Required<IAuthRateLimit> = DEFAULT_CONFIG;
  protected store?: RateLimitStore;

  constructor(@Optional() protected readonly coreRedisService?: CoreRedisService) {}

  /**
   * Auto-configure from ConfigService on module initialization
   */
  onModuleInit(): void {
    const rateLimitConfig = ConfigService.getFastButReadOnly<IAuthRateLimit>('auth.rateLimit');
    if (rateLimitConfig) {
      this.configure(rateLimitConfig);
    }
  }

  /**
   * Configure the rate limiter
   *
   * Follows the "presence implies enabled" pattern:
   * - If config is undefined/null: rate limiting is disabled (backward compatible)
   * - If config is an object (even empty {}): rate limiting is enabled by default
   * - Unless `enabled: false` is explicitly set to disable while pre-configuring
   *
   * @param config - Rate limiting configuration (presence implies enabled)
   */
  configure(config: IAuthRateLimit | null | undefined): void {
    // If config is not provided, rate limiting stays disabled (backward compatible)
    if (config === undefined || config === null) {
      return;
    }

    // Presence of config implies enabled, unless explicitly disabled
    const enabled = config.enabled !== false;

    this.config = {
      ...DEFAULT_CONFIG,
      ...config,
      enabled,
    };

    if (this.config.enabled) {
      this.logger.debug(
        `Legacy Auth rate limiting enabled: ${this.config.max} requests per ${this.config.windowSeconds}s`,
      );
    }
  }

  /**
   * Check if a request is allowed under the rate limit
   *
   * @param ip - Client IP address
   * @param endpoint - Endpoint name (e.g., 'signIn', 'signUp')
   * @returns Rate limit check result
   */
  async check(ip: string, endpoint: string): Promise<RateLimitResult> {
    // If rate limiting is disabled, always allow
    if (!this.config.enabled) {
      return {
        allowed: true,
        current: 0,
        limit: Infinity,
        remaining: Infinity,
        resetIn: 0,
      };
    }

    const limit = this.config.max;
    // rateLimitKey(), not string concatenation: an IP that itself contains the separator (every
    // IPv6 address does) would otherwise straddle the ip/endpoint boundary and share a counter
    // with a different caller.
    const { count, resetIn } = await this.getStore().hit(rateLimitKey(ip, endpoint), this.config.windowSeconds);

    const allowed = count <= limit;
    const remaining = Math.max(0, limit - count);

    if (!allowed) {
      this.logger.warn(`Rate limit exceeded for IP ${this.maskIp(ip)} on ${endpoint}: ${count}/${limit}`);
    }

    return {
      allowed,
      current: count,
      limit,
      remaining,
      resetIn,
    };
  }

  /**
   * Get the configured error message
   */
  getMessage(): string {
    return this.config.message;
  }

  /**
   * Check if rate limiting is enabled
   */
  isEnabled(): boolean {
    return this.config.enabled;
  }

  /**
   * Reset rate limit for a specific IP (useful for testing or admin override)
   *
   * @param ip - Client IP address
   */
  async reset(ip: string): Promise<void> {
    await this.getStore().resetByPrefix(rateLimitKeyPrefix(ip));
  }

  /**
   * Clear all rate limit entries (useful for testing)
   */
  async clear(): Promise<void> {
    await this.getStore().clear();
  }

  /**
   * Get statistics about the rate limiter
   *
   * `activeEntries` is `-1` when a Redis store is in use — the entry count is
   * not cheaply known there.
   */
  getStats(): { activeEntries: number; enabled: boolean } {
    return {
      activeEntries: this.store?.size() ?? 0,
      enabled: this.config.enabled,
    };
  }

  /**
   * Stop the in-memory cleanup interval (for graceful shutdown)
   */
  onModuleDestroy(): void {
    // Not `instanceof InMemoryRateLimitStore`: a RedisRateLimitStore owns an in-memory fallback
    // whose cleanup interval would otherwise outlive the app.
    this.store?.destroy?.();
  }

  /**
   * Lazily select the counter store: Redis when configured and enabled,
   * process-local otherwise.
   */
  protected getStore(): RateLimitStore {
    if (!this.store) {
      this.store = this.coreRedisService?.enabled
        ? new RedisRateLimitStore(this.coreRedisService, 'legacy-auth')
        : new InMemoryRateLimitStore();
    }
    return this.store;
  }

  /**
   * Mask IP address for logging (privacy)
   */
  private maskIp(ip: string): string {
    if (ip.includes('.')) {
      // IPv4: show first two octets
      const parts = ip.split('.');
      return `${parts[0]}.${parts[1]}.*.*`;
    }
    // IPv6: show first segment
    const parts = ip.split(':');
    return `${parts[0]}:****`;
  }
}
