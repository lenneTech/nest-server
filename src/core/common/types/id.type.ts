import { Types } from 'mongoose';

export type IdType = { _id?: Types.ObjectId | string; id?: Types.ObjectId | string } | Types.ObjectId | string;
