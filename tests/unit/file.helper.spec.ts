import { describe, expect, it } from 'vitest';

import { IMAGE_UPLOAD_ALLOW_LIST, multerFileFilter, multerOptionsForImageUpload, UploadAllowList } from '../../src/core/common/helpers/file.helper';

/**
 * The filter used to be ONE unanchored `RegExp`, `.test()`ed against the
 * mimetype AND the extension. `.test()` searches for a substring, so every
 * alternative matched anywhere inside either value — `te?xt` matched the "text"
 * in `text/html`, and a file named `x.txt` sent as `text/html` passed both
 * halves of a filter documented as "no html".
 *
 * Consumer projects hit this for real. The tests below therefore cover three
 * things: the exact-matching allow-list, that the legacy `RegExp` form still
 * works, and — the point of the fix — that scriptable types are rejected on
 * BOTH paths, so an expression that already exists in a consumer project is
 * safe without being rewritten.
 */

/** Run a filter the way multer does and report its verdict. */
function verdict(
  filter: ReturnType<typeof multerFileFilter>,
  mimetype: string,
  originalname: string,
): { accepted: boolean; error?: string } {
  let accepted = false;
  let error: string | undefined;
  filter({}, { mimetype, originalname }, (err: any, result?: boolean) => {
    if (err) {
      error = err instanceof Error ? err.message : String(err);
    }
    accepted = result === true;
  });
  return { accepted, error };
}

const DOCUMENTS: UploadAllowList = {
  extensions: ['.csv', '.pdf', '.txt'],
  mimeTypes: ['application/pdf', 'text/csv', 'text/plain'],
};

describe('multerFileFilter', () => {
  describe('allow-list form', () => {
    it('accepts a mimetype and extension that are both on the list', () => {
      expect(verdict(multerFileFilter(DOCUMENTS), 'text/plain', 'notes.txt').accepted).toBe(true);
      expect(verdict(multerFileFilter(DOCUMENTS), 'application/pdf', 'report.pdf').accepted).toBe(true);
    });

    it('rejects as soon as one half is missing from the list', () => {
      expect(verdict(multerFileFilter(DOCUMENTS), 'application/x-msdownload', 'setup.pdf').accepted).toBe(false);
      expect(verdict(multerFileFilter(DOCUMENTS), 'application/pdf', 'setup.exe').accepted).toBe(false);
    });

    it('matches whole values, never substrings', () => {
      // Only an unanchored matcher would let these through.
      expect(verdict(multerFileFilter(DOCUMENTS), 'evil/text-plain', 'notes.txt').accepted).toBe(false);
      expect(verdict(multerFileFilter(DOCUMENTS), 'text/plain', 'notes.txtx').accepted).toBe(false);
    });

    it('ignores mimetype parameters and casing', () => {
      expect(verdict(multerFileFilter(DOCUMENTS), 'text/plain; charset=utf-8', 'notes.txt').accepted).toBe(true);
      expect(verdict(multerFileFilter(IMAGE_UPLOAD_ALLOW_LIST), 'IMAGE/PNG', 'PHOTO.PNG').accepted).toBe(true);
    });

    it('rejects a file without an extension', () => {
      expect(verdict(multerFileFilter(DOCUMENTS), 'text/plain', 'README').accepted).toBe(false);
    });
  });

  describe('scriptable types are rejected on BOTH forms', () => {
    // This is what makes an ALREADY EXISTING consumer expression safe.
    const legacy = /jpeg|jpg|png|te?xt|csv/;

    it('rejects text/html even when the expression matches it as a substring', () => {
      const result = verdict(multerFileFilter(legacy), 'text/html', 'invoice.txt');
      expect(result.accepted).toBe(false);
      expect(result.error).toMatch(/may execute as script/);
    });

    it('rejects text/xml and application/xhtml+xml', () => {
      expect(verdict(multerFileFilter(legacy), 'text/xml', 'notes.txt').accepted).toBe(false);
      expect(verdict(multerFileFilter(legacy), 'application/xhtml+xml', 'notes.txt').accepted).toBe(false);
    });

    it('rejects SVG on the image default', () => {
      expect(verdict(multerFileFilter(), 'image/svg+xml', 'logo.svg').accepted).toBe(false);
    });

    it('rejects a scriptable EXTENSION even under a harmless mimetype', () => {
      expect(verdict(multerFileFilter(legacy), 'text/plain', 'payload.html').accepted).toBe(false);
      expect(verdict(multerFileFilter(legacy), 'image/png', 'payload.svg').accepted).toBe(false);
    });

    it('allows them only when the caller opts in explicitly', () => {
      const filter = multerFileFilter(
        { extensions: ['.svg'], mimeTypes: ['image/svg+xml'] },
        {
          allowScriptableTypes: true,
        },
      );
      expect(verdict(filter, 'image/svg+xml', 'logo.svg').accepted).toBe(true);
    });
  });

  describe('legacy RegExp form stays usable', () => {
    it('still accepts what it accepted before', () => {
      const filter = multerFileFilter(/jpeg|jpg|png/);
      expect(verdict(filter, 'image/jpeg', 'photo.jpg').accepted).toBe(true);
      expect(verdict(filter, 'image/png', 'photo.png').accepted).toBe(true);
      expect(verdict(filter, 'application/pdf', 'report.pdf').accepted).toBe(false);
    });
  });

  describe('rejection reporting', () => {
    it('reports a real Error, not a bare string', () => {
      let received: unknown;
      multerFileFilter(DOCUMENTS)({}, { mimetype: 'application/x-foo', originalname: 'x.foo' }, (err: unknown) => {
        received = err;
      });
      // A bare string leaves multer with an "error" that has no `message`,
      // which NestJS's transformException cannot map to a 4xx.
      expect(received).toBeInstanceOf(Error);
    });
  });
});

describe('multerOptionsForImageUpload', () => {
  it('applies the image allow-list by default', () => {
    const filter = multerOptionsForImageUpload({}).fileFilter!;
    expect(verdict(filter as any, 'image/png', 'a.png').accepted).toBe(true);
    expect(verdict(filter as any, 'image/svg+xml', 'a.svg').accepted).toBe(false);
  });

  it('still installs a filter when fileTypeRegex is explicitly undefined', () => {
    // Previously this disabled filtering entirely — on a helper named
    // "ImageUpload". Safe-by-default instead; see the migration guide.
    const filter = multerOptionsForImageUpload({ fileTypeRegex: undefined }).fileFilter;
    expect(filter).toBeDefined();
    expect(verdict(filter as any, 'text/html', 'a.txt').accepted).toBe(false);
  });

  it('honours an explicit allowList', () => {
    const filter = multerOptionsForImageUpload({ allowList: DOCUMENTS }).fileFilter!;
    expect(verdict(filter as any, 'application/pdf', 'report.pdf').accepted).toBe(true);
  });
});
