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
