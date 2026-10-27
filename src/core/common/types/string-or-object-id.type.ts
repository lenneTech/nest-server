import type { ObjectIdLike } from './object-id-like.type.js';

/**
 * Everything which will be used by getStringIds or getObjectIds (see helpers/db.helper.ts)
 */
export type StringOrObjectId<T = any> = ObjectIdLike | string | T;
