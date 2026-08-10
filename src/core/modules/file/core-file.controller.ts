import { BadRequestException, Controller, Get, Logger, NotFoundException, Param, Res } from '@nestjs/common';
import type { Response } from 'express';
import type { Readable } from 'stream';

import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { Roles } from '../../common/decorators/roles.decorator';
import { RoleEnum } from '../../common/enums/role.enum';
import { ErrorCode } from '../error-code/error-codes';
import { SkipTenantCheck } from '../tenant/core-tenant.decorators';
import { CoreFileService } from './core-file.service';

const fileStreamLogger = new Logger('CoreFileController');

/**
 * Headers that describe the FILE and must not survive onto an error response.
 *
 * Deliberately not the whole set: CORS headers are already on the response at
 * this point, and removing those would turn a readable 404 into an opaque CORS
 * failure in the browser — hiding the very answer this handler exists to give.
 *
 * `Content-Type` is the one most easily missed. Express only defaults it in
 * `res.json()` when nothing is set yet (`if (!this.get('Content-Type'))`), so the
 * file's own type would otherwise label a JSON body as `image/png` — and an
 * ofetch/`$fetch` client picks its parser from that header and hands the caller a
 * Blob instead of the error message.
 */
const FILE_DELIVERY_HEADERS = ['Cache-Control', 'Content-Disposition', 'Content-Type', 'ETag'];

/**
 * Pipe a GridFS download to the response without letting a read error kill the socket.
 *
 * A GridFS record and its chunks are two separate writes, so a file document can
 * outlive its bytes — an interrupted upload, a restored backup, a manual cleanup.
 * GridFS reports that asynchronously, on the stream, and `stream.pipe(res)` alone
 * installs no error handler: the error goes unhandled, Node destroys the socket
 * mid-response, and any reverse proxy in front turns that into **502 Bad Gateway**.
 * That reads as "the server is down" — the one diagnosis that is wrong here, while
 * every other route keeps answering normally.
 *
 * Nothing has been written when GridFS reports a missing file, so the status is
 * still ours to set and the answer becomes an honest 404. Once bytes are on the
 * wire there is no status left to send and closing the connection is all that
 * remains — but at that point it genuinely is a truncated transfer, which is
 * exactly what a dropped connection means to the client.
 *
 * Note on `pipe()` vs `stream.pipeline()`: pipeline would destroy BOTH streams on
 * error, including the response — which is precisely the object still needed to
 * send the 404. So the source is cleaned up explicitly on `res` close instead;
 * `pipe()` only ever unpipes the destination and would otherwise leave the
 * GridFS read stream and its server-side cursor open on every aborted download.
 */
export function pipeFileToResponse(stream: Readable, res: Response): Response {
  res.on('close', () => {
    if (!stream.destroyed) {
      stream.destroy();
    }
  });

  stream.on('error', (err: Error) => {
    // The answer to the CLIENT stays deliberately indistinguishable from an
    // unknown id, but the server must not lose the event: a files document
    // without its chunks is data corruption, and an error silently converted
    // into a 404 is one nobody will ever notice.
    fileStreamLogger.error(`GridFS download failed: ${err.message}`, err.stack);

    if (res.headersSent) {
      res.destroy();
      return;
    }
    for (const header of FILE_DELIVERY_HEADERS) {
      res.removeHeader(header);
    }
    // No global nosniff on this route, and the body is now correctly typed —
    // set it anyway so a mislabelled response can never be sniffed into markup.
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.status(404).json({ error: 'Not Found', message: ErrorCode.FILE_NOT_FOUND, statusCode: 404 });
  });

  return stream.pipe(res);
}

/**
 * File controller
 *
 * TENANT SCOPING: the class carries `@SkipTenantCheck()`, so the roles below are
 * checked against `user.roles` and never against `membership.role`.
 *
 * That is not a convenience — it is required for the gate to mean what it says.
 * GridFS is reached through the NATIVE MongoDB driver, so `mongooseTenantPlugin`
 * never runs on `fs.files`: one bucket holds every tenant's blobs, unscoped.
 * Without this decorator and with `multiTenancy` active, a role string like
 * `'admin'` would be satisfied by any member whose MEMBERSHIP role is `admin` —
 * a workspace admin of tenant A could then read tenant B's files.
 *
 * A genuinely tenant-aware policy therefore cannot be expressed by a role name.
 * Write `tenantId` into the file metadata at upload time and compare it in an
 * overridden `CoreFileService.checkRights()`.
 */
@Controller('files')
@Roles(RoleEnum.ADMIN)
@SkipTenantCheck()
export abstract class CoreFileController {
  /**
   * Include services
   */
  protected constructor(protected fileService: CoreFileService) {}

  /**
   * Stream a file to the response.
   *
   * Delegates to the module-level {@link pipeFileToResponse} (which stays exported
   * so it can be unit-tested without a Nest context). Override this to change the
   * error status, the body shape or the logging for a project — the free function
   * alone would not be reachable from a subclass.
   */
  protected pipeFileToResponse(stream: Readable, res: Response): Response {
    return pipeFileToResponse(stream, res);
  }

  /**
   * Presigned S3 URL for a download, or undefined to stream through the API.
   *
   * Deliberately fail-soft. A presigned URL is an OPTIMIZATION — it offloads bytes
   * from the API — so nothing about it may cost the caller their download: a
   * missing `@aws-sdk/s3-request-presigner`, an S3 outage or a project service
   * predating this method must all fall through to the streaming path, which
   * still runs the same rights check and answers a refusal exactly like an
   * unknown id. Turning any of those into a 500 would also leak that the file
   * exists, which the streaming path takes care never to do.
   */
  protected async resolveDownloadUrl(id: string): Promise<string | undefined> {
    try {
      return await this.fileService.getDownloadUrl?.(id);
    } catch (error) {
      fileStreamLogger.warn(
        `Presigned download URL unavailable, falling back to streaming: ${error instanceof Error ? error.message : 'Unknown error'}`,
      );
      return undefined;
    }
  }

