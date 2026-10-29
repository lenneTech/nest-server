import { hashPassword, hashUpdatePassword } from '../persistence/policies/password.policy.js';

// Public API since before the policy extraction — keep every import path working
export { hashPassword, hashUpdatePassword, resetSkipPatternsCache } from '../persistence/policies/password.policy.js';

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
 *
 * The hashing decisions live in the password policy (`persistence/policies/password.policy.ts`), which
 * every data store shares; this plugin only applies them to Mongoose's hook shapes.
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
