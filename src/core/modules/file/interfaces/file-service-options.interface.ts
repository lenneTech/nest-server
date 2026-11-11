/**
 * Interface for service options in file services
 */
export interface FileServiceOptions {
  /**
   * Aborts the store request of a download (`getFileStream()` / `getFileStreamByName()`) when it fires.
   *
   * For S3 this matters under load: a request that waits for a free socket of the client's pool stays queued
   * after its HTTP client has gone, and every one of them later takes a socket and allocates a body. The
   * framework's download routes abort it when the response closes. Since 12.8.9.
   */
  abortSignal?: AbortSignal;

  currentUser?: { hasRole: (roles: string[]) => boolean; id: any };

  /**
   * Idle time of a download stream from `getFileStream()` / `getFileStreamByName()` for THIS call (default
   * `file.downloadIdleTimeoutMs`, for S3 `s3.downloadIdleTimeoutMs`). A stream that makes no read progress for that
   * long is closed to release its socket, file handle or cursor.
   *
   * `false` returns the stream unguarded — only for a caller that reads it late on purpose (an archive that appends
   * every file first and pipes each entry when its turn comes) AND is certain to read it to the end or destroy it:
   * such a stream holds its socket, handle or cursor until then. Prefer opening each stream right before it is read.
   * The guard's error handling stays; for S3 the SDK still closes a socket idle for `s3.socketTimeoutMs`.
   * Since 12.8.9.
   */
  downloadIdleTimeoutMs?: false | number;
  force?: boolean;

  /**
   * Custom GridFS metadata to store alongside the file (create operations only).
   *
   * This is what a per-file authorization rule is meant to be built on: write
   * an owner or tenant here at upload time, then compare against it in an
   * overridden `checkRights()` (use `getRawFileInfo()` to read it back — the
   * public `getFileInfo()` strips restricted fields).
   *
   * `contentType` is reserved: `GridFSHelper.writeFileFromStream` stores the
   * file's content type under that key and will overwrite whatever is passed.
   */
  metadata?: Record<string, any>;

  roles?: string | string[];
}
