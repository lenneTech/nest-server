/**
 * TUS Configuration Helper Functions
 *
 * The interfaces are defined in server-options.interface.ts to avoid circular imports.
 * This file contains helper functions and defaults.
 */
import { ITusConfig, ITusExpirationConfig } from '../../../common/interfaces/server-options.interface';

// Re-export for convenience
export {
  ITusConfig,
  ITusCreationConfig,
  ITusExpirationConfig,
} from '../../../common/interfaces/server-options.interface';

/**
 * Additional allowed headers for TUS requests (beyond @tus/server defaults).
 *
 * Note: @tus/server already includes all TUS protocol headers by default:
 * Authorization, Content-Type, Location, Tus-Extension, Tus-Max-Size,
 * Tus-Resumable, Tus-Version, Upload-Concat, Upload-Defer-Length,
 * Upload-Length, Upload-Metadata, Upload-Offset, X-HTTP-Method-Override,
 * X-Requested-With, X-Forwarded-Host, X-Forwarded-Proto, Forwarded
 *
 * This array is only for PROJECT-SPECIFIC additional headers.
 */
export const DEFAULT_TUS_ALLOWED_HEADERS: string[] = [];

/**
 * Default TUS configuration
 */
export const DEFAULT_TUS_CONFIG: Required<
  Omit<ITusConfig, 'allowedTypes' | 'creation' | 'expiration'> & {
    allowedTypes: undefined;
    creation: boolean;
    expiration: ITusExpirationConfig;
  }
> = {
  allowedHeaders: DEFAULT_TUS_ALLOWED_HEADERS,
  allowedTypes: undefined,
  checksum: true,
  concatenation: true,
  creation: true,
  creationWithUpload: true,
  enabled: true,
  expiration: { enabled: true, expiresIn: '24h' },
  maxSize: 50 * 1024 * 1024 * 1024, // 50 GB
  path: '/tus',
  termination: true,
  uploadDir: 'uploads/tus',
};

/**
 * Normalizes tus config from various input formats
 * - `undefined` → enabled with defaults (new behavior: enabled by default)
 * - `true` → enabled with defaults
 * - `false` → disabled
 * - `{ ... }` → enabled with custom config
 */
export function normalizeTusConfig(config: boolean | ITusConfig | undefined): ITusConfig | null {
  // Enabled by default if not specified
  if (config === undefined) {
    return { ...DEFAULT_TUS_CONFIG };
  }
  if (config === true) {
    return { ...DEFAULT_TUS_CONFIG };
  }
  if (config === false) {
    return null;
  }
  // Check explicit enabled: false
  if (config.enabled === false) {
    return null;
  }
  // Merge with defaults
  return {
    ...DEFAULT_TUS_CONFIG,
    ...config,
  };
}

/**
 * Parse expiration time string to milliseconds
 * Supports: '24h', '1d', '12h', '30m', etc.
 */
export function parseExpirationTime(expiresIn: string): number {
  const match = expiresIn.match(/^(\d+)([hdms])$/);
  if (!match) {
    return 24 * 60 * 60 * 1000; // Default: 24 hours
  }

  const value = parseInt(match[1], 10);
  const unit = match[2];

  switch (unit) {
    case 'd':
      return value * 24 * 60 * 60 * 1000;
    case 'h':
      return value * 60 * 60 * 1000;
    case 'm':
      return value * 60 * 1000;
    case 's':
      return value * 1000;
    default:
      return 24 * 60 * 60 * 1000;
  }
}
