/**
 * Mongoose plugin to add a string 'id' field to documents based on the '_id' ObjectId.
 * @param schema - The Mongoose schema to which the plugin will be applied.
 */
export function mongooseIdPlugin(schema) {
  schema.post(/.*/, (docs) => {
    const docsArray = Array.isArray(docs) ? docs : [docs];
    for (const doc of docsArray) {
      // A bare ObjectId is a VALUE, not a document — `distinct()` on an ObjectId field returns an
      // array of them. Mongoose gives `ObjectId.prototype` an `_id` getter returning itself, so the
      // check below matched, and the assignment then hit bson's own `id` SETTER (the 12-byte
      // buffer). bson < 7.3 silently accepted the hex string; bson >= 7.3 (mongodb >= 7.7) throws
      // `BSONError: Cannot create Buffer from the passed potentialBuffer`, turning every
      // `distinct()` over an ObjectId field into a 500.
      if (doc?._bsontype === 'ObjectId') {
        continue;
      }
      if (doc?._id && typeof doc._id.toHexString === 'function') {
        doc.id = doc._id.toHexString();
      }
    }
  });
}
