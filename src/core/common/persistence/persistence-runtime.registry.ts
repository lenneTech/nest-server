/**
 * Process-wide state of the persistence layer: which models were registered, which store serves each, and the
 * runtime that routes a model to its data source. Types-only imports — an import-free leaf, so every persistence
 * file and the services may read it without forming a cycle (see `.claude/rules/architecture.md` → "DI Token
 * Placement (SWC-Safe)").
 */
import type { DataStore } from './data-store.interface.js';

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
  /** Closes what only the boot needs (the owner connections that migrate the schema), once every store exists */
  releaseBootConnections(): Promise<void>;
  /** The store of a model; `mongoModel` is its Mongoose model, used when the model stays on MongoDB */
  resolveStore(name: string, mongoModel: unknown): Promise<DataStore<any>>;
}

const models = new Map<string, PersistedModelRegistration>();
const stores = new Map<string, DataStore<any>>();
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

export function setPersistenceRuntime(value: PersistenceRuntime | undefined): void {
  runtime = value;
}

export function getPersistenceRuntime(): PersistenceRuntime | undefined {
  return runtime;
}
