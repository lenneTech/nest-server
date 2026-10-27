/**
 * Structural shape of an ObjectId, from whichever bson copy created it.
 *
 * The id types describe ids by shape instead of by `mongoose`'s `Types.ObjectId` class: a class
 * identity breaks across two installed copies of bson (`instanceof` fails), and the id types must not
 * tie the core to the MongoDB driver now that ids are opaque strings on every database. A mongoose
 * `Types.ObjectId` satisfies this shape, so every caller that passed one keeps compiling.
 */
export interface ObjectIdLike {
  toHexString(): string;
}
