/**
 * Leases shared by every replica: "exactly one of N does this, and if it dies, somebody takes over".
 *
 * Expiry is part of the decision, never left to a background monitor: an expired lease is taken over by
 * exactly one contender at the moment it is claimed. Import-free leaf (types only).
 */
export interface LockStore {
  /** Release the lease — only by its owner. `true` when this owner held it. */
  release(key: string, owner: string): Promise<boolean>;
  /** Extend a lease this owner still holds. `false` when it expired or someone else took it. */
  renew(key: string, owner: string, ttlSeconds: number): Promise<boolean>;
  /**
   * Take the lease when it is free or expired. Of N concurrent contenders exactly one gets `true`; a lease
   * that is held and unexpired is never taken.
   */
  tryAcquire(key: string, owner: string, ttlSeconds: number): Promise<boolean>;
}
