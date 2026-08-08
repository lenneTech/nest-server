import { BadRequestException, Controller, Get, Logger, NotFoundException, Param, Res } from '@nestjs/common';
import type { Response } from 'express';
import type { Readable } from 'stream';

import { Roles } from '../../common/decorators/roles.decorator';
import { RoleEnum } from '../../common/enums/role.enum';
import { ErrorCode } from '../error-code/error-codes';
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
 */
@Controller('files')
@Roles(RoleEnum.ADMIN)
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
   */
  @Get('id/:id')
  @Roles(RoleEnum.S_EVERYONE)
  async getFileById(@Param('id') id: string, @Res() res: Response) {
    if (!id) {
      throw new BadRequestException(ErrorCode.REQUIRED_FIELD_MISSING);
    }

    const file = await this.fileService.getFileInfo(id);
    if (!file) {
      throw new NotFoundException(ErrorCode.FILE_NOT_FOUND);
    }
    // S3-stored file with presigned downloads enabled: let the client fetch the
    // bytes from S3 directly instead of streaming them through the API
    const url = await this.resolveDownloadUrl(id);
    if (url) {
      return res.redirect(302, url);
    }
    const filestream = await this.fileService.getFileStream(id);
    // `getFileStream` answers null when the service's own rights check refuses.
    // Same answer as an unknown id: never confirm that the file exists.
    if (!filestream) {
      throw new NotFoundException(ErrorCode.FILE_NOT_FOUND);
    }
    res.header('Content-Type', file.contentType || 'application/octet-stream');
    res.header('Content-Disposition', `attachment; filename=${file.filename}`);
    return this.pipeFileToResponse(filestream, res);
  }

  /**
   * Download file by filename
   *
   * Note: If multiple files have the same filename, only the first match is returned.
   * For unique file access, use GET /files/id/:id instead.
   */
  @Get(':filename')
  @Roles(RoleEnum.S_EVERYONE)
  async getFile(@Param('filename') filename: string, @Res() res: Response) {
    if (!filename) {
      throw new BadRequestException(ErrorCode.REQUIRED_FIELD_MISSING);
    }

    const file = await this.fileService.getFileInfoByName(filename);
    if (!file) {
      throw new NotFoundException(ErrorCode.FILE_NOT_FOUND);
    }
    const url = await this.resolveDownloadUrl(file.id);
    if (url) {
      return res.redirect(302, url);
    }
    const filestream = await this.fileService.getFileStream(file.id);
    if (!filestream) {
      throw new NotFoundException(ErrorCode.FILE_NOT_FOUND);
    }
    res.header('Content-Type', file.contentType || 'application/octet-stream');
    res.header('Content-Disposition', `attachment; filename=${file.filename}`);
    return this.pipeFileToResponse(filestream, res);
  }
}
