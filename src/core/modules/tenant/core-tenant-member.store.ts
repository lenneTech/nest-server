import type { DataStore } from '../../common/persistence/data-store.interface.js';
import { getStoreForModel } from '../../common/persistence/persistence-runtime.registry.js';

/**
 * The store serving the membership model when it is routed to a SQL database; `undefined` on MongoDB, where the
 * guard and the service keep their Mongoose path unchanged.
 *
 * Read from the model INSTANCE the guard and the service were given, so it is the store of their own application.
 */
export function routedMemberStore(memberModel: unknown): DataStore<any> | undefined {
  const store = getStoreForModel(memberModel);
  return store && !store.capabilities.mongoosePopulate ? store : undefined;
}
