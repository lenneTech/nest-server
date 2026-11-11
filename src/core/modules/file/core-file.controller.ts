import {
  BadRequestException,
  Controller,
  Get,
  Logger,
  NotFoundException,
  Param,
  Res,
  ServiceUnavailableException,
} from '@nestjs/common';
import type { Response } from 'express';
import type { Readable } from 'stream';

import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { Roles } from '../../common/decorators/roles.decorator';
import { RoleEnum } from '../../common/enums/role.enum';
import { buildContentDisposition } from '../../common/helpers/content-disposition.helper';
import { StreamIdleTimeoutError } from '../../common/helpers/idle-stream.helper';
import { ConfigService } from '../../common/services/config.service';
import { ErrorCode } from '../error-code/error-codes';
import { SkipTenantCheck } from '../tenant/core-tenant.decorators';
import { CoreFileService } from './core-file.service';
import type { FileServiceOptions } from './interfaces/file-service-options.interface';

const fileStreamLogger = new Logger('CoreFileController');

/**
 * Downloads closed by the idle guard since the last report, and when the last report was written.
 *
 * Reported as ONE warning per minute instead of a line per download: a client that stops reading is not a server
 * error, and under an abort storm a line per event (measured: 20 per second, each with a stack) turns the log into an
 * alert storm. `withOpenConnection` counts the closes whose client connection was still open — clients that stopped
 * reading without closing; the rest were waiting on a store that delivered nothing.
 */
const idleCloses = { afterResponseClose: 0, lastReportAt: 0, sample: '', total: 0, withOpenConnection: 0 };
const IDLE_CLOSE_REPORT_INTERVAL_MS = 60_000;

/** An idle close of the download guard — by class or by code, so a second copy of the helper module counts too. */
function isStreamIdleTimeout(error: unknown): error is StreamIdleTimeoutError {
  return error instanceof StreamIdleTimeoutError || (error as { code?: string })?.code === 'LT_STREAM_IDLE_TIMEOUT';
}

function reportIdleClose(
  res: Response,
  error: StreamIdleTimeoutError,
  state: { attachedAt: number; clientGoneSignal: string; responseClosed: boolean },
): void {
  idleCloses.total++;
  const socket = (res as Response & { socket?: { destroyed?: boolean } | null }).socket;
  if (socket && !socket.destroyed) {
    idleCloses.withOpenConnection++;
  }
  // A close the response had already reported: the stream should have been destroyed then, not by the idle guard
  if (state.responseClosed) {
    idleCloses.afterResponseClose++;
  }
  if (!idleCloses.sample) {
    const r = res as Response & { closed?: boolean; writableEnded?: boolean };
    const req = (res as Response & { req?: { destroyed?: boolean } }).req;
    idleCloses.sample =
      `example: ${Date.now() - state.attachedAt} ms after delivery started, response closed event ${state.responseClosed}, ` +
      `destroyed ${r.destroyed}, closed ${r.closed}, headersSent ${r.headersSent}, writableEnded ${r.writableEnded}, ` +
      `socket ${socket ? (socket.destroyed ? 'destroyed' : 'open') : 'none'}, request destroyed ${req?.destroyed}, ` +
      `client-gone signal ${state.clientGoneSignal || 'none'}`;
  }
  const now = Date.now();
  if (now - idleCloses.lastReportAt < IDLE_CLOSE_REPORT_INTERVAL_MS) {
    return;
  }
  fileStreamLogger.warn(
    `${idleCloses.total} file download(s) closed after no read progress for ${error.idleMs} ms since the last ` +
      `report (${idleCloses.withOpenConnection} with the client connection still open: clients that stopped reading ` +
      `without closing; ${idleCloses.afterResponseClose} after the response had already closed; ${idleCloses.sample}). ` +
      'This releases the store socket, file handle or cursor; many of them under load hold S3 sockets for that long — ' +
      'see s3.downloadIdleTimeoutMs.',
  );
  idleCloses.lastReportAt = now;
  idleCloses.total = 0;
  idleCloses.withOpenConnection = 0;
  idleCloses.afterResponseClose = 0;
  idleCloses.sample = '';
}

