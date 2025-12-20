/**
 * BetterAuth Module exports
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
 * Extension points:
 * - CoreBetterAuthController: Abstract controller for REST extension
 * - CoreBetterAuthResolver: Abstract resolver for GraphQL extension (isAbstract: true)
 * - BetterAuthController/BetterAuthResolver: Default implementations
 */

export * from './better-auth-auth.model';
export * from './better-auth-models';
export * from './better-auth-rate-limit.middleware';
export * from './better-auth-rate-limiter.service';
export * from './better-auth-user.mapper';
export * from './better-auth.config';
export * from './better-auth.middleware';
export * from './better-auth.module';
export * from './better-auth.resolver';
export * from './better-auth.service';
export * from './better-auth.types';
export * from './core-better-auth.controller';
export * from './core-better-auth.resolver';
