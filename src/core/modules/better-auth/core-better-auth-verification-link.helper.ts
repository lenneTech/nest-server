import { CompactEncrypt, compactDecrypt } from 'jose';
import { createHash } from 'node:crypto';

/**
 * The verification link's token, sealed (DEV-4056).
 *
 * Better-Auth's email-verification token is a SIGNED JWT, not an encrypted one: its middle segment is base64url JSON
 * with the address and the user id (`{ email, userId, iat, exp }`). Removing `&email=` from the link therefore removed
 * nothing — anyone reading an access log, the browser history or a mail scanner's URL log decodes the address from the
 * token itself. The link carries the token encrypted instead (compact JWE, `dir` + `A256GCM`, key derived from
 * Better-Auth's secret), and the framework opens it where the token comes back: the API middleware before it forwards
 * `GET /verify-email` to Better-Auth, and `POST /iam/resend-verification-email`. Better-Auth's own verification runs
 * unchanged on the token it signed.
 *
 * A link mailed before the seal carries the plain token, which goes through as it is: {@link openVerificationToken}
 * answers an unsealed value unchanged.
 */

/** A sealed token is a compact JWE — five segments; Better-Auth's token is a JWS — three */
export function isSealedVerificationToken(value: unknown): value is string {
  return typeof value === 'string' && value.split('.').length === 5;
}

/** The key of the seal: derived from Better-Auth's secret, so it rotates with it and needs no configuration */
function sealKey(secret: string): Uint8Array {
  return new Uint8Array(createHash('sha256').update(`lt-email-verification-link:${secret}`).digest());
}

/** Encrypt a verification token for the link */
export async function sealVerificationToken(secret: string, token: string): Promise<string> {
  return new CompactEncrypt(new TextEncoder().encode(token))
    .setProtectedHeader({ alg: 'dir', enc: 'A256GCM' })
    .encrypt(sealKey(secret));
}

/**
 * The token a link carried: decrypted when sealed, unchanged when not (a link mailed before the seal). `undefined`
 * for a sealed value that does not open with this secret — forged, garbled, or sealed under a rotated secret.
 */
export async function openVerificationToken(secret: string, value: string): Promise<string | undefined> {
  if (!isSealedVerificationToken(value)) {
    return value;
  }
  try {
    const { plaintext } = await compactDecrypt(value, sealKey(secret), {
      contentEncryptionAlgorithms: ['A256GCM'],
      keyManagementAlgorithms: ['dir'],
    });
    return new TextDecoder().decode(plaintext);
  } catch {
    return undefined;
  }
}
