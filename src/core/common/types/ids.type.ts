import { Types } from 'mongoose';

export type IdsType =
  | ({ _id?: Types.ObjectId | string; id?: Types.ObjectId | string } | Types.ObjectId | string)[]
  | { _id?: Types.ObjectId | string; id?: Types.ObjectId | string }
  | Types.ObjectId
  | string;