/**
 * Release the source on every signal that the client has gone, not only on the response's `close`.
 *
 * Measured under an abort storm (k6, 40 aborts/s against S3 through the full controller route): about one in six
 * aborted downloads never got a `close` on the response although the client's connection was gone on the server side —
 * headers sent, body mid-flight, `res.destroyed` false. Those held their S3 socket until the idle guard ran out. The
 * request and the socket carry the same news through other events: the request closes before its end (it was
 * aborted), and the socket ends or closes. A request whose body was read to the end — a POST export, or any request a
 * body-parsing middleware read — is closed by Node itself on a healthy connection, so its `close` says nothing about
 * the client; the socket listeners still report that client leaving later.
 * Listeners on a keep-alive socket are removed once this response is done, so they never reach the next request.
 */
function watchClientGone(stream: Readable, res: Response, state: { clientGoneSignal: string }): void {
  const req = res.req;
  const socket = res.socket;
  const release = (signal: string) => () => {
    if (res.writableFinished || (signal === 'request close' && req?.readableEnded)) {
      return;
    }
    state.clientGoneSignal ||= signal;
    if (!stream.destroyed) {
      stream.destroy();
    }
  };
  const onRequestClose = release('request close');
  const onSocketEnd = release('socket end');
  const onSocketClose = release('socket close');
  if (typeof req?.once === 'function') {
    req.once('close', onRequestClose);
  }
  socket?.once('end', onSocketEnd);
  socket?.once('close', onSocketClose);
  const cleanUp = () => {
    if (typeof req?.removeListener === 'function') {
      req.removeListener('close', onRequestClose);
    }
    socket?.removeListener('end', onSocketEnd);
    socket?.removeListener('close', onSocketClose);
  };
  res.once('finish', cleanUp);
  res.once('close', cleanUp);
  stream.once('close', cleanUp);
}

/** Marker of {@link CoreFileController.openDownloadStream}: the client has gone, nothing is to be delivered. */
export const RESPONSE_GONE = Symbol('lt.responseGone');

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
const FILE_DELIVERY_HEADERS = ['Cache-Control', 'Content-Disposition', 'Content-Length', 'Content-Type', 'ETag'];

/**
 * Re-exported from the leaf it now lives in, so no import path broke.
 *
 * It moved because the S3 presigned-URL branch in `src/core/common/services/` needs the SAME
 * value, and `src/core/common/**` must not import from `src/core/modules/**`. While the two
 * rendered it separately, the same file downloaded under a different name depending on whether
 * `s3.presignedDownloads` was on.
 */
export { buildContentDisposition };

/**
 * Deliver a download stream to the response — THE way to answer a download route, for every store
 * (S3, filesystem, GridFS), in the framework's controller and in a project's own routes alike.
 *
 * WHY NOT `stream.pipe(res)`: when the client aborts, `pipe()` only unpipes. The source stays open and
 * paused, and it holds what it was given — for S3 a socket of the client's pool. Enough aborted downloads
 * and the pool is full: every further S3 request waits forever while the health check stays green (a
 * production outage with exactly this cause preceded 12.8.9). This function destroys the source as soon as
 * the response closes, and answers a store error before the first byte with a 404 instead of a dropped
 * connection. (Since 12.8.9 the streams of `CoreFileService` and `CoreS3Service` also release themselves
 * after an idle time — a second layer, not a reason to skip this one.)
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
  // A client that left BEFORE this call (it waited for a free socket of the store, then gave up): its response
  // has already closed, and a `close` listener registered now never fires. Without this check the source was
  // never read nor destroyed and kept its S3 socket — under load an avalanche: a few leaks make downloads slow,
  // waiting clients give up, and every one of them leaks the next socket.
  if (isResponseGone(res)) {
    stream.destroy();
    return res;
  }
  const state = { attachedAt: Date.now(), clientGoneSignal: '', responseClosed: false };
  res.on('close', () => {
    state.responseClosed = true;
    if (!stream.destroyed) {
      stream.destroy();
    }
  });
  watchClientGone(stream, res, state);

  stream.on('error', (err: Error) => {
    // No read progress for the idle time: a client that stopped reading (or a store that delivers nothing) — not
    // a server error, so no ERROR line per download (see `reportIdleClose`). Before the first byte it was the store
    // that stalled: 503, the client may retry; afterwards only closing the connection remains.
    if (isStreamIdleTimeout(err)) {
      reportIdleClose(res, err, state);
      if (res.headersSent) {
        res.destroy();
        return;
      }
      for (const header of FILE_DELIVERY_HEADERS) {
        res.removeHeader(header);
      }
      res.setHeader('Retry-After', '5');
      res
        .status(503)
        .json({ error: 'Service Unavailable', message: 'File storage is busy, please retry', statusCode: 503 });
      return;
    }
    // The answer to the CLIENT stays deliberately indistinguishable from an
    // unknown id, but the server must not lose the event: a files document
    // without its chunks is data corruption, and an error silently converted
    // into a 404 is one nobody will ever notice.
    fileStreamLogger.error(`File download failed: ${err.message}`, err.stack);

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
 * Whether the client of a response has gone: the response was destroyed or closed, or its request or socket was.
 *
 * The response alone is not enough. Measured under an abort storm through the full controller route: a share of the
 * aborted downloads reached delivery with the socket and the request already destroyed while the response still read
 * `destroyed: false, closed: false` and never emitted `close` — those held their S3 socket until the idle guard ran
 * out. A request destroyed BEFORE its end was aborted. One destroyed after its body was read to the end has merely
 * completed: Node destroys it by itself then, on a healthy connection (a POST export, or any request whose body a
 * middleware read), so only `destroyed && !readableEnded` counts, next to a destroyed socket.
 */
