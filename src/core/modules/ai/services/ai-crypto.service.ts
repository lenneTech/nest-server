import { Injectable, Logger } from '@nestjs/common';
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';

import { ConfigService } from '../../../common/services/config.service';

/**
 * AES-256-GCM wrapper for AI connection secrets (API keys).
 *
 * Stored shape: `"<iv_b64>.<authTag_b64>.<ciphertext_b64>"` — a dot-separated
 * triplet that carries everything {@link decrypt} needs. The 256-bit key is
 * derived via SHA-256 from a configurable pass-phrase, so any length works.
 *
 * Secret resolution order:
 * 1. `ai.encryptionSecret` (config / `NSC__AI__ENCRYPTION_SECRET`)
 * 2. `SECRETS_ENCRYPTION_KEY` (env)
 * 3. an insecure development default (logs a warning on first use)
 *
 * Rotating the secret invalidates every value currently in the database;
 * operators must decrypt-then-re-encrypt on rotation (out of scope here).
 */
@Injectable()
export class AiCryptoService {
  private readonly logger = new Logger(AiCryptoService.name);
  private warned = false;

  /**
   * Decrypt a stored cipher text. Values without the expected triplet shape are
   * returned unchanged (tolerates legacy/plain values without crashing).
   */
  decrypt(cipherText: string): string {
    if (!cipherText) {
      return '';
    }
    const parts = cipherText.split('.');
    if (parts.length !== 3) {
      return cipherText;
    }
    const [ivB64, tagB64, dataB64] = parts;
    try {
      const iv = Buffer.from(ivB64, 'base64');
      const tag = Buffer.from(tagB64, 'base64');
      const data = Buffer.from(dataB64, 'base64');
      const decipher = createDecipheriv('aes-256-gcm', this.getKey(), iv);
      decipher.setAuthTag(tag);
      const plain = Buffer.concat([decipher.update(data), decipher.final()]);
      return plain.toString('utf8');
    } catch (err) {
      this.logger.error(`Decrypt failed: ${(err as Error).message}`);
      throw new Error('Secret decryption failed — key mismatch or corrupted value', { cause: err });
    }
  }

  /**
   * Encrypt a plaintext secret. Empty/undefined input is preserved as an empty
   * string so "set and cleared" stays distinguishable from "never set".
   */
  encrypt(plainText: string): string {
    if (plainText === '' || plainText === undefined || plainText === null) {
      return '';
    }
    const iv = randomBytes(12); // GCM standard: 96-bit IV
    const cipher = createCipheriv('aes-256-gcm', this.getKey(), iv);
    const encrypted = Buffer.concat([cipher.update(plainText, 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();
    return [iv.toString('base64'), tag.toString('base64'), encrypted.toString('base64')].join('.');
  }

  /**
   * Derive the 32-byte AES key from the configured pass-phrase.
   */
  private getKey(): Buffer {
    const raw =
      ConfigService.get<string>('ai.encryptionSecret') ||
      process.env.NSC__AI__ENCRYPTION_SECRET ||
      process.env.SECRETS_ENCRYPTION_KEY;
    if (!raw) {
      if (!this.warned) {
        this.logger.warn(
          'No AI encryption secret set (ai.encryptionSecret / NSC__AI__ENCRYPTION_SECRET / SECRETS_ENCRYPTION_KEY) — ' +
            'using an insecure development default. DO NOT run this in production; set a random 32+ char value.',
        );
        this.warned = true;
      }
      return createHash('sha256').update('lt-nest-server-ai-dev-only-insecure-default').digest();
    }
    return createHash('sha256').update(raw, 'utf8').digest();
  }
}
