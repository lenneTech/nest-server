import { Injectable, Logger } from '@nestjs/common';

import { IBetterAuthRateLimit } from '../../common/interfaces/server-options.interface';

/**
 * Result of a rate limit check
 */
export interface RateLimitResult {
  /**
   * Whether the request is allowed
   */
  allowed: boolean;

  /**
   * Current request count in the window
   */
  current: number;

  /**
   * Maximum requests allowed
   */
  limit: number;

  /**
   * Number of remaining requests in the window
   */
  remaining: number;

  /**
   * Seconds until the rate limit resets
   */
  resetIn: number;
}

/**
 * Rate limit entry for tracking requests
 */
interface RateLimitEntry {
  count: number;
  resetTime: number;
}

/**
 * Default rate limiting configuration
 */
const DEFAULT_CONFIG: Required<IBetterAuthRateLimit> = {
  enabled: false,
  max: 10,
  message: 'Too many requests, please try again later.',
  skipEndpoints: ['/session', '/callback'],
  strictEndpoints: ['/sign-in', '/sign-up', '/forgot-password', '/reset-password'],
  windowSeconds: 60,
};

/**
 * In-memory rate limiter for Better-Auth endpoints
 *
 * This service provides rate limiting to protect against brute-force attacks
 * on authentication endpoints. It uses an in-memory store with automatic cleanup.
 *
 * Features:
 * - Configurable request limits and time windows
 * - Stricter limits for sensitive endpoints (sign-in, sign-up, etc.)
 * - Skip list for endpoints that don't need rate limiting
 * - Automatic cleanup of expired entries
 * - IP-based tracking
 *
 * @example
 * ```typescript
 * const result = rateLimiter.check('192.168.1.1', '/iam/sign-in');
 * if (!result.allowed) {
 *   throw new TooManyRequestsException(rateLimiter.getMessage());
 * }
 * ```
 */
@Injectable()
export class CoreBetterAuthRateLimiter {
  private readonly logger = new Logger(CoreBetterAuthRateLimiter.name);
  private readonly store = new Map<string, RateLimitEntry>();
  private config: Required<IBetterAuthRateLimit> = DEFAULT_CONFIG;
  private cleanupInterval: NodeJS.Timeout | null = null;

  constructor() {
    // Start cleanup interval (every 5 minutes)
    this.startCleanup();
  }

  /**
   * Configure the rate limiter
   *
   * @param config - Rate limiting configuration
   */
  configure(config: IBetterAuthRateLimit | undefined): void {
    this.config = {
      ...DEFAULT_CONFIG,
      ...config,
      // Ensure arrays are properly merged
      skipEndpoints: config?.skipEndpoints ?? DEFAULT_CONFIG.skipEndpoints,
      strictEndpoints: config?.strictEndpoints ?? DEFAULT_CONFIG.strictEndpoints,
    };

    if (this.config.enabled) {
      this.logger.debug(`Rate limiting enabled: ${this.config.max} requests per ${this.config.windowSeconds}s`);
    }
  }

  /**
   * Check if a request is allowed under the rate limit
   *
   * @param ip - Client IP address
   * @param path - Request path (relative to basePath)
   * @returns Rate limit check result
   */
  check(ip: string, path: string): RateLimitResult {
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

    // Check if this endpoint should skip rate limiting
    if (this.shouldSkip(path)) {
      return {
        allowed: true,
        current: 0,
        limit: Infinity,
        remaining: Infinity,
        resetIn: 0,
      };
    }

    // Determine the limit for this endpoint
    const limit = this.getLimit(path);
    const key = this.getKey(ip, path);
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
      this.logger.warn(`Rate limit exceeded for IP ${this.maskIp(ip)} on ${path}: ${entry.count}/${limit}`);
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
    // Remove all entries for this IP
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
   * Determine if an endpoint should skip rate limiting
   */
  private shouldSkip(path: string): boolean {
    return this.config.skipEndpoints.some((skip) => path === skip || path.endsWith(skip) || path.includes(skip));
  }

  /**
   * Get the rate limit for an endpoint
   * Strict endpoints get half the normal limit
   */
  private getLimit(path: string): number {
    const isStrict = this.config.strictEndpoints.some(
      (strict) => path === strict || path.endsWith(strict) || path.includes(strict),
    );

    return isStrict ? Math.ceil(this.config.max / 2) : this.config.max;
  }

  /**
   * Generate a unique key for rate limiting
   * Uses IP + endpoint category to allow different limits per endpoint type
   */
  private getKey(ip: string, path: string): string {
    // Group similar endpoints together
    const endpoint = this.normalizeEndpoint(path);
    return `${ip}:${endpoint}`;
  }

  /**
   * Normalize endpoint path for consistent grouping
   */
  private normalizeEndpoint(path: string): string {
    // Remove query strings
    const cleanPath = path.split('?')[0];

    // Group callback endpoints
    if (cleanPath.includes('/callback/')) {
      return 'callback';
    }

    // Extract the last segment as the endpoint identifier
    const segments = cleanPath.split('/').filter(Boolean);
    return segments[segments.length - 1] || 'root';
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
