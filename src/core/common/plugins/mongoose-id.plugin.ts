/**
 * Mongoose plugin to add a string 'id' field to documents based on the '_id' ObjectId.
 * @param schema - The Mongoose schema to which the plugin will be applied.
 */
export function mongooseIdPlugin(schema) {
  schema.post(/.*/, (docs) => {
    const docsArray = Array.isArray(docs) ? docs : [docs];
    for (const doc of docsArray) {
      if (doc?._id && typeof doc._id.toHexString === 'function') {
        doc.id = doc._id.toHexString();
      }
    }
  });
}
