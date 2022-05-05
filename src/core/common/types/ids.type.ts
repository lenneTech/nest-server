import { Types } from 'mongoose';

export type IdsType =
  | string
  | Types.ObjectId
  | { id?: string | Types.ObjectId; _id?: string | Types.ObjectId }
  | (string | Types.ObjectId | { id?: string | Types.ObjectId; _id?: string | Types.ObjectId })[];
