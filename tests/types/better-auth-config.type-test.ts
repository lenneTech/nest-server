/**
 * Type tests for IBetterAuth discriminated union types.
 *
 * This file tests compile-time validation that trustedOrigins is required
 * when passkey is enabled. These are NOT runtime tests - they verify
 * TypeScript catches configuration errors at compile time.
 *
 * Run with: npx tsc --noEmit
 */

import { IBetterAuth } from '../../src/core/common/interfaces/server-options.interface';

// =============================================================================
// VALID CONFIGURATIONS - These should all compile without errors
// =============================================================================

// Passkey enabled (boolean) WITH trustedOrigins
const validPasskeyBoolean: IBetterAuth = {
  passkey: true,
  trustedOrigins: ['http://localhost:3001'],
};

// Passkey enabled (config object) WITH trustedOrigins
const validPasskeyConfig: IBetterAuth = {
  passkey: {
    rpId: 'localhost',
    rpName: 'My App',
  },
  trustedOrigins: ['http://localhost:3001'],
};

// Passkey enabled (explicit enabled: true) WITH trustedOrigins
const validPasskeyExplicit: IBetterAuth = {
  passkey: {
    enabled: true,
    rpName: 'My App',
  },
  trustedOrigins: ['http://localhost:3001', 'https://app.example.com'],
};

// Passkey disabled (boolean) - trustedOrigins optional
const validPasskeyDisabledBoolean: IBetterAuth = {
  passkey: false,
};

// Passkey disabled (config object) - trustedOrigins optional
const validPasskeyDisabledConfig: IBetterAuth = {
  passkey: {
    enabled: false,
    rpName: 'Unused Config',
  },
};

// No passkey configured - trustedOrigins optional
const validNoPasskey: IBetterAuth = {
  twoFactor: true,
};

// No passkey but trustedOrigins set anyway (for CORS restriction)
const validNoPasskeyWithOrigins: IBetterAuth = {
  trustedOrigins: ['https://app.example.com'],
  twoFactor: true,
};

// Full configuration with passkey
const validFullConfig: IBetterAuth = {
  basePath: '/iam',
  baseUrl: 'http://localhost:3000',
  enabled: true,
  jwt: {
    expiresIn: '15m',
  },
  passkey: {
    rpId: 'example.com',
    rpName: 'Production App',
    userVerification: 'preferred',
  },
  trustedOrigins: ['https://app.example.com', 'https://admin.example.com'],
  twoFactor: {
    appName: 'Production App',
  },
};

// =============================================================================
// INVALID CONFIGURATIONS - These MUST fail to compile
// =============================================================================

// Passkey enabled (boolean) WITHOUT trustedOrigins
// @ts-expect-error - trustedOrigins is required when passkey is enabled
const invalidPasskeyNoOrigins: IBetterAuth = {
  passkey: true,
};

// Passkey enabled (config object) WITHOUT trustedOrigins
// @ts-expect-error - trustedOrigins is required when passkey is enabled
const invalidPasskeyConfigNoOrigins: IBetterAuth = {
  passkey: {
    rpId: 'localhost',
    rpName: 'My App',
  },
};

// Passkey enabled (explicit enabled: true) WITHOUT trustedOrigins
// @ts-expect-error - trustedOrigins is required when passkey is enabled
const invalidPasskeyExplicitNoOrigins: IBetterAuth = {
  passkey: {
    enabled: true,
    rpName: 'My App',
  },
};

// Edge case: empty object = passkey enabled (defaults to true)
// @ts-expect-error - trustedOrigins is required when passkey is enabled
const invalidEmptyPasskeyObject: IBetterAuth = {
  passkey: {},
};

// =============================================================================
// Prevent unused variable warnings (underscore prefix signals intentionally unused)
// =============================================================================
const _typeTestConfigs = [
  invalidEmptyPasskeyObject,
  invalidPasskeyConfigNoOrigins,
  invalidPasskeyExplicitNoOrigins,
  invalidPasskeyNoOrigins,
  validFullConfig,
  validNoPasskey,
  validNoPasskeyWithOrigins,
  validPasskeyBoolean,
  validPasskeyConfig,
  validPasskeyDisabledBoolean,
  validPasskeyDisabledConfig,
  validPasskeyExplicit,
];
