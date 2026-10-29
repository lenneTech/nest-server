/**
 * Compile-only checks: the driver-neutral id types still accept what projects pass today.
 * Type-checked by `pnpm run typecheck:tests` (part of `check`); never executed.
 */
import { Types } from 'mongoose';

import type { IdType } from '../../src/core/common/types/id.type.js';
import type { IdsType } from '../../src/core/common/types/ids.type.js';
import type { ObjectIdLike } from '../../src/core/common/types/object-id-like.type.js';
import type { StringOrObjectId } from '../../src/core/common/types/string-or-object-id.type.js';

const objectId = new Types.ObjectId();

// A mongoose ObjectId is an ObjectIdLike, so every id type keeps accepting it
const asLike: ObjectIdLike = objectId;
const asId: IdType = objectId;
const asIdObject: IdType = { _id: objectId };
const asIds: IdsType = [objectId, 'a-string-id', { id: objectId }];
const asStringOrObjectId: StringOrObjectId = objectId;
const asStringOrObjectIdString: StringOrObjectId = '651f00010203040506070809';

export const idTypeChecks = [asLike, asId, asIdObject, asIds, asStringOrObjectId, asStringOrObjectIdString];
