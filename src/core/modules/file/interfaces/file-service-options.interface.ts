/**
 * Interface for service options in file services
 */
export interface FileServiceOptions {
  currentUser?: { hasRole: (roles: string[]) => boolean; id: any };
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
