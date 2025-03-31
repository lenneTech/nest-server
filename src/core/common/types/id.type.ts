import { Types } from 'mongoose';

export type IdType = string | Types.ObjectId | { _id?: string | Types.ObjectId; id?: string | Types.ObjectId };
