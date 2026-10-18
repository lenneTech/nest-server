/**
 * In-memory stand-in for the Mongoose connection `CoreAiMcpOAuthService` reads its native
 * collections from. It mimics the subset of the MongoDB driver the service uses (`insertOne`,
 * `findOne`, `findOneAndDelete`, `createIndex`), so the OAuth flow runs without a database.
 *
 * `findOneAndDelete` returns the document itself, as driver 6+ does, and is atomic per call.
 */
export function createMcpOAuthMemoryConnection() {
  const collections = new Map<string, ReturnType<typeof createCollection>>();
  return {
    db: {
      collection: (name: string) => {
        if (!collections.has(name)) {
          collections.set(name, createCollection());
        }
        return collections.get(name)!;
      },
    },
  };
}

function createCollection() {
  const docs: any[] = [];
  const matches = (doc: any, query: any) => Object.keys(query).every((k) => doc[k] === query[k]);
  return {
    docs,
    createIndex: async () => ({}),
    findOne: async (query: any) => docs.find((d) => matches(d, query)) ?? null,
    findOneAndDelete: async (query: any) => {
      const idx = docs.findIndex((d) => matches(d, query));
      if (idx < 0) {
        return null;
      }
      const [removed] = docs.splice(idx, 1);
      return removed;
    },
    insertOne: async (doc: any) => {
      docs.push(doc);
      return { insertedId: doc.client_id ?? doc.code ?? doc.token ?? 'x' };
    },
  };
}
