import bcrypt from 'bcrypt';
import { sha256 } from 'js-sha256';

import { ConfigService } from '../../services/config.service.js';

/**
 * Password hashing decisions, shared by every data store: a plaintext password never reaches storage,
 * whichever API wrote it. `mongoosePasswordPlugin` applies them to Mongoose writes; a SQL store applies
 * the same functions to its rows and patches.
 */

export async function hashUpdatePassword(update: any) {
  if (!update) {
    return;
  }
  if (update.password) {
    update.password = await hashPassword(update.password);
  }
  if (update.$set?.password) {
    update.$set.password = await hashPassword(update.$set.password);
  }
}

// Compiled RegExp cache (built once on first call)
let compiledSkipPatterns: RegExp[] | null = null;

/**
 * Reset the compiled skip patterns cache.
 * Use in test environments where ConfigService is reset between test suites.
 */
export function resetSkipPatternsCache(): void {
  compiledSkipPatterns = null;
}

function getSkipPatterns(): RegExp[] {
  if (compiledSkipPatterns !== null) {
    return compiledSkipPatterns;
  }
  const pluginConfig = ConfigService.configFastButReadOnly?.security?.mongoosePasswordPlugin;
  if (pluginConfig && typeof pluginConfig === 'object' && 'skipPatterns' in pluginConfig && pluginConfig.skipPatterns) {
    compiledSkipPatterns = (pluginConfig.skipPatterns as (string | RegExp)[]).map((p) =>
      p instanceof RegExp ? p : new RegExp(p),
    );
  } else {
    compiledSkipPatterns = [];
  }
  return compiledSkipPatterns;
}

export async function hashPassword(password: string): Promise<string> {
  // Already BCrypt-hashed → skip
  if (/^\$2[aby]\$\d+\$/.test(password)) {
    return password;
  }

  // Check configured skip patterns (e.g. sentinel/lock values)
  const skipPatterns = getSkipPatterns();
  if (skipPatterns.some((pattern) => pattern.test(password))) {
    return password;
  }

  // SHA256 pre-hash if configured and password is not already SHA256
  const sha256Enabled = ConfigService.configFastButReadOnly?.sha256;
  if (sha256Enabled && !/^[a-f0-9]{64}$/i.test(password)) {
    password = sha256(password);
  }

  return bcrypt.hash(password, 10);
}
