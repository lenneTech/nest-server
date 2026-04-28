import { Schema } from 'mongoose';

/**
 * Schema for cached push results keyed by (userId, modelName, clientId).
 * The TTL index on `expiresAt` removes stale entries automatically.
 *
 * Collection name and TTL are configurable via `ISyncConfig.idempotency`.
 */
export function buildSyncIdempotencyKeySchema(ttlSeconds: number): Schema {
  const schema = new Schema(
    {
      clientId: { required: true, type: String },
      expiresAt: { required: true, type: Date },
      modelName: { required: true, type: String },
      result: { required: true, type: Schema.Types.Mixed },
      userId: { required: true, type: String },
    },
    { timestamps: false },
  );

  // Compound unique index on the lookup key — guarantees deduplication.
  schema.index({ clientId: 1, modelName: 1, userId: 1 }, { unique: true });

  // TTL cleanup. Mongoose accepts `expireAfterSeconds: 0` together with
  // an explicit `expiresAt` field — entries are removed once `expiresAt` is
  // reached, regardless of when they were inserted. This is more flexible
  // than a fixed TTL on createdAt because it allows refreshing entries.
  schema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

  // The ttlSeconds parameter is kept on the schema metadata so the
  // service can use it when computing `expiresAt` on writes.
  (schema as any).__ttlSeconds = ttlSeconds;

  return schema;
}
