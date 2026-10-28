import type { DataStore } from './data-store.interface.js';
import { UnsupportedCapabilityError } from './unsupported-capability.error.js';

/** The data methods of the `DataStore` port */
const STORE_METHODS = new Set([
  'count',
  'deleteById',
  'deleteMany',
  'deleteOne',
  'distinct',
  'find',
  'findById',
  'findOne',
  'insert',
  'native',
  'pullFromArray',
  'pushToArray',
  'raw',
  'sum',
  'updateById',
  'updateMany',
  'updateOne',
]);

/**
 * The store of a model no database can hold — the project runs with `database: false`, so a model registered with
 * `CorePersistenceModule.forFeature()` (the framework registers its file metadata, for one) has nowhere to go. Every
 * data method refuses with the reason; nothing fails while the application merely boots.
 */
export function unavailableStore<T = Record<string, any>>(modelName: string, reason: string): DataStore<T> {
  const capabilities = {
    aggregatePipeline: false,
    changeFeed: false,
    gridfs: false,
    idType: 'objectId' as const,
    mongoosePopulate: false,
    rawFilterArm: false,
    rls: false,
    textSearch: false,
    transactions: false,
  };
  return new Proxy({} as DataStore<T>, {
    get(_target, property) {
      if (property === 'modelName') {
        return modelName;
      }
      if (property === 'driver') {
        return 'none';
      }
      if (property === 'capabilities') {
        return capabilities;
      }
      // Only the port's methods refuse: Nest probes every provider for lifecycle hooks (`onModuleInit`, …), and a
      // promise check reads `then` — those must find nothing
      if (typeof property !== 'string' || !STORE_METHODS.has(property)) {
        return undefined;
      }
      return () => {
        throw new UnsupportedCapabilityError(`${modelName}.${property}(): ${reason}`);
      };
    },
  });
}
