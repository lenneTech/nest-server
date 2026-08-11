import type { Response } from 'express';
import { describe, expect, it } from 'vitest';

import { buildContentDisposition } from '../../src/core/common/helpers/content-disposition.helper';
import { CoreS3Service } from '../../src/core/common/services/core-s3.service';
import { CoreFileController } from '../../src/core/modules/file/core-file.controller';

import type { ConfigService } from '../../src/core/common/services/config.service';

/**
 * The same file must download under the same name whichever branch serves it.
 *
 * There are two: `GET /files/id/:id` either streams the bytes and sets the header itself, or —
 * with `s3.presignedDownloads` enabled — answers `302` to an S3 URL carrying
 * `response-content-disposition`, which S3 echoes back as that header. The two rendered the value
 * separately, so the S3 branch percent-encoded a name nothing percent-decodes (`Jahresbericht
 * 2024.pdf` saved as `Jahresbericht%202024.pdf`) and emitted no `filename*` at all, losing a
 * non-ASCII name outright.
 *
 * A config flag is a bad reason for a file to change its name, and nobody compares the two paths
 * by hand — so the parity is asserted here rather than left to convention.
 */

/** Capture the `ResponseContentDisposition` the presigned-URL branch puts on its GetObjectCommand */
function s3Disposition(filename: string): string | undefined {
  const commands: Record<string, any>[] = [];

  class StubbedS3Service extends CoreS3Service {
    constructor() {
      // Not configured via ConfigService — the fields below are what `requireInit()` needs, and
      // stubbing them keeps this a unit test with no AWS SDK and no network.
      super({ getFastButReadOnly: (_key: string, fallback?: unknown) => fallback } as unknown as ConfigService);
      this.config = { bucket: 'test-bucket', presignedDownloads: { expiresInSeconds: 300 } } as any;
      this.client = {} as any;
      this.sdk = {
        GetObjectCommand: function GetObjectCommand(this: any, input: Record<string, any>) {
          commands.push(input);
          this.input = input;
        },
      } as any;
      this.presigner = { getSignedUrl: async () => 'https://example.invalid/signed' } as any;
    }
  }

  const service = new StubbedS3Service();
  // Synchronous up to the command construction, which is all this needs; the promise is settled
  // below so no rejection escapes.
  void service.getPresignedDownloadUrl('some/key', filename);
  return commands[0]?.ResponseContentDisposition;
}

/** Capture the `Content-Disposition` the streaming branch sets */
function streamedDisposition(filename: string): string | undefined {
  const headers: Record<string, string> = {};
  // `header` and `set` are aliases on a real Express response; the controller uses `header`.
  const record = (name: string, value: string) => (headers[name] = value);
  const res = { header: record, set: record } as unknown as Response;

  (CoreFileController.prototype as unknown as { setFileHeaders: (r: Response, f: unknown) => void }).setFileHeaders(
    res,
    { contentType: 'application/pdf', filename },
  );

  return headers['Content-Disposition'];
}

describe('Content-Disposition parity between the streamed and presigned download paths', () => {
  it.each([
    'Jahresbericht 2024.pdf',
    'Übersicht.pdf',
    'a\r\nX-Evil: 1.txt',
    "O'Brien (final)*.pdf",
  ])('renders the same header for %j', (filename) => {
    const streamed = streamedDisposition(filename);

    expect(streamed).toBeDefined();
    expect(s3Disposition(filename)).toBe(streamed);
    // Pinned to the shared builder too, so two hand-rolled implementations that merely happen to
    // agree with each other — and disagree with RFC 6266 — cannot satisfy this test.
    expect(streamed).toBe(buildContentDisposition(filename));
  });

  it('carries the real name in filename* and a literal, unencoded ASCII fallback', () => {
    // The two defects the S3 branch had, stated directly rather than only via the parity above.
    const value = s3Disposition('Jahresbericht 2024.pdf');

    expect(value).toContain('filename="Jahresbericht 2024.pdf"');
    expect(value).not.toContain('Jahresbericht%202024.pdf"');
    expect(s3Disposition('Übersicht.pdf')).toContain("filename*=UTF-8''%C3%9Cbersicht.pdf");
  });
});
