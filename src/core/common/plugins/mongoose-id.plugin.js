export function mongooseIdPlugin(schema) {
  schema.post(['find', 'findOne', 'save', 'deleteOne'], (docs) => {
    if (!Array.isArray(docs)) {
      docs = [docs];
    }

    for (const doc of docs) {
      if (doc !== null && doc._id) {
        doc.id = doc._id.toHexString();
      }
    }
  });
}

module.exports = mongooseIdPlugin;
