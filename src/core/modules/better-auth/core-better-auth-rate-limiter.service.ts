import { Injectable, Logger, Optional } from '@nestjs/common';

import { IBetterAuthRateLimit } from '../../common/interfaces/server-options.interface';
import { CoreRedisService } from '../../common/services/core-redis.service';
import { canonicalRequestPath, pathContainsSegments } from './core-better-auth-path-guard.middleware';
import {
  InMemoryRateLimitStore,
  rateLimitKey,
  rateLimitKeyPrefix,
  RateLimitStore,
  RedisRateLimitStore,
} from '../../common/services/rate-limit-store';

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
 * Default rate limiting configuration
 */
const DEFAULT_CONFIG: Required<IBetterAuthRateLimit> = {
  enabled: false,
  max: 10,
  maxEntries: 10000,
  message: 'Too many requests, please try again later.',
  skipEndpoints: ['/session', '/callback'],
  // The routes Better-Auth actually serves, plus the spellings a project may route itself.
  // `/request-password-reset` is the entry point that MINTS a reset token and sends mail; it
  // matched nothing here before (the only `/` in it is followed by `request`, so
  // `includes('/reset-password')` is false), which left the expensive, mail-sending half of the
  // flow on the FULL limit while the cheap submit half got the halved one. `/forget-password` is
  // Better-Auth's own alias spelling — `/forgot-password` never matched any real route.
  strictEndpoints: [
    '/sign-in',
    '/sign-up',
    '/request-password-reset',
    '/forget-password',
    '/forgot-password',
    '/reset-password',
    '/change-password',
  ],
  windowSeconds: 60,
};

/**
 * Rate limiter for Better-Auth endpoints
 *
 * This service provides rate limiting to protect against brute-force attacks
 * on authentication endpoints. Counters live in a {@link RateLimitStore}: shared
 * via Redis when `ServerOptions.redis` is configured, process-local otherwise.
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
 * const result = await rateLimiter.check('192.168.1.1', '/iam/sign-in');
 * if (!result.allowed) {
 *   throw new TooManyRequestsException(rateLimiter.getMessage());
 * }
 * ```
 */
@Injectable()
export class CoreBetterAuthRateLimiter {
  protected readonly logger = new Logger(CoreBetterAuthRateLimiter.name);
  protected config: Required<IBetterAuthRateLimit> = DEFAULT_CONFIG;
  protected store?: RateLimitStore;

  constructor(@Optional() protected readonly coreRedisService?: CoreRedisService) {}

