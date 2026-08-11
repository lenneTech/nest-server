import { mongo, Types } from 'mongoose';

/**
 * The metadata shape every non-GridFS storage driver writes, and the queries against it.
 *
 * WHY THIS FILE EXISTS: `S3FileHelper` and `FilesystemFileHelper` grew the same
 * six-field document, the same `FileCollection` alias and the same four lookups
 * independently. Two consequences, and the second one is the reason this is not
 * merely tidiness:
 *
 *  1. The two drifted. `getRawFileInfoByName()` consulted S3 and GridFS but not the
 *     filesystem, so a by-name authorization rule saw a different set of files than
 *     the download served.
 *  2. Because the documents are structurally identical, NOTHING in a fetched file
 *     info said which store it came from — so every caller that needed to know had
 *     to go and ask all three stores again. A single download resolved the same id
 *     up to three times.
 *
 * (2) is solved by `CoreFileService.resolveFile()`, which remembers WHICH PROBE
 * ANSWERED and hands that down instead of letting the next caller re-probe. Not by
 * the `storage` marker below — see its own doc for why the collection, not the
 * field, is authoritative when reading.
 *
 * DELIBERATELY IMPORT-FREE apart from mongoose types, so it stays a leaf. See
 * `.claude/rules/architecture.md` → "DI Token Placement (SWC-Safe)".
 */

/** Metadata collection handle (no Mongoose schema — these collections are driver-managed) */
export type FileCollection = mongo.Collection<any>;

/**
 * Which store holds a file's bytes, as recorded on the metadata document.
 *
 * GridFS is absent on purpose: its documents live in `fs.files` and are written by
 * the driver, which will never carry this field. "No marker and found in fs.files"
 * IS the GridFS case.
 */
export type FileStorageMarker = 'filesystem' | 's3';

/**
 * Metadata of a file whose bytes live outside GridFS.
 *
 * The first six fields are exactly a GridFS `fs.files` document, which is what lets
 * `prepareOutput()` map all three stores onto `CoreFileInfo` unchanged.
 */
export interface FileMetadataInfo {
  _id: Types.ObjectId;
  contentType?: string;
  filename: string;
  length: number;
  metadata?: Record<string, any>;
  /**
   * Which driver wrote these bytes.
   *
   * FOR OPERATORS AND DIAGNOSTICS, not for dispatch. Code must derive the store from
   * the COLLECTION a document was found in, never from this field: the two can only
   * ever disagree through corruption or a hand-edit, and trusting the field there
   * would send a read to the wrong store. It earns its place by making the store
   * answerable in a plain query (`db['s3-files'].countDocuments({ storage: 's3' })`)
   * and by surviving an export, where the collection name does not.
   *
   * Absent on documents written before 11.33.0, and on every GridFS document.
   */
  storage?: FileStorageMarker;
  uploadDate: Date;
}

/** Find one metadata document by id */
export async function findMetadataById(
  collection: FileCollection,
  id: string | Types.ObjectId,
): Promise<FileMetadataInfo | null> {
  return (await collection.findOne({ _id: new Types.ObjectId(id) })) as FileMetadataInfo | null;
}

/**
 * Find one metadata document by filename.
 *
 * Resolves the FIRST match — filenames are not unique in any of these stores, and
 * are client-supplied on both the multer and the tus path. Prefer the id lookup
 * wherever the caller has an id.
 */
export async function findMetadataByName(
  collection: FileCollection,
  filename: string,
): Promise<FileMetadataInfo | null> {
  return (await collection.findOne({ filename })) as FileMetadataInfo | null;
}

/** Find metadata documents by filter */
export async function findMetadata(
  collection: FileCollection,
  filter: any = {},
  options: any = {},
): Promise<FileMetadataInfo[]> {
  return (await collection.find(filter, options).toArray()) as FileMetadataInfo[];
}

/**
 * Namespaces whose `filename` index has already been ensured in this process.
 *
 * Keyed by `<db>.<collection>` rather than by object identity: the service builds a
 * fresh collection handle per instance, and two instances in one process (the tests
 * do exactly that) would otherwise each pay the round trip.
 */
const filenameIndexEnsured = new Set<string>();

/**
 * Ensure the `filename` index, ON THE WRITE PATH ONLY.
 *
 * These collections have no Mongoose schema, so nothing creates their indexes
 * implicitly the way the driver does for GridFS's `fs.files`. Without one,
 * `GET /files/:filename` is a collection scan that grows with the file count.
 *
 * WHY THIS IS NOT CALLED WHEN READING: `createIndex` CREATES the collection. Calling
 * it on the read path made a deployment that only ever uses GridFS grow an empty
 * `s3-files` and an empty `filesystem-files` — collections it has no reason to have,
 * which then show up in backups and in the Hub's DB panel as if the driver were in
 * use. A store that is never written to now stays absent, and a store that HAS been
 * written to necessarily went through here, so the index exists exactly where there
 * is data to index.
 *
 * NEVER THROWS. A missing index makes later reads slow, not wrong, and must not turn
 * an upload into a 500 — so a failure only un-marks the namespace, and the next write
 * tries again rather than pinning the failure for the process lifetime.
 *
 * @returns whether the index is now known to exist
 */
export async function ensureFilenameIndex(collection: FileCollection): Promise<boolean> {
  const namespace = `${collection.dbName}.${collection.collectionName}`;
  if (filenameIndexEnsured.has(namespace)) {
    return true;
  }
  filenameIndexEnsured.add(namespace);
  try {
    await collection.createIndex({ filename: 1 });
    return true;
  } catch {
    filenameIndexEnsured.delete(namespace);
    return false;
  }
}
