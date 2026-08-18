import { BadRequestException } from '@nestjs/common';
import { MulterOptions } from '@nestjs/platform-express/multer/interfaces/multer-options.interface';
import { randomBytes } from 'crypto';
import { diskStorage, memoryStorage } from 'multer';
import { extname } from 'path';
import { Readable } from 'stream';

import type { FileUploadSource } from '../../modules/file/interfaces/file-upload.interface';

/**
 * What an upload endpoint accepts: exact mimetypes and exact file extensions.
 *
 * Prefer this over the legacy `RegExp` form. A single expression `.test()`ed
 * against BOTH the mimetype and the extension searches for a SUBSTRING, so every
 * alternative matches anywhere inside either value. An allow-list of `text` /
 * `txt` therefore also accepts `text/html` and `text/xml`, and one containing
 * `md` accepts every mimetype with "md" in it. Consumers hit this in practice:
 * a filter documented as "no html" happily accepted a file named `x.txt` that
 * was sent as `text/html`.
 *
 * Two separate sets also remove the reason the expression could not simply be
 * anchored: it had to carry mimetype FRAGMENTS (`wordprocessingml`, `ms-excel`)
 * next to bare extensions, and no anchoring satisfies both at once.
 */
export interface UploadAllowList {
  /** Allowed file extensions, lowercase and WITH the leading dot. */
  extensions: readonly string[];
  /** Allowed mimetypes, lowercase and without parameters. */
  mimeTypes: readonly string[];
}

/**
 * Default for image uploads — the exact-matching equivalent of the legacy
 * `/jpeg|jpg|png/`.
 */
export const IMAGE_UPLOAD_ALLOW_LIST: UploadAllowList = {
  extensions: ['.jpeg', '.jpg', '.png'],
  mimeTypes: ['image/jpeg', 'image/png'],
};

/**
 * Types a browser may execute as script when it renders the stored file.
 *
 * These are rejected by {@link multerFileFilter} REGARDLESS of the allow-list,
 * because the danger does not depend on what a given endpoint meant to accept:
 * an upload served back from the API origin with one of these content types
 * runs in that origin, with the victim's session. The check is what makes the
 * legacy `RegExp` path safe for existing consumers without breaking their
 * expressions — see `allowScriptableTypes` to opt out.
 */
export const SCRIPTABLE_UPLOAD_MIME_TYPES: readonly string[] = [
  'application/javascript',
  'application/xhtml+xml',
  'application/xml',
  'image/svg+xml',
  'text/html',
  'text/javascript',
  'text/xml',
];

/** Extensions matching {@link SCRIPTABLE_UPLOAD_MIME_TYPES}. */
export const SCRIPTABLE_UPLOAD_EXTENSIONS: readonly string[] = [
  '.htm',
  '.html',
  '.js',
  '.mjs',
  '.svg',
  '.xhtml',
  '.xml',
];

/** Options for {@link multerFileFilter}. */
export interface MulterFileFilterOptions {
  /**
   * Accept markup and script types too (`text/html`, `image/svg+xml`, …).
   *
   * Only set this when the stored file is never served from an origin that
   * carries a session — e.g. a separate download host, or a route that always
   * answers with `Content-Disposition: attachment` AND
   * `X-Content-Type-Options: nosniff`.
   */
  allowScriptableTypes?: boolean;
}

/**
 * Helper class for inputs
 * @deprecated use functions directly
 */
export default class FileHelper {
  /**
   * Get function to generate a random file name for multer with a certain
   * number of digits
   */
  public static multerRandomFileName(numberOfDigits = 32) {
    return multerRandomFileName(numberOfDigits);
  }

  /**
   * Get function to filter files for multer with a certain mimetype & extname
   */
  public static multerFileFilter(
    accept: RegExp | UploadAllowList = IMAGE_UPLOAD_ALLOW_LIST,
    options?: MulterFileFilterOptions,
  ) {
    return multerFileFilter(accept, options);
  }

  /**
   * Get multer options for image upload
   */
  public static multerOptionsForImageUpload(options: {
    allowList?: UploadAllowList;
    destination?: string;
    fileSize?: number;
    fileTypeRegex?: RegExp;
  }): MulterOptions {
    return multerOptionsForImageUpload(options);
  }
}

/**
 * Reduce a reported mimetype to the bare type: lowercase, trimmed, without the
 * `; charset=…` parameters a user agent may append.
 */
function normalizeMimeType(value: string): string {
  return String(value || '')
    .split(';')[0]
    .trim()
    .toLowerCase();
}

/**
 * Get a multer `fileFilter` that accepts only the given mimetypes / extensions.
 *
 * Pass an {@link UploadAllowList} — both the mimetype and the extension must
 * appear in it, each compared as a WHOLE value. The two conditions are
 * independent: either one alone rejects the file, while a pair that is odd yet
 * individually allowed (`report.txt` announced as `application/pdf`) passes.
 * An extension→mimetype MAPPING is deliberately not enforced: user agents
 * genuinely disagree about office and audio types (macOS reports `.csv` as
 * `text/plain`), so a mapping rejects legitimate uploads.
 *
 * A `RegExp` is still accepted for backwards compatibility but is
 * **deprecated**: it is `.test()`ed against both values and therefore matches
 * SUBSTRINGS, which is how `te?xt` ends up accepting `text/html`. Whichever form
 * is used, the types in {@link SCRIPTABLE_UPLOAD_MIME_TYPES} /
 * {@link SCRIPTABLE_UPLOAD_EXTENSIONS} are rejected first unless
 * `options.allowScriptableTypes` is set — that is what closes the hole for
 * expressions that already exist in consumer projects.
 *
 * Rejections are reported as a `BadRequestException`, so the caller gets a 400
 * with a readable reason. An `HttpException` is required, not merely tidier:
 * NestJS's `transformException` returns any NON-`HttpException` unchanged — its
 * switch matches only multer's own message constants (`LIMIT_FILE_SIZE`,
 * `LIMIT_UNEXPECTED_FILE`, …), and a message written here matches none of them.
 * A bare `new Error()` therefore still surfaced to the client as a 500, which
 * reads as "the server broke" for what is in fact a refused file. See
 * `tests/unit/file-upload-rejection-status.spec.ts`.
 */
