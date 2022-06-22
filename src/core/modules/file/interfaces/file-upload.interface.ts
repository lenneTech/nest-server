import { WriteStream } from 'fs-capacitor';
import { Readable } from 'stream';

/**
 * Interface for file uploads
 */
export interface FileUpload {
  /**
   * A private implementation detail that shouldn’t be used outside
   */
  capacitor: WriteStream;

  /**
   * A function that returns a FileUploadCreateReadStream.
   */
  createReadStream: (options?: {
    /** Specify an encoding for the chunks, default: utf8 */
    encoding?: 'utf8' | 'utf8' | 'ucs2' | 'utf16le' | 'latin1' | 'ascii' | 'base64' | 'base64url' | 'hex';

    /**  Maximum number of bytes to store in the internal buffer before ceasing to read from the underlying resource, default: 16384 */
    highWaterMark?: number;
  }) => Readable;

  /**
   * Stream transfer encoding of the file
   */
  encoding: string;

  /**
   * Name of the file
   */
  filename: string;

  /**
   * Mimetype of the file
   */
  mimetype: string;
}
