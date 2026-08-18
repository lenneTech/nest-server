import { Controller, Post, UploadedFile, UseInterceptors } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { afterEach, describe, expect, it } from 'vitest';

import { multerFileFilter, UploadAllowList } from '../../src/core/common/helpers/file.helper';

import type { INestApplication } from '@nestjs/common';

/**
 * These tests drive a REAL Nest + Express + multer stack and assert the HTTP STATUS, because the
 * status is the whole property under test and it is not visible from the filter itself.
 *
 * THE MECHANISM
 * -------------
 * `multerFileFilter` reports a rejection by calling multer's callback with an error. Multer hands
 * that error to Nest's `FileInterceptor`, which passes it through `transformException` from
 * `@nestjs/platform-express`. That function does exactly two things:
 *
 *   1. returns the error UNCHANGED if it is already an `HttpException`;
 *   2. otherwise switches on `error.message` against MULTER'S OWN message constants
 *      (`LIMIT_FILE_SIZE`, `LIMIT_UNEXPECTED_FILE`, …) and — falling off the end of that switch —
 *      returns the error unchanged as well.
 *
 * A rejection message this helper writes matches none of those constants. So a plain `new Error()`
 * takes branch 2, reaches Nest's exception layer as a non-HTTP error, and the client is told the
 * SERVER failed (500) when in fact the client's file was refused (400). Throwing a
 * `BadRequestException` takes branch 1 and arrives as a 400 with the message intact.
 *
 * WHY A UNIT-LEVEL HTTP TEST RATHER THAN AN ASSERTION ON THE CALLBACK
 * -------------------------------------------------------------------
 * Asserting that the callback receives an `Error` is what the previous fix already did, and it
 * passed while the client still got a 500 — the assertion restated the implementation instead of
 * the observable behaviour. The status code is the observable behaviour, and it needs the real
 * interceptor in the path. No database, no framework boot: a bare controller is enough.
 */

const DOCUMENTS: UploadAllowList = {
  extensions: ['.pdf'],
  mimeTypes: ['application/pdf'],
};

/** Rejects anything outside the allow-list, and scriptable types unconditionally. */
@Controller()
class UploadProbeController {
  @Post('upload')
  @UseInterceptors(FileInterceptor('file', { fileFilter: multerFileFilter(DOCUMENTS) }))
  upload(@UploadedFile() file: unknown): { received: boolean } {
    return { received: !!file };
  }
}

async function createApp(): Promise<INestApplication> {
  const moduleRef = await Test.createTestingModule({ controllers: [UploadProbeController] }).compile();
  const app = moduleRef.createNestApplication();
  await app.init();
  return app;
}

describe('multer file rejection over HTTP', () => {
  let app: INestApplication | undefined;

  afterEach(async () => {
    await app?.close();
    app = undefined;
  });

  it('accepts a file that is on the allow-list', async () => {
    // Guards the tests below against passing because EVERY upload fails.
    app = await createApp();

    const res = await request(app.getHttpServer())
      .post('/upload')
      .attach('file', Buffer.from('%PDF-1.4'), { contentType: 'application/pdf', filename: 'report.pdf' });

    expect(res.status).toBe(201);
    expect(res.body.received).toBe(true);
  });

  it('answers 400, not 500, when the type is not on the allow-list', async () => {
    // A refused upload is the CLIENT's mistake. A 500 tells the caller to retry and tells the
    // operator to investigate an outage, and it buries the real reason in an alert channel.
    app = await createApp();

    const res = await request(app.getHttpServer())
      .post('/upload')
      .attach('file', Buffer.from('MZ'), { contentType: 'application/x-msdownload', filename: 'setup.exe' });

    expect(res.status).toBe(400);
    expect(res.body.message).toContain('File upload only supports the following filetypes');
  });

  it('answers 400, not 500, when the type may execute as script', async () => {
    // The scriptable-type path was added separately and has the same defect — fixing only the
    // allow-list branch would leave the more security-relevant rejection reporting an outage.
    app = await createApp();

    const res = await request(app.getHttpServer())
      .post('/upload')
      .attach('file', Buffer.from('<script>'), { contentType: 'text/html', filename: 'page.html' });

    expect(res.status).toBe(400);
    expect(res.body.message).toContain('may execute as script');
  });
});
