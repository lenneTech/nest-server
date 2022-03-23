module.exports = function mongooseIdPlugin(schema, options) {
  schema.post(['find', 'findOne', 'save', 'deleteOne'], function (docs) {
    if (!Array.isArray(docs)) {
      docs = [docs];
    }

    for (const doc of docs) {
      if (doc !== null && doc._id) {
        doc.id = doc._id.toHexString();
      }
    }
  });
};
