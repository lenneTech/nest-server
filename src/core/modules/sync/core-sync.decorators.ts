import type { Type } from '@nestjs/common';

import { SYNC_FIELD_METADATA, SYNC_SERVICE_METADATA } from './core-sync.constants.js';

/** What `@SyncService()` declares: the model it serves under `/sync` and the inputs a push is validated against */
export interface SyncServiceOptions {
  /** Input of a push that creates a record — validated and whitelisted like a request body */
  createInput: Type<any>;
  /** The model class, declared with `@PersistedModel({ sync })` */
  model: Type<any>;
  /**
   * The name the model is registered under in `CorePersistenceModule.forFeature()`, which is also its name in the sync
   * path (`/sync/{model}`)
   * @default the model class's name
   */
  modelName?: string;
  /** Input of a push that changes a record */
  updateInput: Type<any>;
}

/**
 * Offer a model to offline clients through the project's CrudService: `GET/POST /sync/{model}` read and write through
 * this service — its `process()` pipeline, `securityCheck()`, the tenant policy — with the operation roles the model
 * declares in `@PersistedModel({ sync: { roles } })`. Needs the `sync` configuration; without it nothing is registered.
 *
 * @example
 * ```typescript
 * @SyncService({ createInput: NoteCreateInput, model: Note, updateInput: NoteInput })
 * @Injectable()
 * export class NoteService extends CrudService<Note, NoteCreateInput, NoteInput> { … }
 * ```
 */
export function SyncService(options: SyncServiceOptions): ClassDecorator {
  return (target) => {
    Reflect.defineMetadata(SYNC_SERVICE_METADATA, { ...options }, target);
  };
}

/** The `@SyncService()` declaration of a service class (inherited from a parent class), if any */
export function getSyncServiceOptions(target: Function): SyncServiceOptions | undefined {
  return Reflect.getMetadata(SYNC_SERVICE_METADATA, target);
}

/**
 * How a field takes part in a `merge` (protocol §6.4): `lww` — the client's value wins when it changed the field;
 * `reject` — a client change of this field still conflicts when the record changed in the meantime.
 */
export type SyncFieldStrategy = 'lww' | 'reject';

/**
 * Declare how a field is merged when the model's strategy is `merge`. Fields without the decorator merge as `lww`.
 *
 * @example
 * ```typescript
 * @SyncField('reject')
 * @UnifiedField({ description: 'Price, never merged silently' })
 * price?: number;
 * ```
 */
export function SyncField(strategy: SyncFieldStrategy): PropertyDecorator {
  if (strategy !== 'lww' && strategy !== 'reject') {
    throw new Error(`@SyncField: strategy must be 'lww' or 'reject', got ${JSON.stringify(strategy)}`);
  }
  return (target, property) => {
    const own: Record<string, SyncFieldStrategy> = Reflect.hasOwnMetadata(SYNC_FIELD_METADATA, target.constructor)
      ? Reflect.getOwnMetadata(SYNC_FIELD_METADATA, target.constructor)
      : {};
    Reflect.defineMetadata(SYNC_FIELD_METADATA, { ...own, [String(property)]: strategy }, target.constructor);
  };
}

/** The `@SyncField()` strategies of a model class, its parents' included (a child's declaration wins) */
export function getSyncFieldStrategies(modelClass: Function): Record<string, SyncFieldStrategy> {
  const chain: Function[] = [];
  for (let current = modelClass; current && current !== Function.prototype; current = Object.getPrototypeOf(current)) {
    chain.unshift(current);
  }
  return Object.assign(
    {},
    ...chain.map((current) =>
      Reflect.hasOwnMetadata(SYNC_FIELD_METADATA, current) ? Reflect.getOwnMetadata(SYNC_FIELD_METADATA, current) : {},
    ),
  );
}
