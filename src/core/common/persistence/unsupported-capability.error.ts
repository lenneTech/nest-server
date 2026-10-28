/**
 * An operation the model's data store cannot perform (plan §3.6: features ask the store, never the driver name).
 * Named, so a call that would need MongoDB on a SQL-stored model fails loudly instead of reaching another database.
 */
export class UnsupportedCapabilityError extends Error {
  override readonly name = 'UnsupportedCapabilityError';
}
