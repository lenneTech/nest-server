import { Injectable, Logger, OnModuleInit } from '@nestjs/common';

import { IAuthRateLimit } from '../../../common/interfaces/server-options.interface';
import { ConfigService } from '../../../common/services/config.service';

/**
 * Rate limit entry for tracking requests
 */
interface RateLimitEntry {
  count: number;
  resetTime: number;
}

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
 * In-memory rate limiter for Legacy Auth endpoints
 *
 * This service provides rate limiting to protect against brute-force attacks
 * on authentication endpoints. It uses an in-memory store with automatic cleanup.
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
  private readonly logger = new Logger(LegacyAuthRateLimiter.name);
  private readonly store = new Map<string, RateLimitEntry>();
  private config: Required<IAuthRateLimit> = DEFAULT_CONFIG;
  private cleanupInterval: NodeJS.Timeout | null = null;

  constructor() {
    // Start cleanup interval (every 5 minutes)
    this.startCleanup();
  }

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
      this.logger.log(
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
  check(ip: string, endpoint: string): RateLimitResult {
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
    const key = `${ip}:${endpoint}`;
    const now = Date.now();

    // Get or create entry
    let entry = this.store.get(key);

    if (!entry || now >= entry.resetTime) {
      // Create new entry or reset expired one
      entry = {
        count: 1,
        resetTime: now + this.config.windowSeconds * 1000,
      };
      this.store.set(key, entry);

      return {
        allowed: true,
        current: 1,
        limit,
        remaining: limit - 1,
        resetIn: this.config.windowSeconds,
      };
    }

    // Increment count
    entry.count++;

    const resetIn = Math.ceil((entry.resetTime - now) / 1000);
    const allowed = entry.count <= limit;
    const remaining = Math.max(0, limit - entry.count);

    if (!allowed) {
      this.logger.warn(`Rate limit exceeded for IP ${this.maskIp(ip)} on ${endpoint}: ${entry.count}/${limit}`);
    }

    return {
      allowed,
      current: entry.count,
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
  reset(ip: string): void {
    for (const key of this.store.keys()) {
      if (key.startsWith(`${ip}:`)) {
        this.store.delete(key);
      }
    }
  }

  /**
   * Clear all rate limit entries (useful for testing)
   */
  clear(): void {
    this.store.clear();
  }

  /**
   * Get statistics about the rate limiter
   */
  getStats(): { activeEntries: number; enabled: boolean } {
    return {
      activeEntries: this.store.size,
      enabled: this.config.enabled,
    };
  }

  /**
   * Stop the cleanup interval (for graceful shutdown)
   */
  onModuleDestroy(): void {
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
      this.cleanupInterval = null;
    }
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

  /**
   * Start periodic cleanup of expired entries
   */
  private startCleanup(): void {
    // Clean up every 5 minutes
    this.cleanupInterval = setInterval(
      () => {
        const now = Date.now();
        let cleaned = 0;

        for (const [key, entry] of this.store.entries()) {
          if (now >= entry.resetTime) {
            this.store.delete(key);
            cleaned++;
          }
        }

        if (cleaned > 0) {
          this.logger.debug(`Cleaned up ${cleaned} expired rate limit entries`);
        }
      },
      5 * 60 * 1000,
    );

    // Prevent the interval from keeping the process alive
    if (this.cleanupInterval.unref) {
      this.cleanupInterval.unref();
    }
  }
}
