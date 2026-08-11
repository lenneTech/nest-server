/**
 * `Content-Disposition` rendering for a client-supplied filename.
 *
 * An import-free LEAF on purpose. Two call sites in different layers need the identical value —
 * the file controller's streaming branch (`src/core/modules/file/`) and the S3 presigned-URL
 * branch (`src/core/common/services/`) — and `src/core/common/**` must not depend on
 * `src/core/modules/**`. A leaf serves both without an import edge in the wrong direction, and
 * without a cycle to reason about (see `.claude/rules/architecture.md` → "DI Token Placement
 * (SWC-Safe)").
 *
 * Sharing it is the point, not just tidiness: while the logic was duplicated, the SAME file
 * downloaded under a DIFFERENT name depending on whether `s3.presignedDownloads` was enabled.
 */

/**
 * Characters an RFC 8187 ext-value may carry unescaped (`attr-char`).
 *
 * `encodeURIComponent` is close but not equal: it leaves `'`, `(`, `)` and `*`
 * unescaped, and none of those is an `attr-char`. A filename like
 * `O'Brien (final)*.pdf` therefore produced a MALFORMED `filename*` parameter,
 * which a strict parser is entitled to drop — falling back to the ASCII
 * `filename` and losing the very name the ext-value exists to preserve.
 * Over-escaping is always allowed (`value-chars = *( pct-encoded / attr-char )`),
 * so escaping these four extra is the whole fix.
 */
const NON_ATTR_CHAR = /['()*]/g;

/**
 * Everything that may NOT stand in the quoted `filename` fallback.
 *
 * The complement is printable US-ASCII (0x20–0x7E) minus `"` (0x22) and `\`
 * (0x5C) — the two characters that would end the quoted-string early or start a
 * quoted-pair. So the allowed ranges are 0x20–0x21, 0x23–0x5B and 0x5D–0x7E, and
 * everything else (non-ASCII, CR/LF, other control characters, DEL) is replaced
 * with `_`.
 *
 * Replacing rather than deleting is deliberate: it keeps the name's shape
 * recognisable (`Übersicht.pdf` → `_bersicht.pdf`) instead of silently welding
 * neighbouring words together, and it can never produce an empty parameter.
 */
const NON_QUOTABLE_ASCII = /[^\x20-\x21\x23-\x5B\x5D-\x7E]/g;

/**
 * Percent-encode a filename as an RFC 8187 ext-value (the `filename*` parameter).
 */
function toExtValue(filename: string): string {
  return encodeURIComponent(filename).replace(
    NON_ATTR_CHAR,
    (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

/**
 * Build the `Content-Disposition` value for a client-supplied filename.
 *
 * Used for BOTH file delivery paths — the streamed response and the S3 presigned URL's
 * `response-content-disposition` — so a file keeps its name whichever one serves it.
 *
 * Exported so the rendering can be unit-tested without a Nest context, and so a
 * project overriding `CoreFileController.setFileHeaders` can reuse it.
 *
 * Filenames are client-supplied on both the multer path (`multerFileToUpload()`
 * keeps `originalname`, where the old diskStorage path generated the name
 * server-side) and the tus path (`Upload-Metadata`), so this value has to hold
 * up against a hostile name as well as merely an awkward one.
 *
 * Two parameters, because they answer to two different specs and one client set
 * each:
 *
 *  - `filename` is an RFC 6266 quoted-string, and NOTHING percent-decodes it.
 *    Percent-encoding it protects nothing the quotes do not already handle — it
 *    only makes a client without `filename*` support save
 *    `Jahresbericht%202024.pdf`. So it is sanitised to quotable ASCII and left
 *    literal.
 *  - `filename*` is the RFC 8187 ext-value that carries the real, non-ASCII name
 *    for every client that understands it, and it wins over `filename` per RFC
 *    6266 §4.3 when both are present.
 *
 * Injection is closed by the quoting plus the sanitiser, not by the encoding.
 * Before 11.33.0 this header was emitted bare (`filename=${file.filename}`), so a
 * `"` or a `; ` let the caller append or replace parameters outright — and an
 * appended `filename*` WINS over the one meant here. A CR/LF is worse than that:
 * it makes Node's `setHeader` throw `ERR_INVALID_CHAR`, turning that one file's
 * download into a permanent 500.
 */
export function buildContentDisposition(filename?: string): string {
  const name = filename || 'download';
  const quotable = name.replace(NON_QUOTABLE_ASCII, '_');
  return `attachment; filename="${quotable}"; filename*=UTF-8''${toExtValue(name)}`;
}
