/**
 * CoreBetterAuth Module exports
 *
 * Provides integration with the better-auth authentication framework.
 * This module supports:
 * - Email/Password authentication
 * - JWT tokens for API clients
 * - Two-Factor Authentication (TOTP)
 * - Passkey/WebAuthn authentication
 * - Social Login (Google, GitHub, Apple)
 * - Rate limiting for brute-force protection
 * - Parallel operation with Legacy Auth (bcrypt compatible)
 *
 * Naming Convention (consistent with other Core modules):
 * - Core* prefix: Base classes for extension (CoreBetterAuthService, CoreBetterAuthModule, etc.)
 * - Default* prefix: Default implementations (DefaultBetterAuthResolver)
 * - No prefix in consuming projects: Your project's implementations (BetterAuthService, BetterAuthResolver)
 *
 * Extension points:
 * - CoreBetterAuthController: Abstract controller for REST extension
 * - CoreBetterAuthResolver: Abstract resolver for GraphQL extension (isAbstract: true)
 * - DefaultBetterAuthResolver: Default resolver implementation (use as fallback)
 */

export * from './better-auth-token.service';
export * from './better-auth.config';
export * from './better-auth.resolver';
export * from './better-auth.types';
export * from './core-better-auth-api.middleware';
export * from './core-better-auth-auth.model';
export * from './core-better-auth-migration-status.model';
export * from './core-better-auth-models';
export * from './core-better-auth-rate-limit.middleware';
export * from './core-better-auth-rate-limiter.service';
export * from './core-better-auth-user.mapper';
export * from './core-better-auth-web.helper';
export * from './core-better-auth.controller';
export * from './core-better-auth.middleware';
export * from './core-better-auth.module';
export * from './core-better-auth.resolver';
export * from './core-better-auth.service';
