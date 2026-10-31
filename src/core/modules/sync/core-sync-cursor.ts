import { createHash, createHmac, hkdfSync, timingSafeEqual } from 'node:crypto';

/**
 * The pull cursor (protocol §5, plan §3.4): opaque to the client, signed by the server, bound to the model and the user
 * it was issued for. Format: `base64url(JSON).base64url(HMAC-SHA256)`. Nothing in it is a secret — the signature only
 * keeps a client from editing it into another user's, another model's or an earlier position.
 */

/** Where a pull continues */
export type SyncCursorPosition =
  /** SQL: the last change number delivered (`syncSeq`) */
  | { seq: number }
  /** MongoDB: the keyset `(syncAt, id)` of the last record delivered; `id: ''` starts at `at` itself */
  | { at: number; id: string };

export interface SyncCursorState {
  /** Hash of the access epochs the cursor was issued under */
  epochs: string;
  /** Hash of the caller's access when the cursor was issued (user, tenant scope, roles, verification) */
  fingerprint: string;
  model: string;
  position: SyncCursorPosition;
  /** Start (epoch ms) of the run in progress; absent once a page ended its run */
  runStart?: number;
  /**
   * Start (epoch ms) of the run since which the client's state is complete — compared with the tombstone horizon: a
   * tombstone purged after this point may never have reached the client
   */
  since: number;
  user: string;
}

/** Cursors longer than this are refused unread: nothing the server issues comes close */
const MAX_CURSOR_LENGTH = 2048;

/** The key the cursors are signed with, derived from the configured secret (never the secret itself) */
export function deriveCursorKey(secret: string): Buffer {
  return Buffer.from(hkdfSync('sha256', secret, 'lenne.tech', 'nest-server:sync-cursor:v1', 32));
}

export function encodeSyncCursor(state: SyncCursorState, key: Buffer): string {
  const payload = Buffer.from(
    JSON.stringify({
      e: state.epochs,
      f: state.fingerprint,
      k: state.since,
      m: state.model,
      p: 'seq' in state.position ? { s: state.position.seq } : { a: state.position.at, i: state.position.id },
      ...(state.runStart === undefined ? {} : { r: state.runStart }),
      u: state.user,
      v: 1,
    }),
  ).toString('base64url');
  return `${payload}.${sign(payload, key)}`;
}

/** The cursor's state, or `undefined` when it is malformed, tampered with or of another format version */
export function decodeSyncCursor(cursor: unknown, key: Buffer): SyncCursorState | undefined {
  if (typeof cursor !== 'string' || !cursor || cursor.length > MAX_CURSOR_LENGTH) {
    return undefined;
  }
  const [payload, signature, rest] = cursor.split('.');
  if (!payload || !signature || rest !== undefined) {
    return undefined;
  }
  const expected = Buffer.from(sign(payload, key));
  const given = Buffer.from(signature);
  if (expected.length !== given.length || !timingSafeEqual(expected, given)) {
    return undefined;
  }
  let raw: any;
  try {
    raw = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
  } catch {
    return undefined;
  }
  if (
    !raw ||
    raw.v !== 1 ||
    typeof raw.m !== 'string' ||
    typeof raw.u !== 'string' ||
    typeof raw.f !== 'string' ||
    typeof raw.e !== 'string' ||
    !Number.isFinite(raw.k) ||
    (raw.r !== undefined && !Number.isFinite(raw.r)) ||
    !raw.p ||
    typeof raw.p !== 'object'
  ) {
    return undefined;
  }
  let position: SyncCursorPosition;
  if (Number.isFinite(raw.p.s)) {
    position = { seq: raw.p.s };
  } else if (Number.isFinite(raw.p.a) && typeof raw.p.i === 'string') {
    position = { at: raw.p.a, id: raw.p.i };
  } else {
    return undefined;
  }
  return {
    epochs: raw.e,
    fingerprint: raw.f,
    model: raw.m,
    position,
    ...(raw.r === undefined ? {} : { runStart: raw.r }),
    since: raw.k,
    user: raw.u,
  };
}

/** A short, stable hash of a JSON-serializable value (fingerprints, epoch sets) */
export function stableHash(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('base64url').slice(0, 32);
}

function sign(payload: string, key: Buffer): string {
  return createHmac('sha256', key).update(payload).digest('base64url');
}