  /**
   * Configure the rate limiter
   *
   * @param config - Rate limiting configuration
   */
  configure(config: IBetterAuthRateLimit | null | undefined): void {
    // Absent config leaves rate limiting off — backward compatible.
    if (config === undefined || config === null) {
      return;
    }

    // Presence of config implies enabled, unless explicitly disabled. This is the contract
    // `.claude/rules/configurable-features.md` documents for `betterAuth.rateLimit`, and the one
    // `LegacyAuthRateLimiter.configure()` has always implemented. Spreading over an
    // `enabled: false` default without recomputing meant the two sibling limiters had OPPOSITE
    // semantics: a documented `rateLimit: { max: 20 }` armed the legacy limiter and silently
    // armed nothing here — on the side where every new project lives.
    const enabled = config.enabled !== false;

    this.config = {
      ...DEFAULT_CONFIG,
      ...config,
      enabled,
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
   * @param requestPath - Request path (relative to basePath), as sent; dot segments are resolved here
   * @returns Rate limit check result
   */
  async check(ip: string, requestPath: string): Promise<RateLimitResult> {
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

    // Decide on the path the request is served under, not the one as sent: `/callback/../sign-in/email` reaches the
    // sign-in handler, so it must not be skipped as a callback (CoreBetterAuthPathGuardMiddleware refuses such paths
    // before they get here; this keeps the limiter correct where that guard is not registered). Lower-cased because
    // Express routes case-insensitively: `/sign-in/EMAIL` is the same sign-in and must share its counter and its
    // strict limit
    const path = canonicalRequestPath(requestPath).toLowerCase();

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
    const { count, resetIn } = await this.getStore().hit(this.getKey(ip, path), this.config.windowSeconds);

    const allowed = count <= limit;
    const remaining = Math.max(0, limit - count);

    if (!allowed) {
      this.logger.warn(`Rate limit exceeded for IP ${this.maskIp(ip)} on ${path}: ${count}/${limit}`);
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
      // `maxEntries` bounds BOTH stores: process-local entries here, distinct Redis counter keys
      // per window there. A project that tightened the cap must not have it silently ignored the
      // moment `redis` is configured.
      this.store = this.coreRedisService?.enabled
        ? new RedisRateLimitStore(this.coreRedisService, 'better-auth', this.config.maxEntries)
        : new InMemoryRateLimitStore(this.config.maxEntries);
    }
    return this.store;
  }

  /**
   * Determine if an endpoint should skip rate limiting: an entry matches whole path segments, so `/session` skips
   * `/session` but not `/sessions-export`
   */
  private shouldSkip(path: string): boolean {
    return this.config.skipEndpoints.some((skip) => pathContainsSegments(path, skip.toLowerCase()));
  }

  /**
   * Get the rate limit for an endpoint
   * Strict endpoints get half the normal limit
   */
  private getLimit(path: string): number {
    const isStrict = this.config.strictEndpoints.some((strict) => pathContainsSegments(path, strict.toLowerCase()));

    return isStrict ? Math.ceil(this.config.max / 2) : this.config.max;
  }

  /**
   * Generate a unique key for rate limiting
   * Uses IP + endpoint category to allow different limits per endpoint type
   */
  private getKey(ip: string, path: string): string {
    // Group similar endpoints together
    const endpoint = this.normalizeEndpoint(path);
    // rateLimitKey(), not string concatenation: an IP that itself contains the separator (every
    // IPv6 address does) would otherwise straddle the ip/endpoint boundary and share a counter
    // with a different caller.
    return rateLimitKey(ip, endpoint);
  }

  /**
   * The route names the base path serves: the last static segment of every route Better-Auth and the controller
   * answer (`/sign-in/email` → `email`, `/two-factor/enable` → `enable`). Set by CoreBetterAuthRateLimitMiddleware from
   * the running instance. A counter is keyed by one of these names, so a client cannot create counters of its own.
   */
  protected knownEndpoints: null | ReadonlySet<string> = null;

  /**
   * Record the routes the base path serves (paths relative to it, `:param` segments allowed). Only their last static
   * segment counts.
   */
  setKnownEndpoints(paths: Iterable<unknown>): void {
    const names = new Set<string>();
    for (const path of paths) {
      if (typeof path !== 'string') {
        continue;
      }
      const last = path.split('?')[0].split('/').filter(Boolean).pop();
      if (last && !last.startsWith(':')) {
        names.add(last.toLowerCase());
      }
    }
    this.knownEndpoints = names;
  }

  /**
   * Normalize endpoint path for consistent grouping. The result comes from a bounded set — a known route name, a
   * configured strict entry, `callback` or `other` — never from the request alone: keyed by the raw last segment, one
   * client sending `/iam/x1`, `/iam/x2`, … created one counter per path, none of them ever reached the limit, and once
   * the store held `maxEntries` counters every new client fell into the overflow buckets the attacker had filled, and
   * was refused at its first sign-in.
   */
  private normalizeEndpoint(path: string): string {
    // Remove query strings
    const cleanPath = path.split('?')[0];

    // Group callback endpoints
    if (cleanPath.includes('/callback/')) {
      return 'callback';
    }

    // The last segment, when it names a route the base path serves
    const segments = cleanPath.split('/').filter(Boolean);
    const last = segments[segments.length - 1];
    if (last && this.knownEndpoints?.has(last)) {
      return last;
    }

    // A strict route under a name nobody serves (`/reset-password/<token>`, `/sign-in/<anything>`) keeps its own counter
    const strict = this.config.strictEndpoints.find((entry) => pathContainsSegments(cleanPath, entry.toLowerCase()));
    if (strict) {
      return `strict:${strict.toLowerCase()}`;
    }

    // Everything else of one client shares one counter, as every IAM request did before the per-route split
    return 'other';
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