export function isResponseGone(res: Response): boolean {
  const r = res as Response & { closed?: boolean };
  return !!(r.destroyed || r.closed || isRequestAborted(r.req) || r.socket?.destroyed);
}

/** A request destroyed before its end: the client has gone. Node also destroys a request whose body was read to the end. */
function isRequestAborted(req: undefined | { destroyed?: boolean; readableEnded?: boolean }): boolean {
  return !!req?.destroyed && !req.readableEnded;
}

/**
 * An `AbortSignal` that fires when the client of a download has gone — on the same signals `pipeFileToResponse()`
 * releases a source on: the response closes, the request closes before its end, or the socket ends or closes before
 * the response finished (see {@link isResponseGone} for why the response alone is not enough, and why a request read
 * to the end is not a gone client). Pass it as `abortSignal` to `getFileStream()` / `CoreS3Service.getObject()` from
 * a project's own download route, so an S3 request that still waits for a free socket is dropped instead of taking
 * one later for nobody. The socket listeners are removed once the response is done, so a keep-alive socket carries
 * none of them into its next request.
 */
export function downloadAbortSignal(res: Response): AbortSignal {
  const controller = new AbortController();
  if (isResponseGone(res)) {
    controller.abort();
    return controller.signal;
  }
  const req = res.req;
  const socket = res.socket;
  const abortWhileUnfinished = () => {
    if (!res.writableFinished) {
      controller.abort();
    }
  };
  // A request read to the end is closed by Node itself on a healthy connection — not the client leaving. A client
  // that leaves after its body was read is reported by the socket (and usually the response)
  const abortOnRequestClose = () => {
    if (!req?.readableEnded) {
      abortWhileUnfinished();
    }
  };
  if (typeof req?.once === 'function') {
    req.once('close', abortOnRequestClose);
  }
  socket?.once('end', abortWhileUnfinished);
  socket?.once('close', abortWhileUnfinished);
  const cleanUp = () => {
    socket?.removeListener('end', abortWhileUnfinished);
    socket?.removeListener('close', abortWhileUnfinished);
  };
  res.once('finish', cleanUp);
  res.once('close', () => {
    cleanUp();
    controller.abort();
  });
  return controller.signal;
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
  protected async resolveDownloadUrl(id: string, serviceOptions?: FileServiceOptions): Promise<string | undefined> {
    try {
      // `serviceOptions` carries the current user into the service's own rights
      // check. Omitting it made this second check run with `currentUser:
      // undefined`: for the ownership rule documented in the README that fails
      // CLOSED, so presigned downloads silently never fired — not even for
      // admins, since `currentUser?.hasRole(...)` was undefined too. For an
      // override that reads a missing user as "system-internal, allow" it was a
      // no-op instead. Neither is what the path that mints a session-less
      // capability should be doing.
      return await this.fileService.getDownloadUrl?.(id, serviceOptions);
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

    // Registered first: the client may leave while the rights check or the store request is still pending
    const abortSignal = this.downloadAbortSignal(res);
    const serviceOptions = { abortSignal, currentUser };
    // One lookup for both answers — metadata AND which store holds the bytes.
    // getFileInfo() followed by getFileStream() had each probe the three stores
    // from scratch, since neither told the other which one had answered. Same
    // rights check, same 404-on-refusal.
    const resolved = await this.fileService.resolveFile(id, serviceOptions);
    const file = resolved?.info;
    if (!file) {
      throw new NotFoundException(ErrorCode.FILE_NOT_FOUND);
    }
    // Authorized above; a client that already holds these bytes gets 304 without the store being read
    if (this.answerNotModified(res, file)) {
      return res;
    }
    // S3-stored file with presigned downloads enabled: let the client fetch the
    // bytes from S3 directly instead of streaming them through the API.
    //
    // AUTHORIZATION on this branch rests entirely on the `resolveFile()` call
    // above, which runs the very same `checkRights()` `getFileInfo()` did and
    // answers null on refusal, so the throw above turns it into a 404 —
    // `getFileStream()` is never reached here. Keep that call before this
    // block. Note also that the issued URL is a bearer capability: anyone
    // holding it can fetch the object until it expires, without a session. Keep
    // the expiry short, and do not enable presigned downloads for files whose
    // audience is narrower than "anyone who was once allowed to see the link".
    // Only S3-stored bytes can be handed over as a presigned URL, and `resolveFile`
    // already established the store — so a GridFS or filesystem download no longer
    // pays a pointless S3 metadata lookup to find that out.
    const url = resolved.store === 's3' ? await this.resolveDownloadUrl(id, serviceOptions) : undefined;
    if (url) {
      this.setNoStore(res);
      // `res.redirect()` is typed `void`, so returning it directly widened this method's inferred
      // return type to `Promise<void | Response>` — a source-invisible BREAKING change for every
      // project that overrides `getFileById`/`getFile` with an explicit `Promise<Response>` and
      // delegates to super. Nest ignores the returned value once `@Res()` is used, so returning
      // `res` is equivalent and keeps the published contract intact. The explicit annotation on
      // both methods pins it, so inference can never silently widen it again.
      res.redirect(302, url);
      return res;
    }
    const filestream = await this.openDownloadStream(res, () =>
      this.fileService.getFileStream(id, serviceOptions, resolved.store),
    );
    if (filestream === RESPONSE_GONE) {
      return res;
    }
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

    const abortSignal = this.downloadAbortSignal(res);
    const serviceOptions = { abortSignal, currentUser };
    const file = await this.fileService.getFileInfoByName(filename, serviceOptions);
    if (!file) {
      throw new NotFoundException(ErrorCode.FILE_NOT_FOUND);
    }
    if (this.answerNotModified(res, file)) {
      return res;
    }
    // See getFileById(): authorization on the presigned branch rests on the
    // getFileInfoByName() call above.
    const url = await this.resolveDownloadUrl(file.id, serviceOptions);
    if (url) {
      this.setNoStore(res);
      res.redirect(302, url);
      return res;
    }
    const filestream = await this.openDownloadStream(res, () =>
      this.fileService.getFileStream(file.id, serviceOptions),
    );
    if (filestream === RESPONSE_GONE) {
      return res;
    }
    if (!filestream) {
      throw new NotFoundException(ErrorCode.FILE_NOT_FOUND);
    }
    this.setFileHeaders(res, file);
    return this.pipeFileToResponse(filestream, res);
  }

  /**
   * An `AbortSignal` that fires when the response closes — the client has gone. Passed to the store, so an S3
   * request that still waits for a free socket is dropped instead of taking one later for nobody.
   */
  protected downloadAbortSignal(res: Response): AbortSignal {
    return downloadAbortSignal(res);
  }

  /**
   * Open the download stream unless the client has already gone, and release a stream that arrives after it left.
   *
   * Answers {@link RESPONSE_GONE} when there is nobody left to deliver to: before the store is asked, when the
   * store request was aborted because the response closed, or when the stream arrived after it closed (then the
   * stream is destroyed here, so its socket, file handle or cursor is free at once).
   */
  protected async openDownloadStream(
    res: Response,
    open: () => Promise<Readable>,
  ): Promise<Readable | typeof RESPONSE_GONE> {
    if (isResponseGone(res)) {
      return RESPONSE_GONE;
    }
    let stream: Readable;
    try {
      stream = await open();
    } catch (error) {
      if (isResponseGone(res)) {
        return RESPONSE_GONE;
      }
      // The store did not hand out a connection in time (`s3.connectionTimeoutMs`, which includes the wait for a
      // free socket): the store is busy, not broken, and the client may try again — 503, not 500
      if ((error as { name?: string })?.name === 'TimeoutError') {
        fileStreamLogger.warn(`File store busy, download answered 503: ${(error as Error).message}`);
        res.header('Retry-After', '5');
        throw new ServiceUnavailableException('File storage is busy, please retry');
      }
      throw error;
    }
    if (stream && isResponseGone(res)) {
      stream.destroy();
      return RESPONSE_GONE;
    }
    return stream;
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
  protected setFileHeaders(
    res: Response,
    file: { contentType?: string; filename?: string; id?: string; length?: number },
  ): void {
    this.setCacheHeaders(res, file);
    res.header('Content-Type', file.contentType || 'application/octet-stream');
    // See {@link buildContentDisposition} for why the two filename parameters are
    // rendered differently, and for the injection cases the sanitiser closes.
    res.header('Content-Disposition', buildContentDisposition(file.filename));
    // Lets a client and every proxy see the size up front and detect a truncated transfer. Taken from the
    // stored metadata, which each store records from the bytes it wrote.
    if (typeof file.length === 'number' && Number.isSafeInteger(file.length) && file.length >= 0) {
      res.header('Content-Length', String(file.length));
    }
  }

  /**
   * `Cache-Control` and `ETag` of a file response, per `file.downloadCaching`.
   *
   * - `'none'` (default): `private, no-store` — see {@link setFileHeaders} for why.
   * - `'revalidate'`: `private, no-cache` — the BROWSER may keep the file, but must ask again on every use;
   *   the request runs the full role and rights check and is answered `304 Not Modified` without the store
   *   being read. For image-heavy apps that removes most store reads (and S3 sockets) while every view stays
   *   authorized. Shared caches (proxies, CDNs) are still excluded by `private`.
   *
   * The `ETag` is the file id, as a WEAK validator (`W/"<id>"`): the bytes under an id never change (every store
   * writes a new file under a new id; a duplicate is a new id too), but a `compression` middleware in front sends the
   * same file gzip-encoded or not, and RFC 9110 §8.8.3 requires different strong validators for different
   * representations. `If-None-Match` compares weakly anyway, so the 304 works the same.
   */
  protected setCacheHeaders(res: Response, file: { id?: string }): void {
    const mode = ConfigService.configFastButReadOnly?.file?.downloadCaching;
    res.header('Cache-Control', mode === 'revalidate' ? 'private, no-cache' : 'private, no-store');
    const etag = this.fileEtag(file);
    if (etag) {
      res.header('ETag', etag);
    }
  }

  /**
   * Weak validator of a file: its id, quoted, with `W/` (see {@link setCacheHeaders}). `undefined` without an id.
   */
  protected fileEtag(file: { id?: string }): string | undefined {
    return file?.id ? `W/"${String(file.id)}"` : undefined;
  }

  /**
   * Answer `304 Not Modified` when the request's `If-None-Match` names this file's validator.
   *
   * Call it only AFTER the file was resolved with the rights check — a 304 confirms the file exists. Reads the
   * request from `res.req`, so the route signatures (which projects override) stay as they are.
   */
  protected answerNotModified(res: Response, file: { id?: string }): boolean {
    const etag = this.fileEtag(file);
    const header = (res as Response & { req?: { headers?: Record<string, string | string[] | undefined> } }).req
      ?.headers?.['if-none-match'];
    if (!etag || !header) {
      return false;
    }
    // Weak comparison (RFC 9110 §13.1.2): the opaque tags must match, `W/` on either side does not count
    const opaque = (value: string) => value.trim().replace(/^W\//, '');
    const candidates = (Array.isArray(header) ? header.join(',') : header).split(',').map(opaque);
    if (!candidates.includes(opaque(etag)) && !candidates.includes('*')) {
      return false;
    }
    this.setCacheHeaders(res, file);
    res.status(304).end();
    return true;
  }

  /**
   * Mark a download response as uncacheable by any shared cache.
   *
   * Applies to BOTH delivery paths. On the streaming path it stops a reverse
   * proxy or CDN with a blanket `/files/*` rule from handing an authorized
   * response to the next, unauthorized requester. On the presigned path it
   * matters more, not less: that response's `Location` is a bearer capability
   * that works with no session, from any IP, until it expires — and while a 302
   * is not heuristically cacheable per RFC 9111, `proxy_cache_valid 200 302 …`
   * is the single most-copied nginx caching snippet, and Cloudflare's "Cache
   * Everything" stores it too.
   */
  protected setNoStore(res: Response): void {
    res.header('Cache-Control', 'private, no-store');
  }
}
