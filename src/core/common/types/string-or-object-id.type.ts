import { Types } from 'mongoose';

/**
 * Everything which will be used by getStringIds or getObjectIds (see helpers/db.helper.ts)
 */
export type StringOrObjectId<T = any> = string | T | Types.ObjectId;
