import { Inject } from '@nestjs/common';

import { getStoreToken } from './persistence.tokens.js';

/**
 * Inject the data store of a model registered with `CorePersistenceModule.forFeature()` — the
 * database-neutral counterpart of `@InjectModel()`.
 *
 * @example
 * ```typescript
 * constructor(@InjectStore(Project) private readonly projects: DataStore<Project>) {}
 * ```
 */
export function InjectStore(model: Function | string): ParameterDecorator & PropertyDecorator {
  return Inject(getStoreToken(typeof model === 'string' ? model : model.name));
}
