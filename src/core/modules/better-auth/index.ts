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
 * - Legacy password handling for migration
 * - Rate limiting for brute-force protection
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