  /**
   * Download file by ID
   *
   * More reliable than filename-based download as IDs are unique.
   * Recommended for TUS uploads and when filename uniqueness cannot be guaranteed.
   *
   * SECURITY: gated by `file.downloadRoles` (default `[ADMIN]`). The decorator
   * below is the fallback — `CoreModule.forRoot()` rewrites it from config.
   * See `src/core/modules/file/README.md` § Access control for the full model
   * and the 11.32.4 → 11.33.0 migration guide for why the default changed.
   */
  @Get('id/:id')
  @Roles(RoleEnum.ADMIN)
  async getFileById(
    @Param('id') id: string,
    @Res() res: Response,
    @CurrentUser() currentUser?: any,
  ): Promise<Response> {
    if (!id) {
      throw new BadRequestException(ErrorCode.REQUIRED_FIELD_MISSING);
    }

    const serviceOptions = { currentUser };
    const file = await this.fileService.getFileInfo(id, serviceOptions);
    if (!file) {
      throw new NotFoundException(ErrorCode.FILE_NOT_FOUND);
    }
    // S3-stored file with presigned downloads enabled: let the client fetch the
    // bytes from S3 directly instead of streaming them through the API.
    //
    // AUTHORIZATION on this branch rests entirely on the `getFileInfo()` call
    // above, which runs `checkRights()` with the current user and throws 404 on
    // refusal — `getFileStream()` is never reached here. Keep that call before
    // this block. Note also that the issued URL is a bearer capability: anyone
    // holding it can fetch the object until it expires, without a session. Keep
    // the expiry short, and do not enable presigned downloads for files whose
    // audience is narrower than "anyone who was once allowed to see the link".
    const url = await this.resolveDownloadUrl(id);
    if (url) {
      // `res.redirect()` is typed `void`, so returning it directly widened this method's inferred
      // return type to `Promise<void | Response>` — a source-invisible BREAKING change for every
      // project that overrides `getFileById`/`getFile` with an explicit `Promise<Response>` and
      // delegates to super. Nest ignores the returned value once `@Res()` is used, so returning
      // `res` is equivalent and keeps the published contract intact. The explicit annotation on
      // both methods pins it, so inference can never silently widen it again.
      res.redirect(302, url);
      return res;
    }
    const filestream = await this.fileService.getFileStream(id, serviceOptions);
    // `getFileStream` answers null when the service's own rights check refuses.
    // Same answer as an unknown id: never confirm that the file exists.
    if (!filestream) {
      throw new NotFoundException(ErrorCode.FILE_NOT_FOUND);
    }
    this.setFileHeaders(res, file);
    return this.pipeFileToResponse(filestream, res);
  }

  /**
   * Download file by filename
   *
   * Note: If multiple files have the same filename, only the first match is returned.
   * For unique file access, use GET /files/id/:id instead.
   *
   * SECURITY: gated by `file.downloadRoles` — see `getFileById()`. Prefer the
   * id route when widening: this one resolves the FIRST match for a name a
   * caller may be able to guess, so it leaks across files that share a name.
   */
  @Get(':filename')
  @Roles(RoleEnum.ADMIN)
  async getFile(
    @Param('filename') filename: string,
    @Res() res: Response,
    @CurrentUser() currentUser?: any,
  ): Promise<Response> {
    if (!filename) {
      throw new BadRequestException(ErrorCode.REQUIRED_FIELD_MISSING);
    }

    const serviceOptions = { currentUser };
    const file = await this.fileService.getFileInfoByName(filename, serviceOptions);
    if (!file) {
      throw new NotFoundException(ErrorCode.FILE_NOT_FOUND);
    }
    // See getFileById(): authorization on the presigned branch rests on the
    // getFileInfoByName() call above.
    const url = await this.resolveDownloadUrl(file.id);
    if (url) {
      res.redirect(302, url);
      return res;
    }
    const filestream = await this.fileService.getFileStream(file.id, serviceOptions);
    if (!filestream) {
      throw new NotFoundException(ErrorCode.FILE_NOT_FOUND);
    }
    this.setFileHeaders(res, file);
    return this.pipeFileToResponse(filestream, res);
  }

  /**
   * Set the response headers that describe the file being delivered.
   *
   * `Cache-Control: private, no-store` is the security-relevant one. These
   * routes are authorization-gated, and RFC 9111 lets a shared cache store a
   * response that carries no cache directive. A reverse proxy or CDN with a
   * blanket `/files/*` rule would then be free to hand an authorized response
   * to the next, unauthorized requester — reopening at the proxy layer exactly
   * what the role gate closes at the application layer. The directive costs one
   * header and removes that entire class of misconfiguration.
   *
   * `no-store` also suppresses browser disk caching, which is the conservative
   * choice for a bucket that may hold documents. A project serving public,
   * immutable assets can override this to `public, max-age=…` — GridFS blobs
   * are immutable once written, so a validator built from `_id` + `uploadDate`
   * is sound. Do that only for files that are genuinely public.
   */
  protected setFileHeaders(res: Response, file: { contentType?: string; filename?: string }): void {
    res.header('Cache-Control', 'private, no-store');
    res.header('Content-Type', file.contentType || 'application/octet-stream');
    res.header('Content-Disposition', `attachment; filename=${file.filename}`);
  }
}
