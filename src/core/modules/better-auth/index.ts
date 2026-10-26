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

export * from './better-auth-roles.guard.js';
export * from './better-auth-token.service.js';
export * from './better-auth.config.js';
export * from './better-auth.resolver.js';
export * from './better-auth.types.js';
export * from './core-better-auth-api.middleware.js';
export * from './core-better-auth-auth.model.js';
export * from './core-better-auth-cookie.helper.js';
export * from './core-better-auth-email-verification.service.js';
export * from './core-better-auth-error-codes.helper.js';
export * from './core-better-auth-migration-status.model.js';
export * from './core-better-auth-models.js';
export * from './core-better-auth-rate-limit.middleware.js';
export * from './core-better-auth-rate-limiter.service.js';
export * from './core-better-auth-signup-validator.service.js';
export * from './core-better-auth-token.helper.js';
export * from './core-better-auth-user.mapper.js';
export * from './core-better-auth-web.helper.js';
export * from './core-better-auth.constants.js';
export * from './core-better-auth.controller.js';
export * from './core-better-auth.middleware.js';
export * from './core-better-auth.module.js';
// NOT exported: './core-better-auth.registry'.
//
// It is module-internal plumbing that only exists so BetterAuthRolesGuard can reach
// BetterAuthTokenService without importing CoreBetterAuthModule (see .claude/rules/better-auth.md
// §6). Re-exporting it would put `setBetterAuthTokenService()` on the public API — letting a
// consumer swap or null the very token service the guard makes its authorization decisions with.
// Consumers that need the instance already have the public, read-only
// `CoreBetterAuthModule.getTokenServiceInstance()`.
export * from './core-better-auth.resolver.js';
export * from './core-better-auth.service.js';
