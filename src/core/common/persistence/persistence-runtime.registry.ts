/**
 * Process-wide state of the persistence layer: which models were registered, which store serves each, and the
 * runtime that routes a model to its data source. Types-only imports — an import-free leaf, so every persistence
 * file and the services may read it without forming a cycle (see `.claude/rules/architecture.md` → "DI Token
 * Placement (SWC-Safe)").
 */
import type { DataStore } from './data-store.interface.js';
import type { LockStore } from './lock-store.interface.js';

/** A model as `CorePersistenceModule.forFeature()` registered it */
export interface PersistedModelRegistration {
  /** The source the model class declares with `@PersistedModel`, or the definition's `dataSource` */
  declaredSource?: string;
  name: string;
  /** The model's Mongoose schema */
  schema: unknown;
}

/**
 * Routes a model to the store of its data source (plan §3.9). Installed by `CoreModule.forRoot()` when the
 * configuration names a SQL source; without one, every model keeps its Mongoose store.
 */
export interface PersistenceRuntime {
  close(): Promise<void>;
  /** The lease store of the default source when it is a SQL database; `undefined` when it is MongoDB */
  defaultLockStore(): Promise<LockStore | undefined>;
  /** Closes what only the boot needs (the owner connections that migrate the schema), once every store exists */
  releaseBootConnections(): Promise<void>;
  /** The store of a model; `mongoModel` is its Mongoose model, used when the model stays on MongoDB */
  resolveStore(name: string, mongoModel: unknown): Promise<DataStore<any>>;
  /** The configured SQL sources, each with a ping (`SELECT 1` on its application connection) for the health check */
  sqlSources(): { name: string; ping: () => Promise<void> }[];
  /** The default source when it is a SQL database — where the framework keeps its migration state */
  defaultSqlSource(): undefined | { engine?: string; ownerUrl?: string; url: string };
  /** Sources and model routing for the Hub; connection URLs reduced to scheme and host */
  describe(): PersistenceOverview;
}

/** What the data-source configuration resolved to, for operators (the Hub's persistence panel) */
export interface PersistenceOverview {
  defaultSource?: string;
  models: { name: string; source?: string }[];
  sources: { driver: string; engine?: string; host: string; name: string; ownerConfigured: boolean }[];
}

const models = new Map<string, PersistedModelRegistration>();
const stores = new Map<string, DataStore<any>>();
/**
 * The store serving a model, keyed by the Mongoose model INSTANCE. Every application has its own connection and
 * therefore its own model instances, so this lookup — unlike the by-name map above — can never hand one application
 * the store another one (in the same process: tests) created.
 */
const storesByModel = new WeakMap<object, DataStore<any>>();
let runtime: PersistenceRuntime | undefined;

export function registerPersistedModel(registration: PersistedModelRegistration): void {
  models.set(registration.name, registration);
}

export function getPersistedModels(): PersistedModelRegistration[] {
  return [...models.values()];
}

/** Remember the store serving a model — the neutral populate loads references through it */
export function registerDataStore(name: string, store: DataStore<any>): void {
  stores.set(name, store);
}

export function getRegisteredDataStore(name: string): DataStore<any> | undefined {
  return stores.get(name);
}

/**
 * Remember which store serves the model behind a Mongoose model instance, so a service written against
 * `@InjectModel()` runs on the store its model was routed to
 */
export function bindStoreToModel(model: unknown, store: DataStore<any>): void {
  if (model && typeof model === 'function') {
    storesByModel.set(model, store);
  }
}

/** The store routed for the model behind this Mongoose model instance, when one was registered */
export function getStoreForModel(model: unknown): DataStore<any> | undefined {
  return model && typeof model === 'function' ? storesByModel.get(model) : undefined;
}

export function setPersistenceRuntime(value: PersistenceRuntime | undefined): void {
  runtime = value;
}

export function getPersistenceRuntime(): PersistenceRuntime | undefined {
  return runtime;
}
