import { WriteStream } from 'fs-capacitor';
import { Readable } from 'stream';

/**
 * What a file store actually needs from an upload.
 *
 * `FileUpload` additionally carries the graphql-upload `capacitor`, which no
 * store touches — so requiring the full type would exclude every upload that did
 * not arrive over GraphQL (a multer REST upload being the case in point, see
 * `multerFileToUpload()`). `FileUpload` satisfies this structurally, so both
 * paths share a single service signature.
 */
export interface FileUploadSource {
  createReadStream: (options?: unknown) => Readable;
  encoding?: string;
  filename: string;
  mimetype: string;

  /**
   * EXACT size of the file in bytes, when the caller knows it — otherwise leave it out.
   *
   * Only the S3 driver reads it: with a size the object goes up as one streamed request (as a
   * multipart upload above 5 GiB, which AWS S3 refuses in one request), without one it goes up as a
   * multipart upload (`@aws-sdk/lib-storage`, an optional peer — without it the
   * file is read into memory). Omitting it is not a fallback: a GraphQL or streamed REST upload never
   * knows its length, and that is the common case.
   *
   * A WRONG size breaks the upload instead of slowing it down. So never pass the `Content-Length` of a
   * multipart/form-data request: it counts the whole envelope (boundaries, part headers, other
   * fields) and is always larger than the file. Pass it only when it is the file's own length — a
   * TUS upload's `upload.size`, a `stat()` of a file on disk. For data already in memory leave it
   * out: the SDK retries the Buffer parts of a multipart upload after a transient S3 error, but not
   * one streamed request. Anything but a positive integer is treated as unknown.
   */
  size?: number;
}

/**
 * Interface for file uploads
 */
export interface FileUpload extends FileUploadSource {
  /**
   * A private implementation detail that shouldn’t be used outside
   */
  capacitor: WriteStream;

  /**
   * A function that returns a FileUploadCreateReadStream.
   */
  createReadStream: (options?: {
    /** Specify an encoding for the chunks, default: utf8 */
    encoding?: 'ascii' | 'base64' | 'base64url' | 'hex' | 'latin1' | 'ucs2' | 'utf8' | 'utf8' | 'utf16le';

    /**  Maximum number of bytes to store in the internal buffer before ceasing to read from the underlying resource, default: 16384 */
    highWaterMark?: number;
  }) => Readable;

  /**
   * Stream transfer encoding of the file
   * @deprecated This property is deprecated and may be removed in future versions
   */
  encoding?: string;

  /**
   * Name of the file
   */
  filename: string;

  /**
   * Mimetype of the file
   */
  mimetype: string;
}
