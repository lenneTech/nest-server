import type { DataStore } from './data-store.interface.js';
import { UnsupportedCapabilityError } from './unsupported-capability.error.js';

/**
 * Static Mongoose model methods that read or write the collection. `where` / `$where` start a query, and `insertOne`
 * writes through the document's `$save`, not through `save` — each is a way in of its own
 */
const MODEL_DATA_METHODS = [
  '$where',
  'aggregate',
  'bulkSave',
  'bulkWrite',
  'countDocuments',
  'create',
  'deleteMany',
  'deleteOne',
  'distinct',
  'estimatedDocumentCount',
  'exists',
  'find',
  'findAndCount',
  'findById',
  'findByIdAndDelete',
  'findByIdAndUpdate',
  'findOne',
  'findOneAndDelete',
  'findOneAndReplace',
  'findOneAndUpdate',
  'insertMany',
  'insertOne',
  'replaceOne',
  'updateMany',
  'updateOne',
  'watch',
  'where',
] as const;

/** Document methods that write the collection; Mongoose defines `$save` as a separate reference to `save` */
const DOCUMENT_DATA_METHODS = ['$save', 'deleteOne', 'replaceOne', 'save', 'updateOne'] as const;

/**
 * Make the Mongoose model of a model routed to a SQL store refuse every data access.
 *
 * The Mongoose model stays registered — `@InjectModel()` keeps resolving, the schema and the name stay readable, and
 * services that run on the routed store through `CrudService` use nothing else of it. But a direct call
 * (`this.mainDbModel.findByIdAndUpdate(…)`, `doc.save()`) would read and write MongoDB while the rest of the model
 * lives in the SQL database: its data split across two databases, silently. Refusing with a named error turns that
 * into the first thing a project notices. Applied to the model INSTANCE of one application (its own connection), so
 * another application in the same process is unaffected.
 */
export function guardRoutedModel(model: unknown, store: DataStore<any>): void {
  if (!model || typeof model !== 'function') {
    return;
  }
  const target = model as unknown as Record<string, unknown> & { modelName: string; prototype: object };
  const refuse = (method: string) =>
    function refused(): never {
      throw new UnsupportedCapabilityError(
        `${target.modelName}.${method}() reaches MongoDB, but ${target.modelName} is stored on ${store.driver} — ` +
          'use the data store (this.dataStore in a CrudService, or @InjectStore()) instead',
      );
    };
  for (const method of MODEL_DATA_METHODS) {
    if (typeof target[method] === 'function') {
      Object.defineProperty(target, method, { configurable: true, value: refuse(method), writable: true });
    }
  }
  for (const method of DOCUMENT_DATA_METHODS) {
    Object.defineProperty(target.prototype, method, { configurable: true, value: refuse(method), writable: true });
  }
}