export function multerFileFilter(
  accept: RegExp | UploadAllowList = IMAGE_UPLOAD_ALLOW_LIST,
  options?: MulterFileFilterOptions,
) {
  return (req, file, cb) => {
    const mimeType = normalizeMimeType(file?.mimetype);
    const extension = extname(String(file?.originalname || '')).toLowerCase();

    if (
      !options?.allowScriptableTypes &&
      (SCRIPTABLE_UPLOAD_MIME_TYPES.includes(mimeType) || SCRIPTABLE_UPLOAD_EXTENSIONS.includes(extension))
    ) {
      return cb(new BadRequestException(`File upload rejected: ${mimeType || 'unknown type'} may execute as script`));
    }

    const accepted =
      accept instanceof RegExp
        ? accept.test(mimeType) && accept.test(extension)
        : accept.mimeTypes.includes(mimeType) && accept.extensions.includes(extension);

    if (accepted) {
      return cb(null, true);
    }
    cb(new BadRequestException(`File upload only supports the following filetypes - ${describeAccept(accept)}`));
  };
}

/** Render the accepted types for the rejection message. */
function describeAccept(accept: RegExp | UploadAllowList): string {
  return accept instanceof RegExp ? String(accept) : accept.extensions.join(', ');
}

/**
 * Get multer options for image upload
 *
 * Pass `allowList` for exact matching; `fileTypeRegex` is deprecated (see
 * {@link multerFileFilter}). When neither is set, {@link IMAGE_UPLOAD_ALLOW_LIST}
 * applies.
 */
export function multerOptionsForImageUpload(options: {
  allowList?: UploadAllowList;
  destination?: string;
  fileSize?: number;
  fileTypeRegex?: RegExp;
  memory?: boolean;
}): MulterOptions {
  // Set config
  const config = {
    fileSize: 1024 * 1024, // 1MB
    ...options,
  };

  // An explicit regex keeps precedence so existing callers behave as before
  // (minus the scriptable types); otherwise the exact-matching default applies.
  const accept: RegExp | UploadAllowList = config.fileTypeRegex ?? config.allowList ?? IMAGE_UPLOAD_ALLOW_LIST;

  return {
    // File filter
    fileFilter: multerFileFilter(accept),

    // Limits
    limits: {
      // Limit of file size
      fileSize: config.fileSize ? config.fileSize : undefined,
    },

    // Automatic storage handling
    // For configuration see https://github.com/expressjs/multer#storage
    //
    // `memory: true` keeps the upload in RAM so the handler can hand it straight
    // to a central store (GridFS/S3) via `multerFileToUpload()`. Disk storage
    // writes to the POD's filesystem, which another replica cannot read and a
    // restart discards — see `memoryStorage()` below.
    storage: config.memory
      ? memoryStorage()
      : diskStorage({
          // Destination for uploaded file
          // If destination is not set file will be buffered and can be processed
          // in the method
          destination: config.destination ? config.destination : undefined,

          // Generated random file name
          filename: multerRandomFileName(),
        }),
  };
}

/**
 * Adapt a multer upload to the shape `CoreFileService` consumes.
 *
 * Lets a REST/multer endpoint write to the same central storage (GridFS or S3)
 * as the GraphQL upload path, instead of the pod-local disk that multer's
 * `diskStorage` produces. Requires `memory: true` on the multer options — a
 * disk-stored file has no `buffer`, and this throws rather than silently
 * storing an empty file.
 *
 * The returned `createReadStream` is callable more than once: it builds a fresh
 * stream over the same buffer each time, matching graphql-upload's contract.
 */
export function multerFileToUpload(file: {
  buffer?: Buffer;
  mimetype?: string;
  originalname?: string;
}): FileUploadSource {
  if (!file?.buffer) {
    throw new Error(
      'multerFileToUpload() needs an in-memory upload: pass `memory: true` to the multer options ' +
        '(a disk-stored file has no buffer).',
    );
  }
  return {
    createReadStream: () => Readable.from(file.buffer),
    encoding: '7bit',
    filename: file.originalname || randomBytes(16).toString('hex'),
    mimetype: file.mimetype || 'application/octet-stream',
  };
}

/**
 * Get function to generate a random file name for multer with a certain
 * number of digits
 */
export function multerRandomFileName(numberOfDigits = 32) {
  return (req, file, cb) => {
    // Generating a random string
    const randomName = Array(numberOfDigits)
      .fill(null)
      .map(() => Math.round(Math.random() * 16).toString(16))
      .join('');

    // Calling the callback passing the random name generated with the
    // original extension name
    cb(null, `${randomName}${extname(file.originalname)}`);
  };
}
