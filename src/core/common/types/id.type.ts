import type { ObjectIdLike } from './object-id-like.type.js';

export type IdType = ObjectIdLike | string | { _id?: ObjectIdLike | string; id?: ObjectIdLike | string };
