import bcrypt = require('bcrypt');
import { sha256 } from 'js-sha256';

import { ConfigService } from '../services/config.service';

/**
 * Mongoose plugin that automatically hashes passwords before saving to the database.
 * Handles save(), findOneAndUpdate(), updateOne(), updateMany(), replaceOne(),
 * findOneAndReplace(), insertMany(), and bulkWrite() operations.
 *
 * Prevents plaintext passwords from being stored even when developers bypass
 * CrudService.process() and use direct Mongoose operations.
 *
 * Detects already-hashed values (BCrypt pattern) to prevent double-hashing.
 *
 * For sentinel/lock values (e.g. '!LOCKED:REQUIRES_PASSWORD_RESET'), configure
 * skipPatterns in security.mongoosePasswordPlugin to preserve them as-is.
 */
export function mongoosePasswordPlugin(schema) {
  // Pre-save hook
  schema.pre('save', async function () {
    if (!this.isModified('password') || !this['password']) {
      return;
    }
    this['password'] = await hashPassword(this['password']);
  });

  // Pre-findOneAndUpdate hook
  schema.pre('findOneAndUpdate', async function () {
    await hashUpdatePassword(this.getUpdate());
  });

  // Pre-updateOne hook
  schema.pre('updateOne', async function () {
    await hashUpdatePassword(this.getUpdate());
  });

  // Pre-updateMany hook
  schema.pre('updateMany', async function () {
    await hashUpdatePassword(this.getUpdate());
  });

  // Pre-replaceOne hook (replacement doc is a flat object, hashUpdatePassword handles it)
  schema.pre('replaceOne', async function () {
    await hashUpdatePassword(this.getUpdate());
  });

  // Pre-findOneAndReplace hook
  schema.pre('findOneAndReplace', async function () {
    await hashUpdatePassword(this.getUpdate());
  });

  // Pre-insertMany hook (Mongoose 9: first arg is docs array)
  schema.pre('insertMany', async function (docs) {
    if (!Array.isArray(docs)) return;
    for (const doc of docs) {
      if (doc.password) {
        doc.password = await hashPassword(doc.password);
      }
    }
  });

  // Pre-bulkWrite hook
  schema.pre('bulkWrite', async function (ops) {
    for (const op of ops) {
      if ('insertOne' in op) {
        if (op.insertOne.document?.password) {
          op.insertOne.document.password = await hashPassword(op.insertOne.document.password);
        }
      } else if ('updateOne' in op) {
        await hashUpdatePassword(op.updateOne.update);
      } else if ('updateMany' in op) {
        await hashUpdatePassword(op.updateMany.update);
      } else if ('replaceOne' in op) {
        if (op.replaceOne.replacement?.password) {
          op.replaceOne.replacement.password = await hashPassword(op.replaceOne.replacement.password);
        }
      }
    }
  });
}

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
